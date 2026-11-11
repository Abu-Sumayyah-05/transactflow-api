// Module 11, stages 3 and 4: match and classify. A pure function: records
// in, one verdict per reference out. No database, no clock.
//
// Three records can exist for one reference:
//   internal  our ledger says we completed it        (internal_kobo)
//   gateway   what the bank told us online, then     (gateway_kobo)
//   bank      the bank's settlement file, tonight    (entries)
//
//   MATCHED              all agree
//   PENDING_SETTLEMENT   ours, not in the file, but completed after the
//                        file's cut-off: it belongs in the NEXT file. This is
//                        timing, not a break.
//   MISSING_FROM_BANK    ours, completed before the cut-off, and the bank's
//                        file doesn't have it: we think money moved, the bank
//                        doesn't
//   MISSING_FROM_SWITCH  in the bank's file, but we have no completed payment
//                        for it: the bank moved money we don't know about
//   AMOUNT_MISMATCH      both have it, the amounts (or direction) differ
//   DUPLICATE_POSTING    the bank posted it more than once
const { formatNaira } = require('../money');

const BREAKS = Object.freeze(['MISSING_FROM_SWITCH', 'MISSING_FROM_BANK', 'AMOUNT_MISMATCH', 'DUPLICATE_POSTING']);

// internal: [{ reference, payment_id, status, direction, internal_kobo, gateway_kobo, completed_at }]
//           (status is the payment's status; only COMPLETED ones count as "ours")
// entries:  [{ reference, direction, amount_kobo }] from the statement
// alreadySettled: Map(reference -> statement_ref) for items MATCHED in an earlier statement
function classify({ internal, entries, cutoff, graceMs = 0, alreadySettled = new Map() }) {
  const ours = new Map(internal.map((p) => [p.reference, p]));
  const byRef = new Map();
  for (const e of entries) byRef.set(e.reference, [...(byRef.get(e.reference) || []), e]);

  const out = [];
  const verdict = (reference, cls, detail, p, bankKobo) =>
    out.push({
      reference,
      class: cls,
      detail,
      payment_id: p?.payment_id ?? null,
      internal_amount: p?.status === 'COMPLETED' ? p.internal_kobo : null,
      gateway_amount: p?.gateway_kobo ?? null,
      bank_amount: bankKobo,
    });

  for (const [reference, posts] of byRef) {
    const p = ours.get(reference);
    const bank = posts[0];
    if (posts.length > 1) {
      verdict(reference, 'DUPLICATE_POSTING', `The bank posted this ${posts.length} times in one statement`, p, bank.amount_kobo);
    } else if (alreadySettled.has(reference)) {
      verdict(reference, 'DUPLICATE_POSTING', `Already settled in statement ${alreadySettled.get(reference)}; the bank posted it again`, p, bank.amount_kobo);
    } else if (!p) {
      verdict(reference, 'MISSING_FROM_SWITCH', 'The bank settled a transaction we have no record of', null, bank.amount_kobo);
    } else if (p.status !== 'COMPLETED') {
      verdict(reference, 'MISSING_FROM_SWITCH', `The bank settled it, but our payment is ${p.status}, not COMPLETED`, p, bank.amount_kobo);
    } else if (bank.direction !== p.direction) {
      verdict(reference, 'AMOUNT_MISMATCH', `The bank posted a ${bank.direction === 'C' ? 'credit' : 'debit'}; we expected a ${p.direction === 'C' ? 'credit' : 'debit'}`, p, bank.amount_kobo);
    } else if (bank.amount_kobo !== p.internal_kobo) {
      verdict(reference, 'AMOUNT_MISMATCH', `Our ledger says ${formatNaira(p.internal_kobo)}; the bank's file says ${formatNaira(bank.amount_kobo)}`, p, bank.amount_kobo);
    } else if (p.gateway_kobo !== null && p.gateway_kobo !== bank.amount_kobo) {
      verdict(reference, 'AMOUNT_MISMATCH', `The bank confirmed ${formatNaira(p.gateway_kobo)} online but its file says ${formatNaira(bank.amount_kobo)}`, p, bank.amount_kobo);
    } else {
      verdict(reference, 'MATCHED', null, p, bank.amount_kobo);
    }
  }

  // Ours, but not in the file.
  const pendingFrom = cutoff.getTime() - graceMs;
  for (const p of internal) {
    if (p.status !== 'COMPLETED' || byRef.has(p.reference) || alreadySettled.has(p.reference)) continue;
    if (p.completed_at.getTime() > pendingFrom) {
      verdict(p.reference, 'PENDING_SETTLEMENT', 'Completed after the statement cut-off; expected in the next file', p, null);
    } else {
      verdict(p.reference, 'MISSING_FROM_BANK', 'Completed before the statement cut-off, but the bank\'s file does not have it', p, null);
    }
  }
  return out;
}

module.exports = { classify, BREAKS };
