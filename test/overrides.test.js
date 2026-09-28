'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OVERRIDES_URL, parseOverrides, loadOverrides, artSource } = require('../src/main/overrides.js');
const { getTitle, titleKey } = require('../src/renderer/sources.js');

test('override title wins for display and grouping', () => {
  const junk  = { identifier: 'tlr-pstriple', title: 'TLR_PC_FINAL (1)', _override: { title: 'The Last Remnant' } };
  const named = { identifier: 'the-last-remnant', title: 'The Last Remnant' };
  assert.equal(getTitle(junk), 'The Last Remnant');
  assert.equal(titleKey(junk), titleKey(named));
});

test('no override keeps the archive.org title', () => {
  assert.equal(getTitle({ identifier: 'x', title: 'Original', _override: { artUrl: 'https://a/b.jpg' } }), 'Original');
  assert.equal(getTitle({ identifier: 'x', title: 'Original' }), 'Original');
});

test('artSource: absolute URL is fetched', () => {
  assert.deepEqual(artSource('https://img.example/cover.jpg'), { remote: 'https://img.example/cover.jpg' });
  assert.deepEqual(artSource('http://img.example/c.png'), { remote: 'http://img.example/c.png' });
});

test('artSource: path under assets/covers/ is bundled', () => {
  assert.deepEqual(artSource('assets/covers/the-last-remnant.jpg'), { bundled: 'assets/covers/the-last-remnant.jpg' });
  assert.deepEqual(artSource('assets\\covers\\x.jpg'), { bundled: 'assets/covers/x.jpg' });
});

test('artSource: anything else is ignored', () => {
  assert.equal(artSource(undefined), null);
  assert.equal(artSource(''), null);
  assert.equal(artSource(42), null);
  assert.equal(artSource('assets/heroes/x.png'), null);
  assert.equal(artSource('assets/covers/../../main.js'), null);
  assert.equal(artSource('file:///C:/x.jpg'), null);
});

test('parseOverrides rejects non-objects', () => {
  assert.deepEqual(parseOverrides('{"a":{"title":"A"}}'), { a: { title: 'A' } });
  assert.throws(() => parseOverrides('[]'));
  assert.throws(() => parseOverrides('null'));
  assert.throws(() => parseOverrides('not json'));
});

const bundled = '{"b":{"title":"Bundled"}}';

test('loadOverrides: fetched copy wins over bundled', async () => {
  let asked;
  const o = await loadOverrides({
    fetchText: async (url) => { asked = url; return '{"f":{"title":"Fetched"}}'; },
    readBundled: () => bundled,
  });
  assert.equal(asked, OVERRIDES_URL);
  assert.deepEqual(o, { f: { title: 'Fetched' } });
});

test('loadOverrides: fetch failure falls back to bundled', async () => {
  const logs = [];
  const o = await loadOverrides({
    fetchText: async () => { throw new Error('timed out'); },
    readBundled: () => bundled,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(o, { b: { title: 'Bundled' } });
  assert.match(logs.join('\n'), /timed out/);
});

test('loadOverrides: bad fetched JSON falls back to bundled', async () => {
  const o = await loadOverrides({ fetchText: async () => '<html>', readBundled: () => bundled });
  assert.deepEqual(o, { b: { title: 'Bundled' } });
});

test('loadOverrides: no file anywhere means no overrides', async () => {
  const o = await loadOverrides({
    fetchText: async () => { throw new Error('HTTP 404'); },
    readBundled: () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(o, {});
});

test('the bundled overrides.json parses', () => {
  const o = parseOverrides(require('fs').readFileSync(require('path').join(__dirname, '../overrides.json'), 'utf8'));
  for (const entry of Object.values(o)) {
    for (const field of ['artUrl', 'hero']) {
      if (entry[field] != null) assert.ok(artSource(entry[field]), `${field} ${entry[field]} is usable`);
    }
  }
});
