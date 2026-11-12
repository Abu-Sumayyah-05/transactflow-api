// The whole system in one command, for the demo (Phase 11):  npm run demo
//
// Normally TransactFlow is five processes (API, worker, two mock banks, and
// the React dev server). That is right for development and wrong for
// someone who just wants to see it work. This starts everything in one
// process against the database in .env:
//
//   1. applies any new migrations
//   2. creates the demo accounts (scripts/seed.js)
//   3. starts Mock Bank A and Mock Bank B
//   4. starts the API, which also serves the built website
//   5. runs the background jobs inside the API (WORKER_INLINE)
//
// Nothing here is special demo logic: it is the same code the tests run.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

process.env.WORKER_INLINE = 'true';
// Demo mode shows the 3DS-style one-time code on screen (a real bank would
// text it). Set CHALLENGE_REVEAL_OTP=false in .env to turn that off.
process.env.CHALLENGE_REVEAL_OTP ||= 'true';
process.env.PORT ||= '4000';
process.env.BANK_A_URL ||= 'http://localhost:5001';
process.env.BANK_B_URL ||= 'http://localhost:5002';
const site = `http://localhost:${process.env.PORT}`;
const webhookUrl = process.env.TRANSACTFLOW_WEBHOOK_URL || `${site}/api/v1/webhooks/bank`;

(async () => {
  if (!fs.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html'))) {
    throw new Error('The website has not been built yet. Run:  npm run web:build');
  }

  const { Client } = require('pg');
  const { runMigrations } = require('../src/db/migrate');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await runMigrations(db, (line) => console.log(`migrate  ${line}`));
  } finally {
    await db.end();
  }

  const { seed, DEMO_USERS } = require('./seed');
  await seed(console.log);

  const { createBank } = require('../mockbank/bank');
  for (const name of ['A', 'B']) {
    const url = new URL(process.env[`BANK_${name}_URL`]);
    const bank = createBank({ name, webhookUrl, webhookSecret: process.env[`WEBHOOK_SECRET_${name}`] || null });
    await new Promise((resolve) => bank.app.listen(Number(url.port), resolve));
    console.log(`Mock Bank ${name} on ${url.origin}`);
  }

  require('../src/server'); // the API, the website and the background jobs

  console.log(`\nTransactFlow is running: open ${site}`);
  console.log('Sign in with the password in DEMO_PASSWORD as any of:');
  for (const u of DEMO_USERS) console.log(`  ${u.email.padEnd(30)} ${u.role}`);
})().catch((err) => {
  console.error(`\nCould not start the demo: ${err.message}`);
  process.exit(1);
});
