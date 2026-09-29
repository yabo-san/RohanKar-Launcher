'use strict';
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir:    './e2e',
  // E2E_APP (a packaged build's executable) switches to the smoke test;
  // otherwise the frontend runs in Chromium against the standalone backend
  testMatch:  process.env.E2E_APP ? '*.smoke.js' : '*.e2e.js',
  workers:    1,
  timeout:    60_000,
  reporter:   process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir:  'test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    // A Chromium other than Playwright's own, e.g. a system one
    ...(process.env.E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } } : {}),
  },
});
