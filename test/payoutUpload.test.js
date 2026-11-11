// Module 6: POST /payouts/batches validates the CSV, reserves the money for
// the valid rows in one ledger transaction, and queues sub-batches of 100.
// (Sending is the runner's job; see payoutRunner.test.js.)
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const ledger = require('../src/ledger/ledger');
const { HEADER } = require('../src/payouts/csv');
const { app, request, registerAndLogin, fundWallet, balanceOf, makeMerchant } = require('./helpers');

afterAll(() => pool.end());

async function fundedMerchant(kobo = 10_000_000) {
  const m = await makeMerchant(await registerAndLogin('Merchant'));
  if (kobo) await fundWallet(m.accountId, kobo);
  return m;
}

const csv = (...rows) => [HEADER.join(','), ...rows].join('\n');

const upload = (m, text, key = randomUUID()) =>
  request(app)
    .post('/api/v1/payouts/batches')
    .set('Authorization', `Bearer ${m.token}`)
    .set('Idempotency-Key', key)
    .set('Content-Type', 'text/csv')
    .send(text)
    .then((r) => r);

const report = (m, id) => request(app).get(`/api/v1/payouts/batches/${id}`).set('Authorization', `Bearer ${m.token}`).then((r) => r);

describe('POST /payouts/batches', () => {
  test('valid rows are reserved in one transaction and queued; bad rows are reported, not paid', async () => {
    const m = await fundedMerchant(1_000_000); // ₦10,000
    const res = await upload(
      m,
      csv(
        'A,0123456789,Ngozi Eze,1500.00,INV-1',
        'B,0000000001,Ibrahim Musa,2500,INV-2',
        'A,123,Nobody,10,INV-3', // bad account number
        'A,0987654321,Funke Adeyemi,1500,INV-1' // duplicate reference
      )
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'QUEUED',
      total_rows: 4,
      valid_rows: 2,
      reserved_kobo: 400000,
      sub_batches: [{ number: 1, size: 2, status: 'QUEUED' }],
      counts: { queued: 2, rejected: 2, processing: 0, paid: 0, failed: 0 },
    });
    expect(await balanceOf(m.accountId)).toBe(600000);

    const { rows } = await pool.query('SELECT reserve_transaction_id FROM payout_batches WHERE id = $1', [res.body.id]);
    const { rows: entries } = await pool.query(
      `SELECT COALESCE(a.code, 'wallet') AS acct, l.direction, l.amount_kobo FROM ledger_entries l
         JOIN accounts a ON a.id = l.account_id WHERE l.transaction_id = $1 ORDER BY l.direction`,
      [rows[0].reserve_transaction_id]
    );
    expect(entries).toEqual([
      { acct: 'PAYOUTS_RESERVED', direction: 'CREDIT', amount_kobo: 400000 },
      { acct: 'wallet', direction: 'DEBIT', amount_kobo: 400000 },
    ]);

    const r = await report(m, res.body.id);
    expect(r.body.items.map((i) => [i.row, i.status, i.reason])).toEqual([
      [2, 'QUEUED', null],
      [3, 'QUEUED', null],
      [4, 'REJECTED', 'INVALID_ACCOUNT_NUMBER'],
      [5, 'REJECTED', 'DUPLICATE_REFERENCE'],
    ]);
    expect(r.body.items[3]).toMatchObject({ reference: 'INV-1', account_name: 'Funke Adeyemi' });
  });

  test('250 valid rows are queued as 3 sub-batches: 100, 100, 50', async () => {
    const m = await fundedMerchant();
    const rows = Array.from({ length: 250 }, (_, i) => `A,0123456789,Ngozi Eze,${100 + i},R-${i}`);
    const res = await upload(m, csv(...rows));
    expect(res.status).toBe(202);
    expect(res.body.sub_batches.map((s) => s.size)).toEqual([100, 100, 50]);
    const { rows: items } = await pool.query('SELECT sub_batch, COUNT(*)::int AS n FROM payout_items WHERE batch_id = $1 GROUP BY 1 ORDER BY 1', [res.body.id]);
    expect(items).toEqual([{ sub_batch: 1, n: 100 }, { sub_batch: 2, n: 100 }, { sub_batch: 3, n: 50 }]);
  });

  test('if the wallet cannot cover the valid rows, the batch is refused and nothing is created', async () => {
    const m = await fundedMerchant(100000); // ₦1,000
    const res = await upload(m, csv('A,0123456789,Ngozi Eze,600,X1', 'A,0000000001,Ibrahim Musa,600,X2'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(m.accountId)).toBe(100000);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payout_batches WHERE merchant_id = $1', [m.userId]);
    expect(rows[0].n).toBe(0);
  });

  test('the same upload twice (same Idempotency-Key) creates one batch and reserves once', async () => {
    const m = await fundedMerchant(1_000_000);
    const key = randomUUID();
    const text = csv('A,0123456789,Ngozi Eze,100,K1');
    const [a, b] = await Promise.all([upload(m, text, key), upload(m, text, key)]);
    expect([a.status, b.status]).toContain(202);
    await new Promise((r) => setTimeout(r, 50));
    const again = await upload(m, text, key);
    expect(again.body.id).toBe((a.status === 202 ? a : b).body.id);
    expect(await balanceOf(m.accountId)).toBe(990000);
  });

  test('a reference already paid in an earlier batch is rejected as a duplicate', async () => {
    const m = await fundedMerchant();
    await upload(m, csv('A,0123456789,Ngozi Eze,100,SAME-REF'));
    const second = await upload(m, csv('A,0000000001,Ibrahim Musa,200,SAME-REF'));
    expect(second.body).toMatchObject({ valid_rows: 0, reserved_kobo: 0, status: 'DONE' });
    const r = await report(m, second.body.id);
    expect(r.body.items[0]).toMatchObject({ status: 'REJECTED', reason: 'DUPLICATE_REFERENCE' });
  });

  test('a broken file is refused as a whole with a clear message', async () => {
    const m = await fundedMerchant();
    const res = await upload(m, 'bank,amount\nA,10');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_CSV' });
    expect(res.body.error.message).toMatch(/account_number/);
  });

  test('only merchants can upload, and only the owner can see a batch', async () => {
    const customer = await registerAndLogin();
    const res = await upload(customer, csv('A,0123456789,Ngozi Eze,100,C1'));
    expect(res.status).toBe(403);

    const m = await fundedMerchant();
    const ok = await upload(m, csv('A,0123456789,Ngozi Eze,100,C2'));
    const otherMerchant = await fundedMerchant(0);
    expect((await report(otherMerchant, ok.body.id)).status).toBe(404);
    expect((await report(m, 'not-a-uuid')).status).toBe(404);
  });

  test('GET /payouts/batches lists the merchant\'s batches; ?format=csv downloads the report', async () => {
    const m = await fundedMerchant();
    const res = await upload(m, csv('A,0123456789,"Eze, Ngozi",100,L1', 'Z,0123456789,Ngozi Eze,100,L2'));
    const list = await request(app).get('/api/v1/payouts/batches').set('Authorization', `Bearer ${m.token}`);
    expect(list.body.batches.map((b) => b.id)).toContain(res.body.id);

    const file = await request(app).get(`/api/v1/payouts/batches/${res.body.id}?format=csv`).set('Authorization', `Bearer ${m.token}`);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    const lines = file.text.trim().split('\n');
    expect(lines[0]).toBe('row,reference,bank,account_number,account_name,amount,status,reason,resolved_name,payment_reference');
    expect(lines[1]).toBe('2,L1,A,0123456789,"Eze, Ngozi",100.00,QUEUED,,,');
    expect(lines[2]).toMatch(/^3,L2,Z,.*,REJECTED,INVALID_BANK/);
  });

  test('the ledger still balances for every account', async () => {
    expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
  });
});
