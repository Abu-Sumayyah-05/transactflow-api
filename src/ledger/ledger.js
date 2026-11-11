// Double-entry ledger (Module 3).
//
// Convention: an account's balance = sum(CREDIT) - sum(DEBIT).
// A wallet is money the platform owes the customer, so a CREDIT raises it and
// a DEBIT lowers it. The FUNDING system account is the other side of money
// arriving from outside, so it goes negative as wallets are topped up.
const { randomUUID } = require('crypto');
const { AppError } = require('../errors');
const { assertKobo } = require('../money');

const DIRECTIONS = new Set(['DEBIT', 'CREDIT']);

function validate(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new AppError(400, 'LEDGER_UNBALANCED', 'A ledger transaction needs at least two entries');
  }
  let debits = 0;
  let credits = 0;
  for (const e of entries) {
    if (!DIRECTIONS.has(e.direction)) {
      throw new AppError(400, 'INVALID_DIRECTION', `Unknown direction ${e.direction}`);
    }
    assertKobo(e.amountKobo);
    if (e.direction === 'DEBIT') debits += e.amountKobo;
    else credits += e.amountKobo;
  }
  if (debits !== credits) {
    throw new AppError(400, 'LEDGER_UNBALANCED', `Debits (${debits}) do not equal credits (${credits})`);
  }
}

// Posts a balanced set of entries. Must run inside withTransaction so the
// entries and the balance updates commit together or not at all.
async function postTransaction(client, { entries, memo = null, reverses = null }) {
  validate(entries);

  // Lock every touched account row. Sorting the ids means two transfers
  // between the same pair always lock in the same order, so they queue
  // instead of deadlocking.
  const ids = [...new Set(entries.map((e) => e.accountId))].sort();
  const { rows } = await client.query(
    'SELECT id, type, balance_kobo FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
    [ids]
  );
  if (rows.length !== ids.length) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'One of the accounts does not exist');
  }

  // Net change per account, then check wallets stay >= 0 before writing.
  const delta = new Map(ids.map((id) => [id, 0]));
  for (const e of entries) {
    delta.set(e.accountId, delta.get(e.accountId) + (e.direction === 'CREDIT' ? e.amountKobo : -e.amountKobo));
  }
  for (const acct of rows) {
    if (acct.type === 'WALLET' && acct.balance_kobo + delta.get(acct.id) < 0) {
      throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds: your wallet balance is too low for this amount');
    }
  }

  const transactionId = randomUUID();
  for (const e of entries) {
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo, memo, reverses)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [transactionId, e.accountId, e.direction, e.amountKobo, memo, reverses]
    );
  }
  for (const [accountId, change] of delta) {
    if (change !== 0) {
      await client.query('UPDATE accounts SET balance_kobo = balance_kobo + $2 WHERE id = $1', [accountId, change]);
    }
  }
  return transactionId;
}

// Locks account rows in sorted order and returns them.
//
// The lock is SELECT ... FOR NO KEY UPDATE: the row lock an UPDATE of a
// balance takes anyway. Like plain FOR UPDATE it makes everyone who wants to
// change the balance wait their turn. Unlike plain FOR UPDATE it does not
// collide with the light "key share" lock PostgreSQL takes on an account
// whenever a row that points at it (a payment, a ledger entry) is written.
// Those collisions caused deadlocks: see test/lockOrder.test.js.
//
// Rule for every money transaction: call this FIRST, with every account the
// transaction will touch, before inserting anything. Two reasons:
//   1. One order for everyone. If A locks wallet-then-reserve while B locks
//      reserve-then-wallet, each can end up waiting for the other forever
//      (a deadlock). Sorted ids make them queue instead.
//   2. Locks are taken before anything is written, so a transaction never
//      holds half of what it needs while it works.
// Accepts account ids or system account codes ('ESCROW').
async function lockAccounts(client, idsOrCodes) {
  const ids = [];
  for (const x of idsOrCodes) ids.push(/^[0-9a-f-]{36}$/i.test(x) ? x : await getSystemAccountId(client, x));
  const sorted = [...new Set(ids)].sort();
  const { rows } = await client.query(
    'SELECT id, type, code, balance_kobo FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
    [sorted]
  );
  if (rows.length !== sorted.length) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'One of the accounts does not exist');
  return rows;
}

// Undo a transaction by posting its mirror image. The original rows stay.
async function reverseTransaction(client, transactionId, memo) {
  const { rows } = await client.query(
    'SELECT account_id, direction, amount_kobo FROM ledger_entries WHERE transaction_id = $1',
    [transactionId]
  );
  if (rows.length === 0) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'No such ledger transaction');

  const already = await client.query('SELECT 1 FROM ledger_entries WHERE reverses = $1 LIMIT 1', [transactionId]);
  if (already.rowCount > 0) throw new AppError(409, 'ALREADY_REVERSED', 'This transaction was already reversed');

  return postTransaction(client, {
    memo: `reversal: ${memo}`,
    reverses: transactionId,
    entries: rows.map((r) => ({
      accountId: r.account_id,
      direction: r.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amountKobo: r.amount_kobo,
    })),
  });
}

async function getSystemAccountId(client, code) {
  const { rows } = await client.query("SELECT id FROM accounts WHERE type = 'SYSTEM' AND code = $1", [code]);
  if (!rows[0]) throw new Error(`system account ${code} missing; run migrations`);
  return rows[0].id;
}

// Accounts whose stored balance_kobo disagrees with the ledger. Should always
// be empty; recon (Phase 9) will run this nightly.
async function findBalanceMismatches(db) {
  const { rows } = await db.query(`
    SELECT a.id, a.balance_kobo AS stored,
           COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount_kobo ELSE -l.amount_kobo END), 0) AS derived
      FROM accounts a
      LEFT JOIN ledger_entries l ON l.account_id = a.id
     GROUP BY a.id
    HAVING a.balance_kobo <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount_kobo ELSE -l.amount_kobo END), 0)`);
  return rows;
}

module.exports = { postTransaction, reverseTransaction, lockAccounts, getSystemAccountId, findBalanceMismatches };
