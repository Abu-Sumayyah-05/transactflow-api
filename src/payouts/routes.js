// Payouts (merchant only). Mounted behind requireAuth + requireRole('merchant').
const express = require('express');
const { idempotent } = require('../idempotency/idempotency');
const batches = require('./batches');

const router = express.Router();

// POST /payouts/batches — the CSV is the request body (Content-Type: text/csv).
// Reserving the money moves it, so like every money-moving POST it needs an
// Idempotency-Key: a double-clicked Upload creates one batch.
router.post(
  '/batches',
  express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '2mb' }),
  idempotent('POST /payouts/batches', (req, idem) => batches.upload({ merchantId: req.user.id, csvText: req.body }, idem))
);

router.get('/batches', async (req, res) => {
  res.json({ batches: await batches.list(req.user.id) });
});

// GET /payouts/batches/:id — progress and the itemised report.
// ?format=csv downloads the report as a file.
router.get('/batches/:id', async (req, res) => {
  const r = await batches.report(req.user.id, req.params.id);
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`payout-report-${r.id}.csv`).send(batches.reportCsv(r));
    return;
  }
  res.json(r);
});

module.exports = { router };
