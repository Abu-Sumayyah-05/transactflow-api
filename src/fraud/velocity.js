// Module 9: velocity counters in Redis, to catch card testing.
//
// Card testing = a fraudster with a list of stolen cards fires many small
// payments quickly to see which cards work. Each attempt bumps two counters:
//
//   vel:user:<userId>        attempts by this customer   (default 5 per 60 s)
//   vel:card:<fingerprint>   attempts on this card, by anyone (5 per 10 min)
//
// INCR is atomic, so parallel requests can't both read "4" and both pass.
// The TTL is set only when the counter is created (EXPIRE ... NX), so the
// window is fixed: it starts with the first attempt and the counter
// disappears when it ends. Attempts that get blocked still count, so a
// fraudster who keeps hammering stays blocked.
//
// If Redis is down the same counters live in PostgreSQL (velocity_counters),
// updated with one atomic upsert, so the fallback can't be raced either.
const config = require('../config');
const redisClient = require('../redis');

const redis = () => redisClient.redis();

const keyOf = (kind, id) => `vel:${kind}:${id}`;

function limitsFromConfig() {
  return {
    user: { limit: config.velocityUserLimit, windowSeconds: config.velocityUserWindowSeconds },
    card: { limit: config.velocityCardLimit, windowSeconds: config.velocityCardWindowSeconds },
  };
}

async function countInRedis(ids, limits) {
  const tx = redis().multi();
  for (const kind of Object.keys(ids)) {
    tx.incr(keyOf(kind, ids[kind]));
    tx.expire(keyOf(kind, ids[kind]), limits[kind].windowSeconds, 'NX');
  }
  const replies = await tx.exec();
  const counts = {};
  Object.keys(ids).forEach((kind, i) => {
    const [err, value] = replies[i * 2];
    if (err) throw err;
    counts[kind] = Number(value);
  });
  return counts;
}

// Fallback: the same fixed-window counter as one statement. ON CONFLICT
// locks the row, so parallel attempts are counted one after another. An
// expired window starts again at 1.
async function countInDatabase(db, ids, limits) {
  const counts = {};
  for (const kind of Object.keys(ids)) {
    const { rows } = await db.query(
      `INSERT INTO velocity_counters (key, count, expires_at)
       VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN velocity_counters.expires_at <= now() THEN 1 ELSE velocity_counters.count + 1 END,
         expires_at = CASE WHEN velocity_counters.expires_at <= now() THEN EXCLUDED.expires_at
                           ELSE velocity_counters.expires_at END
       RETURNING count`,
      [keyOf(kind, ids[kind]), limits[kind].windowSeconds]
    );
    counts[kind] = rows[0].count;
  }
  return counts;
}

// Records one attempt and says whether any counter is now over its limit.
async function hit({ userId, cardFingerprint }, limits = limitsFromConfig(), { db = null } = {}) {
  const ids = {};
  if (userId) ids.user = userId;
  if (cardFingerprint) ids.card = cardFingerprint;

  let counts;
  let source = 'redis';
  try {
    counts = await countInRedis(ids, limits);
  } catch (err) {
    if (!db) throw err;
    source = 'database';
    console.warn(`velocity: Redis unavailable (${err.message}); counting in PostgreSQL`);
    counts = await countInDatabase(db, ids, limits);
  }
  const breaches = Object.keys(counts).filter((kind) => counts[kind] > limits[kind].limit);
  return { counts, breaches, breached: breaches.length > 0, source };
}

// Admin marked a block as a false positive: let the customer try again.
async function clear({ userId, cardFingerprint }, { db = null } = {}) {
  const keys = [];
  if (userId) keys.push(keyOf('user', userId));
  if (cardFingerprint) keys.push(keyOf('card', cardFingerprint));
  if (!keys.length) return;
  await Promise.resolve()
    .then(() => redis().del(...keys))
    .catch(() => {});
  if (db) await db.query('DELETE FROM velocity_counters WHERE key = ANY($1)', [keys]);
}

module.exports = { hit, clear, limitsFromConfig };
