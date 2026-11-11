// Modules 5 + 9: POST /payments runs the fraud check first, then the gateway.
//   APPROVE    -> straight to the bank, as before
//   CHALLENGE  -> PENDING, waiting for the 3DS-style code; the bank is NOT called
//   BLOCK      -> FAILED at once, never sent to a bank, flagged for review
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const config = require('../src/config');
const tsq = require('../src/payments/tsq');
const { luhnValid } = require('../src/cards/cards');
const { app, request, addCard, balanceOf } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
beforeAll(async () => {
  bank = await startBank('A');
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});
beforeEach(() => bank.reset());

// A user whose email domain we choose (free email providers score +10).
async function signUp(domain = 'company.ng') {
  const email = `buyer-${randomUUID().slice(0, 8)}@${domain}`;
  const password = 'correct-horse-battery';
  const reg = await request(app).post('/api/v1/auth/register').send({ email, password, full_name: 'Buyer' });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { email, token: login.body.token, accountId: reg.body.account.id, userId: reg.body.user.id };
}

// Makes a Luhn-valid card number from a prefix, so each test can use its own
// card (velocity counts per card, across the whole test run).
function cardNumber(prefix) {
  let body = prefix;
  while (body.length < 15) body += String(Math.floor(Math.random() * 10));
  for (let d = 0; d <= 9; d += 1) if (luhnValid(body + d)) return body + d;
  throw new Error('unreachable');
}
const card = (user, prefix = '4111') =>
  addCard(user, { number: cardNumber(prefix), exp_month: 12, exp_year: 2030, cvv: '123' });

const US_ADDRESS = { line1: '1 Market St', city: 'San Francisco', country: 'US' };
const GB_ADDRESS = { line1: '10 Downing St', city: 'London', country: 'GB' };

function pay(user, body, { key = randomUUID(), device = null } = {}) {
  const req = request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', key);
  if (device) req.set('X-Device-Id', device);
  return req.send(body).then((r) => r);
}

const challenge = (user, paymentId, otp, key = randomUUID()) =>
  request(app)
    .post(`/api/v1/payments/${paymentId}/challenge`)
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', key)
    .send({ otp })
    .then((r) => r);

async function decisionFor(paymentId) {
  const { rows } = await pool.query('SELECT * FROM fraud_decisions WHERE payment_id = $1', [paymentId]);
  return rows[0];
}

async function events(paymentId) {
  const { rows } = await pool.query('SELECT to_status FROM payment_events WHERE payment_id = $1 ORDER BY id', [paymentId]);
  return rows.map((r) => r.to_status);
}

describe('approve band: low-risk payments go straight to the bank', () => {
  test('billing matches the card, company email, new device = 15 -> COMPLETED, decision kept', async () => {
    const user = await signUp();
    const c = await card(user);
    const res = await pay(user, { card_token: c.token, amount_kobo: 5000, billing_address: US_ADDRESS }, { device: 'device-aaaa-1111' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('COMPLETED');

    const d = await decisionFor(res.body.id);
    expect(d).toMatchObject({ score: 15, outcome: 'APPROVE', review_status: 'NOT_NEEDED' });
    expect(d.rules_fired.map((r) => r.rule)).toEqual(['new_device']);
  });

  test('a returning customer (old account, same device, known address) scores below zero', async () => {
    const user = await signUp('gmail.com');
    await pool.query("UPDATE users SET created_at = now() - interval '2 years' WHERE id = $1", [user.userId]);
    const c = await card(user);
    const body = { card_token: c.token, amount_kobo: 2000, billing_address: US_ADDRESS };
    const first = await pay(user, body, { device: 'device-bbbb-2222' });
    expect(first.body.status).toBe('COMPLETED');

    // Same address, typed differently: normalised before hashing.
    const second = await pay(
      user,
      { ...body, billing_address: { line1: '  1 market st ', city: 'SAN FRANCISCO', country: 'us' } },
      { device: 'device-bbbb-2222' }
    );
    expect(second.body.status).toBe('COMPLETED');
    const d = await decisionFor(second.body.id);
    expect(d.rules_fired.map((r) => r.rule).sort()).toEqual(['account_over_1_year', 'free_email', 'known_address']);
    expect(d.score).toBe(-40);
  });

  test('the raw billing address is never stored, only a keyed hash and the country', async () => {
    const user = await signUp();
    const c = await card(user);
    const res = await pay(user, { card_token: c.token, amount_kobo: 1000, billing_address: US_ADDRESS });
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [res.body.id]);
    expect(rows[0].billing_country).toBe('US');
    expect(rows[0].billing_address_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toMatch(/Market/i);
  });

  test('a malformed billing address is refused before anything happens', async () => {
    const user = await signUp();
    const c = await card(user);
    const res = await pay(user, { card_token: c.token, amount_kobo: 1000, billing_address: { line1: 'x', country: 'Nigeria' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BILLING_ADDRESS');
    expect(bank.state.calls.charge).toBe(0);
  });
});

describe('challenge band: the 3DS-style step', () => {
  // free email (+10) + new device (+15) + GB billing on a US card (+20) = 45
  async function challenged() {
    const user = await signUp('yahoo.com');
    const c = await card(user);
    const res = await pay(user, { card_token: c.token, amount_kobo: 7500, billing_address: GB_ADDRESS });
    return { user, res };
  }

  test('a 45 score parks the payment in PENDING with a challenge; the bank is not called yet', async () => {
    const { res } = await challenged();
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING', bank: null });
    expect(res.body.challenge).toMatchObject({ required: true, attempts_left: 3 });
    expect(res.body.challenge.test_otp).toMatch(/^\d{6}$/);
    expect(res.body.message).toMatch(/verification code/i);
    expect(bank.state.calls.charge).toBe(0);

    const d = await decisionFor(res.body.id);
    expect(d).toMatchObject({ score: 45, outcome: 'CHALLENGE', review_status: 'OPEN' });
  });

  test('the right code sends it to the bank: COMPLETED, wallet credited, cleared from the queue', async () => {
    const { user, res } = await challenged();
    const done = await challenge(user, res.body.id, res.body.challenge.test_otp);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ status: 'COMPLETED', bank: 'A' });
    expect(done.body.challenge).toBeUndefined();
    expect(bank.state.calls.charge).toBe(1);
    expect(await balanceOf(user.accountId)).toBe(7500);
    expect(await events(res.body.id)).toEqual(['INITIALIZED', 'PENDING', 'AUTHORIZED', 'COMPLETED']);
    expect((await decisionFor(res.body.id)).review_status).toBe('CLEARED_BY_CHALLENGE');
  });

  test('a wrong code says how many tries are left; three wrong codes cancel the payment', async () => {
    const { user, res } = await challenged();
    const wrong = res.body.challenge.test_otp === '000000' ? '111111' : '000000';

    const first = await challenge(user, res.body.id, wrong);
    expect(first.status).toBe(422);
    expect(first.body.error).toMatchObject({ code: 'INVALID_OTP', attempts_left: 2 });
    await challenge(user, res.body.id, wrong);
    const third = await challenge(user, res.body.id, wrong);
    expect(third.body).toMatchObject({ status: 'FAILED', decline_reason: 'CHALLENGE_FAILED' });
    expect(third.body.message).toMatch(/not been charged/i);

    // Even the right code is now too late.
    const late = await challenge(user, res.body.id, res.body.challenge.test_otp);
    expect(late.status).toBe(409);
    expect(bank.state.calls.charge).toBe(0);
    expect(await balanceOf(user.accountId)).toBe(0);
    expect((await decisionFor(res.body.id)).review_status).toBe('OPEN'); // still suspicious
  });

  test('a challenge left too long expires: the background job fails it, nothing is charged', async () => {
    const { user, res } = await challenged();
    await pool.query("UPDATE payments SET challenge_expires_at = now() - interval '1 second' WHERE id = $1", [res.body.id]);
    await tsq.runOnce();
    const { body } = await request(app).get(`/api/v1/payments/${res.body.id}`).set('Authorization', `Bearer ${user.token}`);
    expect(body).toMatchObject({ status: 'FAILED', decline_reason: 'CHALLENGE_EXPIRED' });
    expect(bank.state.calls.charge).toBe(0);
  });

  test('a payment waiting for its challenge is not mistaken for a crashed request', async () => {
    const { res } = await challenged();
    await pool.query("UPDATE payments SET updated_at = now() - interval '1 hour' WHERE id = $1", [res.body.id]);
    await tsq.runOnce();
    const { rows } = await pool.query('SELECT status FROM payments WHERE id = $1', [res.body.id]);
    expect(rows[0].status).toBe('PENDING');
  });

  test('the challenge is only valid from PENDING, and only for a payment that asked for one', async () => {
    const user = await signUp();
    const c = await card(user);
    const approved = await pay(user, { card_token: c.token, amount_kobo: 1000, billing_address: US_ADDRESS });
    const res = await challenge(user, approved.body.id, '123456');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_NOT_ALLOWED');
  });

  test('a double-tapped Verify charges once', async () => {
    const { user, res } = await challenged();
    const key = randomUUID();
    const [a, b] = await Promise.all([
      challenge(user, res.body.id, res.body.challenge.test_otp, key),
      challenge(user, res.body.id, res.body.challenge.test_otp, key),
    ]);
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([201]));
    expect(bank.state.calls.charge).toBe(1);
    expect(await balanceOf(user.accountId)).toBe(7500);
  });

  test("someone else's payment is not found", async () => {
    const { res } = await challenged();
    const stranger = await signUp();
    const r = await challenge(stranger, res.body.id, res.body.challenge.test_otp);
    expect(r.status).toBe(404);
  });
});

describe('block band and velocity (card testing)', () => {
  const saved = {};
  beforeAll(() => {
    for (const k of ['velocityUserLimit', 'velocityCardLimit']) saved[k] = config[k];
    config.velocityUserLimit = 5;
    config.velocityCardLimit = 3;
  });
  afterAll(() => Object.assign(config, saved));

  test('PHASE 6 CHECK: a card-testing burst is blocked', async () => {
    // One account fires 8 payments at once, each on a different card.
    const tester = await signUp();
    const cards = [];
    for (let i = 0; i < 8; i += 1) cards.push(await card(tester));
    const results = await Promise.all(
      cards.map((c) => pay(tester, { card_token: c.token, amount_kobo: 100, billing_address: US_ADDRESS }, { device: 'device-cccc-3333' }))
    );

    // Every response, so a failure shows exactly what came back.
    const summary = results.map((r) => `${r.status} ${r.body.status ?? r.body.error?.code} ${r.body.decline_reason ?? ''}`.trim());
    expect(summary.sort()).toEqual([
      ...Array(5).fill('201 COMPLETED'),
      ...Array(3).fill('201 FAILED BLOCKED_BY_RISK'),
    ]);
    const completed = results.filter((r) => r.body.status === 'COMPLETED');
    const blocked = results.filter((r) => r.body.decline_reason === 'BLOCKED_BY_RISK');
    expect(completed).toHaveLength(5); // the limit, exactly: INCR is atomic
    expect(blocked).toHaveLength(3);
    expect(bank.state.calls.charge).toBe(5); // blocked attempts never reached a bank
    for (const r of blocked) {
      expect(r.body).toMatchObject({ status: 'FAILED', bank: null });
      expect(r.body.message).toMatch(/not been charged/i);
      const d = await decisionFor(r.body.id);
      expect(d.outcome).toBe('BLOCK');
      expect(d.score).toBeGreaterThanOrEqual(80);
      expect(d.review_status).toBe('OPEN');
      expect(d.rules_fired.map((x) => x.rule)).toContain('velocity');
    }
    expect(await events(blocked[0].body.id)).toEqual(['INITIALIZED', 'FAILED']);
  });

  test('one card tried from many accounts is caught by the per-card counter', async () => {
    const shared = cardNumber('4111');
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const u = await signUp();
      const c = await addCard(u, { number: shared, exp_month: 12, exp_year: 2030, cvv: '123' });
      results.push(await pay(u, { card_token: c.token, amount_kobo: 100, billing_address: US_ADDRESS }));
    }
    expect(results.map((r) => r.body.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'FAILED']);
    const d = await decisionFor(results[3].body.id);
    expect(d.rules_fired.find((r) => r.rule === 'velocity').detail).toMatch(/card/);
  });
});
