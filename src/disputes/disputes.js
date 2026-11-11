// Module 9: disputes move funds through the ESCROW ledger account.
//
// A chargeback: the cardholder tells their bank "I didn't make this top-up".
// The bank tells us with a charge.disputed webhook. While the dispute is open,
// the money must be neither spendable by the wallet nor returned to the card,
// so it sits in ESCROW. Every step is a balanced, append-only ledger
// transaction; nothing is ever edited.
//
//   open          wallet -> ESCROW            (up to what the wallet holds)
//   CUSTOMER_WON  ESCROW -> CARD_SETTLEMENT   (the bank takes the money back)
//                 DISPUTE_LOSSES -> CARD_SETTLEMENT for any part already spent
//   MERCHANT_WON  ESCROW -> wallet            (hold released)
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const ledger = require('../ledger/ledger');

// Called by the webhook processor inside its transaction. Throws
// PermanentError (passed in, to avoid a require cycle) for disputes that can
// never be valid, so they go straight to the dead-letter queue.
async function openFromWebhook(client, evt, PermanentError) {
  const data = evt.payload?.data || {};
  const { rows } = await client.query('SELECT * FROM payments WHERE reference = $1 FOR UPDATE', [String(data.reference || '')]);
  const p = rows[0];
  if (!p) throw new Error(`no payment with reference ${data.reference}`); // maybe a race: retried

  if (p.type !== 'CARD_TOPUP' || p.status !== 'COMPLETED') {
    throw new PermanentError(`only a completed card top-up can be disputed (this is a ${p.status} ${p.type})`);
  }
  if (p.bank !== evt.source) throw new PermanentError(`bank ${evt.source} disputed a charge made at bank ${p.bank}`);
  const amount = data.amount_kobo;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > p.amount_kobo) {
    throw new PermanentError(`dispute amount ${amount} kobo is not between 1 and the charge (${p.amount_kobo} kobo)`);
  }

  // One dispute per charge. A second chargeback event for it changes nothing.
  const existing = await client.query('SELECT id FROM disputes WHERE payment_id = $1', [p.id]);
  if (existing.rowCount) return null;

  // Lock the wallet and freeze as much of the amount as it still holds. The
  // wallet can never go negative; the rest is recorded as the shortfall.
  const locked = await ledger.lockAccounts(client, [p.account_id, 'ESCROW']);
  const held = Math.min(amount, Number(locked.find((a) => a.id === p.account_id).balance_kobo));
  let holdTx = null;
  if (held > 0) {
    holdTx = await ledger.postTransaction(client, {
      memo: `dispute hold ${p.reference}`,
      entries: [
        { accountId: p.account_id, direction: 'DEBIT', amountKobo: held },
        { accountId: await ledger.getSystemAccountId(client, 'ESCROW'), direction: 'CREDIT', amountKobo: held },
      ],
    });
  }
  const { rows: created } = await client.query(
    `INSERT INTO disputes (payment_id, source, event_id, reason, amount_kobo, held_kobo, shortfall_kobo, hold_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [p.id, evt.source, evt.event_id, data.reason ? String(data.reason).slice(0, 500) : null, amount, held, amount - held, holdTx]
  );
  return created[0];
}

const OUTCOMES = new Set(['CUSTOMER_WON', 'MERCHANT_WON']);

// POST /admin/disputes/:id/resolve { outcome }
async function resolve({ disputeId, outcome, adminId }, idem) {
  if (!OUTCOMES.has(outcome)) throw new AppError(400, 'INVALID_OUTCOME', 'outcome must be CUSTOMER_WON or MERCHANT_WON');
  if (!Number.isSafeInteger(disputeId)) throw new AppError(404, 'NOT_FOUND', 'No such dispute');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT d.*, p.account_id, p.reference FROM disputes d JOIN payments p ON p.id = d.payment_id WHERE d.id = $1 FOR UPDATE OF d',
      [disputeId]
    );
    const d = rows[0];
    if (!d) throw new AppError(404, 'NOT_FOUND', 'No such dispute');
    if (d.status !== 'OPEN') throw new AppError(409, 'DISPUTE_ALREADY_RESOLVED', `This dispute was already resolved (${d.status})`);

    const held = Number(d.held_kobo);
    const shortfall = Number(d.shortfall_kobo);
    const escrow = await ledger.getSystemAccountId(client, 'ESCROW');
    const entries = [];
    if (outcome === 'CUSTOMER_WON') {
      // The whole disputed amount goes back to the card: what we held, plus
      // the spent part, which the platform pays as a loss.
      if (held > 0) entries.push({ accountId: escrow, direction: 'DEBIT', amountKobo: held });
      if (shortfall > 0) {
        entries.push({ accountId: await ledger.getSystemAccountId(client, 'DISPUTE_LOSSES'), direction: 'DEBIT', amountKobo: shortfall });
      }
      entries.push({ accountId: await ledger.getSystemAccountId(client, 'CARD_SETTLEMENT'), direction: 'CREDIT', amountKobo: held + shortfall });
    } else if (held > 0) {
      entries.push(
        { accountId: escrow, direction: 'DEBIT', amountKobo: held },
        { accountId: d.account_id, direction: 'CREDIT', amountKobo: held }
      );
    }
    // MERCHANT_WON with nothing held moves no money.
    const txId = entries.length
      ? await ledger.postTransaction(client, { memo: `dispute ${outcome.toLowerCase()} ${d.reference}`, entries })
      : null;

    const { rows: updated } = await client.query(
      `UPDATE disputes SET status = $2, resolution_transaction_id = $3, resolved_by = $4, resolved_at = now()
        WHERE id = $1 RETURNING *`,
      [d.id, outcome, txId, adminId]
    );
    const body = present({ ...updated[0], payment_reference: d.reference });
    await idem.complete(client, 200, body);
    return { status: 200, body };
  });
}

function present(d) {
  return {
    id: Number(d.id),
    payment_id: d.payment_id,
    payment_reference: d.payment_reference,
    customer_email: d.customer_email,
    source: d.source,
    reason: d.reason,
    status: d.status,
    amount_kobo: Number(d.amount_kobo),
    held_kobo: Number(d.held_kobo),
    shortfall_kobo: Number(d.shortfall_kobo),
    opened_at: d.opened_at,
    resolved_at: d.resolved_at,
  };
}

async function list({ status = null, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT d.*, p.reference AS payment_reference, u.email AS customer_email
       FROM disputes d
       JOIN payments p ON p.id = d.payment_id
       JOIN accounts a ON a.id = p.account_id
       JOIN users u ON u.id = a.user_id
      WHERE $1::text IS NULL OR d.status = $1
      ORDER BY d.opened_at DESC LIMIT $2`,
    [status, limit]
  );
  return rows.map(present);
}

module.exports = { openFromWebhook, resolve, list };
