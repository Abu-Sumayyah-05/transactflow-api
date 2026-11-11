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
const { cardOf, cardForCharge } = require('../cards/cards');
const fraud = require('../fraud/check');
const repo = require('./repository');
const sm = require('./stateMachine');
const { applyOutcome } = require('./outcomes');

async function walletOf(db, userId) {
  const { rows } = await db.query("SELECT id FROM accounts WHERE user_id = $1 AND type = 'WALLET'", [userId]);
  if (!rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No wallet found for this user');
  return rows[0].id;
}

// `timing` = { startedAt, bankMs }: how long the request and the bank call
// took, saved for the latency metrics (Module 10).
async function finish(paymentId, result, idem, timing) {
  return withTransaction(async (client) => {
    const final = await applyOutcome(client, paymentId, result);
    await client.query('UPDATE payments SET bank_ms = $2, total_ms = $3 WHERE id = $1', [
      paymentId,
      timing.bankMs,
      Date.now() - timing.startedAt,
    ]);
    const body = repo.present(final);
    const status = final.status === 'UNKNOWN' ? 202 : 201;
    await idem.complete(client, status, body);
    return { status, body };
  });
}

// Module 8 fallback: if Bank A's breaker is OPEN, route to Bank B. If both
// are down, say so before anything is charged.
function pickBankOrFail() {
  const bank = gateway.pickCardBank();
  if (!bank) {
    throw new AppError(503, 'BANKS_UNAVAILABLE', 'Card payments are temporarily unavailable. You have not been charged; please try again in a minute.');
  }
  return bank;
}

// Sends a card payment that is PENDING with a bank chosen (and committed) to
// that bank, then records the answer. Shared by the normal path, a passed
// challenge and an admin approval.
async function chargeAtBank(payment, ownerUserId, idem, startedAt = Date.now()) {
  // From here the bank may have the request. If anything below crashes, the
  // key must stay claimed so a retry can't create a second charge.
  idem.sideEffectsStarted();
  const card = await cardForCharge(pool, ownerUserId, payment.card_token);
  const sentAt = Date.now();
  const result = await gateway.charge(payment.bank, { reference: payment.reference, amountKobo: payment.amount_kobo, card });
  return finish(payment.id, result, idem, { startedAt, bankMs: Date.now() - sentAt });
}

// POST /payments. Module 9 decides first, then the gateway (spec: "Runs fraud
// check, then the gateway adapter").
//   APPROVE    PENDING -> bank, exactly as before
//   CHALLENGE  PENDING with a one-time code; no bank, no charge until it's passed
//   BLOCK      FAILED at once; never sent to a bank; OPEN in the fraud queue
async function startCardTopup({ userId, cardToken, amountKobo, billingAddress, deviceId, startedAt = Date.now() }, idem) {
  assertKobo(amountKobo);
  const card = await cardOf(pool, userId, String(cardToken || ''));
  const billing = fraud.parseBillingAddress(billingAddress);
  const accountId = await walletOf(pool, userId);

  const decision = await fraud.assess(pool, { userId, accountId, card, billing, deviceId });
  // Only an approved payment goes to a bank now, so only it needs one now.
  const bank = decision.outcome === 'APPROVE' ? pickBankOrFail() : null;

  const created = await withTransaction(async (client) => {
    const p = await repo.create(client, {
      accountId,
      type: 'CARD_TOPUP',
      amountKobo,
      bank,
      cardToken: card.token,
      billingCountry: billing?.country ?? null,
      billingAddressHash: billing?.hash ?? null,
      deviceId,
    });
    await fraud.record(client, p.id, decision);
    await idem.linkPayment(client, p.id);
    const reason = `fraud score ${decision.score}`;

    if (decision.outcome === 'BLOCK') {
      const final = await sm.transition(client, p.id, 'FAILED', { reason: `blocked: ${reason}`, set: { failure_code: 'FRAUD_BLOCKED' } });
      const body = repo.present(final);
      await idem.complete(client, 201, body);
      return { done: { status: 201, body } };
    }

    if (decision.outcome === 'CHALLENGE') {
      const otp = fraud.newOtp();
      await sm.transition(client, p.id, 'PENDING', { reason: `challenge required: ${reason}`, set: { challenge_status: 'REQUIRED' } });
      const { rows } = await client.query(
        `UPDATE payments SET challenge_otp_hash = $2,
                challenge_expires_at = now() + make_interval(secs => $3::float8 / 1000)
          WHERE id = $1 RETURNING *`,
        [p.id, fraud.hashOtp(p.id, otp), config.challengeTtlMs]
      );
      const body = repo.present(rows[0]);
      // Demo/test only: a real issuer texts this code to the cardholder.
      if (config.challengeRevealOtp) body.challenge.test_otp = otp;
      await idem.complete(client, 202, body);
      return { done: { status: 202, body } };
    }

    return { send: await sm.transition(client, p.id, 'PENDING', { reason: `sent to bank (${reason})` }) };
  });

  if (created.done) return created.done;
  return chargeAtBank(created.send, userId, idem, startedAt);
}

// Locks a card payment that is waiting for its challenge. Only valid from
// PENDING (spec), and only if this payment asked for a challenge.
async function lockChallenged(client, paymentId, userId = null) {
  const { rows } = await client.query(
    `SELECT p.*, a.user_id AS owner_id, now() >= p.challenge_expires_at AS challenge_expired
       FROM payments p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = $1 ${userId ? 'AND a.user_id = $2' : ''} FOR UPDATE OF p`,
    userId ? [paymentId, userId] : [paymentId]
  );
  const p = rows[0];
  if (!p) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  if (p.status !== 'PENDING' || p.challenge_status !== 'REQUIRED') {
    throw new AppError(409, 'CHALLENGE_NOT_ALLOWED', `This payment is ${p.status} and is not waiting for a verification code`);
  }
  return p;
}

// Ends a challenge without charging anything.
async function failChallenge(client, p, failureCode, challengeStatus, reason) {
  return sm.transition(client, p.id, 'FAILED', { reason, set: { failure_code: failureCode, challenge_status: challengeStatus } });
}

// POST /payments/:id/challenge { otp }
async function completeChallenge({ userId, paymentId, otp, startedAt = Date.now() }, idem) {
  if (!/^[0-9a-f-]{36}$/i.test(String(paymentId))) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  const step = await withTransaction(async (client) => {
    const p = await lockChallenged(client, paymentId, userId);
    const respond = async (status, body) => {
      await idem.complete(client, status, body);
      return { done: { status, body } };
    };

    if (p.challenge_expired) {
      return respond(201, repo.present(await failChallenge(client, p, 'CHALLENGE_EXPIRED', 'EXPIRED', 'challenge expired')));
    }

    if (!fraud.otpMatches(p.id, otp, p.challenge_otp_hash)) {
      const attempts = p.challenge_attempts + 1;
      await client.query('UPDATE payments SET challenge_attempts = $2, updated_at = now() WHERE id = $1', [p.id, attempts]);
      if (attempts >= config.challengeMaxAttempts) {
        return respond(201, repo.present(await failChallenge(client, p, 'CHALLENGE_FAILED', 'FAILED', 'wrong code too many times')));
      }
      // Returned, not thrown: the attempt count must commit.
      const left = config.challengeMaxAttempts - attempts;
      return respond(422, {
        error: { code: 'INVALID_OTP', message: `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, attempts_left: left },
      });
    }

    // Right code. Pick the bank now (throws 503, rolls back, and leaves the
    // challenge open to retry if both banks are down).
    const bank = pickBankOrFail();
    await client.query('UPDATE payments SET bank = $2, challenge_status = $3, updated_at = now() WHERE id = $1', [p.id, bank, 'PASSED']);
    await client.query(
      "UPDATE fraud_decisions SET review_status = 'CLEARED_BY_CHALLENGE' WHERE payment_id = $1 AND review_status = 'OPEN'",
      [p.id]
    );
    await idem.linkPayment(client, p.id);
    return { send: { ...p, bank } };
  });

  if (step.done) return step.done;
  return chargeAtBank(step.send, step.send.owner_id, idem, startedAt);
}

// Background job: challenges nobody finished in time are cancelled.
async function expireChallenges(limit = 50) {
  const { rows } = await pool.query(
    `SELECT id FROM payments WHERE status = 'PENDING' AND challenge_status = 'REQUIRED'
        AND challenge_expires_at <= now() LIMIT $1`,
    [limit]
  );
  for (const { id } of rows) {
    await withTransaction(async (client) => {
      const p = await lockChallenged(client, id).catch(() => null);
      if (p) await failChallenge(client, p, 'CHALLENGE_EXPIRED', 'EXPIRED', 'challenge expired');
    });
  }
  return rows.length;
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

async function startBankTransfer({ userId, bank, accountNumber, amountKobo, startedAt = Date.now() }, idem) {
  assertKobo(amountKobo);
  // Name enquiry first, so money is never held for an account that doesn't exist.
  const accountName = await nameEnquiry(bank, accountNumber);

  const payment = await withTransaction(async (client) => {
    const walletId = await walletOf(client, userId);
    // Lock first, before the payment row exists (see ledger.lockAccounts).
    await ledger.lockAccounts(client, [walletId, 'TRANSFERS_IN_FLIGHT']);
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
    await idem.linkPayment(client, p.id);
    await sm.transition(client, p.id, 'PENDING', { reason: 'funds held, sent to bank' });
    return p;
  });

  idem.sideEffectsStarted();
  const sentAt = Date.now();
  const result = await gateway.transfer(bank, { reference: payment.reference, accountNumber, amountKobo });
  return finish(payment.id, result, idem, { startedAt, bankMs: Date.now() - sentAt });
}

module.exports = {
  startCardTopup,
  completeChallenge,
  expireChallenges,
  lockChallenged,
  failChallenge,
  pickBankOrFail,
  chargeAtBank,
  startBankTransfer,
  nameEnquiry,
};
