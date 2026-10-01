'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const LV = require('../src/frontend/list-view.js');

const game = (id, extra = {}) => {
  const g = { identifier: id, title: id.toUpperCase(), _sourceLabel: 'uploader', addeddate: '2024-01-02T00:00:00Z', ...extra };
  g._versions = extra._versions || [g];
  return g;
};
const ctx = (library = {}, downloads = new Map()) => ({ kind: 'game', library, downloads });

test('ciderSort: numbers as numbers, text case-insensitively; ciderSearch ignores punctuation', () => {
  const rows = [{ v: '10' }, { v: '9' }, { v: 'b' }, { v: 'A' }];
  assert.deepEqual(LV.ciderSort(rows.slice(0, 2), r => r.v, 'asc').map(r => r.v), ['9', '10']);
  assert.deepEqual(LV.ciderSort(rows.slice(2), r => r.v, 'asc').map(r => r.v), ['A', 'b']);
  assert.deepEqual(LV.ciderSort(rows.slice(2), r => r.v, 'desc').map(r => r.v), ['b', 'A']);
  assert.deepEqual(LV.ciderSearch([{ t: 'Zoo Tycoon' }, { t: 'Halo' }], 'zoo tycoon!', r => [r.t]).map(r => r.t), ['Zoo Tycoon']);
  assert.equal(LV.ciderSearch([1, 2], '', () => []).length, 2);
});

test('gameStatus: downloading, newer release, installed, nothing', () => {
  const old = game('a');
  old._newer = 'b';
  assert.deepEqual(LV.gameStatus(old, ctx({ a: { install_dir: '/g' } })), { label: 'Newer release', kind: 'update' });
  assert.deepEqual(LV.gameStatus(game('a'), ctx({ a: { install_dir: '/g' } })), { label: 'Installed', kind: 'ok' });
  assert.deepEqual(LV.gameStatus(game('a'), ctx({}, new Map([['a', { status: 'downloading', percent: 42 }]]))), { label: '42%', kind: 'busy' });
  assert.deepEqual(LV.gameStatus(game('a'), ctx({}, new Map([['a', { status: 'extracting' }]]))).label, 'Installing…');
  assert.deepEqual(LV.gameStatus(game('a'), ctx()), { label: '', kind: '' });
});

test('portStatus and isFavorite read the library row', () => {
  const p = { id: 'quiver:x', data: { status: 'available' } };
  const c = (lib) => ({ kind: 'port', library: lib, downloads: new Map() });
  assert.equal(LV.portStatus(p, c({})).label, 'Game data');
  assert.equal(LV.portStatus({ ...p, data: { status: 'missing' } }, c({})).label, 'Needs data');
  assert.equal(LV.portStatus(p, c({ 'quiver:x': {} })).label, 'In library');
  assert.equal(LV.portStatus(p, c({ 'quiver:x': { install_dir: '/p' } })).label, 'Installed');
  assert.equal(LV.isFavorite(p, c({ 'quiver:x': { is_favorite: 1 } })), true);
  // A grouped game is a favourite when any version is
  const a = game('a'), b = game('b');
  a._versions = b._versions = [a, b];
  assert.equal(LV.isFavorite(a, ctx({ b: { is_favorite: 1 } })), true);
  assert.equal(LV.isFavorite(a, ctx({ b: { is_favorite: 0 } })), false);
});

test('visibleColumns: required always, hidden ones and empty ones never', () => {
  const rows = [game('a', { platform: 'PC', downloads: 5 }), game('b')];
  const ids = (hidden) => LV.visibleColumns(LV.GAME_COLUMNS, hidden, rows, ctx()).map(c => c.id);
  // no row has a release date, a size or a status
  assert.deepEqual(ids([]), ['name', 'uploader', 'platform', 'added', 'downloads']);
  assert.deepEqual(ids(['uploader', 'name']), ['name', 'platform', 'added', 'downloads']);
  assert.deepEqual(ids(['nope']), ids([]));
  const choices = LV.columnChoices(LV.GAME_COLUMNS, ['uploader'], rows, ctx());
  assert.equal(choices.some(c => c.id === 'name'), false, 'the name column cannot be hidden');
  assert.deepEqual(choices.find(c => c.id === 'uploader'), { id: 'uploader', label: 'Uploader', on: false, empty: false });
  assert.deepEqual(choices.find(c => c.id === 'size'), { id: 'size', label: 'Size', on: true, empty: true });
});

test('toggleColumn and gridTemplate', () => {
  assert.deepEqual(LV.toggleColumn([], 'size'), ['size']);
  assert.deepEqual(LV.toggleColumn(['size', 'status'], 'size'), ['status']);
  assert.deepEqual(LV.toggleColumn(undefined, 'a'), ['a']);
  const cols = LV.GAME_COLUMNS.filter(c => ['name', 'added'].includes(c.id));
  assert.equal(LV.gridTemplate(cols), '22px 26px minmax(0, 3fr) minmax(0, .8fr) 44px');
});

test('headerSort: another column sorts in its first order, the same one flips; ariaSort', () => {
  const col = (id) => LV.GAME_COLUMNS.find(c => c.id === id);
  assert.deepEqual(LV.headerSort({ sort: 'dateAdded', order: 'desc' }, col('name')), { sort: 'name', order: 'asc' });
  assert.deepEqual(LV.headerSort({ sort: 'name', order: 'asc' }, col('name')), { sort: 'name', order: 'desc' });
  assert.deepEqual(LV.headerSort({ sort: 'name', order: 'desc' }, col('name')), { sort: 'name', order: 'asc' });
  assert.deepEqual(LV.headerSort({ sort: 'name', order: 'asc' }, col('downloads')), { sort: 'downloads', order: 'desc' });
  assert.equal(LV.headerSort({ sort: 'name' }, { id: 'x' }), null);
  assert.equal(LV.ariaSort({ sort: 'name', order: 'asc' }, col('name')), 'ascending');
  assert.equal(LV.ariaSort({ sort: 'name', order: 'desc' }, col('name')), 'descending');
  assert.equal(LV.ariaSort({ sort: 'name', order: 'asc' }, col('added')), 'none');
  // every column's sort key is a real sort
  for (const c of LV.GAME_COLUMNS) assert.ok(LV.GAME_SORTS[c.sort], c.id);
  for (const c of LV.PORT_COLUMNS) assert.ok(LV.PORT_SORTS[c.sort], c.id);
});

test('sortRows: by the pref, a key the table lacks falls back, names break ties', () => {
  const rows = [game('c', { downloads: 1 }), game('a', { downloads: 1 }), game('b', { downloads: 9 })];
  const ids = (prefs, tables = [LV.GAME_SORTS]) => LV.sortRows(rows, prefs, tables, 'name', ctx()).map(g => g.identifier);
  assert.deepEqual(ids({ sort: 'downloads', order: 'desc' }), ['b', 'a', 'c']);
  assert.deepEqual(ids({ sort: 'name', order: 'asc' }), ['a', 'b', 'c']);
  assert.deepEqual(ids({ sort: 'nope', order: 'desc' }), ['c', 'b', 'a']);
  // the first table that has the key wins
  const mine = { downloads: ['Mine', g => g.identifier === 'c' ? 1 : 0] };
  assert.deepEqual(ids({ sort: 'downloads', order: 'desc' }, [mine, LV.GAME_SORTS]), ['c', 'a', 'b']);
  const installed = LV.sortRows(rows, { sort: 'status', order: 'desc' }, [LV.GAME_SORTS], 'name', ctx({ c: { install_dir: '/c' } }));
  assert.equal(installed[0].identifier, 'c');
});

test('column cells: dates, numbers, sizes and missing data', () => {
  const col = (id) => LV.GAME_COLUMNS.find(c => c.id === id);
  const g = game('a', { date: '1999-05-01T00:00:00Z', downloads: 12345, size: 1536, platform: 'PlayStation' });
  assert.equal(col('released').text(g), '1999-05-01');
  assert.equal(col('added').text(g), '2024-01-02');
  assert.equal(col('downloads').text(g), '12,345');
  assert.equal(col('size').text(g), '1.5 KB');
  assert.equal(col('platform').text(g), 'PlayStation');
  assert.equal(col('name').text(g), 'A');
  const bare = game('b', { addeddate: null, _sourceLabel: undefined });
  for (const id of ['released', 'added', 'downloads', 'size', 'platform', 'uploader']) assert.equal(col(id).text(bare), '', id);
  const port = { name: 'P', project: 'Proj', repository: 'o/r', shelfName: 'Nintendo', data: { status: 'none' } };
  assert.deepEqual(LV.PORT_COLUMNS.map(c => c.text(port, { library: {}, downloads: new Map() })), ['P', 'Proj', 'o/r', 'Nintendo', '']);
});

test('row actions: sections in group order, filtered by kind and when, submenus, replace by id', () => {
  const reg = LV.createActions();
  const ran = [];
  reg.register({ id: 'del', label: 'Delete', group: 'remove', danger: true, icon: 'trash' });
  reg.register({ id: 'play', label: 'Play', group: 'play', when: (x) => x.installed, run: (x) => ran.push(x.id) });
  reg.register({ id: 'install', label: (x, c) => (c.kind === 'port' ? 'Download' : 'Install'), group: 'play', when: (x) => !x.installed });
  reg.register({ id: 'fav', label: 'Favorite', group: 'manage', kinds: ['game'] });
  reg.register({ id: 'opts', label: 'Launch Options', group: 'play', kinds: ['port'], children: [
    { id: 'exe', label: 'Choose Executable…' },
    { id: 'never', label: 'Never', when: () => false },
  ] });
  reg.register({ id: 'empty-sub', label: 'Nothing', group: 'goto', children: [{ id: 'no', label: 'No', when: () => false }] });

  const labels = (item, kind) => reg.sections(item, { kind }).map(s => s.map(e => e.label));
  assert.deepEqual(labels({ installed: false }, 'game'), [['Install'], ['Favorite'], ['Delete']]);
  assert.deepEqual(labels({ installed: true }, 'port'), [['Play', 'Launch Options'], ['Delete']]);
  assert.deepEqual(labels({ installed: false }, 'port')[0], ['Download', 'Launch Options']);
  const opts = reg.sections({}, { kind: 'port' })[0].find(e => e.id === 'opts');
  assert.deepEqual(opts.children.map(c => c.id), ['exe']);
  assert.deepEqual(reg.sections({}, { kind: 'game' }).at(-1)[0], { id: 'del', label: 'Delete', icon: 'trash', danger: true, children: null });

  // Another thread adds an admin action without touching the rest
  reg.register({ id: 'make-collision', label: 'Make collision', group: 'admin', icon: 'box' });
  assert.deepEqual(labels({ installed: true }, 'game').at(-2), ['Make collision']);
  assert.deepEqual(LV.MENU_GROUPS, ['pin', 'collection', 'play', 'manage', 'goto', 'admin', 'remove']);

  reg.register({ id: 'del', label: 'Remove', group: 'remove' });
  assert.deepEqual(labels({ installed: true }, 'game').at(-1), ['Remove']);
  assert.equal(reg.all().filter(a => a.id === 'del').length, 1);
  assert.equal(reg.get('exe').label, 'Choose Executable…');
  reg.get('play').run({ id: 'x' });
  assert.deepEqual(ran, ['x']);
  assert.equal(reg.get('nope'), null);
  assert.throws(() => reg.register({ id: 'x', group: 'elsewhere' }), /unknown menu group/);
  assert.throws(() => reg.register({ group: 'play' }), /needs an id/);
});
