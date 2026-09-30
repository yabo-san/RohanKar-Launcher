'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  platformOf, yearOf, sizeLabel, installBytes, gameMeta, portMeta, versionRows, moreFrom, morePorts, createHistory,
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

test('portMeta: shelf, platform, data', () => {
  assert.deepEqual(portMeta({ shelfName: 'Nintendo', data: { status: 'available' }, tags: ['n64', 'platformer', 'rare', 'x'] }),
    ['Nintendo port', 'Windows', 'Game data from archive.org', 'n64, platformer, rare']);
  assert.deepEqual(portMeta({ data: { status: 'missing' }, tags: [] }), ['Port', 'Windows', 'Needs game data']);
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

test('morePorts: the same shelf, with data first', () => {
  const p = (id, shelf, status = 'none') => ({ id, shelf, data: { status } });
  const items = [p('x', 's1'), p('y', 's1', 'available'), p('z', 's2'), p('me', 's1')];
  assert.deepEqual(morePorts(items, items[3]).map(i => i.id), ['y', 'x']);
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
