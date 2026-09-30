'use strict';
// scripts/preview/build.js: the web preview, built from the e2e fixtures
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { build, key, quiverLists } = require('../scripts/preview/build');
const { tmpDir } = require('./backend/helpers');

test('keys drop the token and refresh and sort the query', () => {
  assert.equal(key('/items', { token: 't', shelf: 'wall', refresh: 'true' }), 'GET /items?shelf=wall');
  assert.equal(key('/items', { shelf: 'wall', search: 'a b' }), 'GET /items?search=a+b&shelf=wall');
  assert.equal(key('/health'), 'GET /health');
});

test('the Quiver lists are read from the new UI', () => {
  const { base, lists } = quiverLists();
  assert.match(base, /^https:\/\//);
  assert.ok(lists.some(l => l.shelf === 'Nintendo' && l.file === 'Nintendo.json'));
});

test('a fixtures build saves what the UIs load and wires preview.js into every page', async (t) => {
  const out = path.join(tmpDir(t, 'rk-preview-test-'), 'site');
  const info = await build({ out, fixtures: true });
  assert.equal(info.data, 'fixtures');
  assert.ok(info.items > 0);

  const { responses } = JSON.parse(fs.readFileSync(path.join(out, 'preview-data', 'manifest.json'), 'utf8'));
  for (const k of ['GET /settings', 'GET /sources', 'GET /featured', 'GET /library', 'GET /items?shelf=wall', 'GET /catalogs']) {
    assert.ok(responses[k], k);
    assert.ok(fs.existsSync(path.join(out, 'preview-data', responses[k].file)), k);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(out, 'preview-data', responses['GET /settings'].file), 'utf8'));
  assert.ok(settings.catalogs.length > 0, 'catalogs subscribed, so the page does not try to');
  assert.ok(Object.keys(responses).some(k => /^GET \/items\/[^/]+\/cover$/.test(k)));

  assert.match(fs.readFileSync(path.join(out, 'new', 'index.html'), 'utf8'), /<script src="\.\.\/preview\.js"><\/script>\s*<script src="\.\.\/api\.js">/);
  assert.match(fs.readFileSync(path.join(out, 'cider', 'index.html'), 'utf8'), /<script src="\.\.\/preview\.js"><\/script>\s*<script src="\.\.\/api\.js">/);
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<script src="preview\.js"><\/script>\s*<script src="api\.js">/);
  assert.ok(fs.existsSync(path.join(out, 'preview.js')));
});
