'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir:    './e2e',
  testMatch:  '*.e2e.js',
  workers:    1,
  timeout:    60_000,
  reporter:   process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir:  'test-results',
});
