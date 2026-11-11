// Module 8: retries. Only 5xx and timeouts are retried, with exponential
// backoff and FULL jitter; 4xx is never retried.
const { withRetry, isRetryable, backoffDelay } = require('../src/gateway/retry');

const opts = (extra = {}) => {
  const sleeps = [];
  return {
    sleeps,
    options: {
      maxAttempts: 4,
      baseMs: 100,
      capMs: 1000,
      sleep: async (ms) => sleeps.push(ms),
      random: () => 0.999,
      ...extra,
    },
  };
};

describe('isRetryable (Module 8)', () => {
  test.each([
    [{ httpStatus: 500 }, true],
    [{ httpStatus: 502 }, true],
    [{ httpStatus: 503 }, true],
    [{ httpStatus: null, reason: 'timeout' }, true],
    [{ httpStatus: null, reason: 'network_error' }, true],
    [{ httpStatus: 400 }, false],
    [{ httpStatus: 401 }, false],
    [{ httpStatus: 404 }, false],
    [{ httpStatus: 409 }, false],
    [{ httpStatus: 422 }, false],
    [{ httpStatus: 200 }, false],
    [{ httpStatus: null, reason: 'circuit_open' }, false],
  ])('%p -> %p', (result, expected) => {
    expect(isRetryable(result)).toBe(expected);
  });
});

describe('backoffDelay: exponential with full jitter (Module 8)', () => {
  test('the ceiling doubles each attempt up to the cap', () => {
    const max = (attempt) => backoffDelay(attempt, { baseMs: 100, capMs: 1000 }, () => 0.999999);
    expect([0, 1, 2, 3, 4, 5].map(max)).toEqual([99, 199, 399, 799, 999, 999]);
  });

  test('full jitter: the delay is anywhere from 0 to the ceiling', () => {
    expect(backoffDelay(3, { baseMs: 100, capMs: 1000 }, () => 0)).toBe(0);
    expect(backoffDelay(3, { baseMs: 100, capMs: 1000 }, () => 0.5)).toBe(400);
    const samples = new Set(Array.from({ length: 200 }, () => backoffDelay(3, { baseMs: 100, capMs: 1000 })));
    expect(samples.size).toBeGreaterThan(50); // spread out, not a fixed delay
    for (const d of samples) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(800);
    }
  });
});

describe('withRetry (Module 8)', () => {
  test('a 4xx is never retried', async () => {
    const { sleeps, options } = opts();
    const fn = jest.fn(async () => ({ httpStatus: 400 }));
    const result = await withRetry(fn, options);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(result.httpStatus).toBe(400);
  });

  test('a 5xx is retried up to maxAttempts, with growing jittered waits', async () => {
    const { sleeps, options } = opts();
    const fn = jest.fn(async () => ({ httpStatus: 503 }));
    const result = await withRetry(fn, options);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([99, 199, 399]);
    expect(result.httpStatus).toBe(503);
  });

  test('a timeout is retried, and it stops as soon as one attempt succeeds', async () => {
    const { options } = opts();
    const results = [{ httpStatus: null, reason: 'timeout' }, { httpStatus: 200, json: { ok: true } }, { httpStatus: 200 }];
    const fn = jest.fn(async () => results.shift());
    const result = await withRetry(fn, options);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ httpStatus: 200, json: { ok: true } });
  });

  test('stops retrying when told to (for example, the circuit just opened)', async () => {
    const { options } = opts({ shouldContinue: () => false });
    const fn = jest.fn(async () => ({ httpStatus: 503 }));
    await withRetry(fn, options);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
