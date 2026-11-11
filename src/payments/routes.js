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
    (r, idem) => service.completeChallenge({ userId: r.user.id, paymentId: r.params.id, otp: r.body?.otp }, idem),
    { livePaymentResponse }
  )(req, res)
);

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
