'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FEATURED_URL, parseFeatured, loadFeatured } = require('../src/backend/featured.js');

test('parseFeatured keeps picks in order and drops ones with no key', () => {
  assert.deepEqual(parseFeatured(JSON.stringify({ picks: [
    { identifier: ' dmc4 ', blurb: ' Stylish ' },
    { repository: 'Perfect-Dark-PC-Port/perfect_dark' },
    { identifier: '', repository: '  ' },
    null,
    'x',
  ] })), [
    { identifier: 'dmc4', blurb: 'Stylish' },
    { repository: 'perfect-dark-pc-port/perfect_dark', blurb: null },
  ]);
  assert.throws(() => parseFeatured('[]'), /picks/);
  assert.throws(() => parseFeatured('{}'), /picks/);
});

test('the bundled featured.json parses and has picks', () => {
  const picks = parseFeatured(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'featured.json'), 'utf8'));
  assert.ok(picks.length > 0);
});

test('loadFeatured: fetched copy, then bundled, then none', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const fetched = await loadFeatured({ fetchText: async (url) => { assert.equal(url, FEATURED_URL); return '{"picks":[{"identifier":"a"}]}'; }, readBundled: () => { throw new Error('unused'); }, log });
  assert.deepEqual(fetched, [{ identifier: 'a', blurb: null }]);

  const bundled = await loadFeatured({ fetchText: async () => { throw new Error('offline'); }, readBundled: () => '{"picks":[{"identifier":"b"}]}', log });
  assert.deepEqual(bundled, [{ identifier: 'b', blurb: null }]);

  const none = await loadFeatured({ fetchText: async () => 'not json', readBundled: () => { throw new Error('missing'); }, log });
  assert.deepEqual(none, []);
  assert.ok(logs.some(l => /no bundled copy/.test(l)));
});
