// Phase 5 check, part 1: in 503 mode Bank A's breaker opens and card traffic
// moves to Bank B.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const gateway = require('../src/gateway/gateway');
const { app, request, registerAndLogin, addCard, fundWallet, balanceOf, makeAdmin } = require('./helpers');
const { startBank } = require('./bankHelper');

let bankA;
let bankB;
let user;
let card;

beforeAll(async () => {
  bankA = await startBank('A');
  bankB = await startBank('B');
});
afterAll(async () => {
  await bankA.stop();
  await bankB.stop();
  await pool.end();
});
beforeEach(async () => {
  bankA.reset();
  bankB.reset();
  user = await registerAndLogin('Failover Payer');
  card = await addCard(user);
});

const pay = (amount = 1000) =>
  request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ card_token: card.token, amount_kobo: amount });

describe('circuit breaker + Bank B fallback (Module 8)', () => {
  test('PHASE 5 CHECK: Bank A returns 503s, its breaker opens, and payments complete at Bank B', async () => {
    bankA.setMode({ mode: 'error503', errorRate: 1 });

    const first = await pay();
    expect(first.body).toMatchObject({ bank: 'A', status: 'UNKNOWN' }); // retried, still no answer
    const second = await pay();
    expect(second.body.bank).toBe('A');
    expect(gateway.breakerState('A')).toBe('OPEN');

    const callsToA = bankA.state.calls.charge;
    const third = await pay(2500);
    expect(third.body).toMatchObject({ bank: 'B', status: 'COMPLETED' });
    expect(bankB.state.calls.charge).toBe(1);
    expect(bankA.state.calls.charge).toBe(callsToA); // A wasn't even tried
    expect(await balanceOf(user.accountId)).toBe(2500);
  });

  test('while OPEN, calls to Bank A fail fast without touching the network', async () => {
    gateway.forceOpen('A');
    const started = Date.now();
    const result = await gateway.queryCharge('A', 'TF-ANY');
    expect(result).toMatchObject({ outcome: 'UNKNOWN', reason: 'circuit_open' });
    expect(Date.now() - started).toBeLessThan(50);
  });

  test('if both banks are down the customer is told so and nothing is created or charged', async () => {
    gateway.forceOpen('A');
    gateway.forceOpen('B');
    const res = await pay();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BANKS_UNAVAILABLE');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE account_id = $1', [user.accountId]);
    expect(rows[0].n).toBe(0);
  });

  test('a bank transfer cannot fail over (the account lives at Bank A): fails fast, money is not held', async () => {
    await fundWallet(user.accountId, 50000);
    gateway.forceOpen('A');
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ bank: 'A', account_number: '0123456789', amount_kobo: 10000 });
    expect(res.status).toBe(503);
    expect(await balanceOf(user.accountId)).toBe(50000);
  });

  test('declines (a healthy bank saying no) never trip the breaker', async () => {
    bankA.setMode({ outcome: 'DECLINED', declineCode: '51' });
    for (let i = 0; i < 6; i += 1) await pay();
    expect(gateway.breakerState('A')).toBe('CLOSED');
  });

  test('admins can see breaker state for each bank', async () => {
    gateway.forceOpen('A');
    const admin = await makeAdmin(await registerAndLogin('Ops'));
    const res = await request(app).get('/api/v1/admin/gateway').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.banks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'A', state: 'OPEN' }), expect.objectContaining({ name: 'B', state: 'CLOSED' })])
    );
  });
});
