'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { buildExport, writeExport, SCHEMA_VERSION } = require('../../src/backend/playnite');
const { createBackend, defaultHost } = require('../../src/backend');
const { testBackend, tmpDir } = require('./helpers');

test('buildExport: one record per library row, source and platform from the item', () => {
  const data = buildExport({
    now: 0,
    rows: {
      a: { identifier: 'a', install_dir: '/g/a', exe_path: '/g/a/bin/a.exe', playtime_secs: 60, is_favorite: 1 },
      q: { identifier: 'q', install_dir: null, exe_path: null, source: 'https://c/n.json' },
      m: { identifier: 'm', install_dir: '/g/m', exe_path: null, source: 'manual' },
      z: { identifier: 'z' },
    },
    items: {
      a: { title: 'A Game', source: { type: 'archive.org', uploader: 'u@x' } },
      q: { title: 'Port', source: { type: 'quiver', url: 'https://c/n.json', name: 'Nintendo' } },
    },
    tagsFor: (id) => (id === 'a' ? ['Faves'] : []),
    coverPath: (id) => (id === 'a' ? '/c/a.jpg' : null),
  });
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(data.generatedAt, '1970-01-01T00:00:00.000Z');
  const [a, q, m, z] = data.games;
  assert.deepEqual(a, {
    id: 'a', name: 'A Game', source: { type: 'archive.org', uploader: 'u@x' }, installDir: '/g/a', exe: '/g/a/bin/a.exe',
    args: '', workingDir: '/g/a/bin', installed: true, version: null, coverPath: '/c/a.jpg', heroPath: null,
    platform: 'PC', tags: ['Faves'], favorite: true, lastPlayed: null, playtimeSeconds: 60,
  });
  assert.deepEqual([q.source, q.platform, q.installed, q.workingDir], [{ type: 'quiver', catalog: 'https://c/n.json' }, 'Nintendo', false, null]);
  assert.deepEqual([m.name, m.source, m.workingDir], ['m', { type: 'other', value: 'manual' }, '/g/m']);
  assert.deepEqual(z.source, { type: 'archive.org', uploader: null });
  assert.equal(buildExport({ rows: {} }).games.length, 0);
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
