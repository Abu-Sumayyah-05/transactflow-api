// Phase 5 check, part 2 (Module 8): two simultaneous spends of one balance
// let only one through. The balance row is locked with SELECT ... FOR UPDATE,
// so the second spend waits, then sees the reduced balance.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const ledger = require('../src/ledger/ledger');
const { app, request, registerAndLogin, fundWallet, balanceOf } = require('./helpers');
const { startBank } = require('./bankHelper');

afterAll(() => pool.end());

const transfer = (from, body) =>
  request(app)
    .post('/api/v1/transfers')
    .set('Authorization', `Bearer ${from.token}`)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .then((r) => r);

describe('concurrent spends (Module 8)', () => {
  test('PHASE 5 CHECK: two simultaneous spends of one balance, only one succeeds', async () => {
    const spender = await registerAndLogin('Spender');
    const a = await registerAndLogin('Payee A');
    const b = await registerAndLogin('Payee B');
    await fundWallet(spender.accountId, 10000);

    const results = await Promise.all([
      transfer(spender, { recipient_email: a.email, amount_kobo: 8000 }),
      transfer(spender, { recipient_email: b.email, amount_kobo: 8000 }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await balanceOf(spender.accountId)).toBe(2000);
    expect((await balanceOf(a.accountId)) + (await balanceOf(b.accountId))).toBe(8000);
  });

  test('ten simultaneous spends of ₦30 from ₦100: exactly three succeed, balance never negative', async () => {
    const spender = await registerAndLogin('Burst Spender');
    const payee = await registerAndLogin('Burst Payee');
    await fundWallet(spender.accountId, 10000);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(spender, { recipient_email: payee.email, amount_kobo: 3000 }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(7);
    expect(await balanceOf(spender.accountId)).toBe(1000);
    expect(await balanceOf(payee.accountId)).toBe(9000);
  });

  test('transfers in opposite directions at the same time never deadlock', async () => {
    const x = await registerAndLogin('Xavier Obi');
    const y = await registerAndLogin('Yemi Ade');
    await fundWallet(x.accountId, 50000);
    await fundWallet(y.accountId, 50000);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? transfer(x, { recipient_email: y.email, amount_kobo: 100 })
          : transfer(y, { recipient_email: x.email, amount_kobo: 100 })
      )
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await balanceOf(x.accountId)) + (await balanceOf(y.accountId))).toBe(100000);
  });

  test('a wallet spend and a bank transfer racing for the same money: only one wins', async () => {
    const bank = await startBank('A');
    try {
      const spender = await registerAndLogin('Racer');
      const payee = await registerAndLogin('Racer Payee');
      await fundWallet(spender.accountId, 10000);

      const results = await Promise.all([
        transfer(spender, { bank: 'A', account_number: '0123456789', amount_kobo: 7000 }),
        transfer(spender, { recipient_email: payee.email, amount_kobo: 7000 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(await balanceOf(spender.accountId)).toBe(3000);
    } finally {
      await bank.stop();
    }
  });

  test('a slow bank does not hold the wallet lock: a wallet transfer from the same wallet goes through meanwhile', async () => {
    const bank = await startBank('A');
    try {
      const spender = await registerAndLogin('Patient');
      const payee = await registerAndLogin('Quick Payee');
      await fundWallet(spender.accountId, 10000);
      bank.setMode({ mode: 'slow', delayMs: [1500, 1500] });

      const slow = transfer(spender, { bank: 'A', account_number: '0123456789', amount_kobo: 1000 });
      // Wait until the bank transfer has committed its hold and is waiting on the bank.
      for (let i = 0; i < 100; i += 1) {
        if ((await balanceOf(spender.accountId)) === 9000) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const started = Date.now();
      const quick = await transfer(spender, { recipient_email: payee.email, amount_kobo: 500 });
      expect(quick.status).toBe(201);
      expect(Date.now() - started).toBeLessThan(500);
      await slow;
    } finally {
      await bank.stop();
    }
  });

  test('INVARIANT after all that: every stored balance matches the ledger', async () => {
    expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
  });
});
