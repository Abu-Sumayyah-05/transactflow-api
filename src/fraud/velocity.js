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
// If Redis is down we count the same thing from PostgreSQL (payments created
// in the window), because the database stays the source of truth.
const config = require('../config');
const { redis } = require('../redis');

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

// Fallback: the payments table already records every attempt. +1 for the
// attempt being checked now, which has no row yet.
async function countInDatabase(db, ids, limits) {
  const counts = {};
  if (ids.user) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments p JOIN accounts a ON a.id = p.account_id
        WHERE a.user_id = $1 AND p.type = 'CARD_TOPUP' AND p.created_at > now() - make_interval(secs => $2)`,
      [ids.user, limits.user.windowSeconds]
    );
    counts.user = rows[0].n + 1;
  }
  if (ids.card) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments p JOIN cards c ON c.token = p.card_token
        WHERE c.fingerprint = $1 AND p.created_at > now() - make_interval(secs => $2)`,
      [ids.card, limits.card.windowSeconds]
    );
    counts.card = rows[0].n + 1;
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
    counts = await countInDatabase(db, ids, limits);
  }
  const breaches = Object.keys(counts).filter((kind) => counts[kind] > limits[kind].limit);
  return { counts, breaches, breached: breaches.length > 0, source };
}

// Admin marked a block as a false positive: let the customer try again.
async function clear({ userId, cardFingerprint }) {
  const keys = [];
  if (userId) keys.push(keyOf('user', userId));
  if (cardFingerprint) keys.push(keyOf('card', cardFingerprint));
  if (keys.length) await redis().del(...keys).catch(() => {});
}

module.exports = { hit, clear, limitsFromConfig };
