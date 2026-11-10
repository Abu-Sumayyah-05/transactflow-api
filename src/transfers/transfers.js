const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const { assertKobo } = require('../money');
const ledger = require('../ledger/ledger');
const { idempotent } = require('../idempotency/idempotency');
const payments = require('../payments/service');

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

// GET /transfers/name-enquiry — shows who the money will go to before the
// customer confirms, so a typo doesn't send money to a stranger.
//   ?email=...                       another TransactFlow wallet
//   ?bank=A&account_number=...       an account at a bank (asks the bank)
router.get('/name-enquiry', async (req, res) => {
  if (req.query.bank) {
    const bank = String(req.query.bank).toUpperCase();
    const accountNumber = String(req.query.account_number || '');
    const accountName = await payments.nameEnquiry(bank, accountNumber);
    return res.json({ account_name: accountName, bank, account_number: accountNumber });
  }
  const wallet = await findWalletByEmail(pool, req.query.email);
  if (!wallet) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'No TransactFlow wallet uses that email');
  res.json({ account_name: wallet.full_name, email: wallet.email });
});

// POST /transfers — requires an Idempotency-Key, so a double-tapped Send
// moves money once.
//   { recipient_email, amount_kobo }                 wallet to wallet
//   { bank, account_number, amount_kobo }            to a bank account
router.post('/', idempotent('POST /transfers', async (req, idem) => {
  if (req.body?.bank !== undefined) {
    return payments.startBankTransfer(
      {
        userId: req.user.id,
        bank: String(req.body.bank).toUpperCase(),
        accountNumber: String(req.body.account_number ?? ''),
        amountKobo: req.body.amount_kobo,
      },
      idem
    );
  }
  return walletTransfer(req, idem);
}, { livePaymentResponse: (id) => require('../payments/routes').livePaymentResponse(id) }));

async function walletTransfer(req, idem) {
  const amountKobo = assertKobo(req.body?.amount_kobo);

  return withTransaction(async (client) => {
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
    // COMPLETED is honest here: both ledger rows commit in our own database,
    // in this same transaction as the saved idempotent response.
    const body = {
      transaction_id: transactionId,
      recipient_name: recipient.full_name,
      amount_kobo: amountKobo,
      status: 'COMPLETED',
    };
    await idem.complete(client, 201, body);
    return { status: 201, body };
  });
}

module.exports = { router };
