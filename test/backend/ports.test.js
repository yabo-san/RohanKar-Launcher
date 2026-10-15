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
  const none = ports.pickAsset(['game-linux.AppImage', 'game-macos.zip'].map(asset));
  assert.deepEqual(none, { error: 'No Windows build in the latest release', names: ['game-linux.AppImage', 'game-macos.zip'] });
  assert.match(ports.pickAsset(pd, { pattern: '(' }).error, /Bad asset pattern/);
});

test('pickAsset: a PowerShell script only when there is no Windows build', () => {
  assert.equal(ports.pickAsset(['Setup.ps1', 'notes.txt'].map(asset)).asset.name, 'Setup.ps1');
  assert.equal(ports.pickAsset(['Setup.ps1', 'game-win64.zip'].map(asset)).asset.name, 'game-win64.zip');
});

test('parseRepo: owner/repo, or a link to the repo on GitHub, GitLab or Codeberg', () => {
  const p = ports.parseRepo;
  assert.deepEqual(p('me/port'), { repository: 'me/port', repositorySource: 'github' });
  assert.deepEqual(p('me/port', 'codeberg'), { repository: 'me/port', repositorySource: 'codeberg' });
  assert.deepEqual(p('group/sub/port', 'gitlab'), { repository: 'group/sub/port', repositorySource: 'gitlab' });
  assert.equal(p('group/sub/port'), null, 'only GitLab has subgroups');
  assert.deepEqual(p('me/port', 'sourceforge'), { repository: 'me/port', repositorySource: 'github' });
  assert.deepEqual(p('https://github.com/me/port/releases/latest'), { repository: 'me/port', repositorySource: 'github' });
  assert.deepEqual(p(' https://codeberg.org/testamentenjoyment/SpikeOut-Installer '), { repository: 'testamentenjoyment/SpikeOut-Installer', repositorySource: 'codeberg' });
  assert.deepEqual(p('codeberg.org/me/port.git'), { repository: 'me/port', repositorySource: 'codeberg' });
  assert.deepEqual(p('https://gitlab.com/group/sub/port/-/releases'), { repository: 'group/sub/port', repositorySource: 'gitlab' });
  for (const bad of ['', 'not-a-repo', 'https://example.com/me/port', 'https://github.com/me', null]) assert.equal(p(bad), null, String(bad));
});

test('portTraits: a Codeberg repo links to codeberg.org', () => {
  const t = ports.portTraits({ repository: 'me/port', repositorySource: 'codeberg' });
  assert.deepEqual([t.repositorySource, t.repositoryUrl], ['codeberg', 'https://codeberg.org/me/port']);
  assert.equal(ports.portTraits({ repository: 'me/port', repositorySource: 'nope' }).repositoryUrl, 'https://github.com/me/port');
  assert.deepEqual([ports.portTraits({ bookmark: true }).bookmark, ports.portTraits({ bookmark: 'yes' }).bookmark], [true, false]);
});

test('scriptFromContents: the one top-level .ps1, or the one named install/setup', () => {
  const f = (name, type = 'file') => ({ name, type, sha: 'abcdef0123456789', download_url: `https://x/raw/${name}` });
  assert.deepEqual(ports.scriptFromContents([f('README.md'), f('resources', 'dir'), f('SpikeOut.ps1')]),
    { tag_name: 'script-abcdef012345', assets: [{ name: 'SpikeOut.ps1', browser_download_url: 'https://x/raw/SpikeOut.ps1' }] });
  assert.equal(ports.scriptFromContents([f('a.ps1'), f('Install.ps1')]).assets[0].name, 'Install.ps1');
  assert.equal(ports.scriptFromContents([f('a.ps1'), f('b.ps1')]), null, 'two scripts, neither named install: no guess');
  assert.equal(ports.scriptFromContents([f('README.md')]), null);
  assert.equal(ports.scriptFromContents({ message: 'Not Found' }), null);
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
async function setup(t, { assets, bin: binZip, deleteAfterInstall = false } = {}) {
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
    entry: { folderName: 'PerfectDark-PerfectDarkPCPort', filesToAdd: ['portable.txt'], assetPattern: '(?i)x86_64-windows' },
  };
  return { fake, state, dir, library, installs, events, item };
}

test('a port installs its release build only: filesToAdd laid down, library row kept, no data step', async (t) => {
  const { dir, library, installs, events, item } = await setup(t, { deleteAfterInstall: true });
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
  assert.ok(!fs.existsSync(path.join(dir, 'dl', 'PerfectDark-PerfectDarkPCPort', 'pd-x86_64-windows.zip')), 'deleteAfterInstall removes the download');
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
  assert.deepEqual(fs.readdirSync(path.join(dir, 'dl', 'PerfectDark-PerfectDarkPCPort')).filter(n => n.startsWith('.unpack-')), [], 'staging is cleaned up');
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
    { ok: false, error: 'source_only', detail: 'Perfect Dark is source only: it publishes no download. Build it from https://github.com/o/pd.' });  assert.deepEqual(installs.startPort({ item: { ...item, bookmark: true, repositoryUrl: 'https://github.com/o/pd' } }),
    { ok: false, error: 'bookmark', detail: 'Perfect Dark is a bookmark: install it from its page, https://github.com/o/pd.' });
});

test('portTraits: source only, work in progress, engine or launcher, and the repository page', () => {
  assert.deepEqual(ports.portTraits({ repository: 'a/b', tags: ['Source Only', 'curated'] }),
    { sourceOnly: true, workInProgress: false, bookmark: false, role: null, repositorySource: 'github', repositoryUrl: 'https://github.com/a/b' });
  assert.deepEqual(ports.portTraits({ repository: 'a/b', tags: ['work in progress'] }).workInProgress, true);
  assert.equal(ports.portTraits({ tags: ['engine'] }).role, 'engine');
  assert.equal(ports.portTraits({ tags: ['launcher', 'owner pick'] }).role, 'launcher');
  const gitlab = ports.portTraits({ repository: ' g/r ', repositorySource: 'gitlab' });
  assert.deepEqual([gitlab.repositorySource, gitlab.repositoryUrl], ['gitlab', 'https://gitlab.com/g/r']);
  assert.deepEqual(ports.portTraits(), { sourceOnly: false, workInProgress: false, bookmark: false, role: null, repositorySource: 'github', repositoryUrl: null });
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

// GitLab and Codeberg on par with GitHub: a release build, or failing that a
// top-level install script, from each
test('a GitLab or Codeberg repo installs its release build, or its install script', async (t) => {
  const state = { routes: {} };
  const fake = await fakeArchive(t, state);
  const zip = makeZip({ 'tool.exe': 'MZ' });
  const script = 'Write-Host "hi"\n';
  state.routes['/repos/me/tool/releases'] = (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify([{ tag_name: 'v1', assets: [{ name: 'tool-win64.zip', browser_download_url: `${fake.base}/dl/tool-win64.zip` }] }]));
  };
  state.routes['/dl/tool-win64.zip'] = (req, res) => { res.writeHead(200, { 'content-length': zip.length }); res.end(zip); };
  state.routes['/projects/group%2Fsub%2Fwizard/releases'] = (req, res) => { res.writeHead(200); res.end('[]'); };
  state.routes['/projects/group%2Fsub%2Fwizard/repository/tree'] = (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify([{ id: 'b10b', name: 'Setup.ps1', type: 'blob', path: 'Setup.ps1' }, { id: 't1', name: 'res', type: 'tree', path: 'res' }]));
  };
  state.routes['/projects/group%2Fsub%2Fwizard/repository/files/Setup.ps1/raw'] = (req, res) => { res.writeHead(200, { 'content-length': Buffer.byteLength(script) }); res.end(script); };
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ downloadPath: path.join(dir, 'dl'), installPath: path.join(dir, 'games') });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const installs = createInstalls({ settings, library, archive: createArchive({ base: fake.base }), gamesDir: dir, githubApi: 'http://127.0.0.1:1', gitlabApi: fake.base, codebergApi: fake.base });
  const run = async (item) => { const r = installs.startPort({ item }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };

  const cb = await run({ id: 'cb', title: 'Tool', repository: 'me/tool', repositorySource: 'codeberg', entry: {} });
  assert.deepEqual([cb.status, cb.error, cb.file], ['done', null, 'tool-win64.zip']);
  assert.equal(cb.exePath, path.join(cb.installDir, 'tool.exe'));

  const gl = await run({ id: 'gl', title: 'Wizard', repository: 'group/sub/wizard', repositorySource: 'gitlab', entry: {} });
  assert.deepEqual([gl.status, gl.error, gl.file], ['done', null, 'Setup.ps1']);
  assert.equal(gl.exePath, path.join(gl.installDir, 'Setup.ps1'));
  assert.equal(fs.readFileSync(gl.exePath, 'utf8'), script);
});
