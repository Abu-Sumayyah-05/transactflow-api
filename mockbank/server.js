// Runs one mock bank:  node mockbank/server.js A   (port 5001)
//                      node mockbank/server.js B   (port 5002)
require('dotenv').config({ quiet: true });
const { createBank } = require('./bank');

const name = (process.argv[2] || 'A').toUpperCase();
const url = new URL(process.env[`BANK_${name}_URL`] || `http://localhost:${name === 'A' ? 5001 : 5002}`);

createBank({ name }).app.listen(Number(url.port), () => {
  console.log(`Mock Bank ${name} listening on ${url.origin}`);
});
