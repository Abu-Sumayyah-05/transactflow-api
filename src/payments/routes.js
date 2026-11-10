const express = require('express');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { idempotent } = require('../idempotency/idempotency');
const service = require('./service');
const repo = require('./repository');
const tsq = require('./tsq');

const router = express.Router();

// POST /payments — top up your wallet from a saved card token.
router.post(
  '/',
  idempotent('POST /payments', (req, idem) =>
    service.startCardTopup({ userId: req.user.id, cardToken: req.body?.card_token, amountKobo: req.body?.amount_kobo }, idem)
  )
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

module.exports = { router };
