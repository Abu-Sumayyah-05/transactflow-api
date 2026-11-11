// Module 10: GET /admin/metrics. Success rate, p99 latency and authorization
// rate sliced by bank, computed from the payments table (the source of
// truth), never from a cache.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const gateway = require('../src/gateway/gateway');
const { app, request, registerAndLogin, addCard, fundWallet, makeAdmin } = require('./helpers');
const { startBank } = require('./bankHelper');

let bankA;
let bankB;
let admin;
let user;
let card;
let since;

beforeAll(async () => {
  bankA = await startBank('A');
  bankB = await startBank('B');
  admin = await makeAdmin(await registerAndLogin('Dashboard'));
  user = await registerAndLogin('Metrics Payer');
  card = await addCard(user);
  await fundWallet(user.accountId, 1_000_000);
  // Tests share one database; only look at payments made from here on.
  since = (await pool.query('SELECT now() AS t')).rows[0].t.toISOString();
});
afterAll(async () => {
  await bankA.stop();
  await bankB.stop();
  await pool.end();
});

const pay = (amount = 1000) =>
  request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ card_token: card.token, amount_kobo: amount })
    .then((r) => r.body);

const transfer = (amount = 500) =>
  request(app)
    .post('/api/v1/transfers')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ bank: 'A', account_number: '0123456789', amount_kobo: amount })
    .then((r) => r.body);

const metrics = (query = `?since=${encodeURIComponent(since)}`, as = admin) =>
  request(app).get(`/api/v1/admin/metrics${query}`).set('Authorization', `Bearer ${as.token}`);

test('authorization rate by bank, success rate, volume and latency reflect exactly what happened', async () => {
  // Bank A: 3 approved, 1 declined, then 1 bank transfer.
  for (let i = 0; i < 3; i += 1) expect((await pay(2000)).status).toBe('COMPLETED');
  bankA.setMode({ outcome: 'DECLINED', declineCode: '51' });
  expect((await pay(2000)).status).toBe('FAILED');
  bankA.setMode({});
  expect((await transfer(500)).status).toBe('COMPLETED');
  // Bank A times out once: UNKNOWN is neither a success nor a failure yet.
  bankA.setMode({ mode: 'timeout' });
  expect((await pay(700)).status).toBe('UNKNOWN');
  bankA.setMode({});
  gateway.resetBreakers();
  // Bank A's breaker opens: 2 payments go to Bank B and are approved.
  gateway.forceOpen('A');
  for (let i = 0; i < 2; i += 1) expect((await pay(3000)).bank).toBe('B');

  const res = await metrics();
  expect(res.status).toBe(200);
  const m = res.body;

  const a = m.by_bank.find((b) => b.bank === 'A');
  const b = m.by_bank.find((x) => x.bank === 'B');
  expect(a.card).toMatchObject({ approved: 3, declined: 1, unknown: 1, authorization_rate: 0.75 });
  expect(b.card).toMatchObject({ approved: 2, declined: 0, unknown: 0, authorization_rate: 1 });
  expect(a.transfers).toMatchObject({ completed: 1, failed: 0, success_rate: 1 });
  expect(a.breaker).toBe('OPEN');
  expect(b.breaker).toBe('CLOSED');

  // 6 completed of 7 finished (the UNKNOWN one is not counted until it resolves).
  expect(m.payments).toMatchObject({ total: 8, completed: 6, failed: 1, unresolved: 1 });
  expect(m.success_rate).toBeCloseTo(6 / 7, 4);
  expect(m.volume).toEqual({ completed_count: 6, completed_kobo: 3 * 2000 + 500 + 2 * 3000, completed_display: '₦125.00' });

  // Latency: whole request, and our own share of it (the critical path).
  expect(m.latency_ms.samples).toBe(8);
  expect(m.latency_ms.p99).toBeGreaterThanOrEqual(m.latency_ms.p50);
  expect(m.latency_ms.p99).toBeGreaterThan(0);
  expect(a.latency_ms.p99).toBeGreaterThanOrEqual(300); // includes the timed-out call
  expect(m.critical_path).toMatchObject({ target_ms: 200 });
  expect(typeof m.critical_path.p99_ms).toBe('number');
  expect(m.critical_path.within_target).toBe(m.critical_path.p99_ms <= 200);
  expect(m.critical_path.steps).toHaveLength(4);

  expect(m.outbox.unpublished).toBeGreaterThan(0);
});

test('fraud decisions are counted separately from bank answers', async () => {
  expect((await metrics()).body.fraud).toEqual({ approved: 7, challenged: 0, blocked: 0 });
});

test('?window= limits how far back to look; bad input is refused; admin only', async () => {
  expect((await metrics('?window=15')).body.window.minutes).toBe(15);
  expect((await metrics('')).body.window.minutes).toBe(60);
  expect((await metrics('?window=abc')).status).toBe(400);
  expect((await metrics('?since=yesterday')).status).toBe(400);
  expect((await metrics(undefined, user)).status).toBe(403);
});
