// Module 7: Idempotency-Key handling.
//
// The flow for a money-moving POST:
//   1. claim:    insert (key, scope, hash) as IN_PROGRESS in its own tiny
//                transaction. The primary key means only one request can win.
//   2. work:     the route does its business logic.
//   3. complete: the route saves its response on the key row INSIDE the same
//                database transaction that moved the money, so "money moved"
//                and "response remembered" commit together or not at all.
//   4. release:  if the work throws, the key row is deleted so the client can
//                retry the same key (nothing was charged).
//
// A second request with the same key then gets:
//   same body + COMPLETED   -> the stored response, replayed (no new charge)
//   same body + IN_PROGRESS -> 409, the first request is still running
//   different body          -> 409, the key was reused for something else
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,255}$/;

// Same JSON with keys in a different order must hash the same.
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

async function claim({ key, scope, requestHash }) {
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (key, scope, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (key, scope) DO UPDATE
        SET request_hash = EXCLUDED.request_hash, status = 'IN_PROGRESS',
            response_code = NULL, response = NULL, created_at = now(),
            expires_at = now() + interval '24 hours'
      WHERE idempotency_keys.expires_at < now()   -- an expired key may be reused
     RETURNING key`,
    [key, scope, requestHash]
  );
  if (inserted.rowCount === 1) return { owned: true };

  const { rows } = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1 AND scope = $2', [key, scope]);
  const existing = rows[0];
  if (!existing) {
    // The other request failed and released the key between our two queries.
    return claim({ key, scope, requestHash });
  }
  if (existing.request_hash !== requestHash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
  }
  if (existing.status === 'IN_PROGRESS') {
    throw new AppError(409, 'REQUEST_IN_PROGRESS', 'An identical request is still being processed; retry shortly');
  }
  return { owned: false, replay: { status: existing.response_code, body: existing.response } };
}

async function complete(client, { key, scope }, status, body) {
  await client.query(
    `UPDATE idempotency_keys SET status = 'COMPLETED', response_code = $3, response = $4
      WHERE key = $1 AND scope = $2`,
    [key, scope, status, JSON.stringify(body)]
  );
}

async function release({ key, scope }) {
  await pool.query("DELETE FROM idempotency_keys WHERE key = $1 AND scope = $2 AND status = 'IN_PROGRESS'", [key, scope]);
}

// Wraps a route. The handler gets (req, idem) and must call
// idem.complete(client, status, body) inside its money transaction, then
// return { status, body }.
function idempotent(routeName, handler) {
  return async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header');
    if (!KEY_RE.test(key)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8-255 letters, digits or - _ : .');
    }
    const ref = { key, scope: `${req.user.id}:${routeName}` };
    const claimed = await claim({ ...ref, requestHash: hashRequest(req.body) });

    if (!claimed.owned) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(claimed.replay.status).json(claimed.replay.body);
    }

    let result;
    try {
      result = await handler(req, { complete: (client, status, body) => complete(client, ref, status, body) });
    } catch (err) {
      await release(ref).catch(() => {});
      throw err;
    }
    res.status(result.status).json(result.body);
  };
}

module.exports = { idempotent, hashRequest };
