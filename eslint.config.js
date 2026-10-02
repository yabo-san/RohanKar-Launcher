'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Baseline: rules the existing code fails are switched off per file group so
// CI starts green. Remove an override once the code it covers is fixed.
module.exports = [
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'preview-site/'] },
  js.configs.recommended,
  {
    files: ['src/electron/**/*.js', 'src/backend/**/*.js', 'test/**/*.js', 'scripts/dev.js', 'scripts/ui.js', 'scripts/sandbox.js', 'scripts/live-port.js', 'scripts/curated-ports.js', 'scripts/preview/build.js', 'e2e/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['src/electron/**/*.js'],
    rules: {
      'no-unused-vars': 'off',            // baseline: unused imports/locals in main.js (spawn, start)
      'no-empty': 'off',                  // baseline: 13 intentional empty catch blocks in main.js
    },
  },
  {
    files: ['src/frontend/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
    rules: {
      'no-useless-escape': 'off',         // baseline: redundant \- escapes in renderer.js regexes
      'no-unused-vars': 'off',            // baseline: unused changelogHeading and truncate in renderer.js
      'no-useless-assignment': 'off',     // baseline: dead initial value for hints in renderer.js
    },
  },
  {
    // Defined in api.js and sources.js, which index.html loads before renderer.js
    files: ['src/frontend/renderer.js'],
    languageOptions: {
      globals: {
        api: 'readonly', getTitle: 'readonly', parseSources: 'readonly', formatSources: 'readonly',
        preferredVersion: 'readonly', versionLabel: 'readonly',
      },
    },
  },
  {
    // Defined in ../api.js and ../sources.js, which new/index.html loads before app.js
    files: ['src/frontend/new/app.js'],
    languageOptions: {
      globals: { api: 'readonly', getTitle: 'readonly', parseSources: 'readonly', formatSources: 'readonly', ListView: 'readonly' },
    },
  },
  {
    // The web preview's API stand-in, a plain script loaded before api.js
    files: ['scripts/preview/preview.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    // module.exports is guarded by typeof, for the node:test suite
    files: ['src/frontend/sources.js'],
    languageOptions: { globals: { module: 'writable' } },
  },
  {
    // The same, and getTitle is sources.js's in the page, required under node
    files: ['src/frontend/list-view.js'],
    languageOptions: { globals: { module: 'writable', require: 'readonly', getTitle: 'readonly' } },
  },
  {
    // page.evaluate callbacks run in the renderer and read its top-level state
    files: ['e2e/**/*.e2e.js'],
    languageOptions: { globals: { allGames: 'readonly', allVersions: 'readonly', api: 'readonly' } },
  },
];
