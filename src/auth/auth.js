const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const config = require('../config');

const router = express.Router();

// Slows down password guessing: N attempts per IP per 15 minutes.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again in a few minutes' } },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return { id: u.id, email: u.email, full_name: u.full_name, kyc_status: u.kyc_status, role: u.role };
}

router.post('/register', limiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const fullName = String(req.body?.full_name || '').trim();

  if (!EMAIL_RE.test(email)) throw new AppError(400, 'INVALID_EMAIL', 'Enter a valid email address');
  if (password.length < 10) throw new AppError(400, 'WEAK_PASSWORD', 'Password must be at least 10 characters');
  if (fullName.length < 2) throw new AppError(400, 'INVALID_NAME', 'Enter your full name');

  const hash = await bcrypt.hash(password, config.bcryptRounds);

  // Role is never taken from the request: everyone signs up as a customer.
  const result = await withTransaction(async (client) => {
    const u = await client.query(
      `INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [email, fullName, hash]
    );
    if (u.rowCount === 0) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    const a = await client.query(
      `INSERT INTO accounts (user_id, type, currency) VALUES ($1, 'WALLET', 'NGN')
       RETURNING id, currency, balance_kobo`,
      [u.rows[0].id]
    );
    return { user: publicUser(u.rows[0]), account: a.rows[0] };
  });

  res.status(201).json(result);
});

router.post('/login', limiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  // Same message whether the email or the password is wrong, so attackers
  // can't use login to discover which emails are registered.
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
  res.json({ token, user: publicUser(user) });
});

// Middleware: rejects requests without a valid token, otherwise sets req.user.
function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Log in to continue'));
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new AppError(401, 'UNAUTHENTICATED', 'Your session has expired, log in again'));
  }
}

// Middleware: only lets through users whose token carries one of `roles`.
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user?.role)) return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this'));
    next();
  };
}

module.exports = { router, requireAuth, requireRole };
