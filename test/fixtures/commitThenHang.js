// A stand-in for the app in the Phase 8 check. It commits a business change
// together with its outbox event, says so, and then hangs just before the
// point where it would publish. The test kills it there (SIGKILL: no
// cleanup, no goodbye), exactly like a crash or a pulled plug.
require('../setupEnv');
const { withTransaction } = require('../../src/db/pool');
const outbox = require('../../src/outbox/outbox');

(async () => {
  await withTransaction((client) => outbox.add(client, 'test.crash', process.argv[2], { marker: process.argv[2] }));
  process.stdout.write('COMMITTED\n');
  setInterval(() => {}, 1000); // never reaches the publish
})();
