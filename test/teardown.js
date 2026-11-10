// Runs after each test file: closes the shared Redis connection so Jest can exit.
afterAll(async () => {
  await require('../src/redis').close();
});
