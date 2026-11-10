// Module 7: Idempotency-Key handling, in two layers.
//
//   Redis   SET idem:<scope>:<key> <hash> NX EX 86400
//           A fast lock. The first request to arrive wins in about a
//           millisecond, and a reused key with a different body is refused
//           without touching the database.
//   Postgres idempotency_keys (key, scope) primary key
//           The source of truth. It survives a Redis restart, and the saved
//           response commits in the SAME transaction as the money movement.
//
// The flow for a money-moving POST:
//   1. lock:     Redis SETNX; if the key exists with a different hash -> 409.
//   2. claim:    insert the key row as IN_PROGRESS (only one request can win).
//   3. work:     the route does its business logic.
//   4. complete: the route saves its response on the key row inside its
//                money transaction.
//   5. release:  if the work fails BEFORE anything was sent to a bank, the key
//                is freed so the client can retry with it.
//
// A second request with the same key then gets:
//   different body                     -> 409 IDEMPOTENCY_KEY_REUSED
//   key linked to a payment            -> that payment's LIVE status (even if
//                                         the first request crashed midway)
//   same body + COMPLETED              -> the stored response, replayed
//   same body + IN_PROGRESS, no payment-> 409 REQUEST_IN_PROGRESS
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { redis } = require('../redis');

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,255}$/;
const TTL_SECONDS = 24 * 60 * 60;

// The same JSON with keys in a different order must hash the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(body) {
  return crypto.createHash('sha256').update(canonical(body ?? {})).digest('hex');
}

const lockKeyOf = ({ key, scope }) => `idem:${scope}:${key}`;

// Returns 'ACQUIRED', 'EXISTS' or 'UNAVAILABLE' (Redis down: use the DB alone).
async function redisLock(ref, requestHash) {
  try {
    const ok = await redis().set(lockKeyOf(ref), requestHash, 'EX', TTL_SECONDS, 'NX');
    if (ok === 'OK') return 'ACQUIRED';
    const existing = await redis().get(lockKeyOf(ref));
    if (existing && existing !== requestHash) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
    }
    return 'EXISTS';
  } catch (err) {
    if (err instanceof AppError) throw err;
    return 'UNAVAILABLE';
  }
}

async function claim({ key, scope }, requestHash) {
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (key, scope, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (key, scope) DO UPDATE
        SET request_hash = EXCLUDED.request_hash, status = 'IN_PROGRESS', payment_id = NULL,
            response_code = NULL, response = NULL, created_at = now(),
            expires_at = now() + interval '24 hours'
      WHERE idempotency_keys.expires_at < now()   -- an expired key may be reused
     RETURNING key`,
    [key, scope, requestHash]
  );
  if (inserted.rowCount === 1) return { owned: true };

  const { rows } = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1 AND scope = $2', [key, scope]);
  const existing = rows[0];
  if (!existing) return claim({ key, scope }, requestHash); // released between our two queries
  if (existing.request_hash !== requestHash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
  }
  return { owned: false, existing };
}

async function release(ref) {
  await pool.query("DELETE FROM idempotency_keys WHERE key = $1 AND scope = $2 AND status = 'IN_PROGRESS'", [ref.key, ref.scope]);
  await redis().del(lockKeyOf(ref)).catch(() => {});
}

// Wraps a route. The handler gets (req, idem) and must:
//   - call idem.complete(client, status, body) inside its money transaction
//   - call idem.sideEffectsStarted() before contacting a bank
//   - call idem.linkPayment(client, paymentId) when it creates a payment
//   - return { status, body }
// options.livePaymentResponse(paymentId) answers retries of payment-linked keys.
function idempotent(routeName, handler, { livePaymentResponse } = {}) {
  return async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header');
    if (!KEY_RE.test(key)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8-255 letters, digits or - _ : .');
    }
    const ref = { key, scope: `${req.user.id}:${routeName}` };
    const requestHash = hashRequest(req.body);

    await redisLock(ref, requestHash);
    const claimed = await claim(ref, requestHash);

    if (!claimed.owned) {
      const { existing } = claimed;
      res.set('Idempotent-Replayed', 'true');
      if (existing.payment_id && livePaymentResponse) {
        const live = await livePaymentResponse(existing.payment_id);
        return res.status(live.status).json(live.body);
      }
      if (existing.status === 'IN_PROGRESS') {
        res.removeHeader('Idempotent-Replayed');
        throw new AppError(409, 'REQUEST_IN_PROGRESS', 'An identical request is still being processed; retry shortly');
      }
      return res.status(existing.response_code).json(existing.response);
    }

    // Once a handler has sent something to a bank, a failure must NOT free the
    // key: a retry could then charge twice. The key stays claimed, linked to
    // its payment, and the TSQ job settles the payment.
    let sideEffects = false;
    let result;
    try {
      result = await handler(req, {
        complete: (client, status, body) =>
          client.query(
            `UPDATE idempotency_keys SET status = 'COMPLETED', response_code = $3, response = $4
              WHERE key = $1 AND scope = $2`,
            [ref.key, ref.scope, status, JSON.stringify(body)]
          ),
        linkPayment: (client, paymentId) =>
          client.query('UPDATE idempotency_keys SET payment_id = $3 WHERE key = $1 AND scope = $2', [ref.key, ref.scope, paymentId]),
        sideEffectsStarted: () => {
          sideEffects = true;
        },
      });
    } catch (err) {
      if (!sideEffects) await release(ref).catch(() => {});
      throw err;
    }
    res.status(result.status).json(result.body);
  };
}

module.exports = { idempotent, hashRequest };
