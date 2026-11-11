// Module 1: every issuer response code becomes a clear customer message.
// Never a bare "declined".
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const { classifyDecline, CARD_DECLINES } = require('../src/payments/declines');
const { app, request, registerAndLogin, addCard } = require('./helpers');
const { startBank } = require('./bankHelper');

describe('decline classifier (unit)', () => {
  test.each([
    ['51', 'INSUFFICIENT_FUNDS', /insufficient funds|not enough money/i],
    ['57', 'INTERNATIONAL_DISABLED', /international|online/i],
    ['61', 'FX_LIMIT', /limit/i],
    ['59', 'SUSPECTED_FRAUD', /security|fraud/i],
    ['54', 'CARD_EXPIRED', /expired/i],
    ['82', 'INVALID_CVV', /CVV/],
  ])('code %s -> %s', (code, category, wording) => {
    const d = classifyDecline(code);
    expect(d.category).toBe(category);
    expect(d.message).toMatch(wording);
  });

  test('every mapped code has a full sentence and a next step, never a bare "declined"', () => {
    for (const code of Object.keys(CARD_DECLINES)) {
      const { message } = classifyDecline(code);
      expect(message).not.toMatch(/^declined\.?$/i);
      expect(message.length).toBeGreaterThan(40);
    }
  });

  test('an unknown code still gets a helpful message that names the code', () => {
    const d = classifyDecline('Z9');
    expect(d.category).toBe('OTHER');
    expect(d.message).toMatch(/Z9/);
    expect(d.message.length).toBeGreaterThan(40);
  });
});

describe('decline codes end to end (simulator "decline cycle" mode)', () => {
  let bank;
  let user;
  let card;

  beforeAll(async () => {
    bank = await startBank('A');
    user = await registerAndLogin('Decline Tester');
    card = await addCard(user);
  });
  afterAll(async () => {
    await bank.stop();
    await pool.end();
  });

  test('the bank returns each code in turn and the customer sees the matching message', async () => {
    bank.setMode({ outcome: 'DECLINE_CYCLE' });
    const seen = [];
    for (const code of bank.DECLINE_CYCLE) {
      const res = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ card_token: card.token, amount_kobo: 1000 });
      expect(res.body.status).toBe('FAILED');
      expect(res.body.response_code).toBe(code);
      expect(res.body.decline_reason).toBe(classifyDecline(code).category);
      expect(res.body.message).toBe(classifyDecline(code).message);
      seen.push(res.body.decline_reason);
    }
    expect(new Set(seen).size).toBe(bank.DECLINE_CYCLE.length);
  });
});
