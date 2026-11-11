const crypto = require('crypto');
const { formatNaira } = require('../money');
const config = require('../config');
const { classifyDecline, classifyTransferFailure, classifyInternalFailure } = require('./declines');

// Our reference for the bank: unique, unguessable, safe to show on a receipt.
function newReference() {
  return `TF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function create(client, {
  accountId, type, amountKobo, bank, cardToken = null, destinationAccount = null, destinationName = null,
  billingCountry = null, billingAddressHash = null, deviceId = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO payments (reference, account_id, type, amount_kobo, bank, card_token, destination_account,
                           destination_name, billing_country, billing_address_hash, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [newReference(), accountId, type, amountKobo, bank, cardToken, destinationAccount, destinationName,
      billingCountry, billingAddressHash, deviceId]
  );
  await client.query(
    "INSERT INTO payment_events (payment_id, from_status, to_status, reason) VALUES ($1, NULL, 'INITIALIZED', 'created')",
    [rows[0].id]
  );
  return rows[0];
}

async function findForUser(db, paymentId, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const { rows } = await db.query(
    `SELECT p.* FROM payments p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = $1 AND a.user_id = $2`,
    [paymentId, userId]
  );
  return rows[0] || null;
}

async function events(db, paymentId) {
  const { rows } = await db.query(
    'SELECT from_status, to_status, reason, at FROM payment_events WHERE payment_id = $1 ORDER BY id',
    [paymentId]
  );
  return rows;
}

// What went wrong, in words the customer can act on (Module 1).
function declineOf(p) {
  if (p.status !== 'FAILED') return null;
  if (p.failure_code) return classifyInternalFailure(p.failure_code);
  if (!p.response_code) return null;
  return p.type === 'BANK_TRANSFER' ? classifyTransferFailure(p.response_code) : classifyDecline(p.response_code);
}

function customerMessage(p) {
  const isTransfer = p.type === 'BANK_TRANSFER';
  switch (p.status) {
    case 'COMPLETED':
      return isTransfer ? `Sent ${formatNaira(p.amount_kobo)} to ${p.destination_name}` : `Wallet topped up with ${formatNaira(p.amount_kobo)}`;
    case 'UNKNOWN':
      return isTransfer
        ? 'We are confirming this transfer with the bank. Your money is held safely and will not be sent twice.'
        : 'We are confirming this payment with your bank. You will not be charged twice.';
    case 'PENDING':
      return p.challenge_status === 'REQUIRED'
        ? 'Enter the verification code to finish this payment. You will not be charged until you do.'
        : 'Processing';
    case 'FAILED':
      if (declineOf(p)) return declineOf(p).message;
      // No code from anyone: the bank never received it (TSQ said NOT_FOUND).
      return isTransfer
        ? 'The bank did not receive this transfer. Your money has been returned to your wallet.'
        : 'Your bank did not receive this payment, so you have not been charged.';
    default:
      return 'Processing';
  }
}

function present(p) {
  return {
    id: p.id,
    reference: p.reference,
    type: p.type,
    status: p.status,
    amount_kobo: p.amount_kobo,
    amount_display: formatNaira(p.amount_kobo),
    bank: p.bank,
    response_code: p.response_code,
    decline_reason: declineOf(p)?.category ?? null,
    message: customerMessage(p),
    ...(p.type === 'BANK_TRANSFER' && { account_number: p.destination_account, account_name: p.destination_name }),
    ...(p.status === 'PENDING' && p.challenge_status === 'REQUIRED' && {
      challenge: {
        required: true,
        expires_at: p.challenge_expires_at,
        attempts_left: Math.max(0, config.challengeMaxAttempts - p.challenge_attempts),
      },
    }),
    needs_review: p.needs_review,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

module.exports = { create, findForUser, events, present };
