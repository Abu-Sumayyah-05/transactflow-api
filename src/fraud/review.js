// The admin fraud queue: flagged payments (challenge or block band) that no
// human has looked at yet, and the analyst's approve/block decision.
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const repo = require('../payments/repository');
const sm = require('../payments/stateMachine');
const payments = require('../payments/service');
const velocity = require('./velocity');

async function listQueue({ status = 'OPEN', limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT d.*, u.email AS customer_email, p.*, d.id AS decision_id, d.created_at AS flagged_at
       FROM fraud_decisions d
       JOIN payments p ON p.id = d.payment_id
       JOIN accounts a ON a.id = p.account_id
       JOIN users u ON u.id = a.user_id
      WHERE ($1::text = 'ALL' AND d.outcome <> 'APPROVE') OR d.review_status = $1
      ORDER BY d.created_at DESC LIMIT $2`,
    [status, limit]
  );
  return rows.map((r) => ({
    id: r.decision_id,
    score: r.score,
    outcome: r.outcome,
    rules_fired: r.rules_fired,
    review_status: r.review_status,
    reviewed_at: r.reviewed_at,
    review_note: r.review_note,
    flagged_at: r.flagged_at,
    customer_email: r.customer_email,
    payment: repo.present(r),
  }));
}

const DECISIONS = new Set(['APPROVE', 'BLOCK']);

// POST /admin/fraud/:id/decision { decision, note }. Wrapped in idempotent()
// because approving a payment that waits for its challenge charges the card.
async function decide({ decisionId, decision, note, adminId }, idem) {
  if (!DECISIONS.has(decision)) throw new AppError(400, 'INVALID_DECISION', 'decision must be APPROVE or BLOCK');
  if (!Number.isSafeInteger(decisionId)) throw new AppError(404, 'NOT_FOUND', 'No such fraud decision');

  const step = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM fraud_decisions WHERE id = $1 FOR UPDATE', [decisionId]);
    const d = rows[0];
    if (!d) throw new AppError(404, 'NOT_FOUND', 'No such fraud decision');
    if (d.review_status !== 'OPEN') {
      throw new AppError(409, 'ALREADY_REVIEWED', `This flag was already resolved (${d.review_status})`);
    }
    await client.query(
      `UPDATE fraud_decisions SET review_status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
        WHERE id = $1`,
      [d.id, decision === 'APPROVE' ? 'APPROVED' : 'BLOCKED', adminId, note ? String(note).slice(0, 500) : null]
    );

    const { rows: cur } = await client.query('SELECT * FROM payments WHERE id = $1', [d.payment_id]);
    const waiting = cur[0].status === 'PENDING' && cur[0].challenge_status === 'REQUIRED';

    if (waiting) {
      const p = await payments.lockChallenged(client, d.payment_id);
      if (decision === 'BLOCK') {
        const final = await payments.failChallenge(client, p, 'REVIEW_BLOCKED', 'FAILED', 'blocked by fraud review');
        const body = repo.present(final);
        await idem.complete(client, 200, body);
        return { done: { status: 200, body } };
      }
      // Approved by a human: skip the code and send it to the bank.
      const bank = payments.pickBankOrFail();
      await client.query("UPDATE payments SET bank = $2, challenge_status = 'WAIVED', updated_at = now() WHERE id = $1", [p.id, bank]);
      await idem.linkPayment(client, p.id);
      return { send: { ...p, bank } };
    }

    // Already final (blocked by the rules, or a failed/expired challenge).
    // Approve = false positive: let the customer try again. The failed
    // payment itself stays failed; final states never change.
    if (decision === 'APPROVE' && cur[0].status === 'FAILED') {
      const { rows: owner } = await client.query(
        `SELECT a.user_id, c.fingerprint FROM accounts a LEFT JOIN cards c ON c.token = $2 WHERE a.id = $1`,
        [cur[0].account_id, cur[0].card_token]
      );
      await velocity.clear({ userId: owner[0].user_id, cardFingerprint: owner[0].fingerprint }, { db: client });
    }
    const body = repo.present(cur[0]);
    await idem.complete(client, 200, body);
    return { done: { status: 200, body } };
  });

  if (step.done) return step.done;
  return payments.chargeAtBank(step.send, step.send.owner_id, idem);
}

module.exports = { listQueue, decide };
