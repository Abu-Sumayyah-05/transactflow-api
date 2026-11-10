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
