// Module 4: the card vault. POST /cards takes the card details once, stores
// the number encrypted, throws the CVV away, and hands back a token. Every
// other part of the system only ever sees the token.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { encrypt, decrypt, fingerprint } = require('../security/crypto');

const router = express.Router();

// Luhn checksum: catches most typos in a card number before we bother a bank.
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function brandOf(pan) {
  if (/^4/.test(pan)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(pan)) return 'mastercard';
  if (/^(5061|5078|6500)/.test(pan)) return 'verve';
  return 'unknown';
}

function publicCard(row) {
  return { token: row.token, brand: row.brand, last4: row.last4, exp_month: row.exp_month, exp_year: row.exp_year };
}

const bad = (message) => new AppError(400, 'INVALID_CARD', message);

router.post('/', async (req, res) => {
  // Read the fields we need and nothing else; req.body is never logged.
  const pan = String(req.body?.number ?? '').replace(/[\s-]/g, '');
  const cvv = String(req.body?.cvv ?? '');
  const expMonth = Number(req.body?.exp_month);
  const expYear = Number(req.body?.exp_year);

  if (!/^\d{12,19}$/.test(pan) || !luhnValid(pan)) throw bad('Card number is not valid');
  if (!/^\d{3,4}$/.test(cvv)) throw bad('CVV must be 3 or 4 digits');
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) {
    throw bad('Expiry date is not valid');
  }
  const now = new Date();
  if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) {
    throw bad('This card has expired');
  }
  // The CVV has done its job (format check) and goes out of scope here. It is
  // never written to the database, a log, or the bank request.

  const fp = fingerprint(pan);
  const token = `tok_${crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'x')}`;
  const { rows } = await pool.query(
    `INSERT INTO cards (token, user_id, pan_encrypted, fingerprint, brand, last4, exp_month, exp_year)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, fingerprint) DO UPDATE SET exp_month = EXCLUDED.exp_month, exp_year = EXCLUDED.exp_year
     RETURNING token, brand, last4, exp_month, exp_year`,
    [token, req.user.id, encrypt(pan), fp, brandOf(pan), pan.slice(-4), expMonth, expYear]
  );
  res.status(201).json(publicCard(rows[0]));
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ cards: rows.map(publicCard) });
});

// For the gateway only: the decrypted card, just long enough to send to the bank.
async function cardForCharge(db, userId, token) {
  const { rows } = await db.query('SELECT * FROM cards WHERE token = $1 AND user_id = $2', [token, userId]);
  const card = rows[0];
  if (!card) throw new AppError(404, 'CARD_NOT_FOUND', 'Card not found; add it again');
  return { pan: decrypt(card.pan_encrypted), expMonth: card.exp_month, expYear: card.exp_year, last4: card.last4 };
}

module.exports = { router, luhnValid, cardForCharge };
