// Module 4: the two keys behind card storage. A key pasted into a host's
// settings box often picks up a space or a line break, so that must not
// break payments; and when a key really is wrong, the error must say what
// is wrong with it without ever printing the key.
const { encrypt, decrypt, fingerprint } = require('../src/security/crypto');

const GOOD = 'ab'.repeat(32);
const saved = {};

beforeEach(() => {
  for (const k of ['FIELD_ENCRYPTION_KEY', 'CARD_FINGERPRINT_KEY']) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(saved)) process.env[k] = saved[k];
});

test('a key with a space or line break around it still works, and gives the same result', () => {
  process.env.CARD_FINGERPRINT_KEY = GOOD;
  const clean = fingerprint('4111111111111111');
  process.env.CARD_FINGERPRINT_KEY = `  ${GOOD}\r\n`;
  expect(fingerprint('4111111111111111')).toBe(clean);

  process.env.FIELD_ENCRYPTION_KEY = `${GOOD}\n`;
  expect(decrypt(encrypt('hello'))).toBe('hello');
});

test('a key of the wrong length says how long it is, never what it is', () => {
  const short = 'cd'.repeat(31);
  process.env.CARD_FINGERPRINT_KEY = short;
  expect(() => fingerprint('x')).toThrow(/CARD_FINGERPRINT_KEY.*64 hex characters.*got 62 characters/);
  try {
    fingerprint('x');
  } catch (e) {
    expect(e.message).not.toContain(short);
  }
});

test('a key with characters that are not hex says so', () => {
  process.env.CARD_FINGERPRINT_KEY = `${'ab'.repeat(31)}zz`;
  expect(() => fingerprint('x')).toThrow(/got 64 characters, 2 of them not 0-9 or a-f/);
});

test('a missing key says it is not set', () => {
  delete process.env.FIELD_ENCRYPTION_KEY;
  expect(() => encrypt('x')).toThrow(/FIELD_ENCRYPTION_KEY.*not set/);
});
