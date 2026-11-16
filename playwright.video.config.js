// Records the walkthrough video: `npm run video`.
// One slow, captioned pass through every screen (e2e/walkthrough.video.js),
// against the same throwaway stack the browser tests use (e2e/stack.js).
// The finished file is copied to docs/walkthrough.webm.
const { defineConfig } = require('@playwright/test');

const SIZE = { width: 1280, height: 720 };

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: 'walkthrough.video.js',
  workers: 1,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  globalTeardown: './e2e/saveVideo.js',
  use: {
    baseURL: 'http://localhost:4100',
    channel: process.env.PW_CHANNEL || 'msedge',
    viewport: SIZE,
    video: { mode: 'on', size: SIZE },
    // A pause after every click and keystroke, so a viewer can follow.
    launchOptions: { slowMo: 350 },
  },
  outputDir: './e2e/.results/video',
  webServer: {
    command: 'node e2e/stack.js',
    url: 'http://localhost:4100/health',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
