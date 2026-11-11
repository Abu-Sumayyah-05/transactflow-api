// Module 11: defensive parser for an MT940-style bank statement.
//
// MT940 is the SWIFT end-of-day statement. Each line starts with a tag:
//
//   :20:STMT-A-000001                      statement reference
//   :25:TRANSACTFLOW-A/NGN                 our account at the bank
//   :28C:1/1                               statement number
//   :13D:2611112200+0000                   cut-off: entries up to this time
//   :60F:C261111NGN1000,00                 opening balance  (C credit / D debit)
//   :61:2611111111C2500,50NTRFTF-AAA//A1   one transaction: date, C/D, amount,
//                                          type, OUR reference // BANK reference
//   :86:CARD CHARGE TF-AAA                 free text for the line above
//   :62F:C261111NGN3500,50                 closing balance
//
// Amounts use a comma for decimals ("2500,50"). They are turned into integer
// kobo as text; no float is ever involved.
//
// A bank file is someone else's data, so this parser trusts nothing:
//   - it never throws; the result says ok or gives the reason to halt
//   - a line it can't read is FLAGGED (line number, text, reason) and the
//     rest is still read. Nothing is silently skipped.
//   - the balance check decides whether the file can be used at all:
//     opening + credits - debits must equal the closing balance. If a
//     transaction line was damaged, this is what catches it.
const { formatNaira } = require('../money');

// "2500,50" -> 250050. Returns null if it isn't an amount.
function parseAmount(text) {
  const m = /^(\d{1,15}),(\d{0,2})$/.exec(String(text));
  if (!m) return null;
  const kobo = Number(m[1] + m[2].padEnd(2, '0'));
  return Number.isSafeInteger(kobo) ? kobo : null;
}

// "261111" -> "2026-11-11", or null if it isn't a real date.
function parseDate(yymmdd) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(yymmdd);
  if (!m) return null;
  const iso = `20${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

// ":60F:" / ":62F:" value: C|D, date, currency, amount.
function parseBalance(value) {
  const m = /^([CD])(\d{6})([A-Z]{3})(\d+,\d{0,2})$/.exec(value);
  if (!m) return null;
  const date = parseDate(m[2]);
  const amount = parseAmount(m[4]);
  if (!date || amount === null) return null;
  return { kobo: m[1] === 'D' ? -amount : amount, date, currency: m[3] };
}

// ":61:" value: value date, optional entry date, C|D, amount, N + 3-letter
// type, our reference, then // and the bank's reference.
const ENTRY = /^(\d{6})(?:\d{4})?([CD])(\d+,\d{0,2})N[A-Z0-9]{3}([A-Za-z0-9_\-/.]{1,64}?)\/\/([A-Za-z0-9_-]{1,35})$/;
function parseEntry(value) {
  const m = ENTRY.exec(value);
  if (!m) return null;
  const date = parseDate(m[1]);
  const amount = parseAmount(m[3]);
  // Two decimals are required on a transaction: "250,0" is a damaged line.
  if (!date || amount === null || amount === 0 || !/,\d{2}$/.test(m[3])) return null;
  return { direction: m[2], amount_kobo: amount, reference: m[4], bank_reference: m[5], value_date: date };
}

// ":13D:" value: YYMMDDHHMM+HHMM. Our simulator adds seconds and
// milliseconds (YYMMDDHHMMSS.mmm+HHMM); both forms are accepted.
function parseCutoff(value) {
  const m = /^(\d{6})(\d{2})(\d{2})(?:(\d{2})(?:\.(\d{3}))?)?([+-])(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const date = parseDate(m[1]);
  if (!date) return null;
  const d = new Date(`${date}T${m[2]}:${m[3]}:${m[4] || '00'}.${m[5] || '000'}${m[6]}${m[7]}:${m[8]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseStatement(input) {
  const result = {
    ok: false,
    halt: null,
    reference: null,
    account: null,
    currency: null,
    statement_date: null,
    cutoff: null,
    opening_kobo: null,
    closing_kobo: null,
    computed_closing_kobo: null,
    entries: [],
    flagged: [],
  };
  const stop = (why) => ({ ...result, ok: false, halt: why });

  const text = typeof input === 'string' ? input : '';
  if (text.trim() === '') return stop('The statement file is empty');

  const flag = (line, raw, reason) => result.flagged.push({ line, text: raw.slice(0, 200), reason });
  let opening = null;
  let closing = null;
  let openingBad = false;
  let closingBad = false;
  let lastEntry = null;

  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') return;
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw.trim());
    if (!m) return flag(line, raw, 'not a tagged line');
    const [, tag, value] = m;

    switch (tag) {
      case '20':
        result.reference = value.slice(0, 64);
        break;
      case '25':
        result.account = value.slice(0, 64);
        break;
      case '28C':
        break;
      case '13D':
        result.cutoff = parseCutoff(value);
        if (!result.cutoff) flag(line, raw, 'unreadable cut-off time');
        break;
      case '60F':
        opening = parseBalance(value);
        openingBad = !opening;
        if (openingBad) flag(line, raw, 'unreadable opening balance');
        break;
      case '62F':
        closing = parseBalance(value);
        closingBad = !closing;
        if (closingBad) flag(line, raw, 'unreadable closing balance');
        break;
      case '61': {
        const entry = parseEntry(value);
        if (!entry) {
          lastEntry = null;
          return flag(line, raw, 'unreadable transaction line');
        }
        lastEntry = { line, ...entry, narrative: null };
        result.entries.push(lastEntry);
        break;
      }
      case '86':
        if (lastEntry && lastEntry.narrative === null) lastEntry.narrative = value.slice(0, 200);
        break;
      default:
        flag(line, raw, `unknown tag :${tag}:`);
    }
    return undefined;
  });

  if (!opening) return stop(openingBad ? 'The opening balance (:60F:) is unreadable' : 'The file has no opening balance (:60F:)');
  if (!closing) return stop(closingBad ? 'The closing balance (:62F:) is unreadable' : 'The file has no closing balance (:62F:)');

  result.opening_kobo = opening.kobo;
  result.closing_kobo = closing.kobo;
  result.currency = closing.currency;
  result.statement_date = closing.date;
  if (!result.cutoff) result.cutoff = new Date(`${closing.date}T23:59:59.999Z`);

  // The balance check. Integers only.
  const movement = result.entries.reduce((sum, e) => sum + (e.direction === 'C' ? e.amount_kobo : -e.amount_kobo), 0);
  result.computed_closing_kobo = opening.kobo + movement;
  if (result.computed_closing_kobo !== closing.kobo) {
    const plain = (k) => formatNaira(k).replace(/[₦,]/g, '');
    return stop(
      `The closing balance in the file is ${plain(closing.kobo)} but the opening balance plus the ${result.entries.length} ` +
        `readable transactions comes to ${plain(result.computed_closing_kobo)}. The file is incomplete or altered, so it was not used.`
    );
  }
  result.ok = true;
  return result;
}

module.exports = { parseStatement, parseAmount };
