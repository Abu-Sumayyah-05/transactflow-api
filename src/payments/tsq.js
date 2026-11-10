// Transaction Status Query (TSQ) job, Module 2.
//
// When the bank goes quiet we store UNKNOWN, never FAILED, and this job asks
// the bank "what actually happened to reference X?" until it gets a real
// answer or the TTL runs out (then a human reviews it).
const { pool, withTransaction } = require('../db/pool');
const config = require('../config');
const gateway = require('../gateway/gateway');
const sm = require('./stateMachine');
const { applyOutcome } = require('./outcomes');

const BATCH = 20;
const LEASE_SECONDS = 60;

async function queryBank(p) {
  return p.type === 'CARD_TOPUP' ? gateway.queryCharge(p.bank, p.reference) : gateway.queryTransfer(p.bank, p.reference);
}

// A payment left in PENDING for too long means the process died between
// "sent to bank" and "recorded the answer". Treat it as UNKNOWN so TSQ asks.
async function sweepStalePending() {
  const { rows } = await pool.query(
    `SELECT id FROM payments WHERE status = 'PENDING'
        AND updated_at < now() - make_interval(secs => $1::float8 / 1000) LIMIT $2`,
    [config.pendingStaleMs, BATCH]
  );
  for (const { id } of rows) {
    await withTransaction(async (client) => {
      const { rows: cur } = await client.query('SELECT status FROM payments WHERE id = $1 FOR UPDATE', [id]);
      if (cur[0].status !== 'PENDING') return; // the live request finished meanwhile
      await sm.transition(client, id, 'UNKNOWN', {
        reason: 'stale PENDING (no answer recorded)',
        set: { tsq_next_at: new Date(), tsq_expires_at: new Date(Date.now() + config.tsqTtlMs) },
      });
    });
  }
  return rows.length;
}

// Claims due payments with SKIP LOCKED and pushes their next check out by a
// lease, so two workers never query the same payment at the same time.
async function claimDue() {
  const { rows } = await pool.query(
    `UPDATE payments SET tsq_next_at = now() + make_interval(secs => $2)
      WHERE id IN (SELECT id FROM payments
                    WHERE status = 'UNKNOWN' AND tsq_next_at <= now()
                    ORDER BY tsq_next_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [BATCH, LEASE_SECONDS]
  );
  return rows;
}

async function resolve(p) {
  const result = await queryBank(p);
  return withTransaction((client) => applyOutcome(client, p.id, result));
}

async function runOnce() {
  await sweepStalePending();
  const due = await claimDue();
  for (const p of due) {
    try {
      await resolve(p);
    } catch (err) {
      console.error(`tsq: payment ${p.id} failed to resolve: ${err.message}`);
    }
  }
  return due.length;
}

// Used by GET /payments/:id: one immediate check for one UNKNOWN payment.
async function resolveOne(paymentId) {
  const { rows } = await pool.query("SELECT * FROM payments WHERE id = $1 AND status = 'UNKNOWN'", [paymentId]);
  if (rows[0]) await resolve(rows[0]);
}

function startLoop() {
  const timer = setInterval(() => {
    runOnce().catch((err) => console.error(`tsq loop: ${err.message}`));
  }, config.tsqIntervalMs);
  timer.unref();
  return timer;
}

module.exports = { runOnce, resolveOne, startLoop };
