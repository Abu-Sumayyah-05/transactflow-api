// Mock bank: writes the end-of-day settlement file in MT940 style (see
// src/recon/mt940.js for the format). From the bank's side of our account:
//   C  an approved card charge (the bank owes us the money)
//   D  a transfer it paid out for us
//
// The `faults` are the simulator's settlement modes. Each produces a file
// that is wrong in one specific way, so reconciliation can be shown catching it:
//   badLine       a junk line in the middle of the file
//   missing       leaves one item out (true = the first, or a reference)
//   wrongClosing  closing balance off by ₦1.00
//   wrongAmount   one item ₦100.00 higher than it should be
//   duplicate     one item posted twice
//   extra         an item we never sent
// Except for wrongClosing, the file still adds up: the bank's own books agree
// with what it wrote. That is what makes these breaks hard to spot by eye.
const crypto = require('crypto');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const yymmdd = (d) => `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
// Integer kobo -> "2500,50". No floats.
const amount = (kobo) => `${Math.trunc(Math.abs(kobo) / 100)},${pad(Math.abs(kobo) % 100)}`;
const balance = (kobo, d) => `${kobo < 0 ? 'D' : 'C'}${yymmdd(d)}NGN${amount(kobo)}`;

const pick = (items, which) => (which === true ? items[0] : items.find((i) => i.reference === which));

// items: [{ direction: 'C'|'D', amount_kobo, reference, bank_reference, kind }]
// Returns { text, closing_kobo } where closing_kobo is the true closing balance.
function buildStatement({ bank, seq, openingKobo, items, cutoff, faults = {} }) {
  let lines = items.map((i) => ({ ...i }));

  if (faults.missing) {
    const gone = pick(lines, faults.missing);
    lines = lines.filter((l) => l !== gone);
  }
  if (faults.wrongAmount) {
    const wrong = pick(lines, faults.wrongAmount);
    if (wrong) wrong.amount_kobo += 10000;
  }
  if (faults.duplicate) {
    const twice = pick(lines, faults.duplicate);
    if (twice) lines.push({ ...twice });
  }
  if (faults.extra) {
    lines.push({
      direction: 'C',
      amount_kobo: 123400,
      reference: `TF-GHOST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      bank_reference: `${bank}${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      kind: 'CARD CHARGE',
    });
  }

  const closing = lines.reduce((sum, l) => sum + (l.direction === 'C' ? l.amount_kobo : -l.amount_kobo), openingKobo);
  const day = yymmdd(cutoff);
  const out = [
    `:20:STMT-${bank}-${pad(seq, 6)}`,
    `:25:TRANSACTFLOW-${bank}/NGN`,
    `:28C:${seq}/1`,
    // Cut-off: entries up to this instant are in this file. (Real MT940
    // stops at minutes; ours carries seconds so the demo can be precise.)
    `:13D:${day}${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}.${pad(cutoff.getUTCMilliseconds(), 3)}+0000`,
    `:60F:${balance(openingKobo, cutoff)}`,
  ];
  lines.forEach((l, i) => {
    out.push(`:61:${day}${day.slice(2)}${l.direction}${amount(l.amount_kobo)}NTRF${l.reference}//${l.bank_reference}`);
    out.push(`:86:${l.kind} ${l.reference}`);
    if (faults.badLine && i === 0) out.push('#### CORRUPTED RECORD 0x7F ####');
  });
  if (faults.badLine && lines.length === 0) out.push('#### CORRUPTED RECORD 0x7F ####');
  out.push(`:62F:${balance(closing + (faults.wrongClosing ? 100 : 0), cutoff)}`);

  return { text: `${out.join('\r\n')}\r\n`, closing_kobo: closing };
}

module.exports = { buildStatement };
