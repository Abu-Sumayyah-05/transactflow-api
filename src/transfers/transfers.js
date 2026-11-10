const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const { assertKobo } = require('../money');
const ledger = require('../ledger/ledger');

const router = express.Router();

async function findWalletByEmail(db, email) {
  const { rows } = await db.query(
    `SELECT a.id AS account_id, u.id AS user_id, u.full_name, u.email
       FROM users u JOIN accounts a ON a.user_id = u.id AND a.type = 'WALLET'
      WHERE u.email = $1`,
    [String(email || '').trim().toLowerCase()]
  );
  return rows[0];
}

// GET /transfers/name-enquiry?email= — shows who the money will go to before
// the customer confirms, so a typo doesn't send money to a stranger.
router.get('/name-enquiry', async (req, res) => {
  const wallet = await findWalletByEmail(pool, req.query.email);
  if (!wallet) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'No TransactFlow wallet uses that email');
  res.json({ account_name: wallet.full_name, email: wallet.email });
});

// POST /transfers — wallet to wallet. Idempotency-Key enforcement arrives in
// Phase 4; bank-account transfers arrive with the gateway in Phase 3.
router.post('/', async (req, res) => {
  const amountKobo = assertKobo(req.body?.amount_kobo);

  const result = await withTransaction(async (client) => {
    const sender = await client.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'WALLET'",
      [req.user.id]
    );
    const recipient = await findWalletByEmail(client, req.body?.recipient_email);
    if (!sender.rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No wallet found for this user');
    if (!recipient) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'No TransactFlow wallet uses that email');
    if (recipient.user_id === req.user.id) {
      throw new AppError(400, 'SELF_TRANSFER', 'You cannot send money to your own wallet');
    }

    const transactionId = await ledger.postTransaction(client, {
      memo: `transfer to ${recipient.email}`,
      entries: [
        { accountId: sender.rows[0].id, direction: 'DEBIT', amountKobo },
        { accountId: recipient.account_id, direction: 'CREDIT', amountKobo },
      ],
    });
    return { transaction_id: transactionId, recipient_name: recipient.full_name };
  });

  // COMPLETED is honest here: both ledger rows committed in our own database.
  res.status(201).json({ ...result, amount_kobo: amountKobo, status: 'COMPLETED' });
});

module.exports = { router };
