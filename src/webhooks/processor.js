// Processes stored webhook events and applies them to payments.
//
// Each event is handled in ONE database transaction: lock the event, apply
// the outcome to the payment (and ledger), mark the event PROCESSED. If
// anything throws, it all rolls back and the event is retried later with
// exponential backoff. After 5 failed attempts it is DEAD: that is the
// dead-letter queue, which a human inspects and replays from the admin console.
//
// Errors that retrying can't fix (an amount mismatch, say) go straight to DEAD.
const { pool, withTransaction } = require('../db/pool');
const config = require('../config');
const { applyOutcome } = require('../payments/outcomes');

class PermanentError extends Error {}

const TYPES = {
  'charge.completed': { paymentType: 'CARD_TOPUP', outcome: 'SUCCESS' },
  'charge.failed': { paymentType: 'CARD_TOPUP', outcome: 'DECLINED' },
  'transfer.completed': { paymentType: 'BANK_TRANSFER', outcome: 'SUCCESS' },
  'transfer.failed': { paymentType: 'BANK_TRANSFER', outcome: 'DECLINED' },
};

async function handleEvent(client, evt) {
  const kind = TYPES[evt.event_type];
  if (!kind) return; // an event type we don't act on; record it as processed
  const data = evt.payload?.data || {};

  const { rows } = await client.query('SELECT * FROM payments WHERE reference = $1 FOR UPDATE', [String(data.reference || '')]);
  const p = rows[0];
  // Could be a race (the event beat our own commit), so this one is retried.
  if (!p) throw new Error(`no payment with reference ${data.reference}`);

  if (p.bank !== evt.source) throw new PermanentError(`bank ${evt.source} sent an event for a bank ${p.bank} payment`);
  if (p.type !== kind.paymentType) throw new PermanentError(`${evt.event_type} does not match a ${p.type} payment`);
  if (data.amount_kobo !== p.amount_kobo) {
    throw new PermanentError(`amount mismatch: webhook ${data.amount_kobo} kobo, ours ${p.amount_kobo} kobo`);
  }

  await applyOutcome(client, p.id, {
    outcome: kind.outcome,
    responseCode: data.response_code ?? null,
    bankReference: data.bank_reference ?? null,
  });
}

async function processOne(id) {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM webhook_events WHERE id = $1 AND status IN ('RECEIVED', 'RETRY') FOR UPDATE SKIP LOCKED",
        [id]
      );
      if (!rows[0]) return null; // already handled, or another worker has it
      await handleEvent(client, rows[0]);
      await client.query(
        `UPDATE webhook_events SET status = 'PROCESSED', attempts = attempts + 1, processed_at = now(),
                last_error = NULL, next_attempt_at = NULL WHERE id = $1`,
        [id]
      );
      return 'PROCESSED';
    });
  } catch (err) {
    const permanent = err instanceof PermanentError;
    const { rows } = await pool.query(
      `UPDATE webhook_events
          SET attempts = attempts + 1, last_error = $2,
              status = CASE WHEN $5 OR attempts + 1 >= $3 THEN 'DEAD' ELSE 'RETRY' END,
              next_attempt_at = CASE WHEN $5 OR attempts + 1 >= $3 THEN NULL
                                ELSE now() + make_interval(secs => $4::float8 * power(2, attempts) / 1000) END
        WHERE id = $1 AND status IN ('RECEIVED', 'RETRY')
        RETURNING status`,
      [id, err.message.slice(0, 500), config.webhookMaxAttempts, config.webhookRetryBaseMs, permanent]
    );
    if (rows[0]?.status === 'DEAD') console.warn(`webhook ${id} moved to the dead-letter queue: ${err.message}`);
    return rows[0]?.status ?? null;
  }
}

async function processDue(limit = 50) {
  const { rows } = await pool.query(
    `SELECT id FROM webhook_events
      WHERE status IN ('RECEIVED', 'RETRY') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY id LIMIT $1`,
    [limit]
  );
  for (const { id } of rows) await processOne(id);
  return rows.length;
}

// Admin replay from the DLQ: give the event a fresh set of attempts and run it now.
async function replay(id) {
  const { rowCount } = await pool.query(
    "UPDATE webhook_events SET status = 'RETRY', attempts = 0, next_attempt_at = now() WHERE id = $1 AND status = 'DEAD'",
    [id]
  );
  if (rowCount === 0) return null;
  await processOne(id);
  const { rows } = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [id]);
  return rows[0];
}

function startLoop() {
  const timer = setInterval(() => {
    processDue().catch((err) => console.error(`webhook loop: ${err.message}`));
  }, 2000);
  timer.unref();
  return timer;
}

module.exports = { processOne, processDue, replay, startLoop };
