// Phase 2 check: a wallet-to-wallet transfer writes balanced ledger entries.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const { app, request, registerAndLogin, fundWallet } = require('./helpers');

afterAll(() => pool.end());

// A fresh Idempotency-Key per request; GET routes simply ignore it.
const auth = (u) => ({ Authorization: `Bearer ${u.token}`, 'Idempotency-Key': randomUUID() });

async function balance(u) {
  const res = await request(app).get('/api/v1/accounts/me').set(auth(u));
  return res.body.account.balance_kobo;
}

describe('wallet-to-wallet transfer', () => {
  let sender;
  let recipient;

  beforeAll(async () => {
    sender = await registerAndLogin('Chidi Okafor');
    recipient = await registerAndLogin('Amaka Bello');
    await fundWallet(sender.accountId, 1000000); // ₦10,000.00
  });

  test('name enquiry shows the recipient account name before sending', async () => {
    const res = await request(app)
      .get('/api/v1/transfers/name-enquiry')
      .query({ email: recipient.email })
      .set(auth(sender));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account_name: 'Amaka Bello', email: recipient.email });
  });

  test('name enquiry for an unknown email is 404', async () => {
    const res = await request(app)
      .get('/api/v1/transfers/name-enquiry')
      .query({ email: 'nobody@example.com' })
      .set(auth(sender));
    expect(res.status).toBe(404);
  });

  test('a transfer moves money and writes exactly one balanced debit/credit pair', async () => {
    const res = await request(app)
      .post('/api/v1/transfers')
      .set(auth(sender))
      .send({ recipient_email: recipient.email, amount_kobo: 250000 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount_kobo: 250000, status: 'COMPLETED' });

    const { rows } = await pool.query(
      'SELECT account_id, direction, amount_kobo FROM ledger_entries WHERE transaction_id = $1',
      [res.body.transaction_id]
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { account_id: sender.accountId, direction: 'DEBIT', amount_kobo: 250000 },
        { account_id: recipient.accountId, direction: 'CREDIT', amount_kobo: 250000 },
      ])
    );

    expect(await balance(sender)).toBe(750000);
    expect(await balance(recipient)).toBe(250000);
  });

  test('insufficient funds is refused with a clear reason and moves nothing', async () => {
    const res = await request(app)
      .post('/api/v1/transfers')
      .set(auth(sender))
      .send({ recipient_email: recipient.email, amount_kobo: 999999999 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.error.message).toMatch(/insufficient/i);
    expect(await balance(sender)).toBe(750000);
    expect(await balance(recipient)).toBe(250000);
  });

  test.each([
    [{ amount_kobo: 100.5 }, 'float amount'],
    [{ amount_kobo: '100' }, 'string amount'],
    [{ amount_kobo: 0 }, 'zero amount'],
    [{ amount_kobo: -100 }, 'negative amount'],
  ])('rejects %p (%s) with 400', async (body) => {
    const res = await request(app)
      .post('/api/v1/transfers')
      .set(auth(sender))
      .send({ recipient_email: recipient.email, ...body });
    expect(res.status).toBe(400);
  });

  test('cannot transfer to yourself', async () => {
    const res = await request(app)
      .post('/api/v1/transfers')
      .set(auth(sender))
      .send({ recipient_email: sender.email, amount_kobo: 100 });
    expect(res.status).toBe(400);
  });

  test('requires login', async () => {
    const res = await request(app).post('/api/v1/transfers').send({ recipient_email: recipient.email, amount_kobo: 100 });
    expect(res.status).toBe(401);
  });

  test('the transfer shows in both wallets\' recent activity', async () => {
    const me = await request(app).get('/api/v1/accounts/me').set(auth(recipient));
    expect(me.body.recent[0]).toMatchObject({ direction: 'CREDIT', amount_kobo: 250000 });
  });
});
