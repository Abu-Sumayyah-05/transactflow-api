// Module 8: retry policy for bank calls.
//
// Retry ONLY what might succeed next time:
//   5xx, timeouts, network errors  -> the bank was sick or slow; try again
//   4xx                            -> the request itself is wrong; retrying
//                                     just repeats the same mistake
//   circuit_open                   -> we chose not to call; don't hammer
//
// Is a retry safe for a charge that might have gone through? Yes, because
// every request carries our unique reference and the bank dedupes on it: a
// retry of a processed charge just returns the original result.
//
// Waits use exponential backoff with FULL jitter: a random delay between 0
// and min(cap, base * 2^attempt). The randomness spreads clients out, so
// when a bank comes back they don't all retry in the same millisecond and
// knock it over again (the "thundering herd").

function isRetryable(result) {
  if (result.httpStatus == null) return result.reason === 'timeout' || result.reason === 'network_error';
  return result.httpStatus >= 500;
}

function backoffDelay(attempt, { baseMs, capMs }, random = Math.random) {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fn(attempt) returns a result object (it never throws for bank errors).
async function withRetry(fn, { maxAttempts, baseMs, capMs, sleep = realSleep, random = Math.random, shouldContinue = () => true }) {
  let result;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    result = await fn(attempt);
    const last = attempt === maxAttempts - 1;
    if (!isRetryable(result) || last || !shouldContinue()) return result;
    await sleep(backoffDelay(attempt, { baseMs, capMs }, random));
  }
  return result;
}

module.exports = { withRetry, isRetryable, backoffDelay };
