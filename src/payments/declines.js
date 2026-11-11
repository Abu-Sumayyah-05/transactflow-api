// Module 1: decline classifier.
//
// A card issuer answers with a two-character ISO 8583 response code. "00" is
// approved; everything else is a reason for saying no. Customers can't act on
// "declined (51)", so each code is mapped to a category (for the app and the
// metrics) and a message that says what happened AND what to do next.
//
// The six categories the spec names come first; a few other common codes
// follow. Any code we have never seen still gets a useful message.

const CARD_DECLINES = Object.freeze({
  // insufficient funds
  51: {
    category: 'INSUFFICIENT_FUNDS',
    message: 'Your card has insufficient funds for this amount. Try a smaller amount or another card.',
  },
  // "transaction not permitted to cardholder" / "restricted card": in
  // Nigeria this is almost always a card not enabled for online or
  // international use.
  57: {
    category: 'INTERNATIONAL_DISABLED',
    message: 'Your card is not enabled for online or international payments. Enable it in your bank app, or use another card.',
  },
  62: {
    category: 'INTERNATIONAL_DISABLED',
    message: 'Your card is restricted from this kind of payment (often international or online use). Ask your bank to enable it, or use another card.',
  },
  // exceeds amount limit / exceeds frequency limit
  61: {
    category: 'FX_LIMIT',
    message: 'This payment is over your card\'s spending limit (for foreign-currency cards, the FX limit). Try a smaller amount or contact your bank.',
  },
  65: {
    category: 'FX_LIMIT',
    message: 'You have reached the number of payments your card allows for now. Try again later or contact your bank to raise the limit.',
  },
  // suspected fraud
  59: {
    category: 'SUSPECTED_FRAUD',
    message: 'Your bank stopped this payment as a security precaution. Contact your bank to confirm it was you, then try again.',
  },
  34: {
    category: 'SUSPECTED_FRAUD',
    message: 'Your bank flagged this payment for a security check. Contact your bank to confirm it was you, then try again.',
  },
  // expired card
  54: {
    category: 'CARD_EXPIRED',
    message: 'This card has expired. Add your new card and try again.',
  },
  // CVV checks: 82 (negative CVV result) and N7 (Visa CVV2 mismatch)
  82: {
    category: 'INVALID_CVV',
    message: 'The CVV (the 3 digits on the back of your card) was incorrect. Add the card again with the right CVV.',
  },
  N7: {
    category: 'INVALID_CVV',
    message: 'The CVV (the 3 digits on the back of your card) was incorrect. Add the card again with the right CVV.',
  },
  // other common ones
  '05': {
    category: 'DO_NOT_HONOR',
    message: 'Your bank declined this payment without giving a reason. Contact your bank, or try another card.',
  },
  14: {
    category: 'INVALID_CARD',
    message: 'Your bank does not recognise this card number. Check the card details, or try another card.',
  },
  91: {
    category: 'ISSUER_UNAVAILABLE',
    message: 'Your bank could not be reached to approve this payment. You have not been charged; please try again in a few minutes.',
  },
});

// Bank transfers fail for different reasons; the money is always returned.
const TRANSFER_FAILURES = Object.freeze({
  25: { category: 'ACCOUNT_NOT_FOUND', message: 'The receiving bank could not find that account. Your money has been returned to your wallet.' },
  57: { category: 'NOT_PERMITTED', message: 'The receiving account cannot accept this transfer. Your money has been returned to your wallet.' },
  61: { category: 'LIMIT_EXCEEDED', message: 'This transfer is over the receiving bank\'s limit. Your money has been returned to your wallet; try a smaller amount.' },
  91: { category: 'ISSUER_UNAVAILABLE', message: 'The receiving bank is unavailable. Your money has been returned to your wallet; try again shortly.' },
});

// Failures decided by US, not by a bank (payments.failure_code). None of
// these ever reached a bank, so the customer was never charged.
const INTERNAL_FAILURES = Object.freeze({
  FRAUD_BLOCKED: {
    category: 'BLOCKED_BY_RISK',
    message: 'We stopped this payment to protect your account. You have not been charged. If this was you, wait a few minutes and try again, or contact support.',
  },
  REVIEW_BLOCKED: {
    category: 'BLOCKED_BY_RISK',
    message: 'Our risk team cancelled this payment after review. You have not been charged. Contact support if you think this is a mistake.',
  },
  CHALLENGE_FAILED: {
    category: 'CHALLENGE_FAILED',
    message: 'The verification code was entered wrongly too many times, so this payment was cancelled. You have not been charged; you can start a new payment.',
  },
  CHALLENGE_EXPIRED: {
    category: 'CHALLENGE_EXPIRED',
    message: 'The verification step was not completed in time, so this payment was cancelled. You have not been charged; you can start a new payment.',
  },
});

const classifyInternalFailure = (code) => ({ code, ...INTERNAL_FAILURES[code] });

function classifyDecline(code) {
  const known = CARD_DECLINES[String(code)];
  if (known) return { code: String(code), ...known };
  return {
    code: String(code),
    category: 'OTHER',
    message: `Your bank declined this payment (reason code ${code}). Contact your bank, or try another card.`,
  };
}

function classifyTransferFailure(code) {
  const known = TRANSFER_FAILURES[String(code)];
  if (known) return { code: String(code), ...known };
  return {
    code: String(code),
    category: 'OTHER',
    message: `The receiving bank rejected this transfer (reason code ${code}). Your money has been returned to your wallet.`,
  };
}

module.exports = { classifyDecline, classifyTransferFailure, classifyInternalFailure, CARD_DECLINES, TRANSFER_FAILURES, INTERNAL_FAILURES };
