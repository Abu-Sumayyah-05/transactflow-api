// Module 6: reading a payout CSV and the pre-send checks that need no bank.
//
// Pure functions: text in, rows with a verdict out. No database, no network,
// so every rule can be tested exactly.
//
// File format (header required, columns in any order, extra columns ignored):
//   bank,account_number,account_name,amount,reference
//   A,0123456789,Ngozi Eze,1500.00,INV-0001
//
// amount is in naira (what a person types), turned into integer kobo as text,
// never through a float. reference is the merchant's own ID for the row.
const { AppError } = require('../errors');
const { nairaToKobo } = require('../money');

const HEADER = Object.freeze(['bank', 'account_number', 'account_name', 'amount', 'reference']);
const BANKS = new Set(['A', 'B']);
const NUBAN = /^\d{10}$/;
const REFERENCE = /^[A-Za-z0-9_\-/.]{1,64}$/;

const fileError = (message) => new AppError(400, 'INVALID_CSV', message);

// Splits CSV text into records of fields (RFC 4180: "quoted, fields" and
// "" for a quote inside quotes). A newline inside quotes stays in the field.
function records(text) {
  const out = [];
  let record = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      out.push({ line: recordLine, fields: record });
      record = [];
      field = '';
      line += 1;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (quoted) throw fileError(`Unterminated quote in the record starting on line ${recordLine}`);
  if (field !== '' || record.length) {
    record.push(field);
    out.push({ line: recordLine, fields: record });
  }
  // Blank lines carry no data.
  return out.filter((r) => !(r.fields.length === 1 && r.fields[0].trim() === ''));
}

// Returns { rows: [{ row, fields } | { row, malformed: true }] }. `row` is the
// line number in the file, so the report points the merchant at the right line.
function parseCsv(text, { maxRows = Infinity } = {}) {
  const all = records(String(text ?? '').replace(/^﻿/, ''));
  if (all.length === 0) throw fileError('The file is empty');

  const names = all[0].fields.map((h) => h.trim().toLowerCase());
  const missing = HEADER.filter((h) => !names.includes(h));
  if (missing.length) throw fileError(`Missing column(s): ${missing.join(', ')}. The header must include ${HEADER.join(',')}`);
  const index = Object.fromEntries(HEADER.map((h) => [h, names.indexOf(h)]));

  const body = all.slice(1);
  if (body.length === 0) throw fileError('The file has a header but no payout rows');
  if (body.length > maxRows) throw fileError(`Too many rows: ${body.length} (the limit is ${maxRows} per batch)`);

  return {
    rows: body.map(({ line, fields }) => {
      if (fields.length !== names.length) return { row: line, malformed: true };
      return { row: line, fields: Object.fromEntries(HEADER.map((h) => [h, fields[index[h]].trim()])) };
    }),
  };
}

// One row -> an item, or the first reason it can't be paid.
function checkFormat(fields, limits) {
  const bank = fields.bank.toUpperCase();
  if (!BANKS.has(bank)) return { reason: 'INVALID_BANK' };
  if (!NUBAN.test(fields.account_number)) return { reason: 'INVALID_ACCOUNT_NUMBER' };
  const name = fields.account_name.replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) return { reason: 'INVALID_ACCOUNT_NAME' };
  let amountKobo;
  try {
    amountKobo = nairaToKobo(fields.amount);
  } catch {
    return { reason: 'INVALID_AMOUNT' };
  }
  // Amount sanity: catches "15" typed as "1500000" and other slips.
  if (amountKobo < limits.minKobo) return { reason: 'AMOUNT_TOO_SMALL' };
  if (amountKobo > limits.maxKobo) return { reason: 'AMOUNT_TOO_LARGE' };
  if (!REFERENCE.test(fields.reference)) return { reason: 'INVALID_REFERENCE' };
  return { item: { bank, account_number: fields.account_number, account_name: name, amount_kobo: amountKobo, reference: fields.reference } };
}

// Runs the checks over every row. `usedReferences` holds the merchant's
// references from earlier batches. Duplicates inside the file: the first
// valid row wins, later ones are rejected.
function checkRows(rows, { limits, usedReferences = new Set() }) {
  const seenRefs = new Set();
  const seenPayments = new Set();
  return rows.map(({ row, fields, malformed }) => {
    const empty = { bank: null, account_number: null, account_name: null, amount_kobo: null, reference: null };
    if (malformed) return { row, ...empty, status: 'REJECTED', reason: 'MALFORMED_ROW' };

    const { item, reason } = checkFormat(fields, limits);
    if (reason) {
      return { row, ...empty, ...pickRaw(fields), status: 'REJECTED', reason };
    }
    let dup = null;
    if (usedReferences.has(item.reference) || seenRefs.has(item.reference)) dup = 'DUPLICATE_REFERENCE';
    else if (seenPayments.has(`${item.bank}|${item.account_number}|${item.amount_kobo}`)) dup = 'DUPLICATE_PAYMENT';
    if (dup) return { row, ...item, status: 'REJECTED', reason: dup };

    seenRefs.add(item.reference);
    seenPayments.add(`${item.bank}|${item.account_number}|${item.amount_kobo}`);
    return { row, ...item, status: 'VALID', reason: null };
  });
}

// Keeps what the merchant typed on a rejected row, so the report shows it.
function pickRaw(fields) {
  return {
    bank: fields.bank.slice(0, 10) || null,
    account_number: fields.account_number.slice(0, 20) || null,
    account_name: fields.account_name.slice(0, 100) || null,
    reference: fields.reference.slice(0, 64) || null,
  };
}

// Name enquiry vs the CSV: same words, ignoring case, punctuation, spacing
// and order ("Eze, Ngozi" = "NGOZI EZE"). A different or missing word fails.
function namesMatch(a, b) {
  const words = (s) => String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return words(a) !== '' && words(a) === words(b);
}

module.exports = { parseCsv, checkRows, namesMatch, HEADER };
