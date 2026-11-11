// All settings come from environment variables; nothing secret lives in the repo.
require('dotenv').config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

module.exports = {
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  // bcrypt work factor: 12 in production; tests lower it to keep the suite fast.
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 20),
  // How long to wait for a bank before treating the outcome as UNKNOWN.
  gatewayTimeoutMs: Number(process.env.GATEWAY_TIMEOUT_MS || 5000),
  // TSQ: first check after this delay, back off up to the max, give up
  // (flag for human review, never FAILED) after the TTL.
  tsqInitialDelayMs: Number(process.env.TSQ_INITIAL_DELAY_MS ?? 2000),
  tsqMaxBackoffMs: Number(process.env.TSQ_MAX_BACKOFF_MS || 5 * 60 * 1000),
  tsqTtlMs: Number(process.env.TSQ_TTL_MS || 30 * 60 * 1000),
  tsqIntervalMs: Number(process.env.TSQ_INTERVAL_MS || 5000),
  // A payment left in PENDING this long (process crashed mid-call) is swept to UNKNOWN.
  pendingStaleMs: Number(process.env.PENDING_STALE_MS || 2 * 60 * 1000),
  defaultBank: process.env.DEFAULT_BANK || 'A',
  fallbackBank: process.env.FALLBACK_BANK || 'B',
  // Module 8 retries: up to 3 attempts, full-jitter backoff from 200 ms, capped at 2 s.
  retryMaxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 200),
  retryCapMs: Number(process.env.RETRY_CAP_MS || 2000),
  // Module 9 velocity counters (card testing): attempts allowed per window.
  velocityUserLimit: Number(process.env.VELOCITY_USER_LIMIT || 5),
  velocityUserWindowSeconds: Number(process.env.VELOCITY_USER_WINDOW_SECONDS || 60),
  velocityCardLimit: Number(process.env.VELOCITY_CARD_LIMIT || 5),
  velocityCardWindowSeconds: Number(process.env.VELOCITY_CARD_WINDOW_SECONDS || 600),
  // 3DS-style challenge: one-time code lifetime and tries. The code is shown
  // in the API response only when this flag is on (demo and tests; a real
  // issuer would send it to the cardholder's phone instead).
  challengeTtlMs: Number(process.env.CHALLENGE_TTL_MS || 10 * 60 * 1000),
  challengeMaxAttempts: Number(process.env.CHALLENGE_MAX_ATTEMPTS || 3),
  challengeRevealOtp: process.env.CHALLENGE_REVEAL_OTP === 'true',
  // Module 6 payouts. Sub-batches are always 100 (spec); these tune the rest.
  payoutMaxRows: Number(process.env.PAYOUT_MAX_ROWS || 5000),
  payoutMinItemKobo: Number(process.env.PAYOUT_MIN_ITEM_KOBO || 100), // ₦1
  payoutMaxItemKobo: Number(process.env.PAYOUT_MAX_ITEM_KOBO || 500_000_000), // ₦5,000,000
  // Backpressure: items sent at once within a sub-batch, and how many of a
  // batch's payments may be unresolved (PENDING/UNKNOWN) before it pauses.
  payoutConcurrency: Number(process.env.PAYOUT_CONCURRENCY || 10),
  payoutMaxInFlight: Number(process.env.PAYOUT_MAX_IN_FLIGHT || 50),
  payoutLeaseSeconds: Number(process.env.PAYOUT_LEASE_SECONDS || 60),
  payoutIntervalMs: Number(process.env.PAYOUT_INTERVAL_MS || 2000),
  // Webhooks: process right after receipt (tests turn this off and call
  // processDue themselves); retry with backoff; DLQ after max attempts.
  webhookInlineProcessing: process.env.WEBHOOK_INLINE_PROCESSING !== 'false',
  webhookRetryBaseMs: Number(process.env.WEBHOOK_RETRY_BASE_MS ?? 2000),
  webhookMaxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5),
};
