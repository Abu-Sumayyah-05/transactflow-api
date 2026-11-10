// Module 7: bank webhooks. HMAC over the raw body with a constant-time
// compare, dedupe by event_id (200 on duplicates), and a dead-letter queue
// for events that keep failing.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const webhooks = require('../src/webhooks/processor');
const { app, request, registerAndLogin, addCard, balanceOf, makeAdmin, signWebhook } = require('./helpers');
const { startBank } = require('./bankHelper');

const SECRET = process.env.WEBHOOK_SECRET_A;
let bank;
let user;
let card;

beforeAll(async () => {
  bank = await startBank('A');
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});
beforeEach(async () => {
  bank.reset();
  user = await registerAndLogin('Hook Payer');
  card = await addCard(user);
});

// A payment the bank processed but never answered: UNKNOWN on our side.
async function unknownPayment(amount = 8000) {
  bank.setMode({ mode: 'timeout' });
  const res = await request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ card_token: card.token, amount_kobo: amount });
  bank.setMode({ mode: 'normal' });
  expect(res.body.status).toBe('UNKNOWN');
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [res.body.id]);
  return rows[0];
}

function event(payment, overrides = {}) {
  return {
    event_id: `evt_${randomUUID()}`,
    type: 'charge.completed',
    data: { reference: payment.reference, status: 'APPROVED', response_code: '00', amount_kobo: payment.amount_kobo },
    ...overrides,
  };
}

function deliver(body, { secret = SECRET, signature, bankName = 'A' } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return request(app)
    .post('/api/v1/webhooks/bank')
    .set('Content-Type', 'application/json')
    .set('X-Bank-Name', bankName)
    .set('X-Bank-Signature', signature ?? signWebhook(raw, secret))
    .send(raw);
}

async function eventRow(eventId) {
  const { rows } = await pool.query('SELECT * FROM webhook_events WHERE event_id = $1 ORDER BY id', [eventId]);
  return rows;
}

describe('POST /webhooks/bank (Module 7)', () => {
  test('a valid signature is accepted fast and the webhook settles the payment', async () => {
    const p = await unknownPayment();
    const evt = event(p);
    const res = await deliver(evt);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: false });

    await webhooks.processDue();
    const { rows } = await pool.query('SELECT status FROM payments WHERE id = $1', [p.id]);
    expect(rows[0].status).toBe('COMPLETED');
    expect(await balanceOf(user.accountId)).toBe(8000);
    expect((await eventRow(evt.event_id))[0]).toMatchObject({ signature_valid: true, status: 'PROCESSED' });
  });

  test('a bad signature gets 401, is logged as invalid, and changes nothing', async () => {
    const p = await unknownPayment();
    const evt = event(p);
    const res = await deliver(evt, { secret: 'not-the-real-secret' });
    expect(res.status).toBe(401);

    await webhooks.processDue();
    const { rows } = await pool.query('SELECT status FROM payments WHERE id = $1', [p.id]);
    expect(rows[0].status).toBe('UNKNOWN');
    expect(await eventRow(evt.event_id)).toEqual([expect.objectContaining({ signature_valid: false, status: 'REJECTED' })]);
  });

  test('a body changed after signing is rejected', async () => {
    const p = await unknownPayment();
    const evt = event(p);
    const signature = signWebhook(JSON.stringify(evt), SECRET);
    const tampered = JSON.stringify({ ...evt, data: { ...evt.data, amount_kobo: 99999999 } });
    expect((await deliver(tampered, { signature })).status).toBe(401);
  });

  test('a missing signature or an unknown bank is 401', async () => {
    const p = await unknownPayment();
    const raw = JSON.stringify(event(p));
    expect((await deliver(raw, { signature: '' })).status).toBe(401);
    expect((await deliver(raw, { bankName: 'Z' })).status).toBe(401);
  });

  test('PHASE 4 CHECK: a duplicate webhook is processed once (200 each time)', async () => {
    const p = await unknownPayment(12000);
    const evt = event(p);
    const replies = [];
    for (let i = 0; i < 3; i += 1) replies.push(await deliver(evt));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(replies.map((r) => r.body.duplicate)).toEqual([false, true, true]);

    await webhooks.processDue();
    await webhooks.processDue();
    const rows = await eventRow(evt.event_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].received_count).toBe(3);
    expect(await balanceOf(user.accountId)).toBe(12000);
  });

  test('forged events cannot block the real one (dedupe counts only valid signatures)', async () => {
    const p = await unknownPayment();
    const evt = event(p);
    expect((await deliver(evt, { secret: 'attacker' })).status).toBe(401);
    const real = await deliver(evt);
    expect(real.body.duplicate).toBe(false);
    await webhooks.processDue();
    expect(await balanceOf(user.accountId)).toBe(8000);
  });

  test('a decline webhook fails the payment', async () => {
    const p = await unknownPayment();
    await deliver(event(p, { type: 'charge.failed', data: { reference: p.reference, status: 'DECLINED', response_code: '51', amount_kobo: p.amount_kobo } }));
    await webhooks.processDue();
    const { rows } = await pool.query('SELECT status, response_code FROM payments WHERE id = $1', [p.id]);
    expect(rows[0]).toEqual({ status: 'FAILED', response_code: '51' });
  });

  test('a webhook whose amount disagrees with ours never settles the payment', async () => {
    const p = await unknownPayment(5000);
    const evt = event(p, { data: { reference: p.reference, status: 'APPROVED', response_code: '00', amount_kobo: 999 } });
    await deliver(evt);
    for (let i = 0; i < 6; i += 1) await webhooks.processDue();
    expect((await eventRow(evt.event_id))[0].status).toBe('DEAD');
    expect(await balanceOf(user.accountId)).toBe(0);
  });
});

describe('dead-letter queue (Module 7)', () => {
  test('an event that keeps failing moves to the DLQ after 5 attempts, and an admin can replay it', async () => {
    const admin = await makeAdmin(await registerAndLogin('Ops Admin'));
    const p = await unknownPayment(6000);
    const reference = p.reference;

    // The webhook names a reference we don't know yet, so processing fails.
    const ghostRef = `TF-GHOST-${randomUUID().slice(0, 8)}`;
    const evt = event(p, { data: { reference: ghostRef, status: 'APPROVED', response_code: '00', amount_kobo: 6000 } });
    await deliver(evt);

    for (let i = 0; i < 4; i += 1) await webhooks.processDue();
    expect((await eventRow(evt.event_id))[0]).toMatchObject({ status: 'RETRY', attempts: 4 });
    await webhooks.processDue();
    const dead = (await eventRow(evt.event_id))[0];
    expect(dead).toMatchObject({ status: 'DEAD', attempts: 5 });
    expect(dead.last_error).toMatch(/no payment/i);

    const list = await request(app).get('/api/v1/admin/dlq').set('Authorization', `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.events.map((e) => e.event_id)).toContain(evt.event_id);

    // Ops fixes the cause (here: the reference mix-up), then replays.
    await pool.query('UPDATE payments SET reference = $2 WHERE reference = $1', [reference, ghostRef]);
    const replay = await request(app)
      .post(`/api/v1/admin/dlq/${dead.id}/replay`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('PROCESSED');
    expect(await balanceOf(user.accountId)).toBe(6000);
  });

  test('admin routes are admin only', async () => {
    const res = await request(app).get('/api/v1/admin/dlq').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

  test('the webhook log shows each event with signature validity, duplicates and attempts', async () => {
    const admin = await makeAdmin(await registerAndLogin('Log Reader'));
    const res = await request(app).get('/api/v1/admin/webhooks').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toEqual(
      expect.objectContaining({ event_id: expect.any(String), signature_valid: expect.any(Boolean), received_count: expect.any(Number), attempts: expect.any(Number) })
    );
  });
});

describe('the mock bank sends real webhooks (end to end)', () => {
  let server;
  let liveBank;

  beforeAll(async () => {
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    liveBank = await startBank('B', {
      webhookUrl: `http://127.0.0.1:${server.address().port}/api/v1/webhooks/bank`,
      webhookSecret: process.env.WEBHOOK_SECRET_B,
    });
  });
  afterAll(async () => {
    await liveBank.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting');
  }

  test('duplicate-webhook mode: the bank sends one event 3 times, we process it once', async () => {
    liveBank.setMode({ webhook: 'duplicate', webhookCopies: 3 });
    const reference = `TF-E2E-${randomUUID().slice(0, 8)}`;
    // Ask Bank B for a transfer directly, as our gateway would.
    await fetch(`${process.env.BANK_B_URL}/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference, account_number: '0123456789', amount_kobo: 100 }),
    });
    const row = await waitFor(async () => {
      const { rows } = await pool.query("SELECT * FROM webhook_events WHERE payload->'data'->>'reference' = $1", [reference]);
      return rows[0]?.received_count === 3 && rows;
    });
    expect(row).toHaveLength(1);
    expect(row[0].signature_valid).toBe(true);
  });

  test('bad-signature mode: the bank signs wrongly and we reject and log it', async () => {
    liveBank.setMode({ webhook: 'bad_signature' });
    const reference = `TF-E2E-${randomUUID().slice(0, 8)}`;
    await fetch(`${process.env.BANK_B_URL}/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference, account_number: '0123456789', amount_kobo: 100 }),
    });
    const rows = await waitFor(async () => {
      const r = await pool.query("SELECT * FROM webhook_events WHERE source = 'B' AND signature_valid = false AND raw_body LIKE $1", [`%${reference}%`]);
      return r.rows.length > 0 && r.rows;
    });
    expect(rows[0].status).toBe('REJECTED');
  });
});
