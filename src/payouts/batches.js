// Module 6: accepting a payout batch and reporting on it.
//
// Upload (POST /payouts/batches, idempotent):
//   1. parse the CSV and run the checks that need no bank (csv.js)
//   2. in ONE transaction: create the batch and its items, split the valid
//      items into sub-batches of 100, and reserve their total
//      (wallet -> PAYOUTS_RESERVED). If the wallet can't cover it the whole
//      transaction rolls back: no batch, no items, no money moved.
// Sending happens later, in runner.js.
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const config = require('../config');
const ledger = require('../ledger/ledger');
const { formatNaira } = require('../money');
const { parseCsv, checkRows } = require('./csv');

const SUB_BATCH_SIZE = 100; // spec: sub-batches of 100

async function walletOf(db, userId) {
  const { rows } = await db.query("SELECT id FROM accounts WHERE user_id = $1 AND type = 'WALLET'", [userId]);
  if (!rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No wallet found for this user');
  return rows[0].id;
}

// References this merchant has already used on rows that weren't rejected.
async function usedReferences(db, merchantId, refs) {
  const { rows } = await db.query(
    "SELECT reference FROM payout_items WHERE merchant_id = $1 AND status <> 'REJECTED' AND reference = ANY($2::text[])",
    [merchantId, refs]
  );
  return new Set(rows.map((r) => r.reference));
}

async function upload({ merchantId, csvText }, idem) {
  if (typeof csvText !== 'string' || csvText.length === 0) {
    throw new AppError(400, 'INVALID_CSV', 'Send the CSV as the request body with Content-Type: text/csv');
  }
  const { rows } = parseCsv(csvText, { maxRows: config.payoutMaxRows });
  const refs = rows.filter((r) => r.fields).map((r) => r.fields.reference);
  const items = checkRows(rows, {
    limits: { minKobo: config.payoutMinItemKobo, maxKobo: config.payoutMaxItemKobo },
    usedReferences: await usedReferences(pool, merchantId, refs),
  });
  const valid = items.filter((i) => i.status === 'VALID');
  const total = valid.reduce((sum, i) => sum + i.amount_kobo, 0);
  if (!Number.isSafeInteger(total)) throw new AppError(400, 'INVALID_AMOUNT', 'The batch total is too large');

  return withTransaction(async (client) => {
    const accountId = await walletOf(client, merchantId);
    const { rows: created } = await client.query(
      `INSERT INTO payout_batches (merchant_id, account_id, status, total_rows, valid_rows, reserved_kobo, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 0 THEN now() END) RETURNING *`,
      [merchantId, accountId, valid.length ? 'QUEUED' : 'DONE', items.length, valid.length, total]
    );
    const batch = created[0];

    if (total > 0) {
      // Throws INSUFFICIENT_FUNDS (422) and rolls everything back.
      const txId = await ledger.postTransaction(client, {
        memo: `payout batch ${batch.id} reserved`,
        entries: [
          { accountId, direction: 'DEBIT', amountKobo: total },
          { accountId: await ledger.getSystemAccountId(client, 'PAYOUTS_RESERVED'), direction: 'CREDIT', amountKobo: total },
        ],
      });
      await client.query('UPDATE payout_batches SET reserve_transaction_id = $2 WHERE id = $1', [batch.id, txId]);
    }

    // Valid items in file order: 1-100 -> sub-batch 1, 101-200 -> 2, ...
    let n = 0;
    const toRows = items.map((i) => {
      const isValid = i.status === 'VALID';
      const sub = isValid ? Math.floor(n++ / SUB_BATCH_SIZE) + 1 : null; // eslint-disable-line no-plusplus
      return {
        row_number: i.row,
        sub_batch: sub,
        bank: i.bank,
        account_number: i.account_number,
        account_name: i.account_name,
        amount_kobo: i.amount_kobo,
        reference: i.reference,
        // Per-item idempotency key, also the bank reference: PO-<batch>-<row>.
        idempotency_key: isValid ? `PO-${batch.id.replace(/-/g, '')}-${i.row}` : null,
        status: isValid ? 'QUEUED' : 'REJECTED',
        reason: i.reason,
      };
    });
    // One INSERT for all rows (thousands of round trips would be slow).
    await client.query(
      `INSERT INTO payout_items (batch_id, merchant_id, row_number, sub_batch, bank, account_number, account_name,
                                 amount_kobo, reference, idempotency_key, status, reason)
       SELECT $1, $2, r.row_number, r.sub_batch, r.bank, r.account_number, r.account_name,
              r.amount_kobo, r.reference, r.idempotency_key, r.status, r.reason
         FROM jsonb_to_recordset($3::jsonb) AS r(row_number int, sub_batch int, bank text, account_number text,
              account_name text, amount_kobo bigint, reference text, idempotency_key text, status text, reason text)`,
      [batch.id, merchantId, JSON.stringify(toRows)]
    ).catch((err) => {
      // Two uploads racing with the same reference: the unique index decides.
      if (err.code === '23505' && /merchant_reference/.test(err.constraint || '')) {
        throw new AppError(409, 'DUPLICATE_REFERENCE', 'A reference in this file is being paid by another batch right now');
      }
      throw err;
    });

    const subs = Math.ceil(valid.length / SUB_BATCH_SIZE);
    for (let s = 1; s <= subs; s += 1) {
      const size = Math.min(SUB_BATCH_SIZE, valid.length - (s - 1) * SUB_BATCH_SIZE);
      await client.query('INSERT INTO payout_sub_batches (batch_id, number, size) VALUES ($1, $2, $3)', [batch.id, s, size]);
    }

    const body = await summary(client, batch.id);
    await idem.complete(client, 202, body);
    return { status: 202, body };
  });
}

// An item's outcome: its own status until it is sent, then its payment's.
const ITEM_STATUS_SQL = `CASE
    WHEN i.status = 'REJECTED' THEN 'REJECTED'
    WHEN i.status = 'QUEUED' THEN 'QUEUED'
    WHEN p.status = 'COMPLETED' THEN 'PAID'
    WHEN p.status = 'FAILED' THEN 'FAILED'
    ELSE 'PROCESSING' END`;

async function summary(db, batchId) {
  const { rows: b } = await db.query('SELECT * FROM payout_batches WHERE id = $1', [batchId]);
  const batch = b[0];
  const { rows: subs } = await db.query(
    'SELECT number, size, status, started_at, finished_at FROM payout_sub_batches WHERE batch_id = $1 ORDER BY number',
    [batchId]
  );
  const { rows: counts } = await db.query(
    `SELECT ${ITEM_STATUS_SQL} AS s, COUNT(*)::int AS n,
            COALESCE(SUM(i.amount_kobo), 0)::bigint AS kobo
       FROM payout_items i LEFT JOIN payments p ON p.id = i.payment_id
      WHERE i.batch_id = $1 GROUP BY 1`,
    [batchId]
  );
  const c = { queued: 0, processing: 0, paid: 0, failed: 0, rejected: 0 };
  let paidKobo = 0;
  for (const r of counts) {
    c[r.s.toLowerCase()] = r.n;
    if (r.s === 'PAID') paidKobo = r.kobo;
  }
  // Progress = valid items that reached a final outcome (paid, failed, or
  // rejected by name enquiry at send time).
  const finishedValid = batch.valid_rows - c.queued - c.processing;
  return {
    id: batch.id,
    status: batch.status,
    total_rows: batch.total_rows,
    valid_rows: batch.valid_rows,
    reserved_kobo: batch.reserved_kobo,
    paid_kobo: paidKobo,
    paid_display: formatNaira(paidKobo),
    progress_percent: batch.valid_rows ? Math.floor((finishedValid * 100) / batch.valid_rows) : 100,
    counts: c,
    sub_batches: subs,
    created_at: batch.created_at,
    completed_at: batch.completed_at,
  };
}

async function items(db, batchId) {
  const { rows } = await db.query(
    `SELECT i.row_number AS row, i.reference, i.bank, i.account_number, i.account_name, i.amount_kobo,
            ${ITEM_STATUS_SQL} AS status,
            COALESCE(i.reason, p.failure_code, CASE WHEN p.status = 'FAILED' THEN 'BANK_' || COALESCE(p.response_code, 'NO_RECORD') END) AS reason,
            i.resolved_name, i.sub_batch, p.reference AS payment_reference, p.id AS payment_id
       FROM payout_items i LEFT JOIN payments p ON p.id = i.payment_id
      WHERE i.batch_id = $1 ORDER BY i.row_number`,
    [batchId]
  );
  return rows;
}

async function report(merchantId, batchId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(batchId))) throw new AppError(404, 'BATCH_NOT_FOUND', 'Payout batch not found');
  const { rows } = await pool.query('SELECT 1 FROM payout_batches WHERE id = $1 AND merchant_id = $2', [batchId, merchantId]);
  if (!rows[0]) throw new AppError(404, 'BATCH_NOT_FOUND', 'Payout batch not found');
  return { ...(await summary(pool, batchId)), items: await items(pool, batchId) };
}

async function list(merchantId) {
  const { rows } = await pool.query(
    'SELECT id FROM payout_batches WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50',
    [merchantId]
  );
  return Promise.all(rows.map((r) => summary(pool, r.id)));
}

// The itemised report as a CSV file the merchant can open in a spreadsheet.
const plainNaira = (kobo) => (kobo == null ? '' : `${Math.trunc(kobo / 100)}.${String(kobo % 100).padStart(2, '0')}`);
function cell(value) {
  const s = value == null ? '' : String(value);
  // Quote when needed; a leading = + - @ is neutralised so a spreadsheet
  // never runs a merchant-supplied cell as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
function reportCsv(r) {
  const head = 'row,reference,bank,account_number,account_name,amount,status,reason,resolved_name,payment_reference';
  const lines = r.items.map((i) =>
    [i.row, i.reference, i.bank, i.account_number, i.account_name, plainNaira(i.amount_kobo), i.status, i.reason, i.resolved_name, i.payment_reference]
      .map(cell)
      .join(',')
  );
  return [head, ...lines].join('\n') + '\n';
}

module.exports = { upload, report, list, summary, reportCsv, SUB_BATCH_SIZE };
