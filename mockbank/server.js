// Runs one mock bank:  node mockbank/server.js A   (port 5001)
//                      node mockbank/server.js B   (port 5002)
require('dotenv').config({ quiet: true });
const { createBank } = require('./bank');

const name = (process.argv[2] || 'A').toUpperCase();
const url = new URL(process.env[`BANK_${name}_URL`] || `http://localhost:${name === 'A' ? 5001 : 5002}`);

createBank({
  name,
  webhookUrl: process.env.TRANSACTFLOW_WEBHOOK_URL || null,
  webhookSecret: process.env[`WEBHOOK_SECRET_${name}`] || null,
}).app.listen(Number(url.port), () => {
  console.log(`Mock Bank ${name} listening on ${url.origin}`);
});
