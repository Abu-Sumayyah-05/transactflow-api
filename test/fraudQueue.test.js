// Admin fraud queue (spec: "Flagged transactions with the score and the rules
// that fired, approve or block").
//   waiting for a challenge   approve -> sent to the bank now; block -> FAILED
//   already blocked/failed    approve -> false positive: velocity counters
//                             cleared so the customer can retry; block -> confirmed
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const config = require('../src/config');
const { app, request, registerAndLogin, addCard, balanceOf, makeAdmin } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
let admin;
beforeAll(async () => {
  bank = await startBank('A');
  admin = await makeAdmin(await registerAndLogin('Risk Analyst'));
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});
beforeEach(() => bank.reset());

const GB = { line1: '10 Downing St', city: 'London', country: 'GB' };

async function gmailUser() {
  const email = `q-${randomUUID().slice(0, 8)}@gmail.com`;
  const password = 'correct-horse-battery';
  const reg = await request(app).post('/api/v1/auth/register').send({ email, password, full_name: 'Queue Buyer' });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { email, password, token: login.body.token, accountId: reg.body.account.id, userId: reg.body.user.id };
}

const pay = (user, body) =>
  request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .then((r) => r);

// gmail (+10) + new device (+15) + GB billing on a US card (+20) = 45: challenge
async function challengedPayment() {
  const user = await gmailUser();
  const card = await addCard(user);
  const res = await pay(user, { card_token: card.token, amount_kobo: 9000, billing_address: GB });
  expect(res.body.status).toBe('PENDING');
  return { user, card, payment: res.body };
}

const queue = (query = '') =>
  request(app).get(`/api/v1/admin/fraud${query}`).set('Authorization', `Bearer ${admin.token}`).then((r) => r);

const decide = (decisionId, decision, { key = randomUUID(), as = admin } = {}) =>
  request(app)
    .post(`/api/v1/admin/fraud/${decisionId}/decision`)
    .set('Authorization', `Bearer ${as.token}`)
    .set('Idempotency-Key', key)
    .send({ decision, note: 'checked with customer' })
    .then((r) => r);

async function queueItemFor(paymentId) {
  const res = await queue();
  return res.body.items.find((i) => i.payment.id === paymentId);
}

describe('GET /admin/fraud', () => {
  test('lists open flags with the score, the rules that fired and the payment', async () => {
    const { user, payment } = await challengedPayment();
    const item = await queueItemFor(payment.id);
    expect(item).toMatchObject({
      score: 45,
      outcome: 'CHALLENGE',
      review_status: 'OPEN',
      customer_email: user.email,
      payment: { id: payment.id, status: 'PENDING', amount_kobo: 9000 },
    });
    expect(item.rules_fired.map((r) => r.rule).sort()).toEqual(['billing_mismatch', 'free_email', 'new_device']);
    expect(item.rules_fired.every((r) => typeof r.detail === 'string')).toBe(true);
  });

  test('approved payments are not in the queue', async () => {
    const user = await registerAndLogin();
    const card = await addCard(user);
    const res = await pay(user, { card_token: card.token, amount_kobo: 1000, billing_address: { line1: '1 Main St', city: 'Austin', country: 'US' } });
    expect(await queueItemFor(res.body.id)).toBeUndefined();
  });

  test('customers cannot see it', async () => {
    const user = await registerAndLogin();
    const res = await request(app).get('/api/v1/admin/fraud').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/fraud/:id/decision', () => {
  test('approve a payment waiting for its challenge: it is charged now and leaves the queue', async () => {
    const { user, payment } = await challengedPayment();
    const item = await queueItemFor(payment.id);
    const res = await decide(item.id, 'APPROVE');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: payment.id, status: 'COMPLETED', bank: 'A' });
    expect(bank.state.calls.charge).toBe(1);
    expect(await balanceOf(user.accountId)).toBe(9000);

    const { rows } = await pool.query('SELECT * FROM fraud_decisions WHERE id = $1', [item.id]);
    expect(rows[0]).toMatchObject({ review_status: 'APPROVED', reviewed_by: admin.userId, review_note: 'checked with customer' });
    expect(await queueItemFor(payment.id)).toBeUndefined();
  });

  test('block a payment waiting for its challenge: FAILED, never charged, the code no longer works', async () => {
    const { user, payment } = await challengedPayment();
    const item = await queueItemFor(payment.id);
    const res = await decide(item.id, 'BLOCK');
    expect(res.body).toMatchObject({ status: 'FAILED', decline_reason: 'BLOCKED_BY_RISK' });

    const late = await request(app)
      .post(`/api/v1/payments/${payment.id}/challenge`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ otp: payment.challenge.test_otp });
    expect(late.status).toBe(409);
    expect(bank.state.calls.charge).toBe(0);
  });

  test('a false positive on a velocity block clears the counters so the customer can pay again', async () => {
    const saved = config.velocityUserLimit;
    config.velocityUserLimit = 1;
    try {
      const user = await registerAndLogin();
      const card = await addCard(user);
      // A new address each time, so "known address" (-20) doesn't offset the
      // velocity points (80 + 15 new device - 20 would be 75: a challenge).
      let n = 0;
      const body = () => ({ card_token: card.token, amount_kobo: 500, billing_address: { line1: `${(n += 1)} Main St`, city: 'Austin', country: 'US' } });
      expect((await pay(user, body())).body.status).toBe('COMPLETED');
      const blocked = await pay(user, body());
      expect(blocked.body.decline_reason).toBe('BLOCKED_BY_RISK');

      const item = await queueItemFor(blocked.body.id);
      expect(item.outcome).toBe('BLOCK');
      const res = await decide(item.id, 'APPROVE');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FAILED'); // a failed payment stays failed...
      expect(bank.state.calls.charge).toBe(1);

      expect((await pay(user, body())).body.status).toBe('COMPLETED'); // ...but the retry goes through
    } finally {
      config.velocityUserLimit = saved;
    }
  });

  test('a decision can only be made once', async () => {
    const { payment } = await challengedPayment();
    const item = await queueItemFor(payment.id);
    await decide(item.id, 'BLOCK');
    const again = await decide(item.id, 'APPROVE');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVIEWED');
    expect(bank.state.calls.charge).toBe(0);
  });

  test('a double-clicked Approve charges once', async () => {
    const { payment } = await challengedPayment();
    const item = await queueItemFor(payment.id);
    const key = randomUUID();
    await Promise.all([decide(item.id, 'APPROVE', { key }), decide(item.id, 'APPROVE', { key })]);
    expect(bank.state.calls.charge).toBe(1);
  });

  test('bad input is refused', async () => {
    const { payment } = await challengedPayment();
    const item = await queueItemFor(payment.id);
    expect((await decide(item.id, 'MAYBE')).status).toBe(400);
    expect((await decide(999999999, 'APPROVE')).status).toBe(404);
  });
});
