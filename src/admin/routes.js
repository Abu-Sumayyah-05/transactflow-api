// Admin-only routes. Mounted behind requireAuth + requireRole('admin').
const express = require('express');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const processor = require('../webhooks/processor');
const fraudReview = require('../fraud/review');
const disputes = require('../disputes/disputes');
const recon = require('../recon/engine');
const reconReports = require('../recon/reports');
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

// Disputes (chargebacks): ?status=OPEN | CUSTOMER_WON | MERCHANT_WON (default: all)
const DISPUTE_FILTERS = new Set(['OPEN', 'CUSTOMER_WON', 'MERCHANT_WON']);
router.get('/disputes', async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (status && !DISPUTE_FILTERS.has(status)) throw new AppError(400, 'INVALID_FILTER', `status must be one of ${[...DISPUTE_FILTERS].join(', ')}`);
  res.json({ disputes: await disputes.list({ status }) });
});

// Resolving moves money out of ESCROW, so it needs an Idempotency-Key.
router.post('/disputes/:id/resolve', (req, res) =>
  idempotent(`POST /admin/disputes/${req.params.id}/resolve`, (r, idem) =>
    disputes.resolve({ disputeId: Number(r.params.id), outcome: String(r.body?.outcome || '').toUpperCase(), adminId: r.user.id }, idem)
  )(req, res)
);

// Make a customer a merchant (payouts are merchant-only) or back again.
// The API can never create or demote an admin: that stays a database-level
// operation, so a stolen admin token can't mint more admins. The new role
// takes effect at the user's next login (the role travels in the JWT).
const ASSIGNABLE_ROLES = new Set(['customer', 'merchant']);
router.post('/users/:id/role', async (req, res) => {
  const role = String(req.body?.role || '').toLowerCase();
  if (!ASSIGNABLE_ROLES.has(role)) throw new AppError(400, 'INVALID_ROLE', 'role must be customer or merchant');
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new AppError(404, 'USER_NOT_FOUND', 'No such user');
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new AppError(404, 'USER_NOT_FOUND', 'No such user');
  if (rows[0].role === 'admin') throw new AppError(409, 'CANNOT_CHANGE_ADMIN', 'Admin roles cannot be changed here');
  const updated = await pool.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, email, full_name, role', [req.params.id, role]);
  res.json(updated.rows[0]);
});

// ---- Reconciliation (Module 11) ---------------------------------------------
// POST /admin/recon/run { bank, since?, file? }  manual run. `file` reconciles
// a statement you supply; otherwise the bank is asked for today's.
router.post('/recon/run', async (req, res) => {
  const run = await recon.run({
    bank: String(req.body?.bank || '').toUpperCase(),
    fileText: typeof req.body?.file === 'string' ? req.body.file : null,
    since: req.body?.since ?? null,
    trigger: 'MANUAL',
    actorId: req.user.id,
  });
  res.status(201).json(await recon.getRun(Number(run.id)));
});
router.get('/recon/runs', async (_req, res) => {
  res.json({ runs: await recon.listRuns() });
});
router.get('/recon/runs/:id', async (req, res) => {
  res.json(await recon.getRun(Number(req.params.id)));
});
// Open work by default (unresolved breaks + pending settlement). ?class=...&all=1
router.get('/recon/items', async (req, res) => {
  res.json({ items: await recon.listItems({ cls: req.query.class ? String(req.query.class).toUpperCase() : null, open: req.query.all !== '1' }) });
});
router.post('/recon/items/:id/resolve', async (req, res) => {
  res.json(await recon.resolveItem({ itemId: Number(req.params.id), note: req.body?.note, actorId: req.user.id }));
});
// The four reports: summary, exceptions, outstanding, audit. ?run=<id>, ?format=csv
router.get('/recon/reports/:name', async (req, res) => {
  const report = await reconReports.build(req.params.name, { runId: req.query.run === undefined ? null : Number(req.query.run) });
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`recon-${report.report}.csv`).send(reconReports.toCsv(report));
    return;
  }
  res.json(report);
});

router.use('/simulator', require('./simulator').router);

// Live dashboard numbers: success rate, p99 latency, authorization rate by
// bank. ?window=<minutes> (default 60) or ?since=<ISO time>.
router.get('/metrics', async (req, res) => {
  res.json(await require('../metrics/metrics').compute(req.query));
});

// Gateway health: circuit breaker state per bank (live dashboard).
router.get('/gateway', (_req, res) => {
  res.json({ banks: require('../gateway/gateway').breakerSnapshots() });
});

module.exports = { router };
