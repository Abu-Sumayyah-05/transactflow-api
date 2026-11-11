const app = require('./app');
const config = require('./config');
const tsq = require('./payments/tsq');
const webhooks = require('./webhooks/processor');
const payouts = require('./payouts/runner');

app.listen(config.port, () => {
  console.log(`TransactFlow API listening on http://localhost:${config.port}`);
});

// Until the Phase 8 worker exists, these background jobs run inside the API:
// TSQ for UNKNOWN payments, retries for webhooks that failed to process, and
// the payout runner.
tsq.startLoop();
webhooks.startLoop();
payouts.startLoop();
