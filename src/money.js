const { AppError } = require('./errors');

// The only valid amount: a positive whole number of kobo that JS can hold exactly.
function assertKobo(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a positive whole number of kobo');
  }
  return value;
}

// "1,234.56" -> 123456. Works on the digits as text, so no float is ever
// involved (19.99 * 100 would give 1998.9999999999998).
function nairaToKobo(input) {
  const text = String(input).replace(/,/g, '').trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Enter an amount in naira with at most two decimal places');
  }
  const naira = match[1];
  const kobo = (match[2] || '').padEnd(2, '0');
  return assertKobo(Number(naira + kobo));
}

// 123456 -> "₦1,234.56". Integer division and remainder only.
function formatNaira(kobo) {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const naira = Math.trunc(abs / 100).toLocaleString('en-NG');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}₦${naira}.${rest}`;
}

module.exports = { assertKobo, nairaToKobo, formatNaira };
