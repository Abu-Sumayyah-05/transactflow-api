const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`TransactFlow API listening on http://localhost:${config.port}`);
});

// Background jobs belong to the worker process (npm run worker). For a
// one-process demo deployment, WORKER_INLINE=true runs them here instead.
if (config.workerInline) {
  require('./worker').start();
  console.log('background jobs running inside the API (WORKER_INLINE=true)');
}
