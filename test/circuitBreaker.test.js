// Module 8: circuit breaker. CLOSED -> OPEN at 50% failures over 10 seconds,
// OPEN for 60 seconds (fail fast), then HALF_OPEN with 5 probe requests:
// all pass -> CLOSED, any fails -> OPEN again.
const { CircuitBreaker } = require('../src/gateway/circuitBreaker');

function setup() {
  const clock = { t: 1_000_000 };
  const changes = [];
  const breaker = new CircuitBreaker({
    name: 'A',
    now: () => clock.t,
    onStateChange: (from, to) => changes.push(`${from}->${to}`),
  });
  const advance = (ms) => {
    clock.t += ms;
  };
  const record = (outcomes) => outcomes.forEach((ok) => breaker.record(ok));
  return { breaker, advance, record, changes };
}

const ok = true;
const fail = false;

describe('CircuitBreaker (Module 8)', () => {
  test('starts CLOSED and lets requests through', () => {
    const { breaker } = setup();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.allow()).toBe(true);
  });

  test('needs a minimum number of calls: 4 failures out of 4 do not open it', () => {
    const { breaker, record } = setup();
    record([fail, fail, fail, fail]);
    expect(breaker.state).toBe('CLOSED');
  });

  test('opens at exactly 50% failures over the window', () => {
    const { breaker, record } = setup();
    record([ok, fail, ok, fail, ok, fail]);
    expect(breaker.state).toBe('OPEN');
  });

  test('a recovering bank is not cut off by its own successes', () => {
    const { breaker, record } = setup();
    record([fail, fail, fail, ok, ok]); // 60% failures, but the latest calls succeeded
    expect(breaker.state).toBe('CLOSED');
    breaker.record(fail); // a NEW failure at >= 50% does trip it
    expect(breaker.state).toBe('OPEN');
  });

  test('stays CLOSED below 50%', () => {
    const { breaker, record } = setup();
    record([ok, ok, ok, ok, ok, ok, fail, fail, fail, fail]);
    expect(breaker.state).toBe('CLOSED');
  });

  test('only the last 10 seconds count', () => {
    const { breaker, record, advance } = setup();
    record([fail, fail, fail]);
    advance(10_001);
    record([ok, ok, ok, fail, fail]); // 2 of 5 in the window = 40%
    expect(breaker.state).toBe('CLOSED');
  });

  test('while OPEN it fails fast, and goes HALF_OPEN after 60 seconds', () => {
    const { breaker, record, advance, changes } = setup();
    record([fail, fail, fail, fail, fail]);
    expect(breaker.allow()).toBe(false);
    advance(59_999);
    expect(breaker.allow()).toBe(false);
    advance(1);
    expect(breaker.allow()).toBe(true);
    expect(breaker.state).toBe('HALF_OPEN');
    expect(changes).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN']);
  });

  test('HALF_OPEN lets exactly 5 probe requests through', () => {
    const { breaker, record, advance } = setup();
    record([fail, fail, fail, fail, fail]);
    advance(60_000);
    const allowed = Array.from({ length: 7 }, () => breaker.allow());
    expect(allowed).toEqual([true, true, true, true, true, false, false]);
  });

  test('closes after the 5 probes pass', () => {
    const { breaker, record, advance, changes } = setup();
    record([fail, fail, fail, fail, fail]);
    advance(60_000);
    for (let i = 0; i < 5; i += 1) {
      expect(breaker.allow()).toBe(true);
      breaker.record(ok);
    }
    expect(breaker.state).toBe('CLOSED');
    expect(changes).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
    // A fresh window: one failure after closing does not reopen it.
    breaker.record(fail);
    expect(breaker.state).toBe('CLOSED');
  });

  test('reopens if a probe fails, and the 60 second cooldown starts again', () => {
    const { breaker, record, advance } = setup();
    record([fail, fail, fail, fail, fail]);
    advance(60_000);
    breaker.allow();
    breaker.record(ok);
    breaker.allow();
    breaker.record(fail);
    expect(breaker.state).toBe('OPEN');
    advance(59_999);
    expect(breaker.allow()).toBe(false);
    advance(1);
    expect(breaker.allow()).toBe(true);
  });

  test('snapshot reports state and window stats for the dashboard', () => {
    const { breaker, record } = setup();
    record([ok, ok, fail]);
    expect(breaker.snapshot()).toMatchObject({ name: 'A', state: 'CLOSED', windowCalls: 3, windowFailures: 1 });
  });
});
