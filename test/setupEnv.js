// Runs before every test file. Points the app at the test database so tests
// can never write to dev data.
require('dotenv').config({ quiet: true });

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
// Short timeouts so timeout scenarios run in milliseconds, not seconds.
process.env.GATEWAY_TIMEOUT_MS = '300';
process.env.TSQ_INITIAL_DELAY_MS = '0';
process.env.REDIS_URL = process.env.TEST_REDIS_URL;
// Tests drive webhook processing explicitly with processDue(), and retry at once.
process.env.WEBHOOK_INLINE_PROCESSING = 'false';
process.env.WEBHOOK_RETRY_BASE_MS = '0';
// Gateway retries: same policy, tiny waits.
process.env.RETRY_BASE_MS = '5';
process.env.RETRY_CAP_MS = '20';
