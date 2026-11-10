// All settings come from environment variables; nothing secret lives in the repo.
require('dotenv').config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

module.exports = {
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 20),
};
