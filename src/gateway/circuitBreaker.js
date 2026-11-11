// Module 8: circuit breaker, one per bank.
//
//   CLOSED     normal. Every call's result goes into a rolling 10 second
//              window. If at least minCalls happened and >= 50% failed: OPEN.
//   OPEN       fail fast: don't call the bank at all for 60 seconds. A sick
//              bank gets room to recover, and customers aren't kept waiting
//              on calls that will fail anyway.
//   HALF_OPEN  after the cooldown, let 5 probe calls through.
//              All 5 succeed -> CLOSED. Any fails -> OPEN, cooldown restarts.
//
// "Failure" means the bank was unhealthy (timeout, network error, 5xx).
// A decline or a 4xx is a healthy bank giving an answer, so it counts as
// a success here.
//
// The minimum number of calls stops one unlucky failure (1 of 1 = 100%) from
// tripping the breaker.

class CircuitBreaker {
  constructor({
    name,
    windowMs = 10_000,
    failureThreshold = 0.5,
    minCalls = 5,
    cooldownMs = 60_000,
    probes = 5,
    now = Date.now,
    onStateChange = () => {},
  }) {
    Object.assign(this, { name, windowMs, failureThreshold, minCalls, cooldownMs, probes, now, onStateChange });
    this.reset();
  }

  reset() {
    this.state = 'CLOSED';
    this.calls = []; // { t, ok } within the window
    this.openedAt = null;
    this.probesStarted = 0;
    this.probesPassed = 0;
  }

  setState(next) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    if (next === 'OPEN') this.openedAt = this.now();
    if (next === 'HALF_OPEN') {
      this.probesStarted = 0;
      this.probesPassed = 0;
    }
    if (next === 'CLOSED') this.calls = [];
    this.onStateChange(prev, next, this);
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.calls.length && this.calls[0].t <= cutoff) this.calls.shift();
  }

  cooldownOver() {
    return this.state === 'OPEN' && this.now() - this.openedAt >= this.cooldownMs;
  }

  // Could a call go through right now? Doesn't use up a probe; for routing.
  isAvailable() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') return this.cooldownOver();
    return this.probesStarted < this.probes;
  }

  // Ask before every real call. In HALF_OPEN this uses up one probe.
  allow() {
    if (this.cooldownOver()) this.setState('HALF_OPEN');
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') return false;
    if (this.probesStarted < this.probes) {
      this.probesStarted += 1;
      return true;
    }
    return false;
  }

  record(ok) {
    if (this.state === 'HALF_OPEN') {
      if (!ok) return this.setState('OPEN');
      this.probesPassed += 1;
      if (this.probesPassed >= this.probes) this.setState('CLOSED');
      return undefined;
    }
    if (this.state === 'OPEN') return undefined; // a straggler from before it opened

    this.calls.push({ t: this.now(), ok });
    this.prune();
    // Only a failure can trip the breaker. Otherwise a bank that just
    // recovered (3 timeouts, then 2 good answers = 60% "failures") would
    // be cut off at the very moment it started working again.
    if (ok) return undefined;
    const failures = this.calls.filter((c) => !c.ok).length;
    if (this.calls.length >= this.minCalls && failures / this.calls.length >= this.failureThreshold) {
      this.setState('OPEN');
    }
    return undefined;
  }

  forceOpen() {
    this.setState('OPEN');
  }

  snapshot() {
    this.prune();
    return {
      name: this.name,
      state: this.cooldownOver() ? 'HALF_OPEN' : this.state,
      windowCalls: this.calls.length,
      windowFailures: this.calls.filter((c) => !c.ok).length,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      probesStarted: this.probesStarted,
      probesPassed: this.probesPassed,
    };
  }
}

module.exports = { CircuitBreaker };
