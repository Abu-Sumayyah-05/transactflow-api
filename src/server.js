const app = require('./app');
const config = require('./config');
const tsq = require('./payments/tsq');

app.listen(config.port, () => {
  console.log(`TransactFlow API listening on http://localhost:${config.port}`);
});

// Until the Phase 8 worker exists, the TSQ job runs inside the API process.
tsq.startLoop();
