// Module 4: field-level encryption at rest with AES-256-GCM.
//
// GCM both hides the data and detects tampering: if one byte of the stored
// value changes, decrypt() throws instead of returning garbage. A fresh random
// 12-byte IV per value means the same card encrypts differently every time.
// Stored format: v1.<iv>.<authTag>.<ciphertext>, each base64url.
const crypto = require('crypto');

function keyFromEnv(name) {
  // A key pasted into a host's settings box often carries a space or a line
  // break. Those are never part of a hex key, so drop them from the ends.
  const hex = (process.env[name] || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    // Say what is wrong (length, odd characters) but never print the key.
    const notHex = hex.replace(/[0-9a-f]/gi, '').length;
    const got = !hex ? 'it is not set' : `got ${hex.length} characters${notHex ? `, ${notHex} of them not 0-9 or a-f` : ''}`;
    throw new Error(`${name} must be 32 bytes as 64 hex characters: ${got} (see .env.example)`);
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv('FIELD_ENCRYPTION_KEY'), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

function decrypt(stored) {
  const [version, iv, tag, ct] = String(stored).split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv('FIELD_ENCRYPTION_KEY'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

// Same input -> same output, but useless without the key. Lets us ask "is
// this the same card?" without storing or comparing card numbers.
function fingerprint(value) {
  return crypto.createHmac('sha256', keyFromEnv('CARD_FINGERPRINT_KEY')).update(String(value)).digest('hex');
}

module.exports = { encrypt, decrypt, fingerprint };
