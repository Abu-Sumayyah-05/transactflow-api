// Module 4: tokenization and encryption. No raw card number or CVV is ever
// stored, in the database or in logs.
const { pool } = require('../src/db/pool');
const { encrypt, decrypt } = require('../src/security/crypto');
const { luhnValid } = require('../src/cards/cards');
const { app, request, registerAndLogin, addCard, TEST_CARD } = require('./helpers');
const { startBank } = require('./bankHelper');
const { randomUUID } = require('crypto');

const PAN = '4111111111111111';
let bank;
let logSpies;
let logged = '';

beforeAll(async () => {
  bank = await startBank('A');
  logSpies = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
    jest.spyOn(console, m).mockImplementation((...args) => {
      logged += `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, Object.getOwnPropertyNames(a || {})))).join(' ')}\n`;
    })
  );
});
afterAll(async () => {
  logSpies.forEach((s) => s.mockRestore());
  await bank.stop();
  await pool.end();
});

describe('AES-256-GCM field encryption (Module 4)', () => {
  test('round-trips, uses a fresh IV each time, and detects tampering', () => {
    const a = encrypt('secret');
    const b = encrypt('secret');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('secret');
    const tampered = a.slice(0, -2) + (a.endsWith('A') ? 'B' : 'A') + a.slice(-1);
    expect(() => decrypt(tampered)).toThrow();
  });

  test('Luhn check', () => {
    expect(luhnValid(PAN)).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });
});

describe('POST /cards (Module 4)', () => {
  let user;
  beforeAll(async () => {
    user = await registerAndLogin('Card Owner');
  });
  const post = (body) => request(app).post('/api/v1/cards').set('Authorization', `Bearer ${user.token}`).send(body);

  test('returns a token and safe display fields only', async () => {
    const res = await post(TEST_CARD);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^tok_[A-Za-z0-9]{24,}$/);
    expect(res.body).toMatchObject({ brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030 });
    expect(JSON.stringify(res.body)).not.toContain(PAN);
    expect(JSON.stringify(res.body)).not.toMatch(/cvv/i);
  });

  test('the same card twice returns the same token', async () => {
    const a = await post(TEST_CARD);
    const b = await post(TEST_CARD);
    expect(b.body.token).toBe(a.body.token);
  });

  test.each([
    [{ ...TEST_CARD, number: '4111111111111112' }, 'bad Luhn'],
    [{ ...TEST_CARD, exp_year: 2020 }, 'expired'],
    [{ ...TEST_CARD, cvv: '12' }, 'short CVV'],
    [{ ...TEST_CARD, number: 'abcd' }, 'not digits'],
  ])('rejects %p (%s)', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(PAN);
  });

  test('SECURITY: after tokenizing and paying, no table holds the PAN or a CVV, and no log line does', async () => {
    const card = await addCard(user);
    await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ card_token: card.token, amount_kobo: 5000 });

    // Every column of every table, cast to text.
    const { rows: tables } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    for (const { table_name } of tables) {
      const { rows } = await pool.query(`SELECT t::text AS row FROM "${table_name}" t`);
      for (const { row } of rows) {
        expect(row).not.toContain(PAN);
      }
    }
    const { rows: cvvColumns } = await pool.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ILIKE '%cvv%'"
    );
    expect(cvvColumns).toEqual([]);

    expect(logged).not.toContain(PAN);
    expect(logged).not.toMatch(/"cvv"/i);
  });
});
