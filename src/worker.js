// The worker: everything that happens outside a customer's request.
//
//   outbox relay    publishes committed events to the Redis stream
//   TSQ             asks banks about UNKNOWN payments; expires old challenges
//   webhooks        retries bank events that failed to process (then the DLQ)
//   payouts         sends payout batches, sub-batch by sub-batch
//   recon           nightly reconciliation against each bank's settlement file
//
// Run it with `npm run worker`, next to the API. Every job is safe to run in
// more than one worker at once (each claims its rows with a lock or a
// lease), and safe to kill at any moment: the state lives in PostgreSQL, so
// a restarted worker carries on where the dead one stopped.
const config = require('./config');
const tsq = require('./payments/tsq');
const webhooks = require('./webhooks/processor');
const payouts = require('./payouts/runner');
const outbox = require('./outbox/outbox');
const recon = require('./recon/engine');

function start() {
  return [outbox.startLoop(), tsq.startLoop(), webhooks.startLoop(), payouts.startLoop(), recon.startLoop()];
}

module.exports = { start };

if (require.main === module) {
  const timers = start();
  // The job timers don't keep the process alive on their own (so tests and
  // the API can exit cleanly); this one does.
  const keepAlive = setInterval(() => {}, 60_000);
  console.log(`TransactFlow worker started (outbox every ${config.outboxIntervalMs} ms, TSQ every ${config.tsqIntervalMs} ms)`);

  const stop = async (signal) => {
    console.log(`worker: ${signal} received, stopping`);
    [...timers, keepAlive].forEach(clearInterval);
    await require('./redis').close().catch(() => {});
    await require('./db/pool').pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
