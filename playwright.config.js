// Browser tests (Phase 10 check: every screen works end to end).
// `npm run e2e` builds the React app, then Playwright starts the whole stack
// (e2e/stack.js: banks + API + worker on the test database) and drives a
// real Chromium through the site.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.js',
  workers: 1, // one shared stack and database: run in order
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4100',
    // Uses the Edge already installed on Windows, so no browser download is
    // needed. Set PW_CHANNEL=chrome (or chromium after `npx playwright
    // install chromium`) to use another.
    channel: process.env.PW_CHANNEL || 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: './e2e/.results',
  webServer: {
    command: 'node e2e/stack.js',
    url: 'http://localhost:4100/health',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
