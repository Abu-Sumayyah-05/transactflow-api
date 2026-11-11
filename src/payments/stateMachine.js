// Module 2: payment state machine.
//
//   INITIALIZED -> PENDING -> AUTHORIZED -> COMPLETED
//        |            |  \__________________^   (bank transfers skip AUTHORIZED)
//        v            v
//      FAILED <--- UNKNOWN  (timeout: we don't know yet; TSQ finds out)
//
// COMPLETED and FAILED are final. The same list is enforced by a database
// trigger (migration 003), so even a hand-written UPDATE can't break it.
const { AppError } = require('../errors');

const TRANSITIONS = Object.freeze({
  INITIALIZED: ['PENDING', 'FAILED'],
  PENDING: ['AUTHORIZED', 'COMPLETED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['AUTHORIZED', 'COMPLETED', 'FAILED'],
  AUTHORIZED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
});

const FINAL = new Set(['COMPLETED', 'FAILED']);

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

// Columns a transition may also set in the same UPDATE.
const SETTABLE = new Set([
  'response_code', 'bank_reference', 'ledger_transaction_id', 'tsq_next_at',
  'tsq_expires_at', 'needs_review', 'bank', 'failure_code', 'challenge_status',
]);

// Moves a payment to `to`, inside the caller's transaction. Locks the row so
// two workers can't move the same payment at once, and logs the step.
async function transition(client, paymentId, to, { reason = null, set = {} } = {}) {
  const { rows } = await client.query('SELECT status FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!rows[0]) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  const from = rows[0].status;
  if (!canTransition(from, to)) {
    throw new AppError(409, 'ILLEGAL_TRANSITION', `A payment cannot move from ${from} to ${to}`);
  }

  const cols = ['status = $2', 'updated_at = now()'];
  const values = [paymentId, to];
  for (const [col, value] of Object.entries(set)) {
    if (!SETTABLE.has(col)) throw new Error(`transition cannot set column ${col}`);
    values.push(value);
    cols.push(`${col} = $${values.length}`);
  }
  const updated = await client.query(`UPDATE payments SET ${cols.join(', ')} WHERE id = $1 RETURNING *`, values);
  await client.query(
    'INSERT INTO payment_events (payment_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)',
    [paymentId, from, to, reason]
  );
  return updated.rows[0];
}

module.exports = { TRANSITIONS, FINAL, canTransition, transition };
