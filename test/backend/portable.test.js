'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const P = require('../../src/backend/portable');
const { createLibrary } = require('../../src/backend/library');
const { run } = require('../../src/backend/main');
const { tmpDir, testApi } = require('./helpers');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// An %APPDATA% folder with a library: one game under games/, one elsewhere,
// settings pointing into games/, and Chromium's own files beside them
function seed(dir, outside) {
  fs.mkdirSync(path.join(dir, 'games', 'halo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'games', 'halo', 'halo.exe'), 'MZ');
  fs.mkdirSync(path.join(dir, 'thumbcache'));
  fs.writeFileSync(path.join(dir, 'thumbcache', 'a.jpg'), 'x');
  fs.mkdirSync(path.join(dir, 'Local Storage'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ installPath: path.join(dir, 'games'), checkForUpdates: true }));
  const lib = createLibrary({ dbPath: path.join(dir, 'library.db'), legacyJsonPath: path.join(dir, 'library.json'), log: () => {} });
  lib.recordInstall('halo', path.join(dir, 'games', 'halo'), path.join(dir, 'games', 'halo', 'halo.exe'));
  lib.recordInstall('far', outside, path.join(outside, 'far.exe'));
  lib.close();
}
const rows = (dir) => {
  const lib = createLibrary({ dbPath: path.join(dir, 'library.db'), legacyJsonPath: path.join(dir, 'library.json'), log: () => {} });
  const out = Object.fromEntries(Object.values(lib.all()).map(r => [r.identifier, [r.install_dir, r.exe_path]]));
  lib.close();
  return out;
};

test('rebase and isInside: only paths in the old folder move', () => {
  assert.equal(P.rebase('/a/data/games/x', '/a/data', '/b/y4bo-data'), path.join('/b/y4bo-data', 'games/x'));
  assert.equal(P.rebase('/a/data', '/a/data', '/b'), path.normalize('/b'));
  assert.equal(P.rebase('/a/database/x', '/a/data', '/b'), '/a/database/x');
  assert.equal(P.rebase(null, '/a', '/b'), null);
  assert.ok(P.isInside('/a/b', '/a'));
  assert.ok(!P.isInside('/ab', '/a'));
});

test('isInstalledCopy: an Uninstall *.exe beside the executable', (t) => {
  const dir = tmpDir(t);
  assert.equal(P.isInstalledCopy(dir), false);
  fs.writeFileSync(path.join(dir, 'Uninstall y4bo.exe'), '');
  assert.equal(P.isInstalledCopy(dir), true);
  assert.equal(P.isInstalledCopy(path.join(dir, 'nope')), false);
});

test('portableStatus: not packaged, installed, available, portable', (t) => {
  const exeDir = tmpDir(t);
  const appData = tmpDir(t);
  assert.deepEqual(P.portableStatus({ exeDir: null, dataDir: appData }), { available: false, portable: false, reason: 'not_packaged', dataDir: appData });
  const usual = P.portableStatus({ exeDir, dataDir: appData, defaultDir: appData });
  assert.deepEqual([usual.available, usual.portable, usual.portableDir, usual.pending], [true, false, path.join(exeDir, 'y4bo-data'), null]);
  const portable = P.portableStatus({ exeDir, dataDir: path.join(exeDir, 'y4bo-data'), defaultDir: appData });
  assert.deepEqual([portable.available, portable.portable], [true, true]);
  assert.equal(P.portableStatus({ exeDir, dataDir: appData }, { access: () => { throw new Error('EACCES'); } }).reason, 'read_only');
  fs.writeFileSync(path.join(exeDir, 'Uninstall y4bo.exe'), '');
  assert.deepEqual([P.portableStatus({ exeDir, dataDir: appData }).available, P.portableStatus({ exeDir, dataDir: appData }).reason], [false, 'installed']);
});

test('requestMove, pendingMove, cancelMove, failMove', (t) => {
  const dir = tmpDir(t);
  assert.equal(P.pendingMove(dir), null);
  P.requestMove(dir, '/x/y4bo-data');
  assert.equal(P.pendingMove(dir), path.resolve('/x/y4bo-data'));
  P.failMove(dir, 'disk full');
  assert.equal(P.pendingMove(dir), null, 'a failed move is not retried');
  assert.equal(P.portableStatus({ exeDir: tmpDir(t), dataDir: dir }).error, 'disk full');
  P.requestMove(dir, '/x/y4bo-data');
  assert.equal(P.portableStatus({ exeDir: tmpDir(t), dataDir: dir }).error, null, 'asking again clears the error');
  P.cancelMove(dir);
  assert.equal(P.pendingMove(dir), null);
});

test('moveData: the launcher files move, paths into the old folder are rewritten, Chromium files stay', (t) => {
  const from = tmpDir(t);
  const outside = tmpDir(t);
  const to = path.join(tmpDir(t), 'y4bo-data');
  seed(from, outside);
  P.requestMove(from, to);
  const r = P.moveData({ from, to });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.moved.sort(), ['games', 'library.db', 'settings.json', 'thumbcache'].concat(r.moved.filter(n => n.startsWith('library.db-'))).sort());
  assert.ok(fs.existsSync(path.join(to, 'games', 'halo', 'halo.exe')));
  assert.ok(fs.existsSync(path.join(from, 'Local Storage')), "Chromium's files aren't ours to move");
  assert.ok(!fs.existsSync(path.join(from, 'games')));
  assert.equal(P.pendingMove(from), null, 'the request is done');
  assert.deepEqual(readJson(path.join(to, 'settings.json')), { installPath: path.join(to, 'games'), checkForUpdates: true });
  assert.deepEqual(rows(to), {
    halo: [path.join(to, 'games', 'halo'), path.join(to, 'games', 'halo', 'halo.exe')],
    far: [outside, path.join(outside, 'far.exe')],
  });
});

test('moveData back out of y4bo-data removes the emptied folder, so the next start is not portable', (t) => {
  const appData = tmpDir(t);
  const portable = path.join(tmpDir(t), 'y4bo-data');
  seed(portable, tmpDir(t));
  fs.rmSync(path.join(portable, 'Local Storage'), { recursive: true });
  P.requestMove(portable, appData);
  P.moveData({ from: portable, to: appData });
  assert.ok(!fs.existsSync(portable));
  assert.equal(rows(appData).halo[0], path.join(appData, 'games', 'halo'));
});

test('moveData: games on another drive stay put and settings keep installing there', (t) => {
  const from = tmpDir(t);
  const to = path.join(tmpDir(t), 'y4bo-data');
  seed(from, tmpDir(t));
  const rename = (src, dest) => {
    if (path.basename(src) === 'games') { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    fs.renameSync(src, dest);
  };
  const r = P.moveData({ from, to, rename });
  assert.deepEqual(r.kept, [{ name: 'games', why: 'other_drive' }]);
  assert.ok(fs.existsSync(path.join(from, 'games', 'halo', 'halo.exe')));
  const s = readJson(path.join(to, 'settings.json'));
  assert.equal(s.installPath, path.join(from, 'games'));
  assert.equal(s.downloadPath, path.join(from, 'games'));
  assert.equal(rows(to).halo[0], path.join(from, 'games', 'halo'));
});

test('moveData: a clash moves nothing; a failure part-way puts everything back', (t) => {
  const from = tmpDir(t);
  const to = path.join(tmpDir(t), 'y4bo-data');
  seed(from, tmpDir(t));
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'settings.json'), '{}');
  assert.throws(() => P.moveData({ from, to }), /already has settings\.json/);
  assert.ok(fs.existsSync(path.join(from, 'library.db')));
  fs.rmSync(path.join(to, 'settings.json'));

  let n = 0;
  const rename = (src, dest) => { if (++n === 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); fs.renameSync(src, dest); };
  assert.throws(() => P.moveData({ from, to, rename }), /Couldn't move the data .*EBUSY/);
  for (const name of ['settings.json', 'library.db', 'games', 'thumbcache']) assert.ok(fs.existsSync(path.join(from, name)), name);
  assert.deepEqual(fs.readdirSync(to), []);
  assert.throws(() => P.moveData({ from, to: path.join(from, 'sub') }), /into itself/);
});

test('API: GET and PUT /portable; an installed copy is refused; relaunch needs the desktop app', async (t) => {
  const exeDir = tmpDir(t);
  const defaultDataDir = tmpDir(t);
  const { call, dataDir } = await testApi(t, { exeDir, defaultDataDir });
  const st = (await call('GET', '/portable')).body;
  assert.deepEqual([st.available, st.portable, st.portableDir, st.dataDir], [true, false, path.join(exeDir, 'y4bo-data'), dataDir]);
  const on = await call('PUT', '/portable', { portable: true });
  assert.equal(on.body.pending, path.join(exeDir, 'y4bo-data'));
  assert.equal((await call('PUT', '/portable', { portable: false })).body.pending, null, 'asking for where it already is cancels');
  assert.equal((await call('PUT', '/portable', { portable: 'yes' })).status, 400);
  assert.equal((await call('POST', '/os/relaunch')).status, 501);
  fs.writeFileSync(path.join(exeDir, 'Uninstall y4bo.exe'), '');
  const refused = await call('PUT', '/portable', { portable: true });
  assert.deepEqual([refused.status, refused.body.error], [409, 'installed']);
});

test('the backend does a requested move on start, before library.db opens, and runs from the new folder', async (t) => {
  const from = tmpDir(t);
  const to = path.join(tmpDir(t), 'y4bo-data');
  seed(from, tmpDir(t));
  P.requestMove(from, to);
  const out = path.join(tmpDir(t), 'p.json');
  const base = ['--data-dir', from, '--archive-base', 'http://127.0.0.1:1', '--overrides-url', 'http://127.0.0.1:1/o.json'];
  assert.deepEqual(await run([...base, '--export-playnite', out], {}, () => {}), { exitCode: 0 });
  assert.ok(fs.existsSync(path.join(to, 'library.db')));
  assert.ok(readJson(out).games.some(g => g.installDir === path.join(to, 'games', 'halo')), 'the export reads the rewritten library');
  assert.ok(!fs.existsSync(path.join(from, 'library.db')));
});

test('a move that fails on start leaves the data where it was and keeps the error for Settings', async (t) => {
  const from = tmpDir(t);
  seed(from, tmpDir(t));
  P.requestMove(from, path.join(from, 'inside'));
  const out = path.join(tmpDir(t), 'p.json');
  const base = ['--data-dir', from, '--archive-base', 'http://127.0.0.1:1', '--overrides-url', 'http://127.0.0.1:1/o.json'];
  assert.deepEqual(await run([...base, '--export-playnite', out], {}, () => {}), { exitCode: 0 });
  assert.ok(fs.existsSync(path.join(from, 'library.db')));
  assert.match(P.portableStatus({ exeDir: tmpDir(t), dataDir: from }).error, /into itself/);
});
