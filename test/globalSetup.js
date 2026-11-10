// Runs once before the whole test suite: wipes the test database and applies
// every migration, so each run starts from a known empty schema.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { runMigrations } = require('../src/db/migrate');

module.exports = async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/_test(\?|$)/.test(url)) {
    throw new Error('Refusing to reset a database whose name does not end in _test');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(client);
  await client.end();
};
