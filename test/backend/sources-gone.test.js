'use strict';
// Installed games never depend on their source: taken down upstream, the
// uploader switched off or removed, junk hidden, or the same game from
// another uploader. Fake uploaders only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { testApi, makeZip } = require('./helpers');
const { runCli } = require('../../src/backend/cli');

const A = 'fake-a@example.com';
const B = 'fake-b@example.com';
const doc = (identifier, title, addeddate = '2024-01-01T00:00:00Z') => ({ identifier, title, addeddate, downloads: 1, subject: ['pc'] });
const A_DOCS = [doc('a-one', 'Game One'), doc('a-two', 'Game Two'), doc('a-three', 'Shared Game'), doc('a-junk', 'Junk Pack 9000')];
const B_DOCS = [doc('b-shared', 'Shared Game', '2025-01-01T00:00:00Z')];
const INSTALLED = ['a-one', 'a-two', 'a-three'];

async function setup(t) {
  const ctx = await testApi(t, { state: { search: { [A]: structuredClone(A_DOCS), [B]: structuredClone(B_DOCS) } } });
  const { backend, call, dataDir } = ctx;
  backend.settings.save({ sources: [{ uploader: A, label: 'pack-a', enabled: true }, { uploader: B, label: 'pack-b', enabled: true }] });
  await backend.items.load({ refresh: true });
  for (const id of INSTALLED) {
    const r = await call('POST', '/installs', { id });
    await backend.installs.wait(r.body.installs[0].id);
    fs.writeFileSync(path.join(dataDir, 'thumbcache', `${id}.jpg`), 'x');
  }
  const exported = async () => {
    const { file } = await backend.exportPlaynite(undefined, { loadItems: false });
    return Object.fromEntries(JSON.parse(fs.readFileSync(file, 'utf8')).games.map(g => [g.id, g]));
  };
  const items = async (f = {}) => (await backend.items.list({ refresh: true, ...f })).items;
  const versionOf = (list, id) => list.flatMap(i => i.versions).find(v => v.id === id);
  return { ...ctx, exported, items, versionOf };
}

// Installed, with its folder, exe and cover, in the library and the export
async function assertKept(ctx, ids) {
  const games = await ctx.exported();
  for (const id of ids) {
    const row = ctx.backend.library.get(id);
    assert.ok(row?.install_dir && fs.existsSync(row.install_dir), `${id} installed`);
    assert.ok(row.exe_path?.endsWith('game.exe'), `${id} keeps its exe`);
    assert.equal(games[id].installed, true, `${id} exported installed`);
    assert.ok(games[id].coverPath?.endsWith(`${id}.jpg`), `${id} keeps its cover`);
  }
  return games;
}

test('installs save where they came from', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(INSTALLED.map(id => ctx.backend.library.get(id).uploader), [A, A, A]);
  const games = await assertKept(ctx, INSTALLED);
  assert.deepEqual(games['a-one'].tags, ['source:pack-a']);
  assert.equal(games['a-one'].source, `archive.org:${A}`);
});

test('1. taken down upstream: stays installed, listed and playable, tagged removed-upstream', async (t) => {
  const ctx = await setup(t);
  ctx.fake.search[A] = ctx.fake.search[A].filter(d => d.identifier !== 'a-two');
  const list = await ctx.items();
  const v = ctx.versionOf(list, 'a-two');
  assert.deepEqual([v.local, v.localReason, v.origin, v.source.label], [true, 'removed-upstream', { uploader: A, label: 'pack-a' }, 'Removed upstream']);
  assert.equal(list.find(i => i.id === 'a-two').title, 'Game Two');
  const games = await assertKept(ctx, INSTALLED);
  assert.deepEqual(games['a-two'].tags, ['source:pack-a', 'removed-upstream']);
  assert.equal(games['a-two'].name, 'Game Two');
  assert.equal(games['a-two'].source, `archive.org:${A}`);
  assert.deepEqual(games['a-one'].tags, ['source:pack-a']);
});

test('2. source disabled: its uploads leave browse, its installs stay, tagged source-disabled', async (t) => {
  const ctx = await setup(t);
  ctx.backend.settings.save({ sources: [{ uploader: A, label: 'pack-a', enabled: false }, { uploader: B, label: 'pack-b', enabled: true }] });
  const list = await ctx.items();
  assert.ok(!list.flatMap(i => i.versions).some(v => v.id === 'a-junk'), 'not installed: out of browse');
  assert.deepEqual((await ctx.items({ source: A })), [], 'no pack lists it');
  for (const id of INSTALLED) assert.equal(ctx.versionOf(list, id).localReason, 'source-disabled');
  const games = await assertKept(ctx, INSTALLED);
  assert.deepEqual(games['a-one'].tags, ['source:pack-a', 'source-disabled']);
});

test('3. source removed, rescanned and re-added: installs kept, no duplicates, browse back', async (t) => {
  const ctx = await setup(t);
  const dirs = INSTALLED.map(id => ctx.backend.library.get(id).install_dir);
  ctx.backend.settings.save({ sources: [{ uploader: B, label: 'pack-b', enabled: true }] });
  await ctx.items();
  const scan = await ctx.backend.scanInstalls(path.dirname(dirs[0]));
  assert.deepEqual(scan.found, [], 'nothing re-adopted twice');
  const games = await assertKept(ctx, INSTALLED);
  assert.deepEqual(games['a-one'].tags, ['source:pack-a', 'source-removed']);
  assert.deepEqual(INSTALLED.map(id => ctx.backend.library.get(id).install_dir), dirs);

  // Re-added: the same rows link back, browse has its uploads again
  const rowsBefore = Object.keys(ctx.backend.library.all()).length;
  ctx.backend.settings.save({ sources: [{ uploader: B, label: 'pack-b', enabled: true }, { uploader: A, label: 'pack-a', enabled: true }] });
  const list = await ctx.items();
  assert.equal(Object.keys(ctx.backend.library.all()).length, rowsBefore);
  for (const id of INSTALLED) assert.equal(ctx.versionOf(list, id).local, undefined, `${id} live again`);
  assert.ok(ctx.versionOf(list, 'a-junk'));
  assert.equal(list.filter(i => i.versions.some(v => v.id === 'a-one')).length, 1);
  assert.deepEqual((await ctx.exported())['a-one'].tags, ['source:pack-a']);
});

test('4. junk hidden without unsubscribing: per upload and per keyword; installs untouched', async (t) => {
  const ctx = await setup(t);
  ctx.backend.settings.save({
    sources: [{ uploader: A, label: 'pack-a', enabled: true, titleExclude: 'Junk|Game Two' }, { uploader: B, label: 'pack-b', enabled: true }],
    excludeItems: ['a-one'],
  });
  const ids = (await ctx.items()).flatMap(i => i.versions).map(v => v.id);
  assert.ok(!ids.includes('a-junk'), 'keyword hides junk');
  assert.ok(ids.includes('a-one') && ids.includes('a-two'), 'installed ones keep their cards');
  await assertKept(ctx, INSTALLED);
});

test('5. same game from another uploader: shown as an alternative, never switched', async (t) => {
  const ctx = await setup(t);
  ctx.backend.settings.save({ sources: [{ uploader: A, label: 'pack-a', enabled: false }, { uploader: B, label: 'pack-b', enabled: true }] });
  const shared = (await ctx.items()).find(i => i.title === 'Shared Game');
  assert.deepEqual(shared.versions.map(v => [v.id, !!v.local]), [['b-shared', false], ['a-three', true]]);
  assert.equal(shared.library.identifier, 'a-three');
  const row = ctx.backend.library.get('a-three');
  assert.deepEqual([row.upload, row.uploader], [null, A], 'still the copy from A');
});

test('--export-sources and --import-sources back the uploader list up and add it back', async (t) => {
  const ctx = await setup(t);
  const file = path.join(ctx.dataDir, 'backup', 'sources.json');
  const lines = [];
  const print = (l) => lines.push(JSON.parse(l));
  ctx.backend.settings.save({ sources: [{ uploader: A, label: 'pack-a', enabled: true }, { uploader: B, label: 'pack-b', enabled: false }] });
  assert.equal((await runCli({ command: 'export-sources', value: file }, ctx.backend, { print })).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sources,
    [{ uploader: A, label: 'pack-a', enabled: true }, { uploader: B, label: 'pack-b', enabled: false }]);

  ctx.backend.settings.save({ sources: [] });
  assert.equal((await runCli({ command: 'import-sources', value: file }, ctx.backend, { print })).code, 0);
  assert.deepEqual(ctx.backend.settings.load().sources,
    [{ uploader: A, label: 'pack-a', enabled: true }, { uploader: B, label: 'pack-b', enabled: false }]);
  assert.deepEqual(lines.at(-1), { ok: true, added: 2 });
  await assertKept(ctx, INSTALLED);

  fs.writeFileSync(file, 'nope');
  assert.equal((await runCli({ command: 'import-sources', value: file }, ctx.backend, { print })).code, 1);
  assert.equal((await runCli({ command: 'import-sources', value: path.join(ctx.dataDir, 'none.json') }, ctx.backend, { print })).code, 1);
});

test('an install with no exe gets the one gamevault-exec names', async (t) => {
  const ctx = await setup(t);
  const dir = ctx.backend.library.get('a-one').install_dir;
  ctx.backend.library.setExePath('a-one', null);
  fs.writeFileSync(path.join(dir, 'gamevault-exec'), 'Game\\game.exe');
  assert.deepEqual(ctx.backend.library.fillExes(require('../../src/backend/disk').gamevaultExe), { filled: 1 });
  assert.equal(ctx.backend.library.get('a-one').exe_path, path.join(dir, 'Game', 'game.exe'));
  assert.deepEqual(ctx.backend.library.fillExes(() => null), { filled: 0 });
});

test('local store: install from it with no network, and a stored-only item is listed and installable', async (t) => {
  const ctx = await setup(t);
  const store = path.join(ctx.dataDir, 'nas');
  // The store has an item that isn't in the library and whose upload is gone
  const pdir = path.join(store, 'prototype-2_20260115');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'PROTOTYPE 2.zip'), makeZip({ 'Game/game.exe': 'MZ' }));
  ctx.backend.settings.save({ localStores: [store] });

  // Listed as in-the-store, under the download's name, in no pack's browse
  const list = await ctx.items();
  const v = ctx.versionOf(list, 'prototype-2_20260115');
  assert.deepEqual([v.local, v.localReason, v.localStorePath], [true, 'store-only', pdir]);
  assert.equal(list.find(i => i.id === 'prototype-2_20260115').title, 'PROTOTYPE 2');

  // Installs from the store with no archive.org request
  ctx.fake.requests.length = 0;
  const r = await ctx.call('POST', '/installs', { id: 'prototype-2_20260115' });
  await ctx.backend.installs.wait(r.body.installs[0].id);
  assert.equal(ctx.backend.installs.get(r.body.installs[0].id).status, 'done');
  assert.ok(!ctx.fake.requests.some(u => u.includes('prototype-2')), 'no network for a stored item');
  assert.ok(ctx.backend.library.get('prototype-2_20260115').install_dir);
  // The store keeps its copy
  assert.ok(fs.existsSync(path.join(pdir, 'PROTOTYPE 2.zip')));
});

test('an upload with a store copy installs from the store, not archive.org', async (t) => {
  const ctx = await setup(t);
  const store = path.join(ctx.dataDir, 'nas');
  const dir = path.join(store, 'a-junk');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a-junk.zip'), makeZip({ 'Game/game.exe': 'MZ' }));
  ctx.backend.settings.save({ localStores: [store] });
  ctx.fake.requests.length = 0;
  const r = await ctx.call('POST', '/installs', { id: 'a-junk' });
  await ctx.backend.installs.wait(r.body.installs[0].id);
  assert.equal(ctx.backend.installs.get(r.body.installs[0].id).status, 'done');
  assert.ok(!ctx.fake.requests.some(u => u.includes('download/a-junk')), 'no download for a stored item');
});

test('back up to local store, and keep every download there', async (t) => {
  const ctx = await setup(t);
  const store = path.join(ctx.dataDir, 'nas');
  fs.mkdirSync(store, { recursive: true });
  assert.equal((await ctx.call('POST', '/library/a-one/backup')).status, 409, 'no store set yet');

  ctx.backend.settings.save({ localStores: [store] });
  const r = await ctx.call('POST', '/library/a-one/backup');
  assert.equal(r.status, 200);
  assert.equal(r.body.dir, path.join(store, 'a-one'));
  assert.ok(fs.readdirSync(path.join(store, 'a-one')).length, 'the download is in the store');
  // Again: the copy is already there
  assert.equal((await ctx.call('POST', '/library/a-one/backup')).body.existing, true);

  // keepInStore: a fresh install leaves its download in the store
  ctx.backend.settings.save({ keepInStore: true });
  const inst = await ctx.call('POST', '/installs', { id: 'a-junk' });
  await ctx.backend.installs.wait(inst.body.installs[0].id);
  assert.ok(fs.existsSync(path.join(store, 'a-junk')), 'the download was kept');
});

test('the export carries the schema-2 standing fields', async (t) => {
  const ctx = await setup(t);
  const store = path.join(ctx.dataDir, 'nas');
  fs.mkdirSync(path.join(store, 'stored-gone'), { recursive: true });
  fs.writeFileSync(path.join(store, 'stored-gone', 'g.zip'), makeZip({ 'Game/game.exe': 'MZ' }));
  ctx.backend.settings.save({ localStores: [store] });
  // a-two taken down upstream (pack still on); b-shared is an alternative to a-three
  ctx.fake.search[A] = ctx.fake.search[A].filter(d => d.identifier !== 'a-two');
  await ctx.items();

  const games = await ctx.exported();
  assert.deepEqual(
    [games['a-one'].state, games['a-one'].upstreamState, games['a-one'].sourceState, games['a-one'].sourceLabel, games['a-one'].itemId],
    ['installed', 'available', 'active', 'pack-a', 'a-one']);
  assert.deepEqual([games['a-two'].state, games['a-two'].upstreamState, games['a-two'].sourceState], ['installed', 'removed', 'active']);
  assert.deepEqual(games['a-three'].alternatives, [{ sourceLabel: 'pack-b', itemId: 'b-shared' }]);
  // In the store, not in the library, no live item
  assert.deepEqual([games['stored-gone'].state, games['stored-gone'].localStorePath], ['in-local-store', path.join(store, 'stored-gone')]);
});

test('an uploader disabled while a game is installed: sourceState disabled, not removed', async (t) => {
  const ctx = await setup(t);
  ctx.backend.settings.save({ sources: [{ uploader: A, label: 'pack-a', enabled: false }, { uploader: B, label: 'pack-b', enabled: true }] });
  await ctx.items();
  assert.equal((await ctx.exported())['a-one'].sourceState, 'disabled');
});
