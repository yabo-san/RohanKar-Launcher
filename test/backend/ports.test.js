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
async function setup(t, { rom = 'ROMDATA', dataZip, assets, deleteAfterInstall = false } = {}) {
  const state = { routes: {}, zips: {} };
  const fake = await fakeArchive(t, state);
  const bin = makeZip({ 'pd.exe': 'MZ', 'data/.keep': '' });
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

test('a data file that fails its sha1 fails the install, naming the file, and is removed', async (t) => {
  const { dir, installs, item } = await setup(t, { rom: 'NOT THE ROM' });
  const r = installs.startPort({ item });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /^pd\.ntsc-final\.z64 doesn't match the catalog \(sha1 [0-9a-f]{40}, expected /);
  assert.ok(!fs.existsSync(path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort', 'data', 'pd.ntsc-final.z64')));
});

test('missing data, optional data, patches, no Windows build, no repository', async (t) => {
  const { installs, item, state, fake } = await setup(t, { dataZip: makeZip({ 'other.bin': 'x' }), deleteAfterInstall: true });
  const run = async (it) => { const r = installs.startPort({ item: it }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };

  assert.equal((await run(item)).error, "pd.ntsc-final.z64 isn't in Perfect Dark PC Port.zip");
  const optional = { ...item, id: 'quiver:c1:o/pd2', data: { ...item.data, dataFiles: [{ ...item.data.dataFiles[0], optional: true }] } };
  assert.equal((await run(optional)).status, 'done');
  state.zips['pd_ia/Perfect Dark PC Port.zip'] = makeZip({ 'pd.ntsc-final.z64': 'ROMDATA' });
  const patched = { ...item, id: 'quiver:c1:o/pd3', data: { ...item.data, dataFiles: [{ ...item.data.dataFiles[0], patch: 'fix.bps' }] } };
  assert.match((await run(patched)).error, /needs a patch \(fix\.bps\)/);
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
