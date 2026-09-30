'use strict';
// Port installs: release and asset picking, and a whole install against a
// fake GitHub and archive.org (binary, filesToAdd, data staging, sha1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const ports  = require('../../src/backend/ports');
const { createInstalls } = require('../../src/backend/installs');
const { createArchive } = require('../../src/backend/archive');
const { createSettings } = require('../../src/backend/settings');
const { createLibrary } = require('../../src/backend/library');
const { fakeArchive, tmpDir, makeZip } = require('./helpers');

const asset = (name) => ({ name, browser_download_url: `https://x/${name}` });
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

test('pickRelease skips drafts and prereleases', () => {
  assert.equal(ports.pickRelease([{ tag_name: 'a', prerelease: true }, { tag_name: 'b', draft: true }, { tag_name: 'c' }]).tag_name, 'c');
  assert.equal(ports.pickRelease([{ prerelease: true }]), null);
  assert.equal(ports.pickRelease({ message: 'Not Found' }), null);
});

test('pickAsset: pattern, then filter, then a Windows-looking build, 64-bit first', () => {
  const pd = ['pd-x86_64-linux.tar.gz', 'pd-i686-windows.zip', 'pd-x86_64-windows.zip', 'Source code.zip'].map(asset);
  assert.equal(ports.pickAsset(pd, { pattern: '(?i)X86_64-WINDOWS' }).asset.name, 'pd-x86_64-windows.zip');
  assert.equal(ports.pickAsset(pd).asset.name, 'pd-x86_64-windows.zip');
  const poke = ['pokefirered.exe', 'pokeleafgreen.exe', 'pokefirered-linux'].map(asset);
  assert.equal(ports.pickAsset(poke, { filter: 'LeafGreen' }).asset.name, 'pokeleafgreen.exe');
  assert.equal(ports.pickAsset(['Game-Win32.zip', 'Game-Win64.zip', 'Game-macOS.dmg'].map(asset)).asset.name, 'Game-Win64.zip');
  const none = ports.pickAsset(['game-linux.AppImage', 'game-macos.zip'].map(asset));
  assert.deepEqual(none, { error: 'No Windows build in the latest release', names: ['game-linux.AppImage', 'game-macos.zip'] });
  assert.match(ports.pickAsset(pd, { pattern: '(' }).error, /Bad asset pattern/);
});

test('archiveFile, findFile, inside', (t) => {
  assert.deepEqual(ports.archiveFile('https://archive.org/download/pd_2025/Perfect%20Dark%20PC%20Port.zip'), { identifier: 'pd_2025', file: 'Perfect Dark PC Port.zip' });
  assert.deepEqual(ports.archiveFile('https://archive.org/download/id/a/b.7z'), { identifier: 'id', file: 'a/b.7z' });
  assert.equal(ports.archiveFile('https://example.com/x.zip'), null);
  assert.equal(ports.archiveFile('not a url'), null);

  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'PD.NTSC-Final.Z64'), 'rom');
  assert.equal(ports.findFile(dir, 'pd.ntsc-final.z64'), path.join(dir, 'a', 'b', 'PD.NTSC-Final.Z64'));
  assert.equal(ports.findFile(dir, 'missing.z64'), null);
  assert.equal(ports.findFile(path.join(dir, 'nope'), 'x'), null);

  assert.equal(ports.inside(dir, 'data', 'rom.z64'), path.join(dir, 'data', 'rom.z64'));
  assert.equal(ports.inside(dir, '', 'rom.z64'), path.join(dir, 'rom.z64'));
  assert.equal(ports.inside(dir, '..', 'evil'), null);
});

// A fake GitHub on the fake archive's server: releases for o/pd, and its assets
async function setup(t, { rom = 'ROMDATA', dataZip, assets, bin: binZip, deleteAfterInstall = false } = {}) {
  const state = { routes: {}, zips: {} };
  const fake = await fakeArchive(t, state);
  const bin = binZip || makeZip({ 'pd.exe': 'MZ', 'data/.keep': '' });
  state.routes['/repos/o/pd/releases'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { tag_name: 'nightly', prerelease: true, assets: [] },
      { tag_name: 'v1', assets: (assets || ['pd-x86_64-linux.tar.gz', 'pd-x86_64-windows.zip']).map(n => ({ name: n, browser_download_url: `${fake.base}/gh/${n}` })) },
    ]));
  };
  state.routes['/gh/pd-x86_64-windows.zip'] = (req, res) => { res.writeHead(200, { 'content-length': bin.length }); res.end(bin); };
  state.zips['pd_ia/Perfect Dark PC Port.zip'] = dataZip || makeZip({ 'Perfect Dark/pd.ntsc-final.z64': rom, 'Perfect Dark/readme.txt': 'hi' });

  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ downloadPath: path.join(dir, 'dl'), installPath: path.join(dir, 'games'), deleteAfterInstall });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const events = [];
  const installs = createInstalls({
    settings, library, archive: createArchive({ base: fake.base }), gamesDir: dir, githubApi: fake.base,
    emit: (type, data) => events.push(data),
  });
  const item = {
    id: 'quiver:c1:o/pd', title: 'Perfect Dark', repository: 'o/pd',
    entry: { folderName: 'PerfectDark-PerfectDarkPCPort', filesToAdd: ['portable.txt'] },
    data: {
      contentUrl: 'https://archive.org/download/pd_ia/Perfect%20Dark%20PC%20Port.zip', assetPattern: '(?i)x86_64-windows',
      dataFiles: [{ name: 'pd.ntsc-final.z64', targetSubpath: 'data', sha1: sha1('ROMDATA') }],
    },
  };
  return { fake, state, dir, library, installs, events, item };
}

test('a port installs: release build, filesToAdd, data staged and sha1-checked, library row kept', async (t) => {
  const { dir, library, installs, events, item } = await setup(t);
  library.add(item.id, 'https://c/Nintendo.json');
  const r = installs.startPort({ item });
  assert.equal(r.ok, true);
  assert.deepEqual(installs.startPort({ item }).jobs[0].id, r.jobs[0].id, 'a second start joins the running job');
  await installs.wait(r.jobs[0].id);

  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.error, job.installDir, job.exePath], ['done', null, dest, path.join(dest, 'pd.exe')]);
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'pd.ntsc-final.z64'), 'utf8'), 'ROMDATA');
  assert.ok(fs.existsSync(path.join(dest, 'portable.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'dl', 'pd_ia', '_staging')), 'staging is cleaned up');
  const row = library.get(item.id);
  assert.deepEqual([row.install_dir, row.exe_path, row.source], [dest, path.join(dest, 'pd.exe'), 'https://c/Nintendo.json']);

  const steps = events.map(e => `${e.status}:${e.step}`);
  for (const s of ['downloading:binary', 'extracting:binary', 'downloading:data', 'extracting:data', 'verifying:data', 'done:null']) {
    assert.ok(steps.includes(s), `${s} in ${steps.join(' ')}`);
  }
});

// The real release zip wraps everything in one folder and ships three exes
const PD_REAL = () => makeZip({
  'pd-x86_64-windows/pd.x86_64.exe': 'MZ', 'pd-x86_64-windows/pd.pal.x86_64.exe': 'MZ', 'pd-x86_64-windows/pd.jpn.x86_64.exe': 'MZ',
  'pd-x86_64-windows/SDL2.dll': 'DLL', 'pd-x86_64-windows/data/put_your_rom_here.txt': 'here',
});

test('a release wrapped in one folder is unwrapped, so the data lands beside the exe; exe picks among several', async (t) => {
  const { dir, installs, item } = await setup(t, { bin: PD_REAL() });
  const run = async (it) => { const r = installs.startPort({ item: it }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');

  const job = await run({ ...item, data: { ...item.data, exe: 'pd.x86_64.exe' } });
  assert.deepEqual([job.status, job.error, job.exePath], ['done', null, path.join(dest, 'pd.x86_64.exe')]);
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'pd.ntsc-final.z64'), 'utf8'), 'ROMDATA');
  assert.ok(fs.existsSync(path.join(dest, 'data', 'put_your_rom_here.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'pd-x86_64-windows')), 'no wrapper folder left');
  assert.deepEqual(fs.readdirSync(dest).filter(n => n.startsWith('.unpack-')), [], 'staging is cleaned up');

  // Without exe there are three to pick from, so none is set; a missing exe falls back the same way
  const none = await run({ ...item, id: 'quiver:c1:o/none' });
  assert.deepEqual([none.status, none.exePath], ['done', null]);
  const wrong = await run({ ...item, id: 'quiver:c1:o/wrong', data: { ...item.data, exe: 'nope.exe' } });
  assert.deepEqual([wrong.status, wrong.exePath], ['done', null]);
});

test('keepReleaseFolder keeps the wrapper folder as the release shipped it', async (t) => {
  const { dir, installs, item } = await setup(t, { bin: PD_REAL() });
  const r = installs.startPort({ item: { ...item, data: { ...item.data, keepReleaseFolder: true, exe: 'pd-x86_64-windows/pd.x86_64.exe' } } });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.exePath], ['done', path.join(dest, 'pd-x86_64-windows', 'pd.x86_64.exe')]);
});

test('a data file that fails its sha1 fails the install, naming the file, and is removed', async (t) => {
  const { dir, installs, item } = await setup(t, { rom: 'NOT THE ROM' });
  const r = installs.startPort({ item });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /^pd\.ntsc-final\.z64 doesn't match the catalog \(sha1 [0-9a-f]{40}, expected /);
  assert.ok(!fs.existsSync(path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort', 'data', 'pd.ntsc-final.z64')));
});

// The fixture patch (made with python-bps) turns source.bin into target.bin
const BPS = path.join(__dirname, '..', 'fixtures', 'bps');
const bpsFile = (f) => fs.readFileSync(path.join(BPS, f));

test('a data file with a .bps patch is patched before its sha1 check, wherever the patch lives', async (t) => {
  const dataZip = makeZip({ 'Perfect Dark/pd.ntsc-final.z64': bpsFile('source.bin'), 'Perfect Dark/patches/fix.bps': bpsFile('patch.bps') });
  const { dir, installs, item, state, fake } = await setup(t, { dataZip, deleteAfterInstall: true });
  const run = async (id, patch, extra = {}) => {
    const it = { ...item, id, data: { ...item.data, dataFiles: [{ ...item.data.dataFiles[0], sha1: sha1(bpsFile('target.bin')), patch, ...extra }] } };
    const r = installs.startPort({ item: it });
    await installs.wait(r.jobs[0].id);
    return installs.get(r.jobs[0].id);
  };
  const staged = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort', 'data', 'pd.ntsc-final.z64');

  // in the data archive, by path and by bare name
  assert.deepEqual([(await run('quiver:c1:o/p1', 'patches/fix.bps')).error], [null]);
  assert.deepEqual(fs.readFileSync(staged), bpsFile('target.bin'));
  assert.equal((await run('quiver:c1:o/p2', 'fix.bps')).status, 'done');

  // at a URL, and in the same archive.org item
  state.routes['/patches/fix.bps'] = (req, res) => { res.writeHead(200); res.end(bpsFile('patch.bps')); };
  state.zips['pd_ia/Perfect Dark PC Port.zip'] = makeZip({ 'Perfect Dark/pd.ntsc-final.z64': bpsFile('source.bin') });
  assert.equal((await run('quiver:c1:o/p3', `${fake.base}/patches/fix.bps`)).status, 'done');
  state.zips['pd_ia/extras/fix.bps'] = bpsFile('patch.bps');
  assert.equal((await run('quiver:c1:o/p4', 'extras/fix.bps')).status, 'done');
  assert.ok(state.requests.includes('/download/pd_ia/extras/fix.bps'));
  assert.equal((await run('quiver:c1:o/p5', 'https://archive.org/download/pd_ia/extras/fix.bps')).status, 'done');
  assert.ok(!fs.existsSync(path.join(dir, 'dl', 'pd_ia', 'fix.bps')), 'a downloaded patch goes with deleteAfterInstall');

  // shipped in the release build, which lands first
  const binWithPatch = makeZip({ 'pd.exe': 'MZ', 'patches/ship.bps': bpsFile('patch.bps') });
  state.routes['/gh/pd-x86_64-windows.zip'] = (req, res) => { res.writeHead(200, { 'content-length': binWithPatch.length }); res.end(binWithPatch); };
  assert.equal((await run('quiver:c1:o/p6', 'ship.bps')).status, 'done');

  // failures name the file: a patch for another dump, a download that isn't a patch, a missing one
  state.zips['pd_ia/Perfect Dark PC Port.zip'] = makeZip({ 'Perfect Dark/pd.ntsc-final.z64': 'A DIFFERENT DUMP' });
  assert.equal((await run('quiver:c1:o/p7', 'ship.bps')).error, "pd.ntsc-final.z64 couldn't be patched with ship.bps: the file is not the one this patch was made for");
  assert.ok(!fs.existsSync(staged) || fs.readFileSync(staged).equals(bpsFile('target.bin')), 'nothing half-patched is left');
  assert.match((await run('quiver:c1:o/p8', 'nowhere.bps')).error, /^pd\.ntsc-final\.z64 couldn't be patched with nowhere\.bps: not a BPS patch$/);
  state.routes['/patches/gone.bps'] = (req, res) => { res.writeHead(404); res.end(); };
  assert.equal((await run('quiver:c1:o/p9', `${fake.base}/patches/gone.bps`)).error, `pd.ntsc-final.z64's patch ${fake.base}/patches/gone.bps: HTTP 404`);
});

test('missing data, optional data, no Windows build, no repository', async (t) => {
  const { installs, item, state, fake } = await setup(t, { dataZip: makeZip({ 'other.bin': 'x' }), deleteAfterInstall: true });
  const run = async (it) => { const r = installs.startPort({ item: it }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };

  assert.equal((await run(item)).error, "pd.ntsc-final.z64 isn't in Perfect Dark PC Port.zip (it holds other.bin)");
  const optional = { ...item, id: 'quiver:c1:o/pd2', data: { ...item.data, dataFiles: [{ ...item.data.dataFiles[0], optional: true }] } };
  assert.equal((await run(optional)).status, 'done');
  state.zips['pd_ia/Perfect Dark PC Port.zip'] = makeZip({ 'pd.ntsc-final.z64': 'ROMDATA' });
  const offArchive = { ...item, id: 'quiver:c1:o/pd4', data: { ...item.data, contentUrl: 'https://example.com/x.zip' } };
  assert.match((await run(offArchive)).error, /isn't an archive.org download/);

  state.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ tag_name: 'v2', assets: [{ name: 'pd-linux.AppImage', browser_download_url: `${fake.base}/gh/x` }] }])); };
  assert.equal((await run({ ...item, id: 'quiver:c1:o/pd5', data: null })).error, 'No Windows build in the latest release of o/pd (v2): pd-linux.AppImage');
  state.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(404); res.end('{}'); };
  assert.match((await run({ ...item, id: 'quiver:c1:o/pd6' })).error, /Couldn't read the releases of o\/pd \(HTTP 404\)/);
  state.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(200); res.end('[]'); };
  assert.equal((await run({ ...item, id: 'quiver:c1:o/pd7' })).error, 'o/pd has no published release');

  assert.deepEqual(installs.startPort({ item: { ...item, repository: null } }), { ok: false, error: 'no_repository', detail: 'Perfect Dark has no GitHub repository to install from.' });
});

test('a port with no data and a bare exe asset installs the exe; cancelling stops it', async (t) => {
  const { dir, installs, item, state, fake } = await setup(t, { assets: ['pd-windows.exe'] });
  state.routes['/gh/pd-windows.exe'] = (req, res) => { res.writeHead(200, { 'content-length': 2 }); res.end('MZ'); };
  const r = installs.startPort({ item: { ...item, data: null } });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  assert.deepEqual([job.status, job.exePath], ['done', path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort', 'pd-windows.exe')]);

  state.routes['/gh/pd-windows.exe'] = () => {};  // never answers
  const slow = installs.startPort({ item: { ...item, id: 'quiver:c1:o/slow', data: null } }).jobs[0];
  await new Promise(r => setTimeout(r, 50));
  assert.equal(installs.cancel(slow.id).status, 'cancelled');
  await installs.wait(slow.id);
  assert.equal(installs.get(slow.id).status, 'cancelled');
  void fake;
});

// Shaped like archive.org's /metadata/<id> files list, bookkeeping files included
const IA_FILES = [
  { name: 'Banjo.zip', source: 'original', size: '120', sha1: sha1('zip') },
  { name: 'roms/bk.z64', source: 'original', size: '4', sha1: sha1('ROM1') },
  { name: 'roms/extra/bk-pal.z64', source: 'original', size: '4', sha1: sha1('ROM2') },
  { name: 'Banjo.zip.torrent', source: 'metadata' },
  { name: 'banjo-full_meta.xml', source: 'original' },
  { name: '__ia_thumb.jpg', source: 'original' },
  { name: 'Banjo.png', source: 'derivative' },
];

test('expandSource: one file, a folder, the whole item; bookkeeping files never count', () => {
  const one = ports.expandSource({ ia: 'i', path: 'roms/BK.z64' }, IA_FILES);
  assert.deepEqual(one, { files: [{ name: 'roms/bk.z64', rel: 'bk.z64', sha1: sha1('ROM1'), size: 4 }], single: true });
  const folder = ports.expandSource({ ia: 'i', path: 'roms/*' }, IA_FILES);
  assert.deepEqual(folder.files.map(f => f.rel), ['bk.z64', 'extra/bk-pal.z64']);
  assert.deepEqual(ports.expandSource({ ia: 'i', path: '*' }, IA_FILES).files.map(f => f.name), ['Banjo.zip', 'roms/bk.z64', 'roms/extra/bk-pal.z64']);
  assert.deepEqual(ports.expandSource({ ia: 'i', path: 'nope.bin' }, IA_FILES), { error: "nope.bin isn't in i" });
  assert.deepEqual(ports.expandSource({ ia: 'i', path: 'saves/*' }, IA_FILES), { error: 'Nothing under saves/* in i' });
});

test('validateCollision: a port of its own needs a name; sha1 only on one file', () => {
  assert.deepEqual(ports.validateCollision({ repository: 'a/b', name: 'B' }), []);
  assert.deepEqual(ports.validateCollision({ repository: 'a/b' }), ['an entry with no data sources needs a name (it defines a port of its own)']);
  assert.deepEqual(ports.validateCollision({ repository: 'a/b', sources: [{ ia: 'i', path: 'x/*', sha1: sha1('x') }] }), ['sources[0].sha1 only applies to a single file']);
  assert.deepEqual(ports.validateCollision({ repository: 'a/b', binaryTarget: '..', assetPattern: '(', sources: [{ ia: 'i', path: 'x', extract: 'yes' }] }), [
    'assetPattern: Invalid regular expression: /(/: Unterminated group', 'binaryTarget must be a relative folder', 'sources[0].extract must be true or false',
  ]);
  assert.deepEqual(ports.validateCollision([]), ['entry must be an object']);
  assert.deepEqual(ports.validateCollision({ repository: 'a/b', name: 'B', exe: 'pd.x86_64.exe', keepReleaseFolder: true }), []);
  assert.deepEqual(ports.validateCollision({ repository: 'a/b', name: 'B', exe: '../pd.exe', keepReleaseFolder: 'yes' }), [
    'exe must be a relative path to an .exe', 'keepReleaseFolder must be true or false',
  ]);
  assert.deepEqual(ports.validateCollision({ repository: 'a/b', name: 'B', exe: 'readme.txt' }), ['exe must be a relative path to an .exe']);
});

test('base "data": the archive.org zip unpacks first, the release unpacks over it into binaryTarget', async (t) => {
  const { dir, installs, item, state } = await setup(t);
  state.files['banjo-full'] = IA_FILES;
  state.zips['banjo-full/Banjo.zip'] = makeZip({ 'game.dat': 'DATA', 'bin/pd.exe': 'OLD' });
  const zipSum = sha1(state.zips['banjo-full/Banjo.zip']);
  state.files['banjo-full'] = IA_FILES.map(f => (f.name === 'Banjo.zip' ? { ...f, sha1: zipSum } : f));
  const it = { ...item, data: { assetPattern: '(?i)x86_64-windows', base: 'data', binaryTarget: 'bin', sources: [{ ia: 'banjo-full', path: 'Banjo.zip', extract: true }] } };
  const r = installs.startPort({ item: it });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.error], ['done', null]);
  assert.equal(fs.readFileSync(path.join(dest, 'game.dat'), 'utf8'), 'DATA');
  assert.equal(fs.readFileSync(path.join(dest, 'bin', 'pd.exe'), 'utf8'), 'MZ', 'the release wins over the data');
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'portable.txt')), 'filesToAdd land beside the release');
  assert.ok(!fs.existsSync(path.join(dest, 'Banjo.zip')), 'an extracted archive is not also copied');
});

test('base "binary": one file and a folder placed beside the release, checked against archive.org sha1', async (t) => {
  const { dir, installs, item, state, fake } = await setup(t);
  state.files['banjo-full'] = IA_FILES;
  state.routes['/download/banjo-full/roms/bk.z64'] = (req, res) => { res.writeHead(200); res.end('ROM1'); };
  state.routes['/download/banjo-full/roms/extra/bk-pal.z64'] = (req, res) => { res.writeHead(200); res.end('ROM2'); };
  const sources = [{ ia: 'banjo-full', path: 'roms/bk.z64', target: 'data' }, { ia: 'banjo-full', path: 'roms/*', target: 'all' }];
  const run = async (it) => { const r = installs.startPort({ item: it }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };

  const job = await run({ ...item, data: { assetPattern: '(?i)x86_64-windows', sources } });
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.exePath], ['done', path.join(dest, 'pd.exe')]);
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'bk.z64'), 'utf8'), 'ROM1');
  assert.equal(fs.readFileSync(path.join(dest, 'all', 'extra', 'bk-pal.z64'), 'utf8'), 'ROM2');

  // A wrong file fails the install naming it; the entry's own sha1 beats archive.org's
  state.routes['/download/banjo-full/roms/bk.z64'] = (req, res) => { res.writeHead(200); res.end('CORRUPT'); };
  const bad = await run({ ...item, id: 'quiver:c1:o/bad', data: { sources: [sources[0]] } });
  assert.match(bad.error, /^roms\/bk\.z64 doesn't match archive\.org \(sha1 [0-9a-f]{40}, expected /);
  const pinned = await run({ ...item, id: 'quiver:c1:o/pin', data: { sources: [{ ...sources[0], sha1: sha1('CORRUPT') }] } });
  assert.equal(pinned.status, 'done');
  const missing = await run({ ...item, id: 'quiver:c1:o/miss', data: { sources: [{ ia: 'banjo-full', path: 'nope.bin' }] } });
  assert.equal(missing.error, "nope.bin isn't in banjo-full");
  const optional = await run({ ...item, id: 'quiver:c1:o/opt', data: { sources: [{ ia: 'banjo-full', path: 'nope.bin', optional: true }] } });
  assert.equal(optional.status, 'done');
  const outside = await run({ ...item, id: 'quiver:c1:o/out', data: { binaryTarget: '../x' } });
  assert.match(outside.error, /binaryTarget would land outside/);
  assert.ok(fake.base);
});

test('a ROM zip from a set like N64TOSEC: unpacked, its one ROM renamed with `as` to what the port expects', async (t) => {
  const { dir, installs, item, state } = await setup(t, { bin: PD_REAL() });
  const romZip = makeZip({ 'Perfect Dark (USA) (Rev A).z64': 'TOSECROM', 'readme.txt': 'hi' });
  state.files['N64TOSEC'] = [{ name: 'Perfect Dark (USA) (Rev A).zip', source: 'original', size: String(romZip.length), sha1: sha1(romZip) }];
  state.routes['/download/N64TOSEC/Perfect%20Dark%20(USA)%20(Rev%20A).zip'] = (req, res) => { res.writeHead(200); res.end(romZip); };
  const source = { ia: 'N64TOSEC', path: 'Perfect Dark (USA) (Rev A).zip', target: 'data', extract: true, as: 'pd.ntsc-final.z64' };
  assert.deepEqual(ports.validateCollision({ repository: 'o/pd', sources: [source] }), []);
  const r = installs.startPort({ item: { ...item, data: { assetPattern: '(?i)x86_64-windows', exe: 'pd.x86_64.exe', sources: [source] } } });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.error, job.exePath], ['done', null, path.join(dest, 'pd.x86_64.exe')]);
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'pd.ntsc-final.z64'), 'utf8'), 'TOSECROM');
  assert.deepEqual(fs.readdirSync(path.join(dest, 'data')).sort(), ['pd.ntsc-final.z64', 'put_your_rom_here.txt'], 'no readme, no staging left');

  assert.deepEqual(ports.validateCollision({ repository: 'o/pd', sources: [{ ia: 'i', path: 'x/*', as: 'a.z64' }, { ia: 'i', path: 'x.zip', as: 'data/a.z64' }] }), [
    'sources[0].as only applies to a single file', 'sources[1].as must be a file name',
  ]);
  assert.equal(ports.expandSource({ ia: 'i', path: 'roms/bk.z64', as: 'baserom.z64' }, IA_FILES).files[0].rel, 'baserom.z64');
});
