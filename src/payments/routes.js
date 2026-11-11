const express = require('express');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { idempotent } = require('../idempotency/idempotency');
const service = require('./service');
const repo = require('./repository');
const tsq = require('./tsq');
const fraud = require('../fraud/check');

const router = express.Router();

// How a retry of a payment-creating request is answered: with the payment as
// it is right now. 202 while still in flight, 201 once final.
async function livePaymentResponse(paymentId) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  const body = repo.present(rows[0]);
  return { status: ['COMPLETED', 'FAILED'].includes(body.status) ? 201 : 202, body };
}

// POST /payments — top up your wallet from a saved card token.
router.post(
  '/',
  idempotent(
    'POST /payments',
    (req, idem) =>
      service.startCardTopup(
        {
          userId: req.user.id,
          cardToken: req.body?.card_token,
          amountKobo: req.body?.amount_kobo,
          billingAddress: req.body?.billing_address,
          deviceId: fraud.parseDeviceId(req.get('X-Device-Id')),
          startedAt: req.startedAt,
        },
        idem
      ),
    { livePaymentResponse }
  )
);

// POST /payments/:id/challenge { otp } — the 3DS-style step. It can trigger
// the charge, so like every money-moving POST it needs an Idempotency-Key.
// The payment id is part of the key's scope, so one key can't be replayed
// against a different payment.
router.post('/:id/challenge', (req, res) =>
  idempotent(
    `POST /payments/${req.params.id}/challenge`,
    (r, idem) => service.completeChallenge({ userId: r.user.id, paymentId: r.params.id, otp: r.body?.otp, startedAt: r.startedAt }, idem),
    { livePaymentResponse }
  )(req, res)
);

// GET /payments — my card payments and bank transfers, newest first (History).
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT p.*, c.brand AS card_brand, c.last4 AS card_last4
       FROM payments p
       JOIN accounts a ON a.id = p.account_id
       LEFT JOIN cards c ON c.token = p.card_token
      WHERE a.user_id = $1
      ORDER BY p.created_at DESC, p.id DESC LIMIT $2`,
    [req.user.id, limit]
  );
  res.json({
    payments: rows.map((p) => ({ ...repo.present(p), ...(p.card_token && { card: { brand: p.card_brand, last4: p.card_last4 } }) })),
  });
});

// GET /payments/:id — status and receipt. If the status is UNKNOWN, ask the
// bank right now before answering.
router.get('/:id', async (req, res) => {
  let p = await repo.findForUser(pool, req.params.id, req.user.id);
  if (!p) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  if (p.status === 'UNKNOWN') {
    await tsq.resolveOne(p.id).catch(() => {});
    p = await repo.findForUser(pool, req.params.id, req.user.id);
  }
  res.json({ ...repo.present(p), events: await repo.events(pool, p.id) });
});

module.exports = { router, livePaymentResponse };
