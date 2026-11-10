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
  // Webhooks: process right after receipt (tests turn this off and call
  // processDue themselves); retry with backoff; DLQ after max attempts.
  webhookInlineProcessing: process.env.WEBHOOK_INLINE_PROCESSING !== 'false',
  webhookRetryBaseMs: Number(process.env.WEBHOOK_RETRY_BASE_MS ?? 2000),
  webhookMaxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5),
};
