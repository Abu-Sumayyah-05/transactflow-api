// Starts the WHOLE system in one process for the browser tests: both mock
// banks, the API (serving the built React app) and the worker jobs, all
// against the TEST database and TEST Redis, which are wiped first. Dev data
// is never touched.
//
//   API + site   http://localhost:4100
//   Mock Bank A  http://localhost:5101        Mock Bank B  http://localhost:5102
//
// It also creates three known accounts the tests sign in with.
require('../test/setupEnv');

const PORT = 4100;
process.env.PORT = String(PORT);
process.env.BANK_A_URL = 'http://localhost:5101';
process.env.BANK_B_URL = 'http://localhost:5102';
process.env.WEBHOOK_INLINE_PROCESSING = 'true'; // like production
process.env.GATEWAY_TIMEOUT_MS = '1200';
process.env.TSQ_INTERVAL_MS = '1000';
process.env.PAYOUT_INTERVAL_MS = '500';
process.env.OUTBOX_INTERVAL_MS = '500';

const bcrypt = require('bcryptjs');
const globalSetup = require('../test/globalSetup');
const { createBank } = require('../mockbank/bank');

const PASSWORD = 'correct-horse-battery';
const USERS = [
  { email: 'admin@e2e.example.com', full_name: 'Ada Admin', role: 'admin', kobo: 0 },
  { email: 'merchant@e2e.example.com', full_name: 'Musa Merchant', role: 'merchant', kobo: 50_000_000 },
  { email: 'friend@e2e.example.com', full_name: 'Funmi Friend', role: 'customer', kobo: 0 },
];

(async () => {
  await globalSetup(); // empty schema + migrations, empty Redis db 1

  for (const [name, port] of [['A', 5101], ['B', 5102]]) {
    const bank = createBank({
      name,
      webhookUrl: `http://localhost:${PORT}/api/v1/webhooks/bank`,
      webhookSecret: process.env[`WEBHOOK_SECRET_${name}`],
    });
    await new Promise((resolve) => bank.app.listen(port, resolve));
  }

  const { pool, withTransaction } = require('../src/db/pool');
  const ledger = require('../src/ledger/ledger');
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const u of USERS) {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO users (email, full_name, password_hash, role, kyc_status) VALUES ($1, $2, $3, $4, 'VERIFIED') RETURNING id",
        [u.email, u.full_name, hash, u.role]
      );
      const acct = await client.query("INSERT INTO accounts (user_id, type, currency) VALUES ($1, 'WALLET', 'NGN') RETURNING id", [rows[0].id]);
      if (u.kobo) {
        await ledger.postTransaction(client, {
          memo: 'opening balance',
          entries: [
            { accountId: await ledger.getSystemAccountId(client, 'FUNDING'), direction: 'DEBIT', amountKobo: u.kobo },
            { accountId: acct.rows[0].id, direction: 'CREDIT', amountKobo: u.kobo },
          ],
        });
      }
    });
  }
  void pool;

  const app = require('../src/app');
  require('../src/worker').start();
  app.listen(PORT, () => console.log(`e2e stack ready on http://localhost:${PORT}`));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
