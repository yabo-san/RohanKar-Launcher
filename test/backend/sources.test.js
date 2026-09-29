'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const backend  = require('../../src/backend/sources.js');
const renderer = require('../../src/renderer/sources.js');
const { SEARCH } = require('./helpers');

// The renderer keeps its own copy until it reads grouped items from the API
const CATALOG = require('../../catalog/uploaders.json');

test('backend and renderer agree on default sources and grouping', () => {
  assert.deepEqual(backend.sourcesFromCatalog(CATALOG), renderer.sourcesFromCatalog(CATALOG));
  assert.deepEqual(backend.sourcesFromCatalog({ uploaders: [null, { handle: 'h' }] }), renderer.sourcesFromCatalog({ uploaders: [null, { handle: 'h' }] }));
  assert.deepEqual(backend.sourcesFromCatalog(null), []);
  const docs = [...Object.values(SEARCH).flat(), { identifier: 'x', title: ['The Game (v2) [GOG]'] }, { identifier: 'y-z' }];
  for (const d of docs) {
    assert.equal(backend.titleKey(d), renderer.titleKey(d), d.identifier);
    assert.equal(backend.getTitle(d), renderer.getTitle(d), d.identifier);
  }
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
