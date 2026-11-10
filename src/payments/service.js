// The two outbound money flows. Both follow the same shape:
//
//   tx1  create the payment (and, for transfers, hold the money) -> PENDING
//        COMMIT before calling the bank: never hold a DB transaction or a
//        row lock open across a network call that may take 10 seconds.
//   ---  call the bank through the gateway
//   tx2  apply the outcome (+ ledger) and save the idempotent response together
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const { assertKobo } = require('../money');
const config = require('../config');
const ledger = require('../ledger/ledger');
const gateway = require('../gateway/gateway');
const { cardForCharge } = require('../cards/cards');
const repo = require('./repository');
const sm = require('./stateMachine');
const { applyOutcome } = require('./outcomes');

async function walletOf(db, userId) {
  const { rows } = await db.query("SELECT id FROM accounts WHERE user_id = $1 AND type = 'WALLET'", [userId]);
  if (!rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No wallet found for this user');
  return rows[0].id;
}

async function finish(paymentId, result, idem) {
  return withTransaction(async (client) => {
    const final = await applyOutcome(client, paymentId, result);
    const body = repo.present(final);
    const status = final.status === 'UNKNOWN' ? 202 : 201;
    await idem.complete(client, status, body);
    return { status, body };
  });
}

async function startCardTopup({ userId, cardToken, amountKobo }, idem) {
  assertKobo(amountKobo);
  const card = await cardForCharge(pool, userId, String(cardToken || ''));
  const bank = config.defaultBank;

  const payment = await withTransaction(async (client) => {
    const p = await repo.create(client, {
      accountId: await walletOf(client, userId),
      type: 'CARD_TOPUP',
      amountKobo,
      bank,
      cardToken,
    });
    await sm.transition(client, p.id, 'PENDING', { reason: 'sent to bank' });
    return p;
  });

  // From here the bank may have the request. If anything below crashes, the
  // key must stay claimed so a retry can't create a second charge.
  idem.sideEffectsStarted();
  const result = await gateway.charge(bank, { reference: payment.reference, amountKobo, card });
  return finish(payment.id, result, idem);
}

const NUBAN = /^\d{10}$/;
const BANKS = new Set(['A', 'B']);

function checkBankAccount(bank, accountNumber) {
  if (!BANKS.has(bank)) throw new AppError(400, 'INVALID_BANK', 'Choose a supported bank');
  if (!NUBAN.test(String(accountNumber || ''))) {
    throw new AppError(400, 'INVALID_ACCOUNT_NUMBER', 'Account number must be 10 digits');
  }
}

async function nameEnquiry(bank, accountNumber) {
  checkBankAccount(bank, accountNumber);
  const ne = await gateway.nameEnquiry(bank, accountNumber);
  if (ne.outcome === 'NOT_FOUND') throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'The bank has no account with that number');
  if (ne.outcome !== 'SUCCESS') {
    throw new AppError(503, 'BANK_UNAVAILABLE', 'We could not reach the bank to confirm the account name. Try again shortly.');
  }
  return ne.accountName;
}

async function startBankTransfer({ userId, bank, accountNumber, amountKobo }, idem) {
  assertKobo(amountKobo);
  // Name enquiry first, so money is never held for an account that doesn't exist.
  const accountName = await nameEnquiry(bank, accountNumber);

  const payment = await withTransaction(async (client) => {
    const walletId = await walletOf(client, userId);
    const p = await repo.create(client, {
      accountId: walletId,
      type: 'BANK_TRANSFER',
      amountKobo,
      bank,
      destinationAccount: accountNumber,
      destinationName: accountName,
    });
    // Hold the money now (wallet -> in-flight) so it can't be spent twice
    // while the bank works. Throws INSUFFICIENT_FUNDS and rolls back otherwise.
    const holdId = await ledger.postTransaction(client, {
      memo: `hold for transfer ${p.reference}`,
      entries: [
        { accountId: walletId, direction: 'DEBIT', amountKobo },
        { accountId: await ledger.getSystemAccountId(client, 'TRANSFERS_IN_FLIGHT'), direction: 'CREDIT', amountKobo },
      ],
    });
    await client.query('UPDATE payments SET hold_transaction_id = $2 WHERE id = $1', [p.id, holdId]);
    await sm.transition(client, p.id, 'PENDING', { reason: 'funds held, sent to bank' });
    return p;
  });

  idem.sideEffectsStarted();
  const result = await gateway.transfer(bank, { reference: payment.reference, accountNumber, amountKobo });
  return finish(payment.id, result, idem);
}

module.exports = { startCardTopup, startBankTransfer, nameEnquiry };
