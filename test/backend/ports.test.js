'use strict';
// Port installs: release and asset picking, and a whole install against a
// fake GitHub (the release binary and filesToAdd; game data is the user's job).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const ports  = require('../../src/backend/ports');
const { createInstalls } = require('../../src/backend/installs');
const { createArchive } = require('../../src/backend/archive');
const { createSettings } = require('../../src/backend/settings');
const { createLibrary } = require('../../src/backend/library');
const { fakeArchive, tmpDir, makeZip } = require('./helpers');

const asset = (name) => ({ name, browser_download_url: `https://x/${name}` });

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
  const none = ports.pickAsset(['game-linux.AppImage', 'game-macos.zip'].map(asset));  // neither runs on Windows
  assert.deepEqual(none, { error: 'No Windows build in the latest release', names: ['game-linux.AppImage', 'game-macos.zip'] });
  assert.match(ports.pickAsset(pd, { pattern: '(' }).error, /Bad asset pattern/);
});

test('platformOf: the system a file is for, from its name', () => {
  const cases = {
    'pd-x86_64-windows.zip': 'windows', 'Game-Win64.zip': 'windows', 'dsda-doom-0.29.4-win-x64.zip': 'windows', 'pokefirered.exe': 'windows',
    'ironwail-0.8.2-linux-x64.tar.gz': 'linux', 'devilutionx-linux-x86_64.appimage': 'linux', 'ProjectMidas-v1-steamdeck.7z': 'linux',
    'Starfox64Recompiled-v1.0.3-Flatpak-X64-Release': 'linux', 'dsda-doom-0.29.4-mac-arm64.zip': 'macos', 'Game-darwin64.zip': 'macos',
    'devilutionx-android.apk': 'android', 'zelda3.zip': 'unknown', 'Winter.zip': 'unknown',
  };
  for (const [name, os] of Object.entries(cases)) assert.equal(ports.platformOf(name), os, name);
});

test('pickAsset: an unmarked build counts as Windows\', and checksums and symbols never count', () => {
  // Quest64, Chameleon Twist, zelda3: one zip, no "win" in its name
  assert.equal(ports.pickAsset(['zelda3.zip'].map(asset)).asset.name, 'zelda3.zip');
  // Raze 1.11.0: the pdb 7z isn't the build
  const raze = ['raze_1.11.0_windows.zip', 'raze_1.11.0_windows_pdb.7z', 'raze_1.11.0_linux.tar.xz'].map(asset);
  assert.equal(ports.pickAsset(raze).asset.name, 'raze_1.11.0_windows.zip');
  assert.equal(ports.pickAsset(['game-win64.zip.sha256', 'game-win64.zip', 'checksums.txt'].map(asset)).asset.name, 'game-win64.zip');
  // A marked Windows build beats an unmarked one
  assert.equal(ports.pickAsset(['game.zip', 'game-windows.zip'].map(asset)).asset.name, 'game-windows.zip');
});

test('pickAsset on Linux: the Linux build, then an unmarked one, then Windows\'; never a Flatpak', () => {
  const pd = ['pd-x86_64-linux.tar.gz', 'pd-i686-windows.zip', 'pd-x86_64-windows.zip', 'Source code.zip'].map(asset);
  assert.equal(ports.pickAsset(pd, { platform: 'linux' }).asset.name, 'pd-x86_64-linux.tar.gz');
  assert.equal(ports.pickAsset(['game.zip', 'game-win64.zip'].map(asset), { platform: 'linux' }).asset.name, 'game.zip');
  assert.equal(ports.pickAsset(['game-win64.zip', 'game-macos.zip'].map(asset), { platform: 'linux' }).asset.name, 'game-win64.zip');
  assert.equal(ports.pickAsset(['game-arm64-linux.AppImage', 'game-x86_64-linux.AppImage'].map(asset), { platform: 'linux' }).asset.name, 'game-x86_64-linux.AppImage');
  const sf = ['SF-Flatpak-X64-Release', 'SF-Linux-ARM64-Release', 'SF-Linux-X64-Release', 'SF-macOS-Release', 'SF-Windows-RelWithDebInfo'].map(asset);
  assert.equal(ports.pickAsset(sf, { platform: 'linux' }).asset.name, 'SF-Linux-X64-Release');
  // A user's own pick (assetPattern) is kept, whatever it's for
  assert.equal(ports.pickAsset(pd, { platform: 'linux', pattern: 'x86_64-windows' }).asset.name, 'pd-x86_64-windows.zip');
  // A filter that matches a Linux build too is the user's filter: kept
  assert.equal(ports.pickAsset(['a-linux.zip', 'b-linux.zip', 'b-windows.zip'].map(asset), { platform: 'linux', filter: 'b-' }).asset.name, 'b-linux.zip');
  assert.equal(ports.pickAsset(['game-macos.zip'].map(asset), { platform: 'linux' }).error, 'No Linux or Windows build in the latest release');
  // tar archives are Linux-only builds
  assert.match(ports.pickAsset(['game-linux.tar.gz'].map(asset)).error, /No Windows build/);
});

test('onSteamDeck: SteamOS, or Steam saying so', () => {
  assert.equal(ports.onSteamDeck({ env: { SteamDeck: '1' }, osRelease: () => '' }), true);
  assert.equal(ports.onSteamDeck({ env: {}, osRelease: () => 'NAME="SteamOS"\nID=steamos\n' }), true);
  assert.equal(ports.onSteamDeck({ env: {}, osRelease: () => 'ID=arch\n' }), false);
  assert.equal(typeof ports.onSteamDeck(), 'boolean');
});

test('releasesFromGitlab: GitLab\'s releases in GitHub\'s shape, asset links only', () => {
  const gitlab = require('../fixtures/gitlab/starfox64recomp-releases.json');
  const [r] = ports.releasesFromGitlab(gitlab);
  assert.deepEqual([r.tag_name, r.draft, r.prerelease, r.assets.length], ['v1.0.3', false, false, 5]);
  assert.ok(r.assets.every(a => a.browser_download_url.includes('/-/package_files/')), 'no source archives');
  assert.equal(ports.pickAsset(r.assets).asset.name, 'Starfox64Recompiled-v1.0.3-Windows-RelWithDebInfo');
  assert.equal(ports.pickRelease(ports.releasesFromGitlab([{ tag_name: 'v2', upcoming_release: true, assets: {} }, ...gitlab])).tag_name, 'v1.0.3');
  assert.deepEqual(ports.releasesFromGitlab({ message: '404 Project Not Found' }), []);
  assert.deepEqual(ports.releasesFromGitlab([{ tag_name: 'v1', assets: { links: [{ name: 'a', url: 'https://x/a' }, { name: 'nourl' }] } }])[0].assets,
    [{ name: 'a', browser_download_url: 'https://x/a' }]);
  assert.equal(ports.gitlabReleasesUrl('https://gitlab.com/api/v4', 'group/sub/repo'), 'https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/releases');
});

test('sniffArchiveExt: an archive by its first bytes', (t) => {
  const dir = tmpDir(t);
  const write = (name, buf) => { fs.writeFileSync(path.join(dir, name), buf); return path.join(dir, name); };
  assert.equal(ports.sniffArchiveExt(write('a', makeZip({ 'x.txt': 'x' }))), '.zip');
  assert.equal(ports.sniffArchiveExt(write('b', Buffer.from('377abcaf271c0004', 'hex'))), '.7z');
  assert.equal(ports.sniffArchiveExt(write('c', Buffer.from('MZ'))), '');
  assert.equal(ports.sniffArchiveExt(path.join(dir, 'missing')), '');
});

test('inside keeps a relative path under its root', (t) => {
  const dir = tmpDir(t);
  assert.equal(ports.inside(dir, 'data', 'rom.z64'), path.join(dir, 'data', 'rom.z64'));
  assert.equal(ports.inside(dir, '', 'rom.z64'), path.join(dir, 'rom.z64'));
  assert.equal(ports.inside(dir, '..', 'evil'), null);
});

// A fake GitHub on the fake archive's server: releases for o/pd, and its assets
async function setup(t, { assets, bin: binZip, platform = 'win32' } = {}) {
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

  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ downloadPath: path.join(dir, 'dl'), installPath: path.join(dir, 'games') });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const events = [];
  const installs = createInstalls({
    settings, library, archive: createArchive({ base: fake.base }), gamesDir: dir, githubApi: fake.base, platform, deck: false,
    emit: (type, data) => events.push(data),
  });
  const item = {
    id: 'quiver:c1:o/pd', title: 'Perfect Dark', repository: 'o/pd',
    entry: { folderName: 'PerfectDark-PerfectDarkPCPort', filesToAdd: ['portable.txt'], assetPattern: '(?i)x86_64-windows' },
  };
  return { fake, state, dir, library, installs, events, item };
}

test('a port installs its release build only: filesToAdd laid down, library row kept, no data step', async (t) => {
  const { dir, library, installs, events, item } = await setup(t);
  library.add(item.id, 'https://c/Nintendo.json');
  const r = installs.startPort({ item });
  assert.equal(r.ok, true);
  assert.deepEqual(installs.startPort({ item }).jobs[0].id, r.jobs[0].id, 'a second start joins the running job');
  await installs.wait(r.jobs[0].id);

  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.error, job.installDir, job.exePath, job.file], ['done', null, dest, path.join(dest, 'pd.exe'), 'pd-x86_64-windows.zip']);
  assert.ok(fs.existsSync(path.join(dest, 'portable.txt')));
  assert.ok(fs.existsSync(path.join(dest, 'data', '.keep')));
  assert.ok(!fs.existsSync(path.join(dir, 'dl', 'PerfectDark-PerfectDarkPCPort', 'pd-x86_64-windows.zip')), 'the download is removed once installed');
  const row = library.get(item.id);
  assert.deepEqual([row.install_dir, row.exe_path, row.source], [dest, path.join(dest, 'pd.exe'), 'https://c/Nintendo.json']);

  const steps = new Set(events.map(e => `${e.status}:${e.step}`));
  assert.deepEqual([...steps], ['downloading:binary', 'extracting:binary', 'done:null']);
});

// The real release zip wraps everything in one folder and ships three exes
const PD_REAL = () => makeZip({
  'pd-x86_64-windows/pd.x86_64.exe': 'MZ', 'pd-x86_64-windows/pd.pal.x86_64.exe': 'MZ', 'pd-x86_64-windows/pd.jpn.x86_64.exe': 'MZ',
  'pd-x86_64-windows/SDL2.dll': 'DLL', 'pd-x86_64-windows/data/put_your_rom_here.txt': 'here',
});

test('a release wrapped in one folder is unwrapped; with several exes none is picked', async (t) => {
  const { dir, installs, item } = await setup(t, { bin: PD_REAL() });
  const r = installs.startPort({ item });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.error, job.exePath], ['done', null, null]);
  assert.ok(fs.existsSync(path.join(dest, 'pd.x86_64.exe')));
  assert.ok(fs.existsSync(path.join(dest, 'data', 'put_your_rom_here.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'pd-x86_64-windows')), 'no wrapper folder left');
  assert.ok(!fs.existsSync(path.join(dir, 'dl', 'PerfectDark-PerfectDarkPCPort')), 'download and staging are cleaned up');
});

test('no Windows build, unreadable releases, no release, no repository', async (t) => {
  const { installs, item, state, fake } = await setup(t);
  const run = async (it) => { const r = installs.startPort({ item: it }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };

  state.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ tag_name: 'v2', assets: [{ name: 'pd-linux.AppImage', browser_download_url: `${fake.base}/gh/x` }] }])); };
  assert.equal((await run({ ...item, entry: {} })).error, 'No Windows build in the latest release of o/pd (v2): pd-linux.AppImage');
  state.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(404); res.end('{}'); };
  assert.match((await run({ ...item, id: 'quiver:c1:o/pd6' })).error, /Couldn't read the releases of o\/pd \(HTTP 404\)/);
  state.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(200); res.end('[]'); };
  assert.equal((await run({ ...item, id: 'quiver:c1:o/pd7' })).error, 'o/pd has no published release');

  assert.deepEqual(installs.startPort({ item: { ...item, repository: null } }), { ok: false, error: 'no_repository', detail: 'Perfect Dark has no repository to install from.' });
  assert.deepEqual(installs.startPort({ item: { ...item, sourceOnly: true, repositoryUrl: 'https://github.com/o/pd' } }),
    { ok: false, error: 'source_only', detail: 'Perfect Dark is source only: it publishes no download. Build it from https://github.com/o/pd.' });
});

test('on Linux a port installs its Linux tarball, unwrapped, the shelf\'s Windows filter set aside', async (t) => {
  const { dir, installs, item, state } = await setup(t, { platform: 'linux' });
  // pd-x86_64-linux.tar.gz holds one folder, as the real release does
  const src = tmpDir(t);
  fs.mkdirSync(path.join(src, 'pd-x86_64-linux', 'data'), { recursive: true });
  fs.writeFileSync(path.join(src, 'pd-x86_64-linux', 'pd.x86_64'), 'ELF');
  fs.writeFileSync(path.join(src, 'pd-x86_64-linux', 'data', '.keep'), '');
  const tarball = path.join(src, 'pd.tar.gz');
  require('child_process').execFileSync('tar', ['-czf', tarball, '-C', src, 'pd-x86_64-linux']);
  const tgz = fs.readFileSync(tarball);
  state.routes['/gh/pd-x86_64-linux.tar.gz'] = (req, res) => { res.writeHead(200, { 'content-length': tgz.length }); res.end(tgz); };

  const r = installs.startPort({ item: { ...item, entry: { folderName: item.entry.folderName, releaseAssetFilter: 'windows' } } });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  const dest = path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort');
  assert.deepEqual([job.status, job.error, job.file], ['done', null, 'pd-x86_64-linux.tar.gz']);
  assert.equal(fs.readFileSync(path.join(dest, 'pd.x86_64'), 'utf8'), 'ELF');
  assert.ok(fs.existsSync(path.join(dest, 'data', '.keep')));
  assert.ok(!fs.existsSync(path.join(dest, 'pd-x86_64-linux')), 'no wrapper folder left');

  // A tarball that isn't one fails the install with tar's error
  state.routes['/gh/pd-x86_64-linux.tar.gz'] = (req, res) => { res.writeHead(200, { 'content-length': 3 }); res.end('bad'); };
  const bad = installs.startPort({ item: { ...item, id: 'quiver:c1:o/bad', entry: { folderName: 'Bad' } } });
  await installs.wait(bad.jobs[0].id);
  assert.equal(installs.get(bad.jobs[0].id).status, 'error');
});

test('sniffArchiveExt: compressed tarballs by their first bytes', (t) => {
  const d = tmpDir(t);
  const write = (name, hex) => { const f = path.join(d, name); fs.writeFileSync(f, Buffer.from(hex, 'hex')); return f; };
  assert.equal(ports.sniffArchiveExt(write('gz', '1f8b0800')), '.tar.gz');
  assert.equal(ports.sniffArchiveExt(write('xz', 'fd377a585a0000')), '.tar.xz');
  assert.equal(ports.sniffArchiveExt(write('bz', '425a6839')), '.tar.bz2');
  assert.equal(ports.isArchive('a.tgz'), true);
  assert.equal(ports.isArchive('a.AppImage'), false);
});

test('portTraits: source only, work in progress, engine or launcher, and the repository page', () => {
  assert.deepEqual(ports.portTraits({ repository: 'a/b', tags: ['Source Only', 'curated'] }),
    { sourceOnly: true, workInProgress: false, role: null, repositorySource: 'github', repositoryUrl: 'https://github.com/a/b' });
  assert.deepEqual(ports.portTraits({ repository: 'a/b', tags: ['work in progress'] }).workInProgress, true);
  assert.equal(ports.portTraits({ tags: ['engine'] }).role, 'engine');
  assert.equal(ports.portTraits({ tags: ['launcher', 'owner pick'] }).role, 'launcher');
  const gitlab = ports.portTraits({ repository: ' g/r ', repositorySource: 'gitlab' });
  assert.deepEqual([gitlab.repositorySource, gitlab.repositoryUrl], ['gitlab', 'https://gitlab.com/g/r']);
  assert.deepEqual(ports.portTraits(), { sourceOnly: false, workInProgress: false, role: null, repositorySource: 'github', repositoryUrl: null });
  assert.equal(ports.portTraits({ tags: 'source only' }).sourceOnly, false, 'tags must be a list');
});

test('a bare exe asset installs the exe; cancelling stops it', async (t) => {
  const { dir, installs, item, state } = await setup(t, { assets: ['pd-windows.exe'] });
  const plain = { ...item, entry: { folderName: item.entry.folderName } };
  state.routes['/gh/pd-windows.exe'] = (req, res) => { res.writeHead(200, { 'content-length': 2 }); res.end('MZ'); };
  const r = installs.startPort({ item: plain });
  await installs.wait(r.jobs[0].id);
  const job = installs.get(r.jobs[0].id);
  assert.deepEqual([job.status, job.exePath], ['done', path.join(dir, 'games', 'PerfectDark-PerfectDarkPCPort', 'pd-windows.exe')]);

  state.routes['/gh/pd-windows.exe'] = () => {};  // never answers
  const slow = installs.startPort({ item: { ...plain, id: 'quiver:c1:o/slow' } }).jobs[0];
  await new Promise(r => setTimeout(r, 50));
  assert.equal(installs.cancel(slow.id).status, 'cancelled');
  await installs.wait(slow.id);
  assert.equal(installs.get(slow.id).status, 'cancelled');
});
