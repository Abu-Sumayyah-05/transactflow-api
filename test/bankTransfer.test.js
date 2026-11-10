// Transfers from a wallet to an account at a bank. Name enquiry first; money
// is held in TRANSFERS_IN_FLIGHT while the bank works, then either settled or
// returned to the wallet with a reversing entry.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const tsq = require('../src/payments/tsq');
const { app, request, registerAndLogin, fundWallet, balanceOf } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
let user;

beforeAll(async () => {
  bank = await startBank('A');
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});
beforeEach(async () => {
  bank.reset();
  user = await registerAndLogin('Sender');
  await fundWallet(user.accountId, 100000);
});

const send = (body) =>
  request(app)
    .post('/api/v1/transfers')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send(body);

describe('bank-account transfers', () => {
  test('name enquiry asks the bank for the account name', async () => {
    const res = await request(app)
      .get('/api/v1/transfers/name-enquiry')
      .query({ bank: 'A', account_number: '0123456789' })
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account_name: 'Ngozi Eze', bank: 'A', account_number: '0123456789' });
  });

  test('name enquiry for an account the bank does not know is 404', async () => {
    const res = await request(app)
      .get('/api/v1/transfers/name-enquiry')
      .query({ bank: 'A', account_number: '5555555555' })
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(404);
  });

  test('success: wallet debited, bank paid once, in-flight hold cleared, COMPLETED', async () => {
    const res = await send({ bank: 'A', account_number: '0123456789', amount_kobo: 30000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'COMPLETED', account_name: 'Ngozi Eze', amount_kobo: 30000 });
    expect(await balanceOf(user.accountId)).toBe(70000);
    expect(bank.state.calls.transfer).toBe(1);
  });

  test('bank rejects: FAILED and the money comes back via a reversing entry', async () => {
    bank.setMode({ outcome: 'DECLINED', declineCode: '57' });
    const res = await send({ bank: 'A', account_number: '0123456789', amount_kobo: 30000 });
    expect(res.body.status).toBe('FAILED');
    expect(await balanceOf(user.accountId)).toBe(100000);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ledger_entries WHERE reverses = (SELECT hold_transaction_id FROM payments WHERE id = $1)',
      [res.body.id]
    );
    expect(rows[0].n).toBe(2);
  });

  test('timeout: money stays held (not refunded on a guess) until TSQ learns the truth', async () => {
    bank.setMode({ mode: 'timeout' });
    const res = await send({ bank: 'A', account_number: '0123456789', amount_kobo: 20000 });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('UNKNOWN');
    expect(await balanceOf(user.accountId)).toBe(80000);

    bank.setMode({ mode: 'normal' });
    await tsq.runOnce();
    const { rows } = await pool.query('SELECT status FROM payments WHERE id = $1', [res.body.id]);
    expect(rows[0].status).toBe('COMPLETED');
    expect(await balanceOf(user.accountId)).toBe(80000);
    expect(bank.state.calls.transfer).toBe(1);
  });

  test('insufficient funds: 422 and the bank is never called', async () => {
    const res = await send({ bank: 'A', account_number: '0123456789', amount_kobo: 999999 });
    expect(res.status).toBe(422);
    expect(bank.state.calls.transfer).toBe(0);
  });

  test('a malformed account number is 400', async () => {
    const res = await send({ bank: 'A', account_number: '123', amount_kobo: 100 });
    expect(res.status).toBe(400);
  });

  test('INVARIANT: ledger still balanced and stored balances match the ledger', async () => {
    const ledger = require('../src/ledger/ledger');
    expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
  });
});
