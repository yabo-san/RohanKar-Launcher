'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const backend  = require('../../src/backend/sources.js');
const renderer = require('../../src/renderer/sources.js');
const { SEARCH } = require('./helpers');

// The renderer keeps its own copy until it reads grouped items from the API
test('backend and renderer agree on shipped sources and grouping', () => {
  assert.deepEqual(backend.DEFAULT_SOURCES, renderer.DEFAULT_SOURCES);
  const docs = [...Object.values(SEARCH).flat(), { identifier: 'x', title: ['The Game (v2) [GOG]'] }, { identifier: 'y-z' }];
  for (const d of docs) {
    assert.equal(backend.titleKey(d), renderer.titleKey(d), d.identifier);
    assert.equal(backend.getTitle(d), renderer.getTitle(d), d.identifier);
  }
});

test('sourcesFromSettings: saved list wins, drops junk, else the shipped list', () => {
  assert.equal(backend.sourcesFromSettings({}), backend.DEFAULT_SOURCES);
  assert.deepEqual(backend.sourcesFromSettings({ sources: [{ uploader: 'a' }, null, { label: 'no uploader' }] }), [{ uploader: 'a' }]);
});

test('getTitle falls back to identifier, then Unknown', () => {
  assert.equal(backend.getTitle({ identifier: 'half-life', title: '  ' }), 'half life');
  assert.equal(backend.getTitle({}), 'Unknown');
});
