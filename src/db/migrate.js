// Minimal migration runner: applies each .sql file in migrations/ once, in
// filename order, and records it in schema_migrations. Each file runs inside
// its own transaction, so a broken migration leaves no half-applied schema.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');

async function runMigrations(client, log = () => {}) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const { Client } = require('pg');
  (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await runMigrations(client, console.log);
      console.log('migrations up to date');
    } finally {
      await client.end();
    }
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
