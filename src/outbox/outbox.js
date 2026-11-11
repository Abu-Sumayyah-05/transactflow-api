// Module 10: the transactional outbox.
//
// "Save the payment, then publish an event" is two steps, and a crash
// between them loses the event forever. Instead:
//
//   add()        writes the event to the outbox table using the SAME database
//                client (so the same transaction) as the business change.
//                Either both are saved or neither is.
//   relayOnce()  run by the worker: reads unpublished events in order,
//                publishes each to the Redis stream, stamps published_at.
//
// Whatever kills the app after the commit, the row is still there and the
// relay sends it after restart. The price is at-least-once delivery: a crash
// after publishing but before stamping sends the event again, so every event
// carries an event_id and consumers ignore ids they have already handled.
const { pool } = require('../db/pool');
const config = require('../config');
const redisClient = require('../redis');

const STREAM = 'tf:events';

// Must be called with the transaction's client, never the pool.
async function add(client, eventType, aggregateId, payload) {
  await client.query('INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ($1, $2, $3)', [
    eventType,
    aggregateId == null ? null : String(aggregateId),
    JSON.stringify(payload ?? {}),
  ]);
}

// Default publisher: append to a Redis stream (capped, so it can't grow
// forever). Consumers read it with XREAD or a consumer group.
async function publishToRedis(evt) {
  await redisClient.redis().xadd(
    STREAM, 'MAXLEN', '~', config.outboxStreamMaxLen, '*',
    'event_id', evt.event_id,
    'type', evt.type,
    'aggregate_id', evt.aggregate_id ?? '',
    'created_at', evt.created_at,
    'payload', JSON.stringify(evt.payload)
  );
}

// Publishes up to `limit` events, oldest first. Returns how many went out.
//
// FOR UPDATE SKIP LOCKED: two relays never take the same rows; the second
// simply skips what the first is holding. The rows stay locked until this
// batch commits, so a relay that dies mid-batch releases them untouched.
//
// On a publish failure the batch stops there (later events must not overtake
// an earlier one), the error is recorded, and the next tick tries again.
async function relayOnce({ publish = publishToRedis, afterPublish = null, limit = config.outboxBatchSize } = {}) {
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [limit]
    );
    for (const row of rows) {
      try {
        await publish({
          event_id: row.event_id,
          type: row.event_type,
          aggregate_id: row.aggregate_id,
          created_at: row.created_at.toISOString(),
          payload: row.payload,
        });
      } catch (err) {
        await client.query('UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
          row.id,
          String(err.message).slice(0, 500),
        ]);
        break;
      }
      if (afterPublish) await afterPublish(row); // tests: crash between publish and mark
      await client.query(
        'UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1',
        [row.id]
      );
      sent += 1;
    }
    await client.query('COMMIT');
    return sent;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function stats(db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS unpublished,
            EXTRACT(EPOCH FROM now() - MIN(created_at))::float8 AS oldest_unpublished_seconds
       FROM outbox WHERE published_at IS NULL`
  );
  return rows[0];
}

function startLoop() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Keep going while there is a backlog.
      while ((await relayOnce()) === config.outboxBatchSize);
    } catch (err) {
      console.error(`outbox relay: ${err.message}`);
    } finally {
      running = false;
    }
  }, config.outboxIntervalMs);
  timer.unref();
  return timer;
}

module.exports = { add, relayOnce, stats, startLoop, STREAM };
