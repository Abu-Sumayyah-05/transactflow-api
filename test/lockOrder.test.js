// Module 8: account rows are always locked first and in one order, so
// concurrent money movements queue up instead of deadlocking.
//
// The bug this guards against: a transaction that first INSERTs a row
// pointing at a wallet (which takes a light "key share" lock on the wallet)
// and only then asks for the wallet's FOR UPDATE lock. Two of those at once
// each hold the light lock and each wait for the other: a deadlock.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const config = require('../src/config');
const ledger = require('../src/ledger/ledger');
const runner = require('../src/payouts/runner');
const { HEADER } = require('../src/payouts/csv');
const { app, request, registerAndLogin, fundWallet, balanceOf, makeMerchant } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
const savedTimeout = config.gatewayTimeoutMs;
beforeAll(async () => {
  bank = await startBank('A');
  config.gatewayTimeoutMs = 3000;
});
afterAll(async () => {
  config.gatewayTimeoutMs = savedTimeout;
  await bank.stop();
  await pool.end();
});

test('8 bank transfers from one wallet at once: all complete, none deadlocks', async () => {
  for (let round = 0; round < 3; round += 1) {
    const user = await registerAndLogin('Busy Sender');
    await fundWallet(user.accountId, 100000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/api/v1/transfers')
          .set('Authorization', `Bearer ${user.token}`)
          .set('Idempotency-Key', randomUUID())
          .send({ bank: 'A', account_number: '0123456789', amount_kobo: 1000 })
          .then((r) => r)
      )
    );
    expect(results.map((r) => `${r.status} ${r.body.status ?? r.body.error?.code}`)).toEqual(Array(8).fill('201 COMPLETED'));
    expect(await balanceOf(user.accountId)).toBe(92000);
  }
});

test('a payout batch mixing paid, refused and name-mismatch rows never deadlocks', async () => {
  // Several merchants, because whether the old code deadlocked depended on
  // how the wallet's random id sorted against the system accounts.
  for (let round = 0; round < 4; round += 1) {
    const m = await makeMerchant(await registerAndLogin('Mixed Batch'));
    await fundWallet(m.accountId, 10_000_000);
    const lines = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? `A,0123456789,Ngozi Eze,${100 + i},MX-${i}` : `A,0000000001,Wrong Name,${100 + i},MX-${i}`
    );
    const res = await request(app)
      .post('/api/v1/payouts/batches')
      .set('Authorization', `Bearer ${m.token}`)
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'text/csv')
      .send([HEADER.join(','), ...lines].join('\n'));
    expect(res.status).toBe(202);
    // Odd rounds: the bank refuses the transfers, so refunds race too.
    bank.setMode(round % 2 ? { outcome: 'DECLINED', declineCode: '61' } : {});
    expect(await runner.advance(res.body.id)).toBe('DONE');
    bank.setMode({});

    const paid = round % 2 ? 0 : Array.from({ length: 20 }, (_, k) => (100 + 2 * k) * 100).reduce((a, b) => a + b, 0);
    expect(await balanceOf(m.accountId)).toBe(10_000_000 - paid);
  }
  expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
}, 120000);

test('two uploads by one merchant at once both succeed', async () => {
  const m = await makeMerchant(await registerAndLogin('Double Upload'));
  await fundWallet(m.accountId, 1_000_000);
  const up = (ref) =>
    request(app)
      .post('/api/v1/payouts/batches')
      .set('Authorization', `Bearer ${m.token}`)
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'text/csv')
      .send(`${HEADER.join(',')}\nA,0123456789,Ngozi Eze,100,${ref}`)
      .then((r) => r.status);
  for (let i = 0; i < 5; i += 1) {
    expect(await Promise.all([up(`U${i}a`), up(`U${i}b`), up(`U${i}c`)])).toEqual([202, 202, 202]);
  }
});
