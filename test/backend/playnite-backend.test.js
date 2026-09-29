'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { buildExport, findRow, readExport, writeExport, platformOf, SCHEMA_VERSION, PLATFORMS } = require('../../src/backend/playnite');
const { createBackend, defaultHost } = require('../../src/backend');
const { testBackend, tmpDir } = require('./helpers');

test('buildExport: one record per library row, ids, sources and platforms per kind', () => {
  const data = buildExport({
    now: 0,
    launcherVersion: '9.9.9',
    rows: {
      a:  { identifier: 'a', install_dir: '/g/a', exe_path: '/g/a/bin/a.exe', playtime_secs: 60, is_favorite: 1, last_played_at: 1000 },
      'quiver:c1:x/sm64': { identifier: 'quiver:c1:x/sm64', install_dir: null, exe_path: null, source: 'https://c/n.json' },
      m:  { identifier: 'm', install_dir: '/g/m', exe_path: null, source: 'manual' },
      m2: { identifier: 'm2', source: 'manual' },
      z:  { identifier: 'z' },
      'quiver:c2:y/gone': { identifier: 'quiver:c2:y/gone' },
    },
    items: {
      a: { title: 'A Game', source: { type: 'archive.org', uploader: 'u@x' } },
      'quiver:c1:x/sm64': { title: 'SM64 PC', shelf: 'Nintendo 64', source: { type: 'quiver', url: 'https://c/n.json', name: 'N' }, entry: { folderName: 'sm64ex' } },
    },
    tagsFor: (id) => (id === 'a' ? ['Faves'] : []),
    art: (id) => (id === 'a' ? { cover: '/c/a.jpg', hero: '/h/a.png' } : {}),
    exportIdFor: (id) => (id === 'm' ? '00000000-0000-4000-8000-000000000001' : null),
    previous: { games: [{ id: 'z', name: 'Zed', source: 'archive.org:old@x' }, { id: 'quiver:y/gone', name: 'Gone', source: 'quiver:https://old', platform: 'Xbox', folderName: 'gone' }] },
  });
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(data.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(data.launcherVersion, '9.9.9');
  const [a, q, m, z, gone] = data.games;
  assert.equal(data.games.length, 5, 'a manual entry without an id is left out');
  assert.deepEqual(a, {
    id: 'a', name: 'A Game', source: 'archive.org:u@x', platform: 'PC', installed: true, installDir: '/g/a',
    exe: '/g/a/bin/a.exe', args: '', workingDir: '/g/a/bin', version: null, updateAvailable: false,
    coverPath: '/c/a.jpg', heroPath: '/h/a.png', tags: ['Faves'], lastPlayed: '1970-01-01T00:00:01.000Z',
    playtimeSeconds: 60, favorite: true,
  });
  assert.deepEqual([q.id, q.name, q.source, q.platform, q.installed, q.workingDir, q.folderName],
    ['quiver:x/sm64', 'SM64 PC', 'quiver:https://c/n.json', 'Nintendo', false, null, 'sm64ex']);
  assert.deepEqual([m.id, m.name, m.source, m.platform, m.workingDir], ['00000000-0000-4000-8000-000000000001', 'm', 'manual', 'PC', '/g/m']);
  assert.deepEqual([z.name, z.source, z.coverPath, z.lastPlayed], ['Zed', 'archive.org:old@x', null, null]);
  assert.deepEqual([gone.id, gone.name, gone.source, gone.platform, gone.folderName], ['quiver:y/gone', 'Gone', 'quiver:https://old', 'Xbox', 'gone']);
  assert.equal(buildExport({ rows: {} }).games.length, 0);
  const bare = buildExport({ rows: { z: { identifier: 'z' }, 'quiver:c:k': { identifier: 'quiver:c:k' } } }).games;
  assert.deepEqual(bare.map(g => [g.source, g.platform]), [['archive.org:', 'PC'], ['quiver:', 'Other']]);
});

test('buildExport: updateAvailable when a newer upload of the installed title exists', () => {
  const item = { title: 'T', source: { type: 'archive.org', uploader: 'u' }, versions: [
    { id: 'old', addeddate: '2024-01-01' }, { id: 'new', addeddate: '2024-06-01' }, { id: 'undated' },
  ] };
  const rows = {
    old: { identifier: 'old', install_dir: '/g/old' }, new: { identifier: 'new', install_dir: '/g/new' },
    undated: { identifier: 'undated', install_dir: '/g/u' }, notInstalled: { identifier: 'notInstalled' },
  };
  const games = buildExport({ rows, items: { old: item, new: item, undated: item, notInstalled: item } }).games;
  assert.deepEqual(games.map(g => g.updateAvailable), [true, false, false, false]);
});

test('platformOf: catalog shelves onto the five platforms', () => {
  const cases = { Nintendo: 'Nintendo', 'Switch ports': 'Nintendo', 'N64': 'Nintendo', PlayStation: 'PlayStation', PS2: 'PlayStation',
    'Xbox 360': 'Xbox', PC: 'PC', 'Windows': 'PC', Sega: 'Other', '': 'Other', undefined: 'Other' };
  for (const [shelf, want] of Object.entries(cases)) assert.equal(platformOf(shelf === 'undefined' ? undefined : shelf), want, shelf);
  assert.deepEqual(PLATFORMS, ['PC', 'Nintendo', 'PlayStation', 'Xbox', 'Other']);
});

test('findRow: export ids back to library rows', () => {
  const rows = {
    ia: { identifier: 'ia' },
    'quiver:c1:x/sm64': { identifier: 'quiver:c1:x/sm64' },
    man: { identifier: 'man', source: 'manual', export_id: 'uuid-1' },
  };
  assert.equal(findRow(rows, 'ia').identifier, 'ia');
  assert.equal(findRow(rows, 'quiver:x/sm64').identifier, 'quiver:c1:x/sm64');
  assert.equal(findRow(rows, 'uuid-1').identifier, 'man');
  assert.equal(findRow(rows, 'quiver:none'), null);
  assert.equal(findRow(rows, 'nothing'), null);
  assert.equal(findRow(rows, ''), null);
  assert.equal(findRow(rows, null), null);
});

test('readExport: null when missing or not JSON', (t) => {
  const dir = tmpDir(t);
  assert.equal(readExport(path.join(dir, 'none.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.equal(readExport(path.join(dir, 'bad.json')), null);
});

test('writeExport: atomic write, creates the folder', (t) => {
  const file = path.join(tmpDir(t), 'deep', 'out.json');
  writeExport(file, { games: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { games: [] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['out.json']);
});

test('exportPlaynite: names from loaded items, tags from collections, falls back when sources are down', async (t) => {
  const { backend, dataDir } = await testBackend(t);
  backend.library.recordInstall('rk-e2e-halo-ce', '/g/halo', null);
  const col = backend.library.createCollection('Shooters');
  backend.library.addToCollection(col.id, 'rk-e2e-halo-ce');
  fs.writeFileSync(path.join(dataDir, 'thumbcache', 'rk-e2e-halo-ce.jpg'), 'x');
  const r = await backend.exportPlaynite();
  assert.deepEqual(r, { file: path.join(dataDir, 'playnite-export.json'), count: 1 });
  const [halo] = JSON.parse(fs.readFileSync(r.file, 'utf8')).games;
  assert.equal(halo.name, 'Halo: Combat Evolved');
  assert.deepEqual(halo.tags, ['Shooters']);
  assert.ok(halo.coverPath.endsWith('rk-e2e-halo-ce.jpg'));

  backend.settings.save({ sources: [{ uploader: 'nobody@x' }] });
  const { backend: down } = await testBackend(t);
  down.settings.save({ sources: [{ uploader: 'nobody@x' }] });
  down.library.add('solo');
  const out = path.join(dataDir, 'elsewhere.json');
  await down.exportPlaynite(out);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).games[0].name, 'solo');
});

test('launch, openFolder, removeFromLibrary go through the host', async (t) => {
  const opened = [];
  const trashed = [];
  const { backend, dataDir } = await testBackend(t, {
    host: {
      openPath: async (p) => { opened.push(p); return p.includes('denied') ? 'Access is denied' : ''; },
      revealPath: (p) => opened.push('reveal:' + p),
      trashItem: async (p) => { trashed.push(p); if (p.includes('locked')) throw new Error('EPERM'); },
    },
  });
  const dir = path.join(dataDir, 'g');
  fs.mkdirSync(dir);
  const exe = path.join(dir, 'g.exe');
  fs.writeFileSync(exe, '');
  const denied = path.join(dir, 'denied.exe');
  fs.writeFileSync(denied, '');
  backend.library.recordInstall('g', dir, exe);

  assert.deepEqual(await backend.launch('g', exe), { ok: true });
  assert.deepEqual(await backend.launch('g', denied), { ok: false, error: 'Access is denied' });
  assert.equal((await backend.launch('g', path.join(dir, 'nope.exe'))).ok, false);
  assert.equal((await backend.launch('g')).ok, false);
  assert.deepEqual(backend.openFolder(dir), { ok: true });
  assert.deepEqual(backend.openFolder(path.join(dir, 'nope')), { ok: false, error: 'Folder not found' });
  assert.deepEqual(opened, [exe, denied, 'reveal:' + dir]);

  assert.deepEqual(await backend.removeFromLibrary('g', { installDir: dir, trash: true }), { ok: true });
  assert.deepEqual(trashed, [dir]);
  assert.equal(backend.library.get('g'), null);
  assert.deepEqual(await backend.removeFromLibrary('g', { installDir: path.join(dir, 'gone'), trash: true }), { ok: true });
  const locked = path.join(dataDir, 'locked');
  fs.mkdirSync(locked);
  assert.equal((await backend.removeFromLibrary('x', { installDir: locked, trash: true })).ok, false);
});

test('launch reports a host that throws; openFolder a host that throws', async (t) => {
  const { backend, dataDir } = await testBackend(t, {
    host: { openPath: async () => { throw new Error('boom'); }, revealPath: () => { throw new Error('bang'); } },
  });
  const exe = path.join(dataDir, 'a.exe');
  fs.writeFileSync(exe, '');
  assert.deepEqual(await backend.launch('a', exe), { ok: false, error: 'boom' });
  assert.deepEqual(backend.openFolder(dataDir), { ok: false, error: 'bang' });
});

test('defaultHost: OS actions that need Electron say so', async () => {
  const host = defaultHost('linux');
  for (const fn of ['trashItem', 'chooseFolder', 'openExternal']) {
    assert.throws(() => host[fn]('x'), (e) => e.code === 'unsupported');
  }
  assert.equal(typeof await host.openPath('/definitely/not/here'), 'string');
  host.revealPath('/definitely/not/here');
  assert.equal(typeof defaultHost('win32').openPath, 'function');
  assert.equal(typeof defaultHost('darwin').openPath, 'function');
});

test('createBackend: default options read the bundled overrides and collisions', async (t) => {
  const dataDir = tmpDir(t);
  const logs = [];
  const backend = createBackend({ dataDir, overridesUrl: 'http://127.0.0.1:1/overrides.json', log: (m) => logs.push(m) });
  t.after(() => backend.close());
  const overrides = await backend.getOverrides();
  assert.ok(Object.keys(overrides).length > 0, 'bundled overrides.json');
  assert.ok(logs.some(l => l.includes('bundled copy')));
  assert.ok(fs.existsSync(path.join(dataDir, 'games')));
});
