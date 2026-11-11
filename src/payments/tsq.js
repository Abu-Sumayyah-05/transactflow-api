// Transaction Status Query (TSQ) job, Module 2.
//
// When the bank goes quiet we store UNKNOWN, never FAILED, and this job asks
// the bank "what actually happened to reference X?" until it gets a real
// answer or the TTL runs out (then a human reviews it).
const { pool, withTransaction } = require('../db/pool');
const config = require('../config');
const gateway = require('../gateway/gateway');
const sm = require('./stateMachine');
const { applyOutcome, scheduleTsq } = require('./outcomes');

const BATCH = 20;
const LEASE_SECONDS = 60;

async function queryBank(p) {
  return p.type === 'CARD_TOPUP' ? gateway.queryCharge(p.bank, p.reference) : gateway.queryTransfer(p.bank, p.reference);
}

// A payment left in PENDING for too long means the process died between
// "sent to bank" and "recorded the answer". Treat it as UNKNOWN so TSQ asks.
// A payment waiting for its 3DS-style challenge was never sent, so it is
// left alone here (expireChallenges handles it).
async function sweepStalePending() {
  const { rows } = await pool.query(
    `SELECT id FROM payments WHERE status = 'PENDING' AND challenge_status IS DISTINCT FROM 'REQUIRED'
        AND updated_at < now() - make_interval(secs => $1::float8 / 1000) LIMIT $2`,
    [config.pendingStaleMs, BATCH]
  );
  for (const { id } of rows) {
    await withTransaction(async (client) => {
      const { rows: cur } = await client.query('SELECT status, challenge_status FROM payments WHERE id = $1 FOR UPDATE', [id]);
      if (cur[0].status !== 'PENDING') return; // the live request finished meanwhile
      if (cur[0].challenge_status === 'REQUIRED') return;
      await sm.transition(client, id, 'UNKNOWN', { reason: 'stale PENDING (no answer recorded)' });
      await scheduleTsq(client, id, 0); // due immediately, by the database clock
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

// One tick: sweep stale PENDING, then work through everything that is due,
// batch by batch, so a backlog can't starve newer payments. Each claimed
// payment's next check moves out (lease or backoff), so the loop ends.
const MAX_BATCHES_PER_TICK = 10;

async function runOnce() {
  await require('./service').expireChallenges();
  await sweepStalePending();
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
    const due = await claimDue();
    for (const p of due) {
      try {
        await resolve(p);
      } catch (err) {
        console.error(`tsq: payment ${p.id} failed to resolve: ${err.message}`);
      }
    }
    total += due.length;
    if (due.length < BATCH) break;
  }
  return total;
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
