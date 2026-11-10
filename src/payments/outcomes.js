// Turns a gateway outcome into a state change plus the matching ledger
// entries. Used by the live request AND by the TSQ job, so a payment is
// settled the same way whichever of them learns the answer first.
//
// Rule 7: money only moves on SUCCESS (the bank confirmed it).
const config = require('../config');
const ledger = require('../ledger/ledger');
const sm = require('./stateMachine');

const SETTLES_FROM = new Set(['PENDING', 'UNKNOWN']);

async function settleSuccess(client, p, result) {
  const set = { response_code: result.responseCode ?? null, bank_reference: result.bankReference ?? null, tsq_next_at: null };
  if (p.type === 'CARD_TOPUP') {
    // Bank approved the charge: it owes us the money; we owe the customer.
    await sm.transition(client, p.id, 'AUTHORIZED', { reason: 'bank approved', set });
    const txId = await ledger.postTransaction(client, {
      memo: `card top-up ${p.reference}`,
      entries: [
        { accountId: await ledger.getSystemAccountId(client, 'CARD_SETTLEMENT'), direction: 'DEBIT', amountKobo: p.amount_kobo },
        { accountId: p.account_id, direction: 'CREDIT', amountKobo: p.amount_kobo },
      ],
    });
    return sm.transition(client, p.id, 'COMPLETED', { reason: 'wallet credited', set: { ledger_transaction_id: txId } });
  }
  // Bank paid the recipient: release the hold to what we owe the bank.
  const txId = await ledger.postTransaction(client, {
    memo: `bank transfer ${p.reference}`,
    entries: [
      { accountId: await ledger.getSystemAccountId(client, 'TRANSFERS_IN_FLIGHT'), direction: 'DEBIT', amountKobo: p.amount_kobo },
      { accountId: await ledger.getSystemAccountId(client, 'PAYOUT_SETTLEMENT'), direction: 'CREDIT', amountKobo: p.amount_kobo },
    ],
  });
  return sm.transition(client, p.id, 'COMPLETED', { reason: 'bank confirmed', set: { ...set, ledger_transaction_id: txId } });
}

async function settleFailure(client, p, result, reason) {
  if (p.type === 'BANK_TRANSFER' && p.hold_transaction_id) {
    // Give the held money back with a reversing entry (never by editing).
    await ledger.reverseTransaction(client, p.hold_transaction_id, `transfer ${p.reference} failed`);
  }
  return sm.transition(client, p.id, 'FAILED', {
    reason,
    set: { response_code: result.responseCode ?? null, bank_reference: result.bankReference ?? null, tsq_next_at: null },
  });
}

// The bank's answer is not known. First time: move to UNKNOWN and schedule a
// TSQ. Already UNKNOWN: back off, or past the TTL flag it for a human.
async function markUnknown(client, p, result) {
  if (p.status === 'PENDING') {
    return sm.transition(client, p.id, 'UNKNOWN', {
      reason: result.reason || 'no answer from bank',
      set: {
        tsq_next_at: new Date(Date.now() + config.tsqInitialDelayMs),
        tsq_expires_at: new Date(Date.now() + config.tsqTtlMs),
      },
    });
  }
  const attempts = p.tsq_attempts + 1;
  const expired = p.tsq_expires_at && new Date(p.tsq_expires_at) <= new Date();
  const backoffMs = Math.min(1000 * 2 ** attempts, config.tsqMaxBackoffMs);
  const { rows } = await client.query(
    `UPDATE payments SET tsq_attempts = $2, updated_at = now(),
            tsq_next_at = CASE WHEN $3 THEN NULL ELSE now() + make_interval(secs => $4::float8 / 1000) END,
            needs_review = needs_review OR $3
      WHERE id = $1 RETURNING *`,
    [p.id, attempts, Boolean(expired), backoffMs]
  );
  return rows[0];
}

// Applies one outcome. Safe to call twice: once a payment is final, later
// answers are ignored.
async function applyOutcome(client, paymentId, result) {
  const { rows } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  const p = rows[0];
  if (!SETTLES_FROM.has(p.status)) return p;

  switch (result.outcome) {
    case 'SUCCESS':
      return settleSuccess(client, p, result);
    case 'DECLINED':
      return settleFailure(client, p, result, 'bank declined');
    case 'NOT_FOUND':
      return settleFailure(client, p, result, 'bank has no record (never processed)');
    default:
      return markUnknown(client, p, result);
  }
}

module.exports = { applyOutcome };
