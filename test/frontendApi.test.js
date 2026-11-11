// Endpoints the screens need: the History list and the admin simulator controls.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const { app, request, registerAndLogin, addCard, fundWallet, makeAdmin } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
let admin;
beforeAll(async () => {
  bank = await startBank('A');
  admin = await makeAdmin(await registerAndLogin('Sim Operator'));
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});
beforeEach(() => bank.reset());

const as = (u) => ({
  get: (path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${u.token}`),
  post: (path, body) =>
    request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', randomUUID()).send(body),
});

describe('GET /payments (History)', () => {
  test('lists my payments, newest first, with state and message; never someone else\'s', async () => {
    const me = await registerAndLogin('Historian');
    const card = await addCard(me);
    await fundWallet(me.accountId, 50000);
    const first = await as(me).post('/payments', { card_token: card.token, amount_kobo: 1000 });
    bank.setMode({ outcome: 'DECLINED', declineCode: '54' });
    const second = await as(me).post('/payments', { card_token: card.token, amount_kobo: 2000 });
    bank.setMode({});
    const third = await as(me).post('/transfers', { bank: 'A', account_number: '0123456789', amount_kobo: 3000 });

    const other = await registerAndLogin('Someone Else');
    const otherCard = await addCard(other);
    await as(other).post('/payments', { card_token: otherCard.token, amount_kobo: 999 });

    const res = await as(me).get('/payments');
    expect(res.status).toBe(200);
    expect(res.body.payments.map((p) => p.id)).toEqual([third.body.id, second.body.id, first.body.id]);
    expect(res.body.payments[1]).toMatchObject({ status: 'FAILED', decline_reason: 'CARD_EXPIRED', amount_display: '₦20.00' });
    expect(res.body.payments[0]).toMatchObject({ type: 'BANK_TRANSFER', account_name: 'Ngozi Eze' });
    expect(res.body.payments[2].card).toEqual({ brand: 'visa', last4: '1111' });

    const page = await as(me).get('/payments?limit=1');
    expect(page.body.payments).toHaveLength(1);
  });

  test('GET /accounts/me includes the role, for showing the right menu', async () => {
    const me = await registerAndLogin('Role Check');
    expect((await as(me).get('/accounts/me')).body.account.role).toBe('customer');
  });
});

describe('admin simulator controls', () => {
  test('GET /admin/simulator shows each bank\'s mode (or that it is unreachable)', async () => {
    const res = await as(admin).get('/admin/simulator');
    expect(res.status).toBe(200);
    const a = res.body.banks.find((b) => b.bank === 'A');
    expect(a).toMatchObject({ reachable: true, mode: { mode: 'normal', outcome: 'APPROVED', webhook: 'normal' } });
  });

  test('POST /admin/simulator/mode sets a bank\'s failure mode on the simulator itself', async () => {
    const res = await as(admin).post('/admin/simulator/mode', { bank: 'A', mode: 'error503', errorRate: 0.5 });
    expect(res.status).toBe(200);
    expect(res.body.mode).toMatchObject({ mode: 'error503', errorRate: 0.5 });
    expect(bank.state.mode).toMatchObject({ mode: 'error503', errorRate: 0.5 });

    await as(admin).post('/admin/simulator/mode', { bank: 'A', outcome: 'DECLINE_CYCLE', settlement: { wrongClosing: true } });
    expect(bank.state.mode).toMatchObject({ mode: 'normal', outcome: 'DECLINE_CYCLE', settlement: { wrongClosing: true } });
  });

  test('only known settings are passed on; a bad bank is refused; admin only', async () => {
    await as(admin).post('/admin/simulator/mode', { bank: 'A', mode: 'slow', hack: 'x', holdMs: 1 });
    expect(bank.state.mode.hack).toBeUndefined();
    expect(bank.state.mode.holdMs).toBe(60000);
    expect((await as(admin).post('/admin/simulator/mode', { bank: 'Q', mode: 'slow' })).status).toBe(400);
    expect((await as(admin).post('/admin/simulator/mode', { bank: 'A', mode: 'explode' })).status).toBe(400);
    const customer = await registerAndLogin();
    expect((await as(customer).post('/admin/simulator/mode', { bank: 'A', mode: 'slow' })).status).toBe(403);
  });

  test('POST /admin/simulator/dispute asks the bank to raise a chargeback for a payment', async () => {
    const me = await registerAndLogin('Chargeback Me');
    const card = await addCard(me);
    const paid = await as(me).post('/payments', { card_token: card.token, amount_kobo: 4000 });
    const res = await as(admin).post('/admin/simulator/dispute', { reference: paid.body.reference });
    expect(res.status).toBe(202);
    expect((await as(admin).post('/admin/simulator/dispute', { reference: 'TF-NOPE' })).status).toBe(404);
  });
});
