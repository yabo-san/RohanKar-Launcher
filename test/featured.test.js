'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FEATURED_URL, heroUrl, parseFeatured, parseBanners, loadFeatured } = require('../src/backend/featured.js');

test('parseFeatured keeps picks in order and drops ones with no key', () => {
  assert.deepEqual(parseFeatured(JSON.stringify({ picks: [
    { identifier: ' dmc4 ', blurb: ' Stylish ' },
    { repository: 'Perfect-Dark-PC-Port/perfect_dark' },
    { identifier: '', repository: '  ' },
    null,
    'x',
  ] })), [
    { identifier: 'dmc4', blurb: 'Stylish', banner: null },
    { repository: 'perfect-dark-pc-port/perfect_dark', blurb: null, banner: null },
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
  const fetched = await loadFeatured({ fetchText: async (url) => { if (url.endsWith('banners.json')) throw new Error('404'); assert.equal(url, FEATURED_URL); return '{"picks":[{"identifier":"a"}]}'; }, readBundled: () => { throw new Error('unused'); }, log });
  assert.deepEqual(fetched, [{ identifier: 'a', blurb: null, banner: null }]);

  const bundled = await loadFeatured({ fetchText: async () => { throw new Error('offline'); }, readBundled: () => '{"picks":[{"identifier":"b"}]}', log });
  assert.deepEqual(bundled, [{ identifier: 'b', blurb: null, banner: null }]);

  const none = await loadFeatured({ fetchText: async () => 'not json', readBundled: () => { throw new Error('missing'); }, log });
  assert.deepEqual(none, []);
  assert.ok(logs.some(l => /no bundled copy/.test(l)));
});

const HERO = 'https://cdn2.steamgriddb.com/hero/0123456789abcdef0123456789abcdef.png';

test('heroUrl keeps SteamGridDB CDN images over https only', () => {
  assert.equal(heroUrl(` ${HERO} `), HERO);
  assert.equal(heroUrl('https://cdn.steamgriddb.com/hero/x.webp'), 'https://cdn.steamgriddb.com/hero/x.webp');
  for (const bad of ['http://cdn2.steamgriddb.com/hero/x.png', 'https://www.steamgriddb.com/hero/12345',
    'https://images.igdb.com/igdb/image/upload/t_1080p/x.jpg', 'javascript:alert(1)', 'not a url', '', null, 7]) {
    assert.equal(heroUrl(bad), null, String(bad));
  }
});

test('parseFeatured keeps a pinned CDN banner and drops a page link', () => {
  assert.deepEqual(parseFeatured(JSON.stringify({ picks: [
    { identifier: 'a', banner: HERO },
    { identifier: 'b', banner: 'https://www.steamgriddb.com/hero/12345' },
  ] })).map(p => p.banner), [HERO, null]);
});

test('parseBanners maps keys to CDN URLs, lowercases repos, skips comments and page links', () => {
  const m = parseBanners(JSON.stringify({
    _comment: 'x',
    dmc4: { url: HERO, source: 'auto', artist: 'Julia', hero: 1 },
    'Owner/Repo': { url: HERO, source: 'pinned' },
    page: { url: 'https://www.steamgriddb.com/hero/12345', source: 'pinned' },
    junk: 'nope',
  }));
  assert.deepEqual([...m], [['dmc4', HERO], ['owner/repo', HERO]]);
  assert.throws(() => parseBanners('[]'), /object/);
});

test('loadFeatured: a pick\'s own banner wins over banners.json, which fills the rest', async () => {
  const other = HERO.replace('0123', '9999');
  const texts = {
    'https://x/featured.json': JSON.stringify({ picks: [{ identifier: 'a', banner: HERO }, { identifier: 'b' }, { repository: 'O/R' }, { identifier: 'c' }] }),
    'https://x/banners.json': JSON.stringify({ a: { url: other, source: 'auto' }, b: { url: other, source: 'auto' }, 'o/r': { url: HERO, source: 'pinned' } }),
  };
  const picks = await loadFeatured({ url: 'https://x/featured.json', fetchText: async (u) => texts[u], readBundled: () => { throw new Error('unused'); } });
  assert.deepEqual(picks.map(p => p.banner), [HERO, other, HERO, null]);

  // banners.json unreachable: the bundled copy
  const bundled = await loadFeatured({ url: 'https://x/featured.json',
    fetchText: async (u) => { if (u.endsWith('banners.json')) throw new Error('offline'); return texts[u]; },
    readBundled: () => { throw new Error('unused'); }, readBundledBanners: () => texts['https://x/banners.json'] });
  assert.deepEqual(bundled.map(p => p.banner), [HERO, other, HERO, null]);
});

test('the bundled banners.json parses', () => {
  parseBanners(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'banners.json'), 'utf8'));
});
