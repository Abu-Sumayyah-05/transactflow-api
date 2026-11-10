// Starts a mock bank inside the test process on a random free port and
// points the gateway at it.
const { createBank } = require('../mockbank/bank');

async function startBank(name = 'A') {
  const bank = createBank({ name });
  const server = await new Promise((resolve) => {
    const s = bank.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env[`BANK_${name}_URL`] = `http://127.0.0.1:${server.address().port}`;
  return {
    ...bank,
    stop: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startBank };
