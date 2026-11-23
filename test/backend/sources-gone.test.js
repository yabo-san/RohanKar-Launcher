'use strict';
// Installed games never depend on their source: taken down upstream, the
// uploader switched off or removed, junk hidden, or the same game from
// another uploader. Fake uploaders only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { testApi } = require('./helpers');
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
  assert.deepEqual(games['a-one'].tags, ['source:fake-a', 'source-disabled']);
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
