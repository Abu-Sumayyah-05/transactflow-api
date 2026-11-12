// Seed data for the demo (Phase 11):  npm run seed
//
// Creates four accounts so a visitor can sign in and try every screen
// without setting anything up:
//
//   admin@transactflow.demo      the operations team (admin console)
//   merchant@transactflow.demo   a merchant with ₦500,000 (payouts)
//   customer@transactflow.demo   a two-year-old customer with ₦25,000
//   friend@transactflow.demo     someone to send money to, with ₦5,000
//
// All four share one password, read from DEMO_PASSWORD in .env. It is never
// written in the repo (spec rule 6).
//
// Safe to run again: an account that already exists keeps its balance and
// history, and only has its password reset to DEMO_PASSWORD.
const bcrypt = require('bcryptjs');

const TWO_YEARS = "now() - interval '2 years'";

// Opening balances are whole kobo (₦1 = 100 kobo), never floats.
const DEMO_USERS = [
  { email: 'admin@transactflow.demo', full_name: 'Ada Admin', role: 'admin', kobo: 0 },
  { email: 'merchant@transactflow.demo', full_name: 'Musa Merchant', role: 'merchant', kobo: 50_000_000 },
  // Older than a year, so the fraud rules give this account the -30 "trusted" score.
  { email: 'customer@transactflow.demo', full_name: 'Chidi Customer', role: 'customer', kobo: 2_500_000, aged: true },
  { email: 'friend@transactflow.demo', full_name: 'Funmi Friend', role: 'customer', kobo: 500_000 },
];

async function seed(log = () => {}) {
  const password = process.env.DEMO_PASSWORD || '';
  if (password.length < 10) {
    throw new Error('Set DEMO_PASSWORD in .env (at least 10 characters): the demo accounts sign in with it');
  }
  const config = require('../src/config');
  const { withTransaction } = require('../src/db/pool');
  const ledger = require('../src/ledger/ledger');
  const hash = await bcrypt.hash(password, config.bcryptRounds);

  for (const u of DEMO_USERS) {
    // One database transaction per account: the user, the wallet and the
    // opening balance all exist, or none of them do.
    await withTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO users (email, full_name, password_hash, role, kyc_status, created_at)
         VALUES ($1, $2, $3, $4, 'VERIFIED', ${u.aged ? TWO_YEARS : 'now()'})
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [u.email, u.full_name, hash, u.role]
      );
      if (created.rowCount === 0) {
        await client.query('UPDATE users SET password_hash = $2 WHERE email = $1', [u.email, hash]);
        log(`kept     ${u.email} (already there; password reset)`);
        return;
      }
      const wallet = await client.query("INSERT INTO accounts (user_id, type, currency) VALUES ($1, 'WALLET', 'NGN') RETURNING id", [
        created.rows[0].id,
      ]);
      if (u.kobo) {
        // Money never appears from nowhere: the opening balance is a
        // balanced pair of ledger entries, out of FUNDING and into the wallet.
        await ledger.postTransaction(client, {
          memo: 'opening balance',
          entries: [
            { accountId: await ledger.getSystemAccountId(client, 'FUNDING'), direction: 'DEBIT', amountKobo: u.kobo },
            { accountId: wallet.rows[0].id, direction: 'CREDIT', amountKobo: u.kobo },
          ],
        });
      }
      log(`created  ${u.email} (${u.role})`);
    });
  }
}

module.exports = { seed, DEMO_USERS };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  seed(console.log)
    .then(async () => {
      await require('../src/redis').close().catch(() => {});
      await require('../src/db/pool').pool.end();
      console.log('demo accounts ready');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
