// Module 7: Idempotency-Key. Same key + same body moves money once,
// same key + different body is a 409.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const { app, request, registerAndLogin, fundWallet } = require('./helpers');

afterAll(() => pool.end());

describe('Idempotency-Key on POST /transfers (Module 7)', () => {
  let sender;
  let recipient;

  const send = (key, body, user = sender) => {
    const req = request(app).post('/api/v1/transfers').set('Authorization', `Bearer ${user.token}`);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  async function balance(u) {
    const { rows } = await pool.query('SELECT balance_kobo FROM accounts WHERE id = $1', [u.accountId]);
    return rows[0].balance_kobo;
  }

  beforeEach(async () => {
    sender = await registerAndLogin('Sender');
    recipient = await registerAndLogin('Recipient');
    await fundWallet(sender.accountId, 100000);
  });

  test('a money-moving POST without the header is refused and moves nothing', async () => {
    const res = await send(null, { recipient_email: recipient.email, amount_kobo: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await balance(sender)).toBe(100000);
  });

  test('the same key and body twice (a double-tap) charges once and replays the first response', async () => {
    const key = randomUUID();
    const body = { recipient_email: recipient.email, amount_kobo: 3000 };
    const first = await send(key, body);
    const second = await send(key, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await balance(sender)).toBe(97000);
    expect(await balance(recipient)).toBe(3000);
  });

  test('the same key with a different body is 409 and moves nothing more', async () => {
    const key = randomUUID();
    await send(key, { recipient_email: recipient.email, amount_kobo: 3000 });
    const res = await send(key, { recipient_email: recipient.email, amount_kobo: 9000 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balance(sender)).toBe(97000);
  });

  test('two simultaneous requests with one key move money once', async () => {
    const key = randomUUID();
    const body = { recipient_email: recipient.email, amount_kobo: 5000 };
    const results = await Promise.all([send(key, body), send(key, body), send(key, body)]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const s of statuses) expect([201, 409]).toContain(s);
    expect(await balance(sender)).toBe(95000);
    expect(await balance(recipient)).toBe(5000);
  });

  test('a request that fails (insufficient funds) does not use up the key', async () => {
    const key = randomUUID();
    const body = { recipient_email: recipient.email, amount_kobo: 150000 };
    expect((await send(key, body)).status).toBe(422);

    await fundWallet(sender.accountId, 100000);
    const retry = await send(key, body);
    expect(retry.status).toBe(201);
    expect(await balance(sender)).toBe(50000);
  });

  test('keys are per user: two users can use the same key independently', async () => {
    const other = await registerAndLogin('Other');
    await fundWallet(other.accountId, 10000);
    const key = randomUUID();
    const a = await send(key, { recipient_email: recipient.email, amount_kobo: 1000 });
    const b = await send(key, { recipient_email: recipient.email, amount_kobo: 2000 }, other);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await balance(recipient)).toBe(3000);
  });
});

// Phase 4: the Redis lock, payments, and crash recovery.
describe('Redis SETNX lock and POST /payments (Module 7)', () => {
  const Redis = require('ioredis');
  const tsq = require('../src/payments/tsq');
  const { addCard } = require('./helpers');
  const { startBank } = require('./bankHelper');

  let bank;
  let redis;
  let user;
  let card;

  beforeAll(async () => {
    bank = await startBank('A');
    redis = new Redis(process.env.TEST_REDIS_URL);
  });
  afterAll(async () => {
    redis.disconnect();
    await bank.stop();
  });
  beforeEach(async () => {
    bank.reset();
    user = await registerAndLogin('Card Payer');
    card = await addCard(user);
  });

  const pay = (key, amount = 5000) =>
    request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ card_token: card.token, amount_kobo: amount });

  test('the key is locked in Redis with SET NX and a 24 hour TTL', async () => {
    const key = randomUUID();
    await pay(key);
    const lockKey = `idem:${user.userId}:POST /payments:${key}`;
    const ttl = await redis.ttl(lockKey);
    expect(ttl).toBeGreaterThan(24 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(24 * 3600);
  });

  test('PHASE 4 CHECK: the same key twice charges the card once', async () => {
    const key = randomUUID();
    const a = await pay(key);
    const b = await pay(key);
    expect(b.body.id).toBe(a.body.id);
    expect(bank.state.calls.charge).toBe(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE account_id = $1', [user.accountId]);
    expect(rows[0].n).toBe(1);
  });

  test('PHASE 4 CHECK: the same key with a different body is 409', async () => {
    const key = randomUUID();
    await pay(key, 5000);
    const res = await pay(key, 6000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(bank.state.calls.charge).toBe(1);
  });

  test('a double-tap while the bank is still working returns the live payment, not an error', async () => {
    bank.setMode({ mode: 'slow', delayMs: [250, 250] });
    const key = randomUUID();
    // .then() starts the request now; supertest otherwise waits to be awaited.
    const first = pay(key).then((r) => r);

    // Wait until the first request has committed its PENDING payment.
    for (let i = 0; i < 50; i += 1) {
      const { rows } = await pool.query('SELECT 1 FROM payments WHERE account_id = $1', [user.accountId]);
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = await pay(key);
    expect(second.status).toBe(202);
    expect(second.body.status).toBe('PENDING');
    expect(second.headers['idempotent-replayed']).toBe('true');

    const done = await first;
    expect(done.body.status).toBe('COMPLETED');
    expect(second.body.id).toBe(done.body.id);
    expect(bank.state.calls.charge).toBe(1);
  });

  test('a replay shows the payment as it is now: UNKNOWN at first, COMPLETED after TSQ', async () => {
    bank.setMode({ mode: 'timeout' });
    const key = randomUUID();
    const first = await pay(key);
    expect(first.body.status).toBe('UNKNOWN');

    bank.setMode({ mode: 'normal' });
    await tsq.runOnce();
    const replay = await pay(key);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ id: first.body.id, status: 'COMPLETED' });
    expect(bank.state.calls.charge).toBe(1);
  });

  test('after a crash mid-request (key left IN_PROGRESS), a retry gets the payment instead of being stuck', async () => {
    const key = randomUUID();
    const first = await pay(key);
    // Simulate the process dying before the response was saved.
    await pool.query(
      "UPDATE idempotency_keys SET status = 'IN_PROGRESS', response = NULL, response_code = NULL WHERE key = $1",
      [key]
    );
    const retry = await pay(key);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ id: first.body.id, status: 'COMPLETED' });
    expect(bank.state.calls.charge).toBe(1);
  });
});
