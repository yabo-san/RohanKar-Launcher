'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const backend  = require('../../src/backend/sources.js');
const frontend = require('../../src/frontend/sources.js');
const { SEARCH } = require('./helpers');

// The frontend keeps getTitle for display; it must name things as the backend does
test('backend and frontend agree on titles', () => {
  const docs = [...Object.values(SEARCH).flat(), { identifier: 'x', title: ['The Game (v2) [GOG]'] }, { identifier: 'y-z' }, { identifier: 'o', title: 'x', _override: { title: 'O' } }];
  for (const d of docs) assert.equal(backend.getTitle(d), frontend.getTitle(d), d.identifier);
});

test('sourcesFromCatalog: bundled catalog turns on the launcher uploaders; junk is skipped', () => {
  const on = backend.sourcesFromCatalog(require('../../catalog/uploaders.json')).filter(s => s.enabled);
  assert.ok(on.length > 0);
  assert.deepEqual(backend.sourcesFromCatalog({ uploaders: [null, { handle: 'h' }] }), [{ uploader: 'h', label: 'h', enabled: false }]);
  assert.deepEqual(backend.sourcesFromCatalog(null), []);
});

test('sourcesFromSettings: saved list wins, drops junk, else the defaults', () => {
  const defaults = [{ uploader: 'd' }];
  assert.equal(backend.sourcesFromSettings({}, defaults), defaults);
  assert.deepEqual(backend.sourcesFromSettings({}), []);
  assert.deepEqual(backend.sourcesFromSettings({ sources: [{ uploader: 'a' }, null, { label: 'no uploader' }] }), [{ uploader: 'a' }]);
});

test('getTitle falls back to identifier, then Unknown', () => {
  assert.equal(backend.getTitle({ identifier: 'half-life', title: '  ' }), 'half life');
  assert.equal(backend.getTitle({}), 'Unknown');
});
