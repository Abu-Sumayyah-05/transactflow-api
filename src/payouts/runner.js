// Module 6: the payout runner. Sends a batch's items to the bank, one
// sub-batch of 100 at a time, and is safe to stop and rerun at any point.
//
// advance(batchId) does, under a lease (one runner per batch):
//   1. resume: items a crashed runner left half-done (payment PENDING) are
//      sent again WITH THE SAME REFERENCE. The bank dedupes on the
//      reference, so if it already paid, it returns the first result
//      instead of paying twice. This is what the per-item key is for.
//   2. sub-batches in order: sub-batch 2 starts only when every item of
//      sub-batch 1 has been sent (or rejected).
//   3. finish: the batch is DONE once every item has a final outcome.
//
// Backpressure: within a sub-batch at most payoutConcurrency items are in the
// air at once, and the batch pauses (sends nothing more) while
//   - the bank's circuit breaker is not letting calls through  -> 'PAUSED'
//   - payoutMaxInFlight of its payments are still unresolved   -> 'BACKPRESSURE'
// The next tick tries again, so a sick bank is never flooded.
//
// Returns 'DONE' | 'WAITING' (all sent, some outcomes still unknown) |
//         'PAUSED' | 'BACKPRESSURE' | 'BUSY' (another runner holds the lease).
const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const config = require('../config');
const ledger = require('../ledger/ledger');
const gateway = require('../gateway/gateway');
const repo = require('../payments/repository');
const sm = require('../payments/stateMachine');
const { applyOutcome } = require('../payments/outcomes');
const { namesMatch } = require('./csv');

// ---- lease ---------------------------------------------------------------

async function acquireLease(batchId, owner) {
  const { rows } = await pool.query(
    `UPDATE payout_batches
        SET lease_owner = $2, lease_until = now() + make_interval(secs => $3),
            status = CASE WHEN status = 'QUEUED' THEN 'PROCESSING' ELSE status END
      WHERE id = $1 AND status <> 'DONE' AND (lease_until IS NULL OR lease_until < now())
      RETURNING *`,
    [batchId, owner, config.payoutLeaseSeconds]
  );
  return rows[0] || null;
}

// Extends our lease before each send. If it was lost (we stalled past it and
// another runner took over), stop: never keep sending without the lease.
async function renewLease(batchId, owner) {
  const { rowCount } = await pool.query(
    `UPDATE payout_batches SET lease_until = now() + make_interval(secs => $3)
      WHERE id = $1 AND lease_owner = $2 AND lease_until >= now()`,
    [batchId, owner, config.payoutLeaseSeconds]
  );
  if (!rowCount) throw new Error(`lost the lease on payout batch ${batchId}`);
}

async function releaseLease(batchId, owner) {
  await pool.query('UPDATE payout_batches SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2', [batchId, owner]);
}

// ---- one item --------------------------------------------------------------

async function inFlight(batchId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payout_items i JOIN payments p ON p.id = i.payment_id
      WHERE i.batch_id = $1 AND p.status IN ('PENDING', 'UNKNOWN')`,
    [batchId]
  );
  return rows[0].n;
}

// Rejected at send time (name enquiry): refund its share of the reserve.
async function reject(batch, item, reason, resolvedName) {
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM payout_items WHERE id = $1 FOR UPDATE', [item.id]);
    if (rows[0].status !== 'QUEUED') return;
    const txId = await ledger.postTransaction(client, {
      memo: `payout ${item.idempotency_key} rejected (${reason}): reserve released`,
      entries: [
        { accountId: await ledger.getSystemAccountId(client, 'PAYOUTS_RESERVED'), direction: 'DEBIT', amountKobo: item.amount_kobo },
        { accountId: batch.account_id, direction: 'CREDIT', amountKobo: item.amount_kobo },
      ],
    });
    await client.query(
      "UPDATE payout_items SET status = 'REJECTED', reason = $2, resolved_name = $3, release_transaction_id = $4 WHERE id = $1",
      [item.id, reason, resolvedName, txId]
    );
  });
  return 'REJECTED';
}

// Creates the item's payment and holds its money, in one transaction,
// BEFORE anything goes to the bank. The payment's reference is the item's
// idempotency key, and payments.reference is unique, so an item can never
// get a second payment.
async function createPayment(batch, item, resolvedName) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM payout_items WHERE id = $1 FOR UPDATE', [item.id]);
    if (rows[0].status !== 'QUEUED') return null;
    // Lock first, before the payment row exists (see ledger.lockAccounts).
    await ledger.lockAccounts(client, [batch.account_id, 'PAYOUTS_RESERVED', 'TRANSFERS_IN_FLIGHT']);
    const p = await repo.create(client, {
      reference: item.idempotency_key,
      accountId: batch.account_id,
      type: 'BANK_TRANSFER',
      amountKobo: item.amount_kobo,
      bank: item.bank,
      destinationAccount: item.account_number,
      destinationName: resolvedName,
    });
    const holdId = await ledger.postTransaction(client, {
      memo: `hold for payout ${p.reference}`,
      entries: [
        { accountId: await ledger.getSystemAccountId(client, 'PAYOUTS_RESERVED'), direction: 'DEBIT', amountKobo: item.amount_kobo },
        { accountId: await ledger.getSystemAccountId(client, 'TRANSFERS_IN_FLIGHT'), direction: 'CREDIT', amountKobo: item.amount_kobo },
      ],
    });
    await client.query('UPDATE payments SET hold_transaction_id = $2 WHERE id = $1', [p.id, holdId]);
    await client.query("UPDATE payout_items SET status = 'SENT', payment_id = $2, resolved_name = $3 WHERE id = $1", [item.id, p.id, resolvedName]);
    return sm.transition(client, p.id, 'PENDING', { reason: `payout batch ${batch.id}, row ${item.row_number}` });
  });
}

// Sends (or re-sends: same reference, so the bank dedupes) and records the answer.
async function sendToBank(payment, hooks) {
  await hooks.beforeSend?.(payment);
  const result = await gateway.transfer(payment.bank, {
    reference: payment.reference,
    accountNumber: payment.destination_account,
    amountKobo: payment.amount_kobo,
  });
  await hooks.afterSend?.(payment);
  await withTransaction((client) => applyOutcome(client, payment.id, result));
}

async function processItem(batch, item, hooks) {
  // Pre-send check that needs the bank: does the account exist, and is it
  // the person the merchant meant?
  const ne = await gateway.nameEnquiry(item.bank, item.account_number);
  if (ne.outcome === 'NOT_FOUND') return reject(batch, item, 'ACCOUNT_NOT_FOUND', null);
  if (ne.outcome !== 'SUCCESS') return 'PAUSED'; // bank unreachable: try again next tick
  if (!namesMatch(item.account_name, ne.accountName)) return reject(batch, item, 'NAME_MISMATCH', ne.accountName);

  const payment = await createPayment(batch, item, ne.accountName);
  if (!payment) return 'SKIPPED';
  await sendToBank(payment, hooks);
  return 'SENT';
}

// ---- a pool of workers with backpressure ----------------------------------

// Runs `work` over `list` with at most `concurrency` at once. Each worker
// takes its item first (so two workers never get the same one), then asks
// `gate(item)` for a reason to stop ('PAUSED' / 'BACKPRESSURE'); a stopped
// item is simply left QUEUED for the next tick.
// An error stops new work; items already in the air finish; then it rethrows.
async function runPool(list, concurrency, gate, work) {
  let next = 0;
  let stop = null;
  let error = null;
  async function worker() {
    while (!stop && !error && next < list.length) {
      const item = list[next];
      next += 1;
      const reason = await gate(item);
      if (reason) {
        stop = stop || reason;
        return;
      }
      try {
        const r = await work(item);
        if (r === 'PAUSED') stop = stop || 'PAUSED';
      } catch (err) {
        error = error || err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (error) throw error;
  return stop;
}

// ---- the batch -----------------------------------------------------------

async function finish(batchId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE i.status = 'QUEUED')::int AS queued,
            COUNT(*) FILTER (WHERE p.status NOT IN ('COMPLETED', 'FAILED'))::int AS unresolved
       FROM payout_items i LEFT JOIN payments p ON p.id = i.payment_id WHERE i.batch_id = $1`,
    [batchId]
  );
  if (rows[0].queued || rows[0].unresolved) return 'WAITING';
  await pool.query("UPDATE payout_batches SET status = 'DONE', completed_at = now() WHERE id = $1 AND status <> 'DONE'", [batchId]);
  return 'DONE';
}

async function advance(batchId, { hooks = {} } = {}) {
  const owner = `runner-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const batch = await acquireLease(batchId, owner);
  if (!batch) {
    const { rows } = await pool.query('SELECT status FROM payout_batches WHERE id = $1', [batchId]);
    return rows[0]?.status === 'DONE' ? 'DONE' : 'BUSY';
  }

  try {
    const gate = async (item) => {
      if ((await inFlight(batchId)) >= config.payoutMaxInFlight) return 'BACKPRESSURE';
      if (!gateway.bankAvailable(item.bank)) return 'PAUSED';
      await renewLease(batchId, owner);
      return null;
    };

    // 1. Resume what a crashed runner left PENDING (UNKNOWN ones belong to TSQ).
    const { rows: orphans } = await pool.query(
      `SELECT p.* FROM payout_items i JOIN payments p ON p.id = i.payment_id
        WHERE i.batch_id = $1 AND p.status = 'PENDING' ORDER BY i.row_number`,
      [batchId]
    );
    for (const p of orphans) {
      if (!gateway.bankAvailable(p.bank)) return 'PAUSED';
      await renewLease(batchId, owner);
      await sendToBank(p, hooks);
    }

    // 2. Sub-batches, strictly in order.
    for (;;) {
      const { rows: subs } = await pool.query(
        "SELECT * FROM payout_sub_batches WHERE batch_id = $1 AND status <> 'DONE' ORDER BY number LIMIT 1",
        [batchId]
      );
      const sub = subs[0];
      if (!sub) break;
      await pool.query(
        "UPDATE payout_sub_batches SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE batch_id = $1 AND number = $2",
        [batchId, sub.number]
      );
      const { rows: items } = await pool.query(
        "SELECT * FROM payout_items WHERE batch_id = $1 AND sub_batch = $2 AND status = 'QUEUED' ORDER BY row_number",
        [batchId, sub.number]
      );
      const stopped = await runPool(items, config.payoutConcurrency, gate, (item) => processItem(batch, item, hooks));
      if (stopped) return stopped;

      const { rows: left } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM payout_items WHERE batch_id = $1 AND sub_batch = $2 AND status = 'QUEUED'",
        [batchId, sub.number]
      );
      if (left[0].n) return 'PAUSED';
      await pool.query(
        "UPDATE payout_sub_batches SET status = 'DONE', finished_at = now() WHERE batch_id = $1 AND number = $2",
        [batchId, sub.number]
      );
    }

    // 3. Done once every item has a final outcome.
    return await finish(batchId);
  } finally {
    await releaseLease(batchId, owner).catch(() => {});
  }
}

// One tick over every unfinished batch, oldest first.
async function runOnce() {
  const { rows } = await pool.query("SELECT id FROM payout_batches WHERE status <> 'DONE' ORDER BY created_at LIMIT 20");
  for (const { id } of rows) {
    try {
      await advance(id);
    } catch (err) {
      console.error(`payouts: batch ${id}: ${err.message}`);
    }
  }
}

function startLoop() {
  const timer = setInterval(() => {
    runOnce().catch((err) => console.error(`payout loop: ${err.message}`));
  }, config.payoutIntervalMs);
  timer.unref();
  return timer;
}

module.exports = { advance, runOnce, startLoop };
