const { randomUUID } = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { withTransaction } = require('../src/db/pool');
const ledger = require('../src/ledger/ledger');

function uniqueEmail(prefix = 'user') {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

async function registerAndLogin(name = 'Test User') {
  const email = uniqueEmail();
  const password = 'correct-horse-battery';
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, full_name: name });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { email, token: login.body.token, accountId: reg.body.account.id };
}

// Puts money into a wallet the same way the platform will: a balanced
// transaction from the FUNDING system account. Tests only.
async function fundWallet(accountId, amountKobo) {
  return withTransaction(async (client) => {
    const funding = await ledger.getSystemAccountId(client, 'FUNDING');
    return ledger.postTransaction(client, {
      memo: 'test funding',
      entries: [
        { accountId: funding, direction: 'DEBIT', amountKobo },
        { accountId, direction: 'CREDIT', amountKobo },
      ],
    });
  });
}

module.exports = { app, request, uniqueEmail, registerAndLogin, fundWallet };
