// Mock bank simulator. A real sandbox can't be told to fail on demand; this
// one can. The admin console (and the tests) flip its mode live:
//
//   normal    reply straight away
//   timeout   PROCESS the request, record the result, but never reply
//   slow      reply after delayMs (default 5-10 s)
//   error503  return 503 for errorRate (0..1) of calls, without processing
//
// `outcome` picks APPROVED or DECLINED (with declineCode) for new requests.
//
// Webhooks (only when the bank is given a webhookUrl):
//   webhook: 'normal'         one signed event per charge/transfer
//            'duplicate'      the same event webhookCopies (default 3) times
//            'bad_signature'  signed with the wrong secret
//            'off'            no webhooks
// Settlement-file modes are added in Phase 9.
const express = require('express');
const crypto = require('crypto');

const DEFAULT_MODE = Object.freeze({
  mode: 'normal',
  outcome: 'APPROVED',
  declineCode: '51',
  errorRate: 0,
  delayMs: [5000, 10000],
  holdMs: 60000,
  webhook: 'normal',
  webhookCopies: 3,
});

// Fake customer accounts for name enquiry and transfers.
const ACCOUNTS = {
  '0123456789': 'Ngozi Eze',
  '0000000001': 'Ibrahim Musa',
  '0987654321': 'Funke Adeyemi',
  '1122334455': 'Emeka Nwosu',
};

function createBank({ name, webhookUrl = null, webhookSecret = null }) {
  const state = {
    name,
    mode: { ...DEFAULT_MODE },
    charges: new Map(),
    transfers: new Map(),
    calls: { charge: 0, transfer: 0 },
  };

  function setMode(patch) {
    state.mode = { ...DEFAULT_MODE, ...patch };
    return state.mode;
  }
  function reset() {
    state.mode = { ...DEFAULT_MODE };
    state.charges.clear();
    state.transfers.clear();
    state.calls = { charge: 0, transfer: 0 };
  }

  const app = express();
  app.use(express.json());

  // Simulator control, protected by a shared token when one is configured.
  const sim = express.Router();
  sim.use((req, res, next) => {
    const token = process.env.SIM_TOKEN;
    if (token && req.get('x-sim-token') !== token) return res.status(401).json({ error: 'bad sim token' });
    next();
  });
  sim.get('/mode', (_req, res) => res.json(state.mode));
  sim.post('/mode', (req, res) => res.json(setMode(req.body || {})));
  sim.post('/reset', (_req, res) => {
    reset();
    res.json({ ok: true });
  });
  app.use('/_sim', sim);

  // 503 mode fails a share of calls before doing any work.
  app.use((req, res, next) => {
    if (state.mode.mode === 'error503' && Math.random() < state.mode.errorRate) {
      return res.status(503).json({ error: 'service unavailable' });
    }
    next();
  });

  // Sends the reply in the way the current mode dictates.
  function reply(res, body) {
    const { mode, delayMs, holdMs } = state.mode;
    if (mode === 'timeout') {
      // Already processed and recorded; just never answer.
      setTimeout(() => res.socket?.destroy(), holdMs).unref();
      return;
    }
    if (mode === 'slow') {
      const [min, max] = delayMs;
      setTimeout(() => res.json(body), min + Math.random() * (max - min)).unref();
      return;
    }
    res.json(body);
  }

  // Sends a signed webhook for a processed charge or transfer, a moment
  // after the reply (so in timeout mode the webhook is our only answer).
  function sendWebhook(type, record) {
    const { webhook, webhookCopies } = state.mode;
    if (!webhookUrl || webhook === 'off') return;
    const raw = JSON.stringify({
      event_id: `evt_${name}_${crypto.randomBytes(8).toString('hex')}`,
      type,
      created_at: new Date().toISOString(),
      data: {
        reference: record.reference,
        status: record.status,
        response_code: record.response_code,
        amount_kobo: record.amount_kobo,
        bank_reference: record.bank_reference,
      },
    });
    const secret = webhook === 'bad_signature' ? 'definitely-not-the-shared-secret' : webhookSecret || '';
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    const copies = webhook === 'duplicate' ? webhookCopies : 1;
    for (let i = 0; i < copies; i += 1) {
      setTimeout(() => {
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bank-name': name, 'x-bank-signature': signature },
          body: raw,
        }).catch(() => {});
      }, 50 + i * 30).unref();
    }
  }

  const bankRef = () => `${name}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  // Card charge (authorise + capture in one step).
  app.post('/charges', (req, res) => {
    const { reference, amount_kobo: amount, pan, exp_month: expMonth, exp_year: expYear } = req.body || {};
    if (!reference || !Number.isSafeInteger(amount) || !/^\d{12,19}$/.test(String(pan)) || !expMonth || !expYear) {
      return res.status(400).json({ error: 'bad request' });
    }
    // Banks dedupe on the merchant reference: a retry returns the first result.
    if (state.charges.has(reference)) return reply(res, state.charges.get(reference));

    state.calls.charge += 1;
    const approved = state.mode.outcome === 'APPROVED';
    const record = {
      reference,
      amount_kobo: amount,
      last4: String(pan).slice(-4), // the bank keeps the PAN to itself; we only echo last4
      status: approved ? 'APPROVED' : 'DECLINED',
      response_code: approved ? '00' : state.mode.declineCode,
      bank_reference: bankRef(),
      at: new Date().toISOString(),
    };
    state.charges.set(reference, record);
    reply(res, record);
    sendWebhook(approved ? 'charge.completed' : 'charge.failed', record);
  });

  // Transaction status query (TSQ) for a charge.
  app.get('/charges/:reference', (req, res) => {
    const record = state.charges.get(req.params.reference);
    if (!record) return res.status(404).json({ status: 'NOT_FOUND' });
    res.json(record);
  });

  app.get('/accounts/:number', (req, res) => {
    const accountName = ACCOUNTS[req.params.number];
    if (!accountName) return res.status(404).json({ error: 'account not found' });
    res.json({ account_number: req.params.number, account_name: accountName });
  });

  // Outbound transfer to one of this bank's customers.
  app.post('/transfers', (req, res) => {
    const { reference, account_number: accountNumber, amount_kobo: amount } = req.body || {};
    if (!reference || !Number.isSafeInteger(amount) || !accountNumber) {
      return res.status(400).json({ error: 'bad request' });
    }
    if (state.transfers.has(reference)) return reply(res, state.transfers.get(reference));

    state.calls.transfer += 1;
    let status = 'SUCCESSFUL';
    let code = '00';
    if (!ACCOUNTS[accountNumber]) {
      status = 'FAILED';
      code = '25'; // unable to locate record
    } else if (state.mode.outcome !== 'APPROVED') {
      status = 'FAILED';
      code = state.mode.declineCode;
    }
    const record = { reference, account_number: accountNumber, amount_kobo: amount, status, response_code: code, bank_reference: bankRef() };
    state.transfers.set(reference, record);
    reply(res, record);
    sendWebhook(status === 'SUCCESSFUL' ? 'transfer.completed' : 'transfer.failed', record);
  });

  app.get('/transfers/:reference', (req, res) => {
    const record = state.transfers.get(req.params.reference);
    if (!record) return res.status(404).json({ status: 'NOT_FOUND' });
    res.json(record);
  });

  return { app, state, setMode, reset };
}

module.exports = { createBank, ACCOUNTS };
