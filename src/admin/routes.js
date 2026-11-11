// Admin-only routes. Mounted behind requireAuth + requireRole('admin').
const express = require('express');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const processor = require('../webhooks/processor');
const fraudReview = require('../fraud/review');
const { idempotent } = require('../idempotency/idempotency');

const router = express.Router();

const EVENT_COLUMNS = `id, event_id, source, event_type, signature_valid, status, received_count,
  attempts, last_error, received_at, last_received_at, processed_at`;

// Webhook log: every event received, valid or not, duplicates and attempts.
router.get('/webhooks', async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${EVENT_COLUMNS} FROM webhook_events ORDER BY id DESC LIMIT 200`);
  res.json({ events: rows });
});

// Dead-letter queue.
router.get('/dlq', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLUMNS}, payload FROM webhook_events WHERE status = 'DEAD' ORDER BY id DESC LIMIT 200`
  );
  res.json({ events: rows });
});

router.post('/dlq/:id/replay', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) throw new AppError(404, 'NOT_FOUND', 'No such dead-letter event');
  const evt = await processor.replay(id);
  if (!evt) throw new AppError(404, 'NOT_FOUND', 'No such dead-letter event');
  res.json({ id: evt.id, event_id: evt.event_id, status: evt.status, attempts: evt.attempts, last_error: evt.last_error });
});

// Fraud queue: ?status=OPEN (default) | APPROVED | BLOCKED | CLEARED_BY_CHALLENGE | ALL
const QUEUE_FILTERS = new Set(['OPEN', 'APPROVED', 'BLOCKED', 'CLEARED_BY_CHALLENGE', 'ALL']);
router.get('/fraud', async (req, res) => {
  const status = String(req.query.status || 'OPEN').toUpperCase();
  if (!QUEUE_FILTERS.has(status)) throw new AppError(400, 'INVALID_FILTER', `status must be one of ${[...QUEUE_FILTERS].join(', ')}`);
  res.json({ items: await fraudReview.listQueue({ status }) });
});

router.post('/fraud/:id/decision', (req, res) =>
  idempotent(
    `POST /admin/fraud/${req.params.id}/decision`,
    (r, idem) =>
      fraudReview.decide(
        { decisionId: Number(r.params.id), decision: String(r.body?.decision || '').toUpperCase(), note: r.body?.note, adminId: r.user.id },
        idem
      ),
    { livePaymentResponse: (id) => require('../payments/routes').livePaymentResponse(id) }
  )(req, res)
);

// Gateway health: circuit breaker state per bank (live dashboard).
router.get('/gateway', (_req, res) => {
  res.json({ banks: require('../gateway/gateway').breakerSnapshots() });
});

module.exports = { router };
