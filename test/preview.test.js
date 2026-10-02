'use strict';
// scripts/preview/build.js: the web preview, built from the e2e fixtures
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { build, key } = require('../scripts/preview/build');
const { tmpDir } = require('./backend/helpers');

test('keys drop the token and refresh and sort the query', () => {
  assert.equal(key('/items', { token: 't', shelf: 'wall', refresh: 'true' }), 'GET /items?shelf=wall');
  assert.equal(key('/items', { shelf: 'wall', search: 'a b' }), 'GET /items?search=a+b&shelf=wall');
  assert.equal(key('/health'), 'GET /health');
});

test('a fixtures build saves what the UIs load and wires preview.js into both pages', async (t) => {
  const out = path.join(tmpDir(t, 'rk-preview-test-'), 'site');
  const info = await build({ out, fixtures: true });
  assert.equal(info.data, 'fixtures');
  assert.ok(info.items > 0);

  const { responses } = JSON.parse(fs.readFileSync(path.join(out, 'preview-data', 'manifest.json'), 'utf8'));
  for (const k of ['GET /settings', 'GET /sources', 'GET /featured', 'GET /library', 'GET /items?shelf=wall', 'GET /catalogs']) {
    assert.ok(responses[k], k);
    assert.ok(fs.existsSync(path.join(out, 'preview-data', responses[k].file)), k);
  }
  // The curated shelf by default; Quiver's four saved again for the Settings switch
  const shelvesOf = (k) => JSON.parse(fs.readFileSync(path.join(out, 'preview-data', responses[k].file), 'utf8')).catalogs.map(c => c.shelf);
  assert.deepEqual(shelvesOf('GET /catalogs'), ['Curated']);
  assert.deepEqual(shelvesOf('QUIVER GET /catalogs'), ['Curated', 'Nintendo', 'PlayStation', 'Xbox', 'Other']);
  assert.ok(shelvesOf('ON QUIVER GET /catalogs').includes('Nintendo'));
  assert.ok(Object.keys(responses).some(k => /^GET \/items\/[^/]+\/cover$/.test(k)));

  // Saved again with Allow additional sources on: user.json's entries, badged
  const read = (k) => JSON.parse(fs.readFileSync(path.join(out, 'preview-data', responses[k].file), 'utf8'));
  assert.equal(read('GET /user-sources').enabled, false);
  assert.equal(read('ON GET /user-sources').enabled, true);
  assert.equal(read('GET /items?shelf=wall').items.some(i => i.userSource), false);
  assert.equal(read('ON GET /items?shelf=wall').items.find(i => i.id === 'rk-e2e-user-demo').userSource, true);
  assert.ok(read('ON GET /catalogs').catalogs.some(c => c.id === 'local'));
  assert.ok(responses['GET /items/rk-e2e-user-demo/cover'], 'covers for what only shows with it on');

  assert.match(fs.readFileSync(path.join(out, 'new', 'index.html'), 'utf8'), /<script src="\.\.\/preview\.js"><\/script>\s*<script src="\.\.\/api\.js">/);
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<script src="preview\.js"><\/script>\s*<script src="api\.js">/);
  assert.ok(fs.existsSync(path.join(out, 'preview.js')));
});
