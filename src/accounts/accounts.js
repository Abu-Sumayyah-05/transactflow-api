const express = require('express');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { formatNaira } = require('../money');

const router = express.Router();

// GET /accounts/me — balance and recent activity, read straight from
// PostgreSQL every time. Balances are never cached (Module 10).
router.get('/me', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.currency, a.balance_kobo, u.full_name, u.email, u.kyc_status, u.role
       FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $1 AND a.type = 'WALLET'`,
    [req.user.id]
  );
  const account = rows[0];
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No wallet found for this user');

  const recent = await pool.query(
    `SELECT transaction_id, direction, amount_kobo, memo, created_at
       FROM ledger_entries WHERE account_id = $1
      ORDER BY id DESC LIMIT 20`,
    [account.id]
  );

  res.json({
    account: { ...account, balance_display: formatNaira(account.balance_kobo) },
    recent: recent.rows,
  });
});

module.exports = { router };
