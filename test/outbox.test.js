// Module 10: the transactional outbox.
//
// The problem: "save the payment, then tell the world" is two steps. Crash
// between them and the world never hears. So the event is written to the
// outbox table IN THE SAME TRANSACTION as the business change, and a
// separate relay publishes it afterwards, retrying until it succeeds.
//
// PHASE 8 CHECK: kill the app between the database commit and the publish,
// and the event still goes out after restart.
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { pool, withTransaction } = require('../src/db/pool');
const { redis } = require('../src/redis');
const outbox = require('../src/outbox/outbox');
const sm = require('../src/payments/stateMachine');
const { app, request, registerAndLogin, addCard } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
beforeAll(async () => {
  bank = await startBank('A');
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});

// A publisher that just collects, so tests can see exactly what went out.
function collector() {
  const sent = [];
  return { sent, publish: async (evt) => sent.push(evt) };
}
// Other test files leave their own events behind; clear the backlog.
async function drain() {
  while ((await outbox.relayOnce({ publish: async () => {} })) > 0);
}
const rowsFor = async (aggregateId) =>
  (await pool.query('SELECT * FROM outbox WHERE aggregate_id = $1 ORDER BY id', [aggregateId])).rows;

async function payment() {
  const user = await registerAndLogin('Outbox Payer');
  const card = await addCard(user);
  const res = await request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ card_token: card.token, amount_kobo: 4200 });
  expect(res.body.status).toBe('COMPLETED');
  return res.body;
}

describe('writing events', () => {
  test('every payment state change writes an event, unpublished, with the facts a consumer needs', async () => {
    const p = await payment();
    const rows = await rowsFor(p.id);
    expect(rows.map((r) => r.event_type)).toEqual(['payment.pending', 'payment.authorized', 'payment.completed']);
    expect(rows.every((r) => r.published_at === null)).toBe(true);
    expect(rows[2].payload).toMatchObject({
      payment_id: p.id,
      reference: p.reference,
      status: 'COMPLETED',
      from_status: 'AUTHORIZED',
      amount_kobo: 4200,
      bank: 'A',
    });
  });

  test('a wallet-to-wallet transfer writes transfer.completed', async () => {
    const { fundWallet } = require('./helpers');
    const sender = await registerAndLogin('Sender');
    const recipient = await registerAndLogin('Recipient');
    await fundWallet(sender.accountId, 5000);
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ recipient_email: recipient.email, amount_kobo: 1200 });
    const rows = await rowsFor(res.body.transaction_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'transfer.completed',
      payload: { from_account_id: sender.accountId, to_account_id: recipient.accountId, amount_kobo: 1200 },
    });
  });

  test('same transaction: if the business change rolls back, so does its event', async () => {
    const p = await payment();
    const before = (await rowsFor(p.id)).length;
    const marker = randomUUID();
    await expect(
      withTransaction(async (client) => {
        await outbox.add(client, 'test.rollback', marker, {});
        await sm.transition(client, p.id, 'PENDING'); // illegal: COMPLETED is final
      })
    ).rejects.toThrow(/cannot move/);
    expect(await rowsFor(marker)).toHaveLength(0);
    expect(await rowsFor(p.id)).toHaveLength(before);
  });
});

describe('PHASE 8 CHECK', () => {
  test('the app is killed after the commit and before the publish; the event still goes out after restart', async () => {
    await drain();
    const marker = `crash-${randomUUID()}`;

    // 1. The "app" commits, then is killed before it can publish.
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'commitThenHang.js'), marker], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('COMMITTED') && resolve());
      child.on('exit', (code) => reject(new Error(`fixture exited early (${code})`)));
    }).finally(() => child.removeAllListeners('exit'));
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGKILL');
    await exited;

    // 2. The commit survived; nothing was published.
    const [row] = await rowsFor(marker);
    expect(row).toMatchObject({ event_type: 'test.crash', published_at: null });
    const streamBefore = await redis().xrange(outbox.STREAM, '-', '+');
    expect(streamBefore.some(([, f]) => f.includes(row.event_id))).toBe(false);

    // 3. "Restart": the relay runs and publishes it to the real Redis stream.
    expect(await outbox.relayOnce()).toBe(1);
    const stream = await redis().xrange(outbox.STREAM, '-', '+');
    const mine = stream.filter(([, f]) => f.includes(row.event_id));
    expect(mine).toHaveLength(1);
    const flat = mine[0][1];
    const fields = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    expect(fields).toMatchObject({ event_id: row.event_id, type: 'test.crash' });
    expect(JSON.parse(fields.payload)).toEqual({ marker });
    expect((await rowsFor(marker))[0].published_at).not.toBeNull();

    // 4. And only once: the next run has nothing to do.
    expect(await outbox.relayOnce()).toBe(0);
  });
});

describe('the relay', () => {
  beforeEach(drain);

  test('publishes in the order written and marks each event published', async () => {
    const p = await payment();
    const c = collector();
    await outbox.relayOnce(c);
    expect(c.sent.map((e) => e.type)).toEqual(['payment.pending', 'payment.authorized', 'payment.completed']);
    expect(c.sent[0]).toMatchObject({ aggregate_id: p.id, payload: { payment_id: p.id } });
    expect(c.sent[0].event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await rowsFor(p.id)).every((r) => r.published_at)).toBe(true);
  });

  test('if publishing fails, the event stays, the error is recorded, order is kept, and it goes out later', async () => {
    const p = await payment();
    let calls = 0;
    const failing = {
      publish: async () => {
        calls += 1;
        throw new Error('redis is down');
      },
    };
    expect(await outbox.relayOnce(failing)).toBe(0);
    expect(calls).toBe(1); // stopped at the first failure: later events must not overtake it
    const rows = await rowsFor(p.id);
    expect(rows[0]).toMatchObject({ published_at: null, attempts: 1, last_error: 'redis is down' });
    expect(rows[1]).toMatchObject({ published_at: null, attempts: 0 });

    const c = collector();
    expect(await outbox.relayOnce(c)).toBe(3);
    expect(c.sent.map((e) => e.type)).toEqual(['payment.pending', 'payment.authorized', 'payment.completed']);
  });

  test('a crash after publishing but before marking sends the event again with the SAME event_id (at-least-once)', async () => {
    const marker = randomUUID();
    await withTransaction((client) => outbox.add(client, 'test.twice', marker, {}));
    const c = collector();
    const crash = new Error('died after publish');
    const dying = {
      publish: c.publish,
      afterPublish: () => {
        throw crash;
      },
    };
    await expect(outbox.relayOnce(dying)).rejects.toBe(crash);
    await outbox.relayOnce(c);
    expect(c.sent).toHaveLength(2);
    expect(c.sent[0].event_id).toBe(c.sent[1].event_id); // consumers dedupe on this
  });

  test('two relays at once never publish the same event twice', async () => {
    const marker = randomUUID();
    await withTransaction(async (client) => {
      for (let i = 0; i < 30; i += 1) await outbox.add(client, 'test.parallel', marker, { i });
    });
    const sent = [];
    const slow = {
      publish: async (e) => {
        await new Promise((r) => setTimeout(r, 2));
        sent.push(e);
      },
    };
    await Promise.all([1, 2, 3].map(() => outbox.relayOnce({ ...slow, limit: 10 })));
    await outbox.relayOnce(slow);
    expect(sent).toHaveLength(30);
    expect(new Set(sent.map((e) => e.event_id)).size).toBe(30);
  });

  test('stats() reports the backlog', async () => {
    const marker = randomUUID();
    await withTransaction((client) => outbox.add(client, 'test.stats', marker, {}));
    expect(await outbox.stats()).toMatchObject({ unpublished: 1 });
    await drain();
    expect(await outbox.stats()).toMatchObject({ unpublished: 0, oldest_unpublished_seconds: null });
  });
});
