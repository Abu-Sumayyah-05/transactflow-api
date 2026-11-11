// Module 9: disputes move funds through the ESCROW ledger account.
//
// A card chargeback arrives from the bank as a signed charge.disputed webhook.
//   open           wallet -> ESCROW (as much as the wallet still holds)
//   CUSTOMER_WON   ESCROW -> CARD_SETTLEMENT (money goes back to the card);
//                  any part the wallet had already spent is a platform loss
//                  (DISPUTE_LOSSES -> CARD_SETTLEMENT)
//   MERCHANT_WON   ESCROW -> wallet (the hold is released)
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const ledger = require('../src/ledger/ledger');
const webhooks = require('../src/webhooks/processor');
const { app, request, registerAndLogin, addCard, balanceOf, makeAdmin, signWebhook } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
let admin;
beforeAll(async () => {
  bank = await startBank('A');
  admin = await makeAdmin(await registerAndLogin('Disputes Desk'));
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});

async function toppedUpUser(amount) {
  const user = await registerAndLogin('Disputer');
  const card = await addCard(user);
  const res = await request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ card_token: card.token, amount_kobo: amount });
  expect(res.body.status).toBe('COMPLETED');
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [res.body.id]);
  return { user, payment: rows[0] };
}

// The bank says: the cardholder disputed this charge.
async function chargeback(payment, { amount = payment.amount_kobo, eventId = `evt_${randomUUID()}`, bankName = 'A' } = {}) {
  const raw = JSON.stringify({
    event_id: eventId,
    type: 'charge.disputed',
    data: { reference: payment.reference, amount_kobo: amount, reason: 'cardholder does not recognise the charge' },
  });
  const res = await request(app)
    .post('/api/v1/webhooks/bank')
    .set('Content-Type', 'application/json')
    .set('X-Bank-Name', bankName)
    .set('X-Bank-Signature', signWebhook(raw, process.env[`WEBHOOK_SECRET_${bankName}`]))
    .send(raw);
  expect(res.status).toBe(200);
  await webhooks.processDue();
  return eventId;
}

async function disputeFor(paymentId) {
  const { rows } = await pool.query('SELECT * FROM disputes WHERE payment_id = $1', [paymentId]);
  return rows[0];
}

// Net effect of one ledger transaction, by account code ('wallet' for wallets).
async function movements(transactionId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(a.code, 'wallet') AS account, l.direction, l.amount_kobo
       FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
      WHERE l.transaction_id = $1 ORDER BY a.code NULLS FIRST, l.direction`,
    [transactionId]
  );
  return rows.map((r) => `${r.direction} ${r.account} ${r.amount_kobo}`);
}

const resolve = (disputeId, outcome, key = randomUUID()) =>
  request(app)
    .post(`/api/v1/admin/disputes/${disputeId}/resolve`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('Idempotency-Key', key)
    .send({ outcome })
    .then((r) => r);

describe('opening a dispute', () => {
  test('a chargeback moves the disputed amount from the wallet into ESCROW', async () => {
    const { user, payment } = await toppedUpUser(10000);
    await chargeback(payment);

    const d = await disputeFor(payment.id);
    expect(d).toMatchObject({ status: 'OPEN', amount_kobo: 10000, held_kobo: 10000, shortfall_kobo: 0, source: 'A' });
    expect(await balanceOf(user.accountId)).toBe(0);
    expect(await movements(d.hold_transaction_id)).toEqual(['DEBIT wallet 10000', 'CREDIT ESCROW 10000']);
  });

  test('a partial chargeback holds only the disputed part', async () => {
    const { user, payment } = await toppedUpUser(10000);
    await chargeback(payment, { amount: 2500 });
    expect(await balanceOf(user.accountId)).toBe(7500);
    expect((await disputeFor(payment.id)).held_kobo).toBe(2500);
  });

  test('if the wallet already spent the money, the dispute holds what is left and records the shortfall', async () => {
    const { user, payment } = await toppedUpUser(10000);
    const friend = await registerAndLogin('Friend');
    await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ recipient_email: friend.email, amount_kobo: 7000 });

    await chargeback(payment);
    expect(await disputeFor(payment.id)).toMatchObject({ held_kobo: 3000, shortfall_kobo: 7000 });
    expect(await balanceOf(user.accountId)).toBe(0); // never negative
  });

  test('a fully spent wallet still opens the dispute, with nothing held', async () => {
    const { user, payment } = await toppedUpUser(4000);
    const friend = await registerAndLogin('Friend');
    await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ recipient_email: friend.email, amount_kobo: 4000 });

    await chargeback(payment);
    expect(await disputeFor(payment.id)).toMatchObject({ status: 'OPEN', held_kobo: 0, shortfall_kobo: 4000, hold_transaction_id: null });
  });

  test('the same chargeback delivered twice opens one dispute and holds the money once', async () => {
    const { user, payment } = await toppedUpUser(6000);
    const eventId = `evt_${randomUUID()}`;
    await chargeback(payment, { eventId });
    await chargeback(payment, { eventId });
    // A second, different event for the same charge is ignored too.
    await chargeback(payment);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM disputes WHERE payment_id = $1', [payment.id]);
    expect(rows[0].n).toBe(1);
    expect(await balanceOf(user.accountId)).toBe(0);
  });

  test('impossible disputes go to the dead-letter queue and move no money', async () => {
    const { user, payment } = await toppedUpUser(5000);
    await chargeback(payment, { amount: 999999 }); // more than was charged
    await chargeback(payment, { bankName: 'B' }); // the wrong bank
    expect(await disputeFor(payment.id)).toBeUndefined();
    expect(await balanceOf(user.accountId)).toBe(5000);
    const { rows } = await pool.query(
      "SELECT status FROM webhook_events WHERE event_type = 'charge.disputed' AND payload->'data'->>'reference' = $1",
      [payment.reference]
    );
    expect(rows.map((r) => r.status)).toEqual(['DEAD', 'DEAD']);
  });
});

describe('resolving a dispute', () => {
  test('CUSTOMER_WON: ESCROW pays back the card (CARD_SETTLEMENT); the wallet stays debited', async () => {
    const { user, payment } = await toppedUpUser(10000);
    await chargeback(payment);
    const d = await disputeFor(payment.id);

    const res = await resolve(d.id, 'CUSTOMER_WON');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CUSTOMER_WON', held_kobo: 10000, shortfall_kobo: 0 });
    const after = await disputeFor(payment.id);
    expect(await movements(after.resolution_transaction_id)).toEqual(['CREDIT CARD_SETTLEMENT 10000', 'DEBIT ESCROW 10000']);
    expect(await balanceOf(user.accountId)).toBe(0);
  });

  test('CUSTOMER_WON with a shortfall: the platform absorbs the spent part as a dispute loss', async () => {
    const { user, payment } = await toppedUpUser(10000);
    const friend = await registerAndLogin('Friend');
    await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ recipient_email: friend.email, amount_kobo: 7000 });
    await chargeback(payment);
    const d = await disputeFor(payment.id);

    await resolve(d.id, 'CUSTOMER_WON');
    const after = await disputeFor(payment.id);
    expect(await movements(after.resolution_transaction_id)).toEqual([
      'CREDIT CARD_SETTLEMENT 10000',
      'DEBIT DISPUTE_LOSSES 7000',
      'DEBIT ESCROW 3000',
    ]);
  });

  test('MERCHANT_WON: the held money goes back to the wallet', async () => {
    const { user, payment } = await toppedUpUser(10000);
    await chargeback(payment, { amount: 4000 });
    const d = await disputeFor(payment.id);
    expect(await balanceOf(user.accountId)).toBe(6000);

    await resolve(d.id, 'MERCHANT_WON');
    const after = await disputeFor(payment.id);
    expect(after.status).toBe('MERCHANT_WON');
    expect(await movements(after.resolution_transaction_id)).toEqual(['CREDIT wallet 4000', 'DEBIT ESCROW 4000']);
    expect(await balanceOf(user.accountId)).toBe(10000);
  });

  test('a dispute is resolved once; a double-clicked Resolve moves money once', async () => {
    const { user, payment } = await toppedUpUser(10000);
    await chargeback(payment);
    const d = await disputeFor(payment.id);
    const key = randomUUID();
    await Promise.all([resolve(d.id, 'MERCHANT_WON', key), resolve(d.id, 'MERCHANT_WON', key)]);
    const again = await resolve(d.id, 'CUSTOMER_WON');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DISPUTE_ALREADY_RESOLVED');
    expect(await balanceOf(user.accountId)).toBe(10000);
  });

  test('bad input is refused', async () => {
    const { payment } = await toppedUpUser(1000);
    await chargeback(payment);
    const d = await disputeFor(payment.id);
    expect((await resolve(d.id, 'SPLIT')).status).toBe(400);
    expect((await resolve(987654321, 'CUSTOMER_WON')).status).toBe(404);
  });

  test('GET /admin/disputes lists disputes with their payment and customer', async () => {
    const { user, payment } = await toppedUpUser(1500);
    await chargeback(payment);
    const res = await request(app).get('/api/v1/admin/disputes').set('Authorization', `Bearer ${admin.token}`);
    const item = res.body.disputes.find((x) => x.payment_reference === payment.reference);
    expect(item).toMatchObject({ status: 'OPEN', amount_kobo: 1500, held_kobo: 1500, customer_email: user.email });
  });

  test('every account still agrees with the ledger, and ESCROW never goes negative', async () => {
    expect(await ledger.findBalanceMismatches(pool)).toEqual([]);
    const { rows } = await pool.query("SELECT balance_kobo FROM accounts WHERE code = 'ESCROW'");
    expect(rows[0].balance_kobo).toBeGreaterThanOrEqual(0);
  });
});

describe('simulator: the bank raises a chargeback on demand (end to end)', () => {
  let server;
  let liveBank;
  beforeAll(async () => {
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    // Replaces Bank A for this block: same name, but it sends real webhooks.
    liveBank = await startBank('A', {
      webhookUrl: `http://127.0.0.1:${server.address().port}/api/v1/webhooks/bank`,
      webhookSecret: process.env.WEBHOOK_SECRET_A,
    });
  });
  afterAll(async () => {
    await liveBank.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  test('POST /_sim/disputes makes the bank send a signed charge.disputed webhook; the money moves to ESCROW', async () => {
    const { user, payment } = await toppedUpUser(3000);
    const sim = await fetch(`${process.env.BANK_A_URL}/_sim/disputes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-token': process.env.SIM_TOKEN || '' },
      body: JSON.stringify({ reference: payment.reference }),
    });
    expect(sim.status).toBe(202);

    let d;
    for (let i = 0; i < 100 && !d; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      await webhooks.processDue();
      d = await disputeFor(payment.id);
    }
    expect(d).toMatchObject({ status: 'OPEN', held_kobo: 3000 });
    expect(await balanceOf(user.accountId)).toBe(0);
  });

  test('the simulator refuses a chargeback for a charge it never processed', async () => {
    const res = await fetch(`${process.env.BANK_A_URL}/_sim/disputes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-token': process.env.SIM_TOKEN || '' },
      body: JSON.stringify({ reference: 'TF-NEVER-SEEN' }),
    });
    expect(res.status).toBe(404);
  });
});
