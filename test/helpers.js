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
  return { email, password, token: login.body.token, accountId: reg.body.account.id, userId: reg.body.user.id };
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

const TEST_CARD = { number: '4111 1111 1111 1111', exp_month: 12, exp_year: 2030, cvv: '123', holder_name: 'Test Payer' };

async function addCard(user, card = TEST_CARD) {
  const res = await request(app).post('/api/v1/cards').set('Authorization', `Bearer ${user.token}`).send(card);
  if (res.status !== 201) throw new Error(`addCard failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function balanceOf(accountId) {
  const { rows } = await require('../src/db/pool').pool.query('SELECT balance_kobo FROM accounts WHERE id = $1', [accountId]);
  return rows[0].balance_kobo;
}

// Promotes a user to admin and logs in again so the JWT carries the new role.
async function makeAdmin(user) {
  await require('../src/db/pool').pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.userId]);
  const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: user.password });
  return { ...user, token: login.body.token };
}

// Signs a webhook body the way a bank does: HMAC-SHA256 over the raw bytes.
function signWebhook(rawBody, secret) {
  return `sha256=${randomHmac(rawBody, secret)}`;
}
function randomHmac(rawBody, secret) {
  return require('crypto').createHmac('sha256', secret).update(rawBody).digest('hex');
}

module.exports = { app, request, uniqueEmail, registerAndLogin, fundWallet, addCard, balanceOf, makeAdmin, signWebhook, TEST_CARD };
