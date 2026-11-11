// Admin simulator controls: the API's side of the "Simulator controls"
// screen. The browser never talks to a mock bank directly; it asks the API,
// which checks the caller is an admin and forwards to the bank's /_sim
// endpoints with the shared SIM_TOKEN.
const express = require('express');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');

const router = express.Router();
const BANKS = ['A', 'B'];

async function sim(bank, method, path, body) {
  const base = process.env[`BANK_${bank}_URL`];
  if (!base) return { reachable: false };
  try {
    const res = await fetch(`${base}/_sim${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-token': process.env.SIM_TOKEN || '' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    return { reachable: true, status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { reachable: false };
  }
}

// Only these settings are forwarded, each checked.
const MODES = new Set(['normal', 'timeout', 'slow', 'error503']);
const OUTCOMES = new Set(['APPROVED', 'DECLINED', 'DECLINE_CYCLE']);
const WEBHOOKS = new Set(['normal', 'duplicate', 'bad_signature', 'off']);
const SETTLEMENT_FLAGS = ['badLine', 'wrongClosing', 'extra'];
const SETTLEMENT_PICKS = ['missing', 'wrongAmount', 'duplicate']; // true or a reference

function cleanMode(body) {
  const bad = (what) => new AppError(400, 'INVALID_MODE', `Invalid simulator setting: ${what}`);
  const out = {};
  if (body.mode !== undefined) {
    if (!MODES.has(body.mode)) throw bad('mode');
    out.mode = body.mode;
  }
  if (body.outcome !== undefined) {
    if (!OUTCOMES.has(body.outcome)) throw bad('outcome');
    out.outcome = body.outcome;
  }
  if (body.declineCode !== undefined) {
    if (!/^[A-Z0-9]{2}$/.test(String(body.declineCode))) throw bad('declineCode');
    out.declineCode = String(body.declineCode);
  }
  if (body.errorRate !== undefined) {
    const rate = Number(body.errorRate);
    if (!(rate >= 0 && rate <= 1)) throw bad('errorRate');
    out.errorRate = rate;
  }
  if (body.webhook !== undefined) {
    if (!WEBHOOKS.has(body.webhook)) throw bad('webhook');
    out.webhook = body.webhook;
  }
  if (body.webhookCopies !== undefined) {
    const n = Number(body.webhookCopies);
    if (!(Number.isInteger(n) && n >= 2 && n <= 3)) throw bad('webhookCopies');
    out.webhookCopies = n;
  }
  if (body.settlement !== undefined) {
    const s = body.settlement || {};
    const settlement = {};
    for (const k of SETTLEMENT_FLAGS) if (s[k] === true) settlement[k] = true;
    for (const k of SETTLEMENT_PICKS) {
      if (s[k] === true || (typeof s[k] === 'string' && /^[A-Za-z0-9_\-/.]{1,64}$/.test(s[k]))) settlement[k] = s[k];
    }
    if (s.cutoff !== undefined) {
      if (Number.isNaN(new Date(s.cutoff).getTime())) throw bad('settlement.cutoff');
      settlement.cutoff = new Date(s.cutoff).toISOString();
    }
    out.settlement = settlement;
  }
  return out;
}

function bankOf(body) {
  const bank = String(body?.bank || '').toUpperCase();
  if (!BANKS.includes(bank)) throw new AppError(400, 'INVALID_BANK', 'bank must be A or B');
  return bank;
}

// GET /admin/simulator — the current mode of each bank.
router.get('/', async (_req, res) => {
  const banks = await Promise.all(
    BANKS.map(async (bank) => {
      const r = await sim(bank, 'GET', '/mode');
      return { bank, reachable: r.reachable && r.status === 200, mode: r.reachable && r.status === 200 ? r.json : null };
    })
  );
  res.json({ banks });
});

// POST /admin/simulator/mode { bank, ...settings } — settings left out go
// back to normal, so one click always gives a known state.
router.post('/mode', async (req, res) => {
  const bank = bankOf(req.body);
  const r = await sim(bank, 'POST', '/mode', cleanMode(req.body || {}));
  if (!r.reachable || r.status !== 200) throw new AppError(502, 'SIMULATOR_UNREACHABLE', `Mock Bank ${bank} is not running`);
  res.json({ bank, mode: r.json });
});

// POST /admin/simulator/dispute { reference, amount_kobo? } — the bank that
// took the charge raises a chargeback (it arrives as a signed webhook).
router.post('/dispute', async (req, res) => {
  const reference = String(req.body?.reference || '');
  const { rows } = await pool.query("SELECT bank FROM payments WHERE reference = $1 AND type = 'CARD_TOPUP' AND bank IS NOT NULL", [reference]);
  if (!rows[0]) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'No card payment with that reference');
  const body = { reference };
  if (Number.isSafeInteger(req.body?.amount_kobo)) body.amount_kobo = req.body.amount_kobo;
  const r = await sim(rows[0].bank, 'POST', '/disputes', body);
  if (!r.reachable) throw new AppError(502, 'SIMULATOR_UNREACHABLE', `Mock Bank ${rows[0].bank} is not running`);
  if (r.status !== 202) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'The bank has no approved charge with that reference');
  res.status(202).json(r.json);
});

module.exports = { router };
