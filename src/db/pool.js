const { Pool, types } = require('pg');

// Postgres BIGINT (type 20) arrives as a string by default, because JS numbers
// lose precision above 2^53. Kobo amounts stay far below that (2^53 kobo is
// about ₦90 trillion), so parse to Number but fail loudly if one ever doesn't fit.
types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`BIGINT ${value} exceeds safe integer range`);
  return n;
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Runs fn inside BEGIN/COMMIT on one connection. Any throw rolls everything
// back, so money moves are all-or-nothing.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
