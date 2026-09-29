'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { parseCli, runCli } = require('../../src/backend/cli');
const { run } = require('../../src/backend/main');
const { testBackend, tmpDir } = require('./helpers');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// runCli with its printed lines collected
async function cli(backend, argv) {
  const lines = [];
  const r = await runCli(parseCli(argv), backend, { print: (l) => lines.push(JSON.parse(l)) });
  return { ...r, out: lines[0] };
}

test('parseCli: the first command flag and its value', () => {
  assert.deepEqual(parseCli(['C:\\y4bo.exe', '--install', 'abc']), { command: 'install', value: 'abc' });
  assert.deepEqual(parseCli(['.', '--launch=quiver:x/y']), { command: 'launch', value: 'quiver:x/y' });
  assert.deepEqual(parseCli(['--export-playnite', 'C:\\out.json', '--launch', 'x']), { command: 'export-playnite', value: 'C:\\out.json' });
  assert.deepEqual(parseCli(['--uninstall', '--other']), { command: 'uninstall', value: null });
  assert.equal(parseCli(['--data-dir', 'x', 'plain']), null);
  assert.equal(parseCli([]), null);
});

test('every library change rewrites playnite-export.json, batched; flush writes a pending one now', async (t) => {
  const { backend, dataDir } = await testBackend(t, { playniteExportDelayMs: 20 });
  const file = path.join(dataDir, 'playnite-export.json');
  backend.library.add('one');
  backend.library.add('two');
  assert.equal(fs.existsSync(file), false, 'batched, not written per change');
  await backend.flushPlayniteExport();
  assert.deepEqual(readJson(file).games.map(g => g.id), ['one', 'two']);
  assert.match(readJson(file).launcherVersion, /^\d+\.\d+\.\d+/);

  backend.library.remove('one');
  await new Promise(r => setTimeout(r, 60));
  await backend.flushPlayniteExport();
  assert.deepEqual(readJson(file).games.map(g => g.id), ['two']);
  assert.equal(backend.archive && backend.items.loadedVersions().length, 0, 'a library change fetches nothing');
});

test('auto export: names from the last export and loaded catalogs, failures logged, nothing after close', async (t) => {
  const logs = [];
  const { backend, dataDir, fake } = await testBackend(t, { playniteExportDelayMs: 5, log: (m) => logs.push(m) });
  const file = path.join(dataDir, 'playnite-export.json');
  fake.routes['/n.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ name: 'SM64 PC', repository: 'X/SM64', folderName: 'sm64ex' }])); };
  const { catalog } = await backend.catalogs.subscribe({ url: `${fake.base}/n.json`, name: 'Nintendo' });
  backend.library.add(`quiver:${catalog.id}:x/sm64`, catalog.url);
  await backend.flushPlayniteExport();
  const [port] = readJson(file).games;
  assert.deepEqual([port.id, port.name, port.platform, port.folderName], ['quiver:x/sm64', 'SM64 PC', 'Nintendo', 'sm64ex']);

  // A failed write is logged, not thrown
  fs.rmSync(file);
  fs.mkdirSync(file);
  backend.library.add('again');
  await backend.flushPlayniteExport();
  assert.ok(logs.some(l => l.startsWith('[playnite] export failed')));

  fs.rmdirSync(file);
  backend.library.add('late');
  backend.close();
  await backend.flushPlayniteExport();
  assert.equal(fs.existsSync(file), false);
});

test('export art: cached cover, bundled override, hero in the install folder; nothing fetched', async (t) => {
  const { backend, dataDir, fake } = await testBackend(t);
  const install = path.join(dataDir, 'games', 'rk-e2e-halo-ce');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'hero.png'), 'x');
  backend.library.recordInstall('rk-e2e-halo-ce', install, null);
  backend.library.add('no-cover');
  fs.writeFileSync(path.join(dataDir, 'thumbcache', 'rk-e2e-halo-ce.jpg'), 'x');
  const before = fake.requests.length;
  await backend.exportPlaynite(undefined, { loadItems: false });
  const [halo, bare] = readJson(path.join(dataDir, 'playnite-export.json')).games;
  assert.equal(halo.coverPath, path.join(dataDir, 'thumbcache', 'rk-e2e-halo-ce.jpg'));
  assert.equal(halo.heroPath, path.join(install, 'hero.png'));
  assert.deepEqual([bare.coverPath, bare.heroPath], [null, null]);
  assert.ok(fake.requests.slice(before).every(r => !r.startsWith('/advancedsearch')), 'no archive.org search');

  const art = backend.covers.localArt;
  const overrides = { a: { artUrl: 'assets/covers/none.jpg', hero: 'https://x/h.jpg' }, b: { artUrl: 'https://x/c.jpg' } };
  assert.deepEqual(art('a', null, overrides), { cover: null, hero: null });
  assert.deepEqual(art('b', null, overrides), { cover: null, hero: null });
  assert.deepEqual(art('../x', null, {}), { cover: null, hero: null });
});

test('launch records when it was played; uninstall keeps the entry', async (t) => {
  const trashed = [];
  const { backend, dataDir } = await testBackend(t, {
    host: { openPath: async () => '', trashItem: async (p) => { trashed.push(p); if (p.includes('locked')) throw new Error('EPERM'); } },
  });
  const dir = path.join(dataDir, 'g');
  fs.mkdirSync(dir);
  const exe = path.join(dir, 'g.exe');
  fs.writeFileSync(exe, '');
  backend.library.recordInstall('g', dir, exe);
  backend.library.setFavorite('g', true);
  await backend.launch('g', exe);
  assert.ok(backend.library.get('g').last_played_at > 0);

  assert.deepEqual(await backend.uninstall('g'), { ok: true });
  assert.deepEqual(trashed, [dir]);
  assert.deepEqual([backend.library.get('g').install_dir, backend.library.get('g').is_favorite], [null, 1]);
  assert.deepEqual(await backend.uninstall('g'), { ok: true }, 'no folder: just clears');
  assert.deepEqual(await backend.uninstall('nope'), { ok: false, error: 'not_in_library' });

  const locked = path.join(dataDir, 'locked');
  fs.mkdirSync(locked);
  backend.library.recordInstall('l', locked, null);
  assert.equal((await backend.uninstall('l')).ok, false);
});

test('--install: downloads, installs and exits 0; the export says installed', async (t) => {
  const { backend, dataDir } = await testBackend(t);
  const r = await cli(backend, ['--install', 'rk-e2e-halo-ce']);
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);
  assert.ok(r.out.exePath.endsWith('game.exe'));
  const [halo] = readJson(path.join(dataDir, 'playnite-export.json')).games;
  assert.deepEqual([halo.id, halo.installed, halo.exe], ['rk-e2e-halo-ce', true, r.out.exePath]);
});

test('--install: failures exit 1; a choice, a port or a manual entry opens the window', async (t) => {
  const { backend, fake } = await testBackend(t, {
    state: { files: { several: [{ name: 'a.zip', size: '1' }, { name: 'b.zip', size: '1' }], empty: [{ name: 'x.txt', size: '1' }] } },
  });
  assert.deepEqual(await cli(backend, ['--install', 'several']).then(r => r.open), 'several');
  const empty = await cli(backend, ['--install', 'empty']);
  assert.deepEqual([empty.code, empty.out.error], [1, 'no_installable_file']);

  fake.routes['/download/broken/broken.zip'] = (req, res) => { res.writeHead(500); res.end(); };
  const broken = await cli(backend, ['--install', 'broken']);
  assert.deepEqual([broken.code, broken.out.error], [1, 'HTTP 500']);

  assert.equal((await cli(backend, ['--install', 'quiver:x/y'])).open, 'quiver:x/y');
  backend.library.add('mine', 'manual');
  const id = backend.library.exportId('mine');
  assert.equal((await cli(backend, ['--install', id])).open, 'mine');
  assert.equal((await cli(backend, ['--install'])).code, 2);
});

test('--launch: an installed game starts; one not installed opens the window on it', async (t) => {
  const opened = [];
  const { backend, dataDir } = await testBackend(t, { host: { openPath: async (p) => { opened.push(p); return p.includes('bad') ? 'nope' : ''; } } });
  const exe = path.join(dataDir, 'g.exe');
  fs.writeFileSync(exe, '');
  backend.library.recordInstall('g', dataDir, exe);
  const ok = await cli(backend, ['--launch', 'g']);
  assert.deepEqual([ok.code, ok.out], [0, { id: 'g', ok: true }]);
  assert.deepEqual(opened, [exe]);

  const bad = path.join(dataDir, 'bad.exe');
  fs.writeFileSync(bad, '');
  backend.library.recordInstall('b', dataDir, bad);
  assert.equal((await cli(backend, ['--launch', 'b'])).code, 1);

  backend.library.add('notyet');
  assert.equal((await cli(backend, ['--launch', 'notyet'])).open, 'notyet');
  assert.equal((await cli(backend, ['--launch', 'unknown'])).open, 'unknown');
});

test('--uninstall and --export-playnite', async (t) => {
  const { backend, dataDir } = await testBackend(t, { host: { trashItem: async () => {} } });
  backend.library.recordInstall('g', path.join(dataDir, 'gone'), null);
  const u = await cli(backend, ['--uninstall', 'g']);
  assert.deepEqual([u.code, u.out.ok], [0, true]);
  assert.equal(backend.library.get('g').install_dir, null);
  assert.equal((await cli(backend, ['--uninstall', 'nope'])).code, 1);

  const out = path.join(tmpDir(t), 'sub', 'export.json');
  const e = await cli(backend, ['--export-playnite', out]);
  assert.deepEqual([e.code, e.out.file, e.out.count], [0, out, 1]);
  assert.equal(readJson(out).games[0].installed, false);
});

test('standalone: a command runs instead of the server and gives its exit code', async (t) => {
  const dataDir = tmpDir(t);
  const base = ['--data-dir', dataDir, '--archive-base', 'http://127.0.0.1:1', '--overrides-url', 'http://127.0.0.1:1/o.json'];
  const lines = [];
  const out = path.join(dataDir, 'p.json');
  assert.deepEqual(await run([...base, '--export-playnite', out], {}, (l) => lines.push(l)), { exitCode: 0 });
  assert.equal(readJson(out).schemaVersion, 1);
  assert.deepEqual(await run([...base, '--launch', 'x'], {}, (l) => lines.push(l)), { exitCode: 3 });
  assert.deepEqual(JSON.parse(lines[1]), { ok: false, error: 'needs_window', id: 'x' });
});
