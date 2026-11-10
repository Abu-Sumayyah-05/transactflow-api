// Shared Redis connection. Redis holds short-lived locks and counters only;
// balances are never cached (Module 10). Every caller must cope with Redis
// being down, because PostgreSQL stays the source of truth.
const Redis = require('ioredis');

let client = null;
let warned = false;

function redis() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6380/0', {
      // Fail a command after 500 ms instead of queueing it forever while
      // Redis is unreachable, so callers can fall back to the database.
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
    });
    client.on('error', (err) => {
      if (!warned) console.warn(`redis unavailable, falling back to PostgreSQL: ${err.message}`);
      warned = true;
    });
    client.on('ready', () => {
      warned = false;
    });
  }
  return client;
}

async function close() {
  if (client) {
    const c = client;
    client = null;
    await c.quit().catch(() => c.disconnect());
  }
}

module.exports = { redis, close };
