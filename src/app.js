const express = require('express');
require('./config');
const { AppError } = require('./errors');
const auth = require('./auth/auth');
const accounts = require('./accounts/accounts');
const transfers = require('./transfers/transfers');
const cards = require('./cards/cards');
const payments = require('./payments/routes');
const webhooks = require('./webhooks/routes');
const admin = require('./admin/routes');

const app = express();
app.disable('x-powered-by');

// Webhooks first: their HMAC is checked over the raw bytes, so they must be
// mounted BEFORE the JSON parser consumes the body.
app.use('/api/v1/webhooks', webhooks.router);

app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

const v1 = express.Router();
v1.use('/auth', auth.router);
v1.use('/accounts', auth.requireAuth, accounts.router);
v1.use('/transfers', auth.requireAuth, transfers.router);
v1.use('/cards', auth.requireAuth, cards.router);
v1.use('/payments', auth.requireAuth, payments.router);
v1.use('/admin', auth.requireAuth, auth.requireRole('admin'), admin.router);
app.use('/api/v1', v1);

app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));

// Express 5 forwards errors thrown in async handlers here automatically.
// Known errors get their own status; anything else is a 500 with no internals leaked.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
});

module.exports = app;
