'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createInstalls } = require('../../src/backend/installs');
const { createArchive } = require('../../src/backend/archive');
const { createSettings } = require('../../src/backend/settings');
const { createLibrary } = require('../../src/backend/library');
const { fakeArchive, tmpDir, makeZip } = require('./helpers');

async function setup(t, state = {}, settingsData = {}, opts = {}) {
  const fake = await fakeArchive(t, state);
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ downloadPath: path.join(dir, 'dl'), installPath: path.join(dir, 'games'), ...settingsData });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const events = [];
  const netLog = [];
  const installs = createInstalls({
    settings, library, archive: createArchive({ base: fake.base }), gamesDir: path.join(dir, 'default'),
    emit: (type, data) => events.push({ type, data }), netLog: (...a) => netLog.push(a), ...opts,
  });
  return { fake, dir, settings, library, installs, events, netLog };
}

test('download: writes the file, reports progress, fails on HTTP errors', async (t) => {
  const { fake, dir, installs, netLog } = await setup(t);
  const seen = [];
  const r = await installs.download({ key: 'k', identifier: 'rk-halo', url: `${fake.base}/download/rk-halo/rk-halo.zip`, fileName: 'rk-halo.zip', onProgress: p => seen.push(p) });
  assert.deepEqual(r, { ok: true, filePath: path.join(dir, 'dl', 'rk-halo', 'rk-halo.zip') });
  assert.equal(seen.at(-1), 100);
  assert.deepEqual(netLog[0].slice(0, 3), ['download', `${fake.base}/download/rk-halo/rk-halo.zip`, 200]);
  const missing = await installs.download({ key: 'k2', identifier: 'x', url: `${fake.base}/nope`, fileName: 'x.zip' });
  assert.deepEqual(missing, { ok: false, error: 'HTTP 404' });
  const down = await installs.download({ key: 'k3', identifier: 'x', url: 'http://127.0.0.1:1/x.zip', fileName: 'x.zip' });
  assert.equal(down.ok, false);
});

test('download: a failed write reports the error', async (t) => {
  const { fake, dir, installs } = await setup(t);
  fs.mkdirSync(path.join(dir, 'dl', 'x', 'x.zip'), { recursive: true });  // a folder where the file goes
  const r = await installs.download({ key: 'k', identifier: 'x', url: `${fake.base}/download/x/x.zip`, fileName: 'x.zip' });
  assert.equal(r.ok, false);
});

test('download: cancel resolves as Cancelled, before or during the transfer', async (t) => {
  const { fake, installs } = await setup(t, {
    routes: {
      '/hang': () => {},
      '/drip': (req, res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('x'); },
    },
  });
  const p = installs.download({ key: 'hang', identifier: 'h', url: `${fake.base}/hang`, fileName: 'h.zip' });
  installs.cancelDownload('hang');
  assert.deepEqual(await p, { ok: false, error: 'Cancelled' });

  let progressed;
  const started = new Promise(r => { progressed = r; });
  const q = installs.download({ key: 'drip', identifier: 'd', url: `${fake.base}/drip`, fileName: 'd.zip', onProgress: progressed });
  await started;
  installs.cancelDownload('drip');
  assert.deepEqual(await q, { ok: false, error: 'Cancelled' });
  assert.deepEqual(installs.cancelDownload('not-running'), { ok: true });
});

test('extract: zip into the item folder or a collection subfolder; other formats refused', async (t) => {
  const { dir, installs } = await setup(t, {}, { deleteAfterInstall: true });
  const zip = path.join(dir, 'dl', 'g', 'g.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.writeFileSync(zip, makeZip({ 'Game/game.exe': 'MZ' }));
  const r = await installs.extract({ filePath: zip, identifier: 'g.' });
  assert.deepEqual(r, { ok: true, installDir: path.join(dir, 'games', 'g'), parentInstallDir: path.join(dir, 'games', 'g') });
  assert.ok(fs.existsSync(path.join(dir, 'games', 'g', 'Game', 'game.exe')));
  await new Promise(res => setTimeout(res, 50));
  assert.equal(fs.existsSync(zip), false, 'deleteAfterInstall removes the archive');

  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.writeFileSync(zip, makeZip({ 'a.exe': 'MZ' }));
  const sub = await installs.extract({ filePath: zip, identifier: 'coll', subFolder: 'Crazy Taxi' });
  assert.equal(sub.installDir, path.join(dir, 'games', 'coll', '_GAME_Crazy Taxi'));

  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, 'not a zip');
  assert.equal((await installs.extract({ filePath: bad, identifier: 'b' })).ok, false);
  assert.deepEqual(await installs.extract({ filePath: path.join(dir, 'x.iso'), identifier: 'b' }), { ok: false, error: 'Unsupported archive format' });
});

test('extract: uses 7-Zip when it is installed', { skip: process.platform === 'win32' && 'uses a sh stand-in for 7z.exe' }, async (t) => {
  const fake7z = path.join(tmpDir(t), '7z');
  fs.writeFileSync(fake7z, '#!/bin/sh\ncase "$2" in *fail.7z) exit 2;; esac\nmkdir -p "${3#-o}" && touch "${3#-o}/from7z.exe"\n', { mode: 0o755 });
  const { dir, installs } = await setup(t, {}, {}, { sevenZip: fake7z });
  const ok = await installs.extract({ filePath: path.join(dir, 'game.7z'), identifier: 'z' });
  assert.equal(ok.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'games', 'z', 'from7z.exe')));
  assert.equal((await installs.extract({ filePath: path.join(dir, 'fail.7z'), identifier: 'z' })).ok, false);
});

test('start: one archive installs end to end and lands in library.db', async (t) => {
  const { dir, installs, library, events } = await setup(t);
  const r = await installs.start({ itemId: 'rk-halo' });
  assert.equal(r.ok, true);
  const [job] = r.jobs;
  assert.equal(job.status, 'downloading');
  await installs.wait(job.id);
  const done = installs.get(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.exePath, path.join(dir, 'games', 'rk-halo', 'Game', 'game.exe'));
  assert.equal(library.get('rk-halo').install_dir, path.join(dir, 'games', 'rk-halo'));
  assert.deepEqual([...new Set(events.map(e => e.data.status))], ['downloading', 'extracting', 'done']);
  assert.equal(installs.list().length, 1);
  assert.equal(installs.get('nope'), null);
  assert.equal(installs.cancel('nope'), null);
  assert.equal(installs.cancel(job.id).status, 'done', 'a finished job is not cancelled');
});

test('start: several archives need a choice; each extracts into its own folder', async (t) => {
  const { dir, installs, library } = await setup(t, { files: { coll: [{ name: 'Crazy Taxi.zip' }, { name: 'NiGHTS.zip' }, { name: 'art.png' }] } });
  const ask = await installs.start({ itemId: 'coll' });
  assert.equal(ask.error, 'choose_files');
  assert.deepEqual(ask.choices.map(f => f.name), ['Crazy Taxi.zip', 'NiGHTS.zip']);
  assert.equal((await installs.start({ itemId: 'coll', files: ['art.png'] })).error, 'unknown_file');
  assert.equal((await installs.start({ itemId: 'coll', files: [] })).error, 'unknown_file');

  const r = await installs.start({ itemId: 'coll', files: ['Crazy Taxi.zip', 'NiGHTS.zip'] });
  await Promise.all(r.jobs.map(j => installs.wait(j.id)));
  assert.ok(fs.existsSync(path.join(dir, 'games', 'coll', '_GAME_Crazy Taxi', 'Game', 'game.exe')));
  assert.ok(fs.existsSync(path.join(dir, 'games', 'coll', '_GAME_NiGHTS')));
  const row = library.get('coll');
  assert.equal(row.install_dir, path.join(dir, 'games', 'coll'));
  assert.equal(row.exe_path, null, 'two games, two exes: the user picks at launch');
});

test('start: errors from the file list, download and extraction are reported', async (t) => {
  const { fake, installs } = await setup(t, {
    files: { none: [{ name: 'a.txt' }], bad: [{ name: 'bad.zip' }] },
    zips: { 'bad/bad.zip': Buffer.from('not a zip') },
    routes: { '/metadata/broken': (req, res) => { res.writeHead(200); res.end('x'); } },
  });
  assert.equal((await installs.start({ itemId: 'none' })).error, 'no_installable_file');
  assert.equal((await installs.start({ itemId: 'broken' })).error, 'file_list_failed');

  const bad = (await installs.start({ itemId: 'bad' })).jobs[0];
  await installs.wait(bad.id);
  assert.equal(installs.get(bad.id).status, 'error');

  fake.routes['/download/gone/gone.zip'] = (req, res) => { res.writeHead(500); res.end(); };
  const gone = (await installs.start({ itemId: 'gone' })).jobs[0];
  await installs.wait(gone.id);
  assert.deepEqual([installs.get(gone.id).status, installs.get(gone.id).error], ['error', 'HTTP 500']);
});

test('start: a running job is reused; cancel stops it', async (t) => {
  const { fake, installs } = await setup(t);
  fake.routes['/download/slow/slow.zip'] = () => {};
  const a = (await installs.start({ itemId: 'slow' })).jobs[0];
  const b = (await installs.start({ itemId: 'slow' })).jobs[0];
  assert.equal(a.id, b.id);
  assert.equal(installs.cancel(a.id).status, 'cancelled');
  await installs.wait(a.id);
  assert.equal(installs.get(a.id).status, 'cancelled');
});

test('scan: adopts matching folders, skips ones already installed', async (t) => {
  const { dir, installs, library } = await setup(t);
  const scanDir = path.join(dir, 'games');
  fs.mkdirSync(path.join(scanDir, 'rk-halo'), { recursive: true });
  fs.writeFileSync(path.join(scanDir, 'rk-halo', 'halo.exe'), '');
  fs.mkdirSync(path.join(scanDir, 'Zoo Tycoon'), { recursive: true });
  fs.mkdirSync(path.join(scanDir, 'kept'), { recursive: true });
  library.recordInstall('kept', path.join(scanDir, 'kept'), null);
  library.setFavorite('rk-halo', true);

  const r = installs.scan({ scanDir, knownIdentifiers: ['rk-halo', 'kept'], titleMap: { 'Zoo Tycoon': 'rk-zoo' } });
  assert.deepEqual(r.found.map(f => [f.identifier, f.matchedBy, !!f.exePath]).sort(), [['rk-halo', 'identifier', true], ['rk-zoo', 'title', false]]);
  assert.equal(library.get('rk-halo').is_favorite, 1);
  assert.equal(library.get('rk-zoo').install_dir, path.join(scanDir, 'Zoo Tycoon'));
});

test('scan: nothing without a library', async (t) => {
  const { installs } = await setup(t);
  const noDb = createInstalls({ settings: createSettings('/nope'), library: { available: false }, archive: {}, gamesDir: '/x' });
  assert.deepEqual(noDb.scan({ scanDir: '/', knownIdentifiers: [] }), { found: [] });
  assert.deepEqual(installs.scan({ scanDir: '/does/not/exist', knownIdentifiers: ['a'] }), { found: [] });
});

test('download and install folders fall back to the default games folder', async (t) => {
  const fake = await fakeArchive(t);
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  const installs = createInstalls({ settings, library: {}, archive: createArchive({ base: fake.base }), gamesDir: path.join(dir, 'games') });
  const r = await installs.download({ key: 'k', identifier: 'a', url: `${fake.base}/download/a/a.zip`, fileName: '../a.zip' });
  assert.equal(r.filePath, path.join(dir, 'games', 'a', 'a.zip'));
  const x = await installs.extract({ filePath: r.filePath, identifier: 'a' });
  assert.equal(x.installDir, path.join(dir, 'games', 'a'));
});
