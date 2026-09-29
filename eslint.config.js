'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Baseline: rules the existing code fails are switched off per file group so
// CI starts green. Remove an override once the code it covers is fixed.
module.exports = [
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['src/main/**/*.js', 'src/backend/**/*.js', 'test/**/*.js', 'e2e/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['src/main/**/*.js'],
    rules: {
      'no-unused-vars': 'off',            // baseline: unused imports/locals in main.js (spawn, start)
      'no-empty': 'off',                  // baseline: 13 intentional empty catch blocks in main.js
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
    rules: {
      'no-useless-escape': 'off',         // baseline: redundant \- escapes in renderer.js regexes
      'no-unused-vars': 'off',            // baseline: unused changelogHeading and truncate in renderer.js
      'no-useless-assignment': 'off',     // baseline: dead initial value for hints in renderer.js
    },
  },
  {
    // Defined in sources.js, which index.html loads before renderer.js
    files: ['src/renderer/renderer.js'],
    languageOptions: {
      globals: {
        sourcesFromCatalog: 'readonly', getTitle: 'readonly', parseSources: 'readonly', formatSources: 'readonly',
        titleKey: 'readonly', preferredVersion: 'readonly', versionLabel: 'readonly',
      },
    },
  },
  {
    // module.exports is guarded by typeof, for the node:test suite
    files: ['src/renderer/sources.js'],
    languageOptions: { globals: { module: 'writable' } },
  },
  {
    // page.evaluate callbacks run in the renderer and read its top-level state
    files: ['e2e/**/*.e2e.js'],
    languageOptions: { globals: { allGames: 'readonly', allVersions: 'readonly' } },
  },
];
