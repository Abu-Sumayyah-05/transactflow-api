const app = require('./app');
const config = require('./config');
const tsq = require('./payments/tsq');
const webhooks = require('./webhooks/processor');

app.listen(config.port, () => {
  console.log(`TransactFlow API listening on http://localhost:${config.port}`);
});

// Until the Phase 8 worker exists, these background jobs run inside the API:
// TSQ for UNKNOWN payments, and retries for webhooks that failed to process.
tsq.startLoop();
webhooks.startLoop();
