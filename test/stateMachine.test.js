// Module 2: payment state machine. Illegal jumps are rejected; every change
// is recorded in payment_events.
const { pool, withTransaction } = require('../src/db/pool');
const sm = require('../src/payments/stateMachine');
const payments = require('../src/payments/repository');
const { registerAndLogin } = require('./helpers');

afterAll(() => pool.end());

describe('canTransition (Module 2)', () => {
  test.each([
    ['INITIALIZED', 'PENDING'],
    ['INITIALIZED', 'FAILED'],
    ['PENDING', 'AUTHORIZED'],
    ['PENDING', 'COMPLETED'],
    ['PENDING', 'FAILED'],
    ['PENDING', 'UNKNOWN'],
    ['UNKNOWN', 'AUTHORIZED'],
    ['UNKNOWN', 'COMPLETED'],
    ['UNKNOWN', 'FAILED'],
    ['AUTHORIZED', 'COMPLETED'],
    ['AUTHORIZED', 'FAILED'],
  ])('%s -> %s is allowed', (from, to) => {
    expect(sm.canTransition(from, to)).toBe(true);
  });

  test.each([
    ['COMPLETED', 'PENDING'],
    ['COMPLETED', 'FAILED'],
    ['FAILED', 'COMPLETED'],
    ['FAILED', 'PENDING'],
    ['INITIALIZED', 'COMPLETED'],
    ['UNKNOWN', 'PENDING'],
    ['AUTHORIZED', 'PENDING'],
    ['PENDING', 'INITIALIZED'],
    ['PENDING', 'NOT_A_STATE'],
  ])('%s -> %s is rejected', (from, to) => {
    expect(sm.canTransition(from, to)).toBe(false);
  });
});

describe('transition() against the database (Module 2)', () => {
  let user;
  beforeAll(async () => {
    user = await registerAndLogin('State Tester');
  });

  async function newPayment() {
    return withTransaction((client) =>
      payments.create(client, { accountId: user.accountId, type: 'BANK_TRANSFER', amountKobo: 1000, bank: 'A', destinationAccount: '0123456789' })
    );
  }

  test('a legal path is applied and every step is logged', async () => {
    const p = await newPayment();
    expect(p.status).toBe('INITIALIZED');
    await withTransaction(async (client) => {
      await sm.transition(client, p.id, 'PENDING');
      await sm.transition(client, p.id, 'AUTHORIZED');
      await sm.transition(client, p.id, 'COMPLETED');
    });
    const { rows } = await pool.query(
      'SELECT from_status, to_status FROM payment_events WHERE payment_id = $1 ORDER BY id',
      [p.id]
    );
    expect(rows).toEqual([
      { from_status: null, to_status: 'INITIALIZED' },
      { from_status: 'INITIALIZED', to_status: 'PENDING' },
      { from_status: 'PENDING', to_status: 'AUTHORIZED' },
      { from_status: 'AUTHORIZED', to_status: 'COMPLETED' },
    ]);
  });

  test('COMPLETED -> PENDING is rejected and the status is unchanged', async () => {
    const p = await newPayment();
    await withTransaction(async (client) => {
      await sm.transition(client, p.id, 'PENDING');
      await sm.transition(client, p.id, 'COMPLETED');
    });
    await expect(withTransaction((client) => sm.transition(client, p.id, 'PENDING'))).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    const { rows } = await pool.query('SELECT status FROM payments WHERE id = $1', [p.id]);
    expect(rows[0].status).toBe('COMPLETED');
  });

  test('the database refuses a status change that skips the state machine', async () => {
    const p = await newPayment();
    await expect(pool.query("UPDATE payments SET status = 'COMPLETED' WHERE id = $1", [p.id])).rejects.toThrow(
      /illegal payment transition/i
    );
  });

  test('payment_events is append-only', async () => {
    await expect(pool.query('UPDATE payment_events SET to_status = to_status')).rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM payment_events')).rejects.toThrow(/append-only/i);
  });
});
