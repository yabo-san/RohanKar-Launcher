'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir:    './e2e',
  // E2E_APP (a packaged build's executable) switches to the smoke test
  testMatch:  process.env.E2E_APP ? '*.smoke.js' : '*.e2e.js',
  workers:    1,
  timeout:    60_000,
  reporter:   process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir:  'test-results',
});
