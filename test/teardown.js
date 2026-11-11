// Runs around every test file.
// Breakers live in process memory; reset them so one test's outage doesn't
// leak into the next test.
beforeEach(() => {
  require('../src/gateway/gateway').resetBreakers();
});

// Close the shared Redis connection so Jest can exit.
afterAll(async () => {
  await require('../src/redis').close();
});
