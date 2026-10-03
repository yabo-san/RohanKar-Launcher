'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  platformOf, yearOf, sizeLabel, installBytes, gameMeta, portMeta, versionRows, moreFrom, morePorts, createHistory,
  collapseSeries, seriesRows, seriesMeta,
} = require('../src/frontend/details.js');

test('platformOf: the first subject naming a platform', () => {
  assert.equal(platformOf(['tycoon', 'pc']), 'PC');
  assert.equal(platformOf('Strategy; MS-DOS'), 'DOS');
  assert.equal(platformOf(['N64', 'Windows']), 'Nintendo 64');
  assert.equal(platformOf(['shooter']), '');
  assert.equal(platformOf(null), '');
});

test('yearOf: date first, then addeddate', () => {
  assert.equal(yearOf({ date: '1999-05-01', addeddate: '2024-01-01T00:00:00Z' }), '1999');
  assert.equal(yearOf({ addeddate: '2024-01-01T00:00:00Z' }), '2024');
  assert.equal(yearOf({ date: 'unknown' }), '');
});

test('installBytes and sizeLabel: the largest installable file', () => {
  assert.equal(installBytes([{ size: '100' }, { size: '734003200' }, { size: 'x' }]), 734003200);
  assert.equal(installBytes(null), 0);
  assert.equal(sizeLabel(734003200), '700 MB');
  assert.equal(sizeLabel(1536), '1.5 KB');
  assert.equal(sizeLabel(0), '');
});

test('gameMeta: platform, year, size, downloads, only what is known', () => {
  const v = { subject: ['pc', 'tycoon'], addeddate: '2024-03-01T10:00:00Z', downloads: 1200 };
  assert.deepEqual(gameMeta(v, { bytes: 2 * 1024 ** 3 }), ['PC', '2024', '2.0 GB', '1,200 downloads']);
  assert.deepEqual(gameMeta({ downloads: 1 }), ['1 download']);
  assert.deepEqual(gameMeta({}), []);
});

test('portMeta: shelf, platform, tags', () => {
  assert.deepEqual(portMeta({ shelfName: 'Nintendo', tags: ['n64', 'platformer', 'rare', 'x'] }),
    ['Nintendo port', 'Windows', 'n64, platformer, rare']);
  assert.deepEqual(portMeta({ tags: [] }), ['Port', 'Windows']);
});

test('versionRows: newest first, numbered, installed, newer and selected marked', () => {
  const versions = [
    { identifier: 'old', _sourceLabel: 'rohan', addeddate: '2024-03-01T10:00:00Z', downloads: 1200, _newer: 'new' },
    { identifier: 'new', _sourceLabel: 'frankie', addeddate: '2025-01-08T10:00:00Z', downloads: 300, _user: true },
  ];
  const rows = versionRows(versions, { selected: 'old', library: { old: { install_dir: '/g/old' } } });
  assert.deepEqual(rows, [
    { n: 1, identifier: 'new', uploader: 'frankie', date: '2025-01-08', downloads: 300, installed: false, newer: true, user: true, on: false },
    { n: 2, identifier: 'old', uploader: 'rohan', date: '2024-03-01', downloads: 1200, installed: true, newer: false, user: false, on: true },
  ]);
  // Not installed: a newer upload is nothing to point at
  assert.equal(versionRows(versions, {}).some(r => r.newer), false);
});

test('moreFrom: same uploader, most downloaded first, the current title left out', () => {
  const a = { identifier: 'a', downloads: 5, _uploader: 'u1' };
  const b = { identifier: 'b', downloads: 50, _uploader: 'u1' };
  const c = { identifier: 'c', downloads: 500, _uploader: 'u2' };
  const d = { identifier: 'd', downloads: 1, _versions: [{ _uploader: 'u2' }, { _uploader: 'u1' }] };
  assert.deepEqual(moreFrom([a, b, c, d], 'u1', { except: a }).map(g => g.identifier), ['b', 'd']);
  assert.deepEqual(moreFrom([a, b], 'u1', { limit: 1 }).map(g => g.identifier), ['b']);
  assert.deepEqual(moreFrom([a], null), []);
});

test('morePorts: the same shelf, in catalog order, the current port left out', () => {
  const p = (id, shelf) => ({ id, shelf });
  const items = [p('x', 's1'), p('y', 's1'), p('z', 's2'), p('me', 's1')];
  assert.deepEqual(morePorts(items, items[3]).map(i => i.id), ['x', 'y']);
  assert.deepEqual(morePorts(items, items[3], { limit: 1 }).map(i => i.id), ['x']);
});

test('createHistory: back returns the page with its scroll, forward redoes, a new page clears forward', () => {
  const h = createHistory();
  const home = { name: 'home', scroll: 420 };
  const game = { name: 'game', arg: 'halo' };
  assert.equal(h.canBack, false);
  assert.equal(h.push(home, game), true);
  assert.equal(h.push(game, { name: 'game', arg: 'halo' }), false, 'the same page is not a step');
  assert.equal(h.canBack, true);
  assert.deepEqual(h.step({ ...game, scroll: 10 }, -1), home);
  assert.equal(h.canForward, true);
  assert.deepEqual(h.step(home, 1), { ...game, scroll: 10 });
  assert.equal(h.step(game, 1), null);
  h.step(game, -1);
  h.push(home, { name: 'wall' });
  assert.equal(h.canForward, false);
  // A search is its own page
  assert.equal(h.push({ name: 'home', query: 'halo' }, { name: 'home' }), true);
});

const titled = (id, extra = {}) => ({ identifier: id, title: id, _sourceLabel: 'rohanjackson071', platform: 'PC', ...extra });

test('collapseSeries: a series is one card where its first game was; one game alone stays itself', () => {
  const games = [
    titled('halo'),
    titled('fifa-18', { _series: 'FIFA', addeddate: '2025-02-01', downloads: 10, date: '2017' }),
    titled('wwe-2k20', { _series: 'WWE 2K' }),
    titled('fifa-08', { _series: 'FIFA', addeddate: '2025-06-01', downloads: 90, date: '2007', _sourceLabel: 'r4zel1ght' }),
  ];
  const out = collapseSeries(games);
  assert.deepEqual(out.map(x => x.identifier), ['halo', 'series:FIFA', 'wwe-2k20']);
  const fifa = out[1];
  assert.equal(fifa._seriesCard, true);
  assert.equal(fifa.title, 'FIFA');
  assert.deepEqual(fifa._games.map(g => g.identifier), ['fifa-18', 'fifa-08']);
  assert.equal(fifa.downloads, 100);
  assert.equal(fifa.addeddate, '2025-06-01');
  assert.equal(fifa.date, '2007');
  assert.equal(fifa.platform, 'PC');
  assert.equal(fifa._sourceLabel, '2 uploaders');
  // the most downloaded game's art
  assert.equal(fifa._cover, 'fifa-08');
  assert.deepEqual(collapseSeries(null), []);
});

test('seriesRows: oldest first, numbered, versions and installs counted per game', () => {
  const a = titled('fifa-18', { date: '2017', downloads: 5 });
  const b1 = titled('fifa-08', { date: '2007', downloads: 3 });
  const b2 = titled('fifa-08-pstriple', { downloads: 4 });
  b1._versions = [b1, b2];
  const c = titled('fifa-17', { date: '2017' });
  const rows = seriesRows([a, b1, c], { titleOf: g => g.title.toUpperCase(), library: { 'fifa-08-pstriple': { install_dir: '/g' } } });
  assert.deepEqual(rows.map(r => [r.n, r.title, r.year]), [[1, 'FIFA-08', '2007'], [2, 'FIFA-17', '2017'], [3, 'FIFA-18', '2017']]);
  assert.deepEqual(rows[0], { n: 1, identifier: 'fifa-08', title: 'FIFA-08', year: '2007', uploader: 'rohanjackson071', downloads: 7, versions: 2, installed: true });
  assert.equal(rows[2].installed, false);
});

test('seriesMeta: years, games, downloads', () => {
  assert.deepEqual(seriesMeta([{ year: '2007', downloads: 1000 }, { year: '2017', downloads: 234 }]), ['2007–2017', '2 games', '1,234 downloads']);
  assert.deepEqual(seriesMeta([{ year: '2007', downloads: 0 }, { year: '2007', downloads: 0 }]), ['2007', '2 games']);
  assert.deepEqual(seriesMeta([{ year: '', downloads: 1 }]), ['1 game', '1 download']);
});
