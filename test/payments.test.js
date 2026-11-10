// Module 2 + Phase 3 check: a card payment through Mock Bank A. In timeout
// mode the payment goes to UNKNOWN, then TSQ moves it to the bank's real
// final status. It is never marked FAILED just because the bank went quiet.
const { randomUUID } = require('crypto');
const { pool, withTransaction } = require('../src/db/pool');
const tsq = require('../src/payments/tsq');
const payments = require('../src/payments/repository');
const sm = require('../src/payments/stateMachine');
const { app, request, registerAndLogin, addCard, balanceOf } = require('./helpers');
const { startBank } = require('./bankHelper');

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
  user = await registerAndLogin('Payer');
  card = await addCard(user);
});

const pay = (amount, { key = randomUUID(), u = user, token = card.token } = {}) =>
  request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${u.token}`)
    .set('Idempotency-Key', key)
    .send({ card_token: token, amount_kobo: amount });

const getPayment = (id, u = user) =>
  request(app).get(`/api/v1/payments/${id}`).set('Authorization', `Bearer ${u.token}`);

async function events(paymentId) {
  const { rows } = await pool.query('SELECT to_status FROM payment_events WHERE payment_id = $1 ORDER BY id', [paymentId]);
  return rows.map((r) => r.to_status);
}

describe('card top-up through Mock Bank A', () => {
  test('approved: COMPLETED, wallet credited once, balanced ledger, full event trail', async () => {
    const res = await pay(250000);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'COMPLETED', amount_kobo: 250000, bank: 'A' });
    expect(await balanceOf(user.accountId)).toBe(250000);
    expect(await events(res.body.id)).toEqual(['INITIALIZED', 'PENDING', 'AUTHORIZED', 'COMPLETED']);

    const { rows } = await pool.query(
      `SELECT SUM(CASE WHEN direction='DEBIT' THEN amount_kobo ELSE 0 END)::bigint AS d,
              SUM(CASE WHEN direction='CREDIT' THEN amount_kobo ELSE 0 END)::bigint AS c
         FROM ledger_entries WHERE transaction_id = (SELECT ledger_transaction_id FROM payments WHERE id = $1)`,
      [res.body.id]
    );
    expect(rows[0]).toEqual({ d: 250000, c: 250000 });
  });

  test('declined: FAILED with a reason (never a bare "declined"), wallet untouched', async () => {
    bank.setMode({ outcome: 'DECLINED', declineCode: '51' });
    const res = await pay(1000);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.response_code).toBe('51');
    expect(res.body.message).not.toMatch(/^declined\.?$/i);
    expect(res.body.message.length).toBeGreaterThan(15);
    expect(await balanceOf(user.accountId)).toBe(0);
  });

  test('PHASE 3 CHECK: bank times out after approving -> UNKNOWN -> TSQ finds APPROVED -> COMPLETED', async () => {
    bank.setMode({ mode: 'timeout' });
    const res = await pay(70000);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('UNKNOWN');
    expect(await balanceOf(user.accountId)).toBe(0); // not credited on a guess

    bank.setMode({ mode: 'normal' });
    await tsq.runOnce();

    const after = await getPayment(res.body.id);
    expect(after.body.status).toBe('COMPLETED');
    expect(await balanceOf(user.accountId)).toBe(70000);
    expect(await events(res.body.id)).toEqual(['INITIALIZED', 'PENDING', 'UNKNOWN', 'AUTHORIZED', 'COMPLETED']);
  });

  test('PHASE 3 CHECK: bank times out after declining -> UNKNOWN -> TSQ finds DECLINED -> FAILED', async () => {
    bank.setMode({ mode: 'timeout', outcome: 'DECLINED', declineCode: '51' });
    const res = await pay(70000);
    expect(res.body.status).toBe('UNKNOWN');

    bank.setMode({ mode: 'normal' });
    await tsq.runOnce();
    const after = await getPayment(res.body.id);
    expect(after.body.status).toBe('FAILED');
    expect(after.body.response_code).toBe('51');
    expect(await balanceOf(user.accountId)).toBe(0);
  });

  test('a 503 is UNKNOWN too; TSQ learns the bank never processed it -> FAILED', async () => {
    bank.setMode({ mode: 'error503', errorRate: 1 });
    const res = await pay(5000);
    expect(res.body.status).toBe('UNKNOWN');

    bank.setMode({ mode: 'normal' });
    await tsq.runOnce();
    expect((await getPayment(res.body.id)).body.status).toBe('FAILED');
    expect(bank.state.charges.size).toBe(0);
  });

  test('GET /payments/:id runs a TSQ check itself when the status is UNKNOWN', async () => {
    bank.setMode({ mode: 'timeout' });
    const res = await pay(1500);
    bank.setMode({ mode: 'normal' });

    const after = await getPayment(res.body.id);
    expect(after.body.status).toBe('COMPLETED');
  });

  test('bank unreachable during TSQ: stays UNKNOWN with backoff; past the TTL it is flagged for review, never FAILED', async () => {
    bank.setMode({ mode: 'timeout' });
    const res = await pay(2000);
    bank.setMode({ mode: 'error503', errorRate: 1 });

    await tsq.runOnce();
    let { rows } = await pool.query('SELECT status, tsq_attempts, tsq_next_at > now() AS later FROM payments WHERE id = $1', [res.body.id]);
    expect(rows[0]).toEqual({ status: 'UNKNOWN', tsq_attempts: 1, later: true });

    await pool.query(
      "UPDATE payments SET tsq_next_at = now(), tsq_expires_at = now() - interval '1 second' WHERE id = $1",
      [res.body.id]
    );
    await tsq.runOnce();
    ({ rows } = await pool.query('SELECT status, needs_review, tsq_next_at FROM payments WHERE id = $1', [res.body.id]));
    expect(rows[0]).toEqual({ status: 'UNKNOWN', needs_review: true, tsq_next_at: null });
  });

  test('a payment stuck in PENDING (crash mid-call) is swept to UNKNOWN and resolved by TSQ', async () => {
    const p = await withTransaction(async (client) => {
      const created = await payments.create(client, {
        accountId: user.accountId,
        type: 'CARD_TOPUP',
        amountKobo: 3000,
        bank: 'A',
        cardToken: card.token,
      });
      await sm.transition(client, created.id, 'PENDING');
      return created;
    });
    await pool.query("UPDATE payments SET updated_at = now() - interval '10 minutes' WHERE id = $1", [p.id]);

    await tsq.runOnce();
    expect(await events(p.id)).toEqual(['INITIALIZED', 'PENDING', 'UNKNOWN', 'FAILED']); // bank never saw it
  });

  test('double-tap: the same Idempotency-Key charges the bank once', async () => {
    const key = randomUUID();
    const a = await pay(4000, { key });
    const b = await pay(4000, { key });
    expect(b.body.id).toBe(a.body.id);
    expect(bank.state.calls.charge).toBe(1);
    expect(await balanceOf(user.accountId)).toBe(4000);
  });

  test("a customer cannot see someone else's payment or use their card", async () => {
    const res = await pay(1000);
    const other = await registerAndLogin('Snoop');
    expect((await getPayment(res.body.id, other)).status).toBe(404);
    const stolen = await pay(1000, { u: other });
    expect(stolen.status).toBe(404);
    expect(stolen.body.error.code).toBe('CARD_NOT_FOUND');
  });

  test('rejects non-integer amounts', async () => {
    expect((await pay(10.5)).status).toBe(400);
  });
});
