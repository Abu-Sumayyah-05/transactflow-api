// Module 3: double-entry ledger. Debits equal credits for every transaction,
// entries are append-only, mistakes are fixed with reversing entries.
const { pool, withTransaction } = require('../src/db/pool');
const ledger = require('../src/ledger/ledger');
const { registerAndLogin, fundWallet } = require('./helpers');

afterAll(() => pool.end());

async function entriesFor(transactionId) {
  const { rows } = await pool.query(
    'SELECT account_id, direction, amount_kobo FROM ledger_entries WHERE transaction_id = $1',
    [transactionId]
  );
  return rows;
}

async function balanceOf(accountId) {
  const { rows } = await pool.query('SELECT balance_kobo FROM accounts WHERE id = $1', [accountId]);
  return rows[0].balance_kobo;
}

describe('ledger (Module 3)', () => {
  let alice;
  let bob;

  beforeAll(async () => {
    alice = await registerAndLogin('Alice');
    bob = await registerAndLogin('Bob');
  });

  test('a balanced transaction writes a debit and a credit and moves balances', async () => {
    const txId = await fundWallet(alice.accountId, 500000);
    const rows = await entriesFor(txId);

    expect(rows).toHaveLength(2);
    const debits = rows.filter((r) => r.direction === 'DEBIT').reduce((s, r) => s + r.amount_kobo, 0);
    const credits = rows.filter((r) => r.direction === 'CREDIT').reduce((s, r) => s + r.amount_kobo, 0);
    expect(debits).toBe(500000);
    expect(credits).toBe(500000);
    expect(await balanceOf(alice.accountId)).toBe(500000);
  });

  test('rejects an unbalanced transaction and writes nothing', async () => {
    const before = await balanceOf(alice.accountId);
    await expect(
      withTransaction((client) =>
        ledger.postTransaction(client, {
          entries: [
            { accountId: alice.accountId, direction: 'DEBIT', amountKobo: 1000 },
            { accountId: bob.accountId, direction: 'CREDIT', amountKobo: 999 },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'LEDGER_UNBALANCED' });
    expect(await balanceOf(alice.accountId)).toBe(before);
  });

  test('rejects fewer than two entries', async () => {
    await expect(
      withTransaction((client) =>
        ledger.postTransaction(client, {
          entries: [{ accountId: alice.accountId, direction: 'DEBIT', amountKobo: 100 }],
        })
      )
    ).rejects.toMatchObject({ code: 'LEDGER_UNBALANCED' });
  });

  test.each([1.5, '100', 0, -100])('rejects non-integer or non-positive amount %p', async (amount) => {
    await expect(
      withTransaction((client) =>
        ledger.postTransaction(client, {
          entries: [
            { accountId: alice.accountId, direction: 'DEBIT', amountKobo: amount },
            { accountId: bob.accountId, direction: 'CREDIT', amountKobo: amount },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  test('a wallet cannot be debited below zero', async () => {
    const fresh = await registerAndLogin('Empty');
    await expect(
      withTransaction((client) =>
        ledger.postTransaction(client, {
          entries: [
            { accountId: fresh.accountId, direction: 'DEBIT', amountKobo: 1 },
            { accountId: bob.accountId, direction: 'CREDIT', amountKobo: 1 },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  test('the database itself refuses an unbalanced transaction at commit', async () => {
    // Bypasses postTransaction to prove the guard does not depend on app code.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo)
         VALUES (gen_random_uuid(), $1, 'CREDIT', 100)`,
        [bob.accountId]
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('ledger entries cannot be updated or deleted', async () => {
    await expect(pool.query('UPDATE ledger_entries SET amount_kobo = 1')).rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/i);
  });

  test('a mistake is fixed with a reversing entry, not an edit', async () => {
    const before = await balanceOf(alice.accountId);
    const txId = await fundWallet(alice.accountId, 7000);
    const reversalId = await withTransaction((client) => ledger.reverseTransaction(client, txId, 'test mistake'));

    expect(await balanceOf(alice.accountId)).toBe(before);
    expect(await entriesFor(txId)).toHaveLength(2); // original untouched
    const reversal = await entriesFor(reversalId);
    expect(reversal).toHaveLength(2);
    expect(reversal.find((r) => r.account_id === alice.accountId).direction).toBe('DEBIT');

    await expect(
      withTransaction((client) => ledger.reverseTransaction(client, txId, 'again'))
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  test('INVARIANT: for every transaction, debits equal credits', async () => {
    const { rows } = await pool.query(`
      SELECT transaction_id,
             SUM(CASE WHEN direction = 'DEBIT'  THEN amount_kobo ELSE 0 END) AS debits,
             SUM(CASE WHEN direction = 'CREDIT' THEN amount_kobo ELSE 0 END) AS credits
        FROM ledger_entries
       GROUP BY transaction_id`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.debits).toBe(row.credits);
    }
  });

  test('INVARIANT: every stored balance equals the balance derived from the ledger, in integer kobo', async () => {
    const mismatches = await ledger.findBalanceMismatches(pool);
    expect(mismatches).toEqual([]);

    const { rows } = await pool.query('SELECT balance_kobo FROM accounts');
    for (const { balance_kobo } of rows) {
      expect(Number.isSafeInteger(balance_kobo)).toBe(true);
    }
  });
});
