// Module 9: the fraud check that runs before a card payment reaches a bank.
//
// Gathers the signals (from the request, the user, earlier payments and the
// velocity counters), hands them to the pure scoring rules, and saves the
// decision with its reasons in fraud_decisions.
const crypto = require('crypto');
const { AppError } = require('../errors');
const { fingerprint } = require('../security/crypto');
const rules = require('./rules');
const velocity = require('./velocity');

const COUNTRY = /^[A-Z]{2}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;

// billing_address is optional ({ line1, city, country }). If given it must be
// well formed. Returns { country, hash } or null.
function parseBillingAddress(input) {
  if (input === undefined || input === null) return null;
  const line1 = String(input.line1 ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const city = String(input.city ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const country = String(input.country ?? '').trim().toUpperCase();
  if (line1.length < 3 || city.length < 2 || !COUNTRY.test(country)) {
    throw new AppError(400, 'INVALID_BILLING_ADDRESS', 'Billing address needs line1, city and a 2-letter country code (e.g. NG)');
  }
  // Normalised first, so "1 Market St" and " 1 market st" are the same
  // address. Keyed HMAC, so the hash can't be reversed by guessing addresses.
  return { country, hash: fingerprint(`addr|${line1}|${city}|${country}`) };
}

function parseDeviceId(header) {
  const id = String(header ?? '').trim();
  return DEVICE_ID.test(id) ? id : null;
}

// Runs the rules for one attempt. `card` is the cards row.
async function assess(db, { userId, accountId, card, billing, deviceId }) {
  const { rows: users } = await db.query(
    // Account age from the database clock, like every other time in the system.
    'SELECT email, EXTRACT(EPOCH FROM now() - created_at) / 86400 AS age_days FROM users WHERE id = $1',
    [userId]
  );
  const { rows: history } = await db.query(
    `SELECT bool_or(device_id = $2) AS device_seen, bool_or(billing_address_hash = $3) AS address_known
       FROM payments WHERE account_id = $1 AND status = 'COMPLETED'`,
    [accountId, deviceId, billing?.hash ?? null]
  );
  const v = await velocity.hit({ userId, cardFingerprint: card.fingerprint }, undefined, { db });

  const result = rules.score({
    email: users[0].email,
    billingCountry: billing?.country ?? null,
    cardCountry: card.issuer_country,
    deviceSeen: Boolean(deviceId && history[0].device_seen),
    accountAgeDays: Number(users[0].age_days),
    knownAddress: Boolean(billing && history[0].address_known),
    velocityBreached: v.breached,
    velocityDetail: v.breached
      ? v.breaches.map((kind) => `${v.counts[kind]} attempts on this ${kind === 'user' ? 'account' : 'card'}`).join(', ')
      : null,
  });
  return { ...result, velocity: v };
}

async function record(client, paymentId, { score, rulesFired, outcome }) {
  await client.query(
    `INSERT INTO fraud_decisions (payment_id, score, rules_fired, outcome, review_status)
     VALUES ($1, $2, $3, $4, $5)`,
    [paymentId, score, JSON.stringify(rulesFired), outcome, outcome === 'APPROVE' ? 'NOT_NEEDED' : 'OPEN']
  );
}

// 6-digit one-time code for the challenge. Only its hash is stored.
function newOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
const hashOtp = (paymentId, otp) => fingerprint(`otp|${paymentId}|${otp}`);
function otpMatches(paymentId, otp, storedHash) {
  if (!/^\d{6}$/.test(String(otp ?? '')) || !storedHash) return false;
  // Constant-time compare, so response timing leaks nothing about the code.
  return crypto.timingSafeEqual(Buffer.from(hashOtp(paymentId, otp)), Buffer.from(storedHash));
}

module.exports = { assess, record, parseBillingAddress, parseDeviceId, newOtp, hashOtp, otpMatches };
