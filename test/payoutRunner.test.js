// Module 6: the payout runner. Sub-batches of 100, run strictly in order,
// with backpressure, and safe to rerun after a crash.
//
// PHASE 7 CHECK: a 250-item batch runs as 3 sub-batches, and rerunning after
// a crash pays nobody twice.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const config = require('../src/config');
const ledger = require('../src/ledger/ledger');
const gateway = require('../src/gateway/gateway');
const tsq = require('../src/payments/tsq');
const runner = require('../src/payouts/runner');
const { HEADER } = require('../src/payouts/csv');
const { app, request, registerAndLogin, fundWallet, balanceOf, makeMerchant } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
// The mock bank runs inside this test process, sharing the event loop with
// hundreds of database calls. The suite's 300 ms bank timeout can then trip
// on a healthy bank, open the breaker, and (correctly) pause the batch. A
// realistic timeout here; the test that wants timeouts sets its own.
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
beforeEach(() => bank.reset());

const FUNDS = 100_000_000; // ₦1,000,000

// Hundreds of items each lock the same system ledger rows, so these run
// close to one item at a time (~0.1 s each against Postgres in Docker).
const LONG = 120_000;

async function merchant() {
  const m = await makeMerchant(await registerAndLogin('Payroll Ltd'));
  await fundWallet(m.accountId, FUNDS);
  return m;
}

// n rows to the bank's known accounts; each amount differs (₦100 + i), so
// none is a duplicate payment.
const NAMES = { '0123456789': 'Ngozi Eze', '0000000001': 'Ibrahim Musa', '0987654321': 'Funke Adeyemi', '1122334455': 'Emeka Nwosu' };
function rows(n, prefix = randomUUID().slice(0, 6)) {
  const accts = Object.keys(NAMES);
  return Array.from({ length: n }, (_, i) => {
    const a = accts[i % accts.length];
    return `A,${a},${NAMES[a]},${100 + i},${prefix}-${i}`;
  });
}
const sumKobo = (n) => Array.from({ length: n }, (_, i) => (100 + i) * 100).reduce((x, y) => x + y, 0);

async function uploadBatch(m, lines) {
  const res = await request(app)
    .post('/api/v1/payouts/batches')
    .set('Authorization', `Bearer ${m.token}`)
    .set('Idempotency-Key', randomUUID())
    .set('Content-Type', 'text/csv')
    .send([HEADER.join(','), ...lines].join('\n'));
  expect(res.status).toBe(202);
  return res.body;
}

const report = (m, id) => request(app).get(`/api/v1/payouts/batches/${id}`).set('Authorization', `Bearer ${m.token}`).then((r) => r.body);

async function batchPayments(batchId) {
  const { rows: r } = await pool.query(
    'SELECT p.* FROM payout_items i JOIN payments p ON p.id = i.payment_id WHERE i.batch_id = $1',
    [batchId]
  );
  return r;
}

// Simulates the API process dying: whatever the runner held is left behind.
// Its lease then runs out, and PENDING payments look stale.
async function afterCrash(batchId) {
  await pool.query("UPDATE payout_batches SET lease_owner = 'dead-process', lease_until = now() - interval '1 second' WHERE id = $1", [batchId]);
}

describe('PHASE 7 CHECK', () => {
  test('a 250-item batch runs as 3 sub-batches (100, 100, 50), strictly one after another', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, rows(250));

    expect(await runner.advance(batch.id)).toBe('DONE');

    const r = await report(m, batch.id);
    expect(r).toMatchObject({ status: 'DONE', progress_percent: 100, counts: { paid: 250, failed: 0, rejected: 0, queued: 0, processing: 0 } });
    expect(r.sub_batches.map((s) => [s.number, s.size, s.status])).toEqual([[1, 100, 'DONE'], [2, 100, 'DONE'], [3, 50, 'DONE']]);
    // Strictly in order: each sub-batch starts only after the previous one finished.
    for (let i = 1; i < 3; i += 1) {
      expect(new Date(r.sub_batches[i].started_at).getTime()).toBeGreaterThanOrEqual(new Date(r.sub_batches[i - 1].finished_at).getTime());
    }
    // Every item was sent in its own sub-batch's window.
    const { rows: order } = await pool.query(
      `SELECT i.sub_batch, MIN(p.created_at) AS first, MAX(p.created_at) AS last
         FROM payout_items i JOIN payments p ON p.id = i.payment_id WHERE i.batch_id = $1 GROUP BY 1 ORDER BY 1`,
      [batch.id]
    );
    expect(order[0].last <= order[1].first && order[1].last <= order[2].first).toBe(true);

    expect(bank.state.calls.transfer).toBe(250);
    expect(bank.state.requests.transfer).toBe(250);
    expect(r.paid_kobo).toBe(sumKobo(250));
    expect(await balanceOf(m.accountId)).toBe(FUNDS - sumKobo(250));
  }, LONG);

  test.each([
    ['after the bank call, before the answer was recorded', 'afterSend', 250],
    ['after the payment was created, before the bank call', 'beforeSend', 120],
  ])('a crash %s: the rerun finishes the batch and pays nobody twice', async (_label, hook, n) => {
    const m = await merchant();
    const batch = await uploadBatch(m, rows(n));

    // Die on the 110th item (in sub-batch 2).
    let seen = 0;
    const crash = new Error('simulated crash');
    await expect(
      runner.advance(batch.id, {
        hooks: {
          [hook]: () => {
            seen += 1;
            if (seen === 110) throw crash;
          },
        },
      })
    ).rejects.toBe(crash);
    await afterCrash(batch.id);

    const mid = await report(m, batch.id);
    expect(mid.status).toBe('PROCESSING');
    expect(mid.counts.processing).toBeGreaterThanOrEqual(1); // the item we died on

    // Restart: the runner carries on (TSQ may also run; both are safe together).
    await tsq.runOnce();
    expect(await runner.advance(batch.id)).toBe('DONE');

    const r = await report(m, batch.id);
    expect(r.counts).toEqual({ paid: n, failed: 0, rejected: 0, queued: 0, processing: 0 });
    const payments = await batchPayments(batch.id);
    expect(payments).toHaveLength(n);
    expect(new Set(payments.map((p) => p.reference)).size).toBe(n);
    expect(payments.every((p) => p.status === 'COMPLETED')).toBe(true);

    // Nobody paid twice: the bank processed exactly n transfers, one per
    // reference, and the wallet paid out each amount exactly once.
    expect(bank.state.calls.transfer).toBe(n);
    expect(bank.state.transfers.size).toBe(n);
    expect(await balanceOf(m.accountId)).toBe(FUNDS - sumKobo(n));
    expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
  }, LONG);
});

describe('the lease: one runner per batch', () => {
  test('while another runner holds the lease, advance() leaves the batch alone', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, rows(3));
    await pool.query("UPDATE payout_batches SET lease_owner = 'someone-else', lease_until = now() + interval '1 minute' WHERE id = $1", [batch.id]);
    expect(await runner.advance(batch.id)).toBe('BUSY');
    expect(bank.state.requests.transfer).toBe(0);
    await afterCrash(batch.id);
    expect(await runner.advance(batch.id)).toBe('DONE');
  });

  test('two runners started at once: one works, the other backs off; each item is sent once', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, rows(20));
    const results = await Promise.all([runner.advance(batch.id), runner.advance(batch.id)]);
    expect(results.sort()).toEqual(['BUSY', 'DONE']);
    expect(bank.state.requests.transfer).toBe(20);
  });
});

describe('pre-send name enquiry', () => {
  test('a name that does not match the bank\'s is rejected and its money returned to the wallet', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, ['A,0123456789,Ngozi Eze,100,NM-1', 'A,0000000001,Chidi Okafor,200,NM-2']);
    expect(await runner.advance(batch.id)).toBe('DONE');

    const r = await report(m, batch.id);
    expect(r.items[1]).toMatchObject({ status: 'REJECTED', reason: 'NAME_MISMATCH', account_name: 'Chidi Okafor', resolved_name: 'Ibrahim Musa' });
    expect(r.counts).toMatchObject({ paid: 1, rejected: 1 });
    expect(bank.state.requests.transfer).toBe(1);
    expect(await balanceOf(m.accountId)).toBe(FUNDS - 10000);

    // A rejected row never paid anyone, so its reference can be used again.
    const retry = await uploadBatch(m, ['A,0000000001,Ibrahim Musa,200,NM-2']);
    expect(retry.valid_rows).toBe(1);
  });

  test('an account the bank does not have is rejected and refunded', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, ['B,5555555555,Ghost Person,100,GH-1']);
    await startBank('B').then(async (b) => {
      expect(await runner.advance(batch.id)).toBe('DONE');
      await b.stop();
    });
    const r = await report(m, batch.id);
    expect(r.items[0]).toMatchObject({ status: 'REJECTED', reason: 'ACCOUNT_NOT_FOUND' });
    expect(await balanceOf(m.accountId)).toBe(FUNDS);
  });
});

describe('bank failures', () => {
  test('a transfer the bank refuses is FAILED and refunded to the wallet (hold reversed, reserve released)', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, ['A,0123456789,Ngozi Eze,100,BF-1', 'A,0000000001,Ibrahim Musa,250,BF-2']);
    bank.setMode({ outcome: 'DECLINED', declineCode: '61' });
    expect(await runner.advance(batch.id)).toBe('DONE');

    const r = await report(m, batch.id);
    expect(r.counts).toMatchObject({ failed: 2, paid: 0 });
    expect(r.items[0].reason).toBe('BANK_61');
    expect(await balanceOf(m.accountId)).toBe(FUNDS);
    expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
  });
});

describe('backpressure', () => {
  test('an OPEN circuit breaker pauses the batch without sending; it resumes when the bank recovers', async () => {
    const m = await merchant();
    const batch = await uploadBatch(m, rows(5));
    gateway.forceOpen('A');
    expect(await runner.advance(batch.id)).toBe('PAUSED');
    expect(bank.state.requests.transfer).toBe(0);
    expect((await report(m, batch.id)).counts.queued).toBe(5);

    gateway.resetBreakers();
    expect(await runner.advance(batch.id)).toBe('DONE');
    expect(bank.state.calls.transfer).toBe(5);
  });

  test('too many unresolved payments: the batch waits for TSQ before sending more', async () => {
    const saved = { c: config.payoutConcurrency, f: config.payoutMaxInFlight, t: config.gatewayTimeoutMs };
    config.payoutConcurrency = 3;
    config.payoutMaxInFlight = 3;
    config.gatewayTimeoutMs = 300; // timeout mode: give up on the bank quickly
    try {
      const m = await merchant();
      const batch = await uploadBatch(m, rows(10));
      bank.setMode({ mode: 'timeout' }); // the bank pays but never answers: UNKNOWN
      expect(await runner.advance(batch.id)).toBe('BACKPRESSURE');
      expect(bank.state.calls.transfer).toBe(3);
      expect((await report(m, batch.id)).counts).toMatchObject({ processing: 3, queued: 7 });

      bank.setMode({ mode: 'normal' });
      gateway.resetBreakers();
      await tsq.runOnce(); // finds the 3 real results
      expect(await runner.advance(batch.id)).toBe('DONE');
      expect((await report(m, batch.id)).counts.paid).toBe(10);
      expect(bank.state.calls.transfer).toBe(10);
    } finally {
      config.payoutConcurrency = saved.c;
      config.payoutMaxInFlight = saved.f;
      config.gatewayTimeoutMs = saved.t;
    }
  });

  test('runOnce() advances every active batch', async () => {
    const m = await merchant();
    const a = await uploadBatch(m, rows(2));
    const b = await uploadBatch(m, rows(2));
    await runner.runOnce();
    for (const id of [a.id, b.id]) expect((await report(m, id)).status).toBe('DONE');
  });
});
