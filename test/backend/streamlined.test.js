'use strict';
// The streamlined UI's backend: the repo file picker, newer port releases,
// copy/paste config, archive.org update dates
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeZip, testApi } = require('./helpers');
const ports = require('../../src/backend/ports');
const config = require('../../src/backend/config');
const { accountUploads } = require('../../src/backend/archive');

const asset = (name) => ({ name, browser_download_url: `https://example.test/${name}` });

test('patternFor: version numbers become \\d+, the rest is literal, and it picks the next release', () => {
  const p = ports.patternFor('pd-x86_64-windows-1.2.zip');
  assert.equal(p, '^pd-x\\d+_\\d+-windows-\\d+\\.\\d+\\.zip$');
  const next = ports.pickAsset([asset('pd-x86_64-linux-1.3.tar.gz'), asset('pd-i686-windows-1.3.zip'), asset('pd-x86_64-windows-1.3.zip')], { pattern: p });
  assert.equal(next.asset.name, 'pd-x86_64-windows-1.3.zip');
  assert.equal(ports.patternFor('a+b (c).exe'), '^a\\+b \\(c\\)\\.exe$');
});

test('releaseFiles: Windows files first, the automatic pick, and whether to ask', () => {
  const two = ports.releaseFiles({ tag_name: 'v2', assets: [asset('game-linux.tar.gz'), asset('game-win64.zip'), asset('game-win32.zip')] });
  assert.equal(two.tag, 'v2');
  assert.deepEqual(two.files.map(f => [f.name, f.windows]), [['game-win64.zip', true], ['game-win32.zip', true], ['game-linux.tar.gz', false]]);
  assert.equal(two.auto, 'game-win64.zip');
  assert.equal(two.choose, true);
  const one = ports.releaseFiles({ tag_name: 'v1', assets: [asset('game-windows.zip'), asset('game-linux.zip')] });
  assert.deepEqual([one.auto, one.choose], ['game-windows.zip', false]);
  const none = ports.releaseFiles({ tag_name: 'v1', assets: [asset('source.tar.gz')] });
  assert.deepEqual([none.auto, none.choose], [null, true]);
  assert.deepEqual(ports.releaseFiles(null), { tag: null, files: [], auto: null, choose: false });
});

test('accountUploads keeps updatedate', () => {
  const { hits } = accountUploads({ response: { body: { page_elements: { uploads: { hits: { total: 1, hits: [
    { fields: { identifier: 'x', addeddate: '2024-01-01', updatedate: ['2025-02-02'] } },
  ] } } } } } });
  assert.equal(hits[0].doc.updatedate, '2025-02-02');
});

test('config: build, read and merge', () => {
  const built = config.buildConfig({
    sources: [{ uploader: '@rohan', label: 'Rohan', enabled: true }, { uploader: '@off', enabled: false }, { uploader: '' }],
    repos: [{ repository: 'me/port', repositorySource: null, assetPattern: '^x$', extra: 1 }],
    hidden: ['a', 'a', 'b'],
  });
  assert.deepEqual(built, { y4bo: 1, packs: [{ uploader: '@rohan', label: 'Rohan' }], repos: [{ repository: 'me/port', assetPattern: '^x$' }], hidden: ['a', 'b'] });

  assert.deepEqual(config.readConfig(JSON.stringify(built)), { ok: true, config: built });
  assert.equal(config.readConfig('nope').ok, false);
  assert.match(config.readConfig({}).error, /isn't a y4bo config/);
  assert.match(config.readConfig({ y4bo: 2 }).error, /version 2/);
  assert.match(config.readConfig({ y4bo: 1, packs: 'x' }).error, /must be lists/);
  assert.match(config.readConfig({ y4bo: 1, packs: [{}] }).error, /uploader/);
  assert.match(config.readConfig({ y4bo: 1, repos: [{ name: 'x' }] }).error, /repository/);
  assert.match(config.readConfig({ y4bo: 1, hidden: ['https://archive.org/details/@someone'] }).error, /Not an archive.org upload/);
  assert.deepEqual(config.readConfig({ y4bo: 1, hidden: ['https://archive.org/details/zoo'] }).config.hidden, ['zoo']);

  const m = config.mergeConfig(
    { sources: [{ uploader: '@Rohan', enabled: true }, { uploader: '@off', enabled: false }], repos: [{ repository: 'Me/Port' }], hidden: ['a'] },
    { y4bo: 1, packs: [{ uploader: '@rohan' }, { uploader: '@off' }, { uploader: '@new', label: 'New' }], repos: [{ repository: 'me/port' }, { repository: 'x/y' }, { repository: 'X/Y' }], hidden: ['a', 'b'] },
  );
  assert.deepEqual(m.sources, [{ uploader: '@Rohan', enabled: true }, { uploader: '@off', enabled: true }, { uploader: '@new', label: 'New', enabled: true }]);
  assert.deepEqual(m.repos, [{ repository: 'x/y' }]);
  assert.deepEqual(m.excludeItems, ['a', 'b']);
  assert.deepEqual(m.added, { packs: 2, repos: 1, hidden: 1 });
});

test('GET and PUT /config: copy what was added, paste it back merged', async (t) => {
  const { call } = await testApi(t);
  await call('PUT', '/settings', { sources: [{ uploader: '@rohan', label: 'Rohan', enabled: true }], excludeItems: ['zoo'] });
  await call('PUT', `/repos/${encodeURIComponent('me/port')}`, { assetPattern: '^p\\.zip$' });
  const got = (await call('GET', '/config')).body;
  assert.deepEqual(got, { y4bo: 1, packs: [{ uploader: '@rohan', label: 'Rohan' }], repos: [{ repository: 'me/port', assetPattern: '^p\\.zip$' }], hidden: ['zoo'] });

  const pasted = await call('PUT', '/config', { text: JSON.stringify({ y4bo: 1, packs: [{ uploader: '@friend' }], repos: [{ repository: 'friend/game' }, { repository: 'bad' }], hidden: ['halo'] }) });
  assert.equal(pasted.status, 200);
  assert.deepEqual(pasted.body.added, { packs: 1, repos: 1, hidden: 1 });
  assert.equal(pasted.body.errors.length, 1);
  const after = (await call('GET', '/config')).body;
  assert.deepEqual(after.packs.map(p => p.uploader), ['@rohan', '@friend']);
  assert.deepEqual(after.repos.map(r => r.repository), ['me/port', 'friend/game']);
  assert.deepEqual(after.hidden, ['zoo', 'halo']);

  const bad = await call('PUT', '/config', { text: '{"hello": 1}' });
  assert.deepEqual([bad.status, bad.body.error], [400, 'bad_config']);
});

test('A port records its release tag; a newer release shows in /ports/updates; /repos/:repo/release lists the files', async (t) => {
  const curated = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'catalog', 'curated-ports.json'), 'utf8'));
  const releases = require('../fixtures/gitlab/starfox64recomp-releases.json');
  const zip = makeZip({ 'Starfox64Recompiled.exe': 'MZ' });
  const state = { routes: {} };
  const asFake = (base, list) => JSON.stringify(list.map(r => ({ ...r, assets: { ...r.assets,
    links: r.assets.links.map(l => ({ ...l, direct_asset_url: l.direct_asset_url.replace('https://gitlab.com', base) })) } })));
  const { call, backend, fake } = await testApi(t, { state, curated: true });
  const releasesRoute = '/projects/sonicdcer%2FStarfox64Recomp/releases';
  state.routes['/curated-ports.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify(curated)); };
  state.routes[releasesRoute] = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(asFake(fake.base, releases)); };
  state.routes['/sonicdcer/Starfox64Recomp/-/package_files/333158626/download'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length }); res.end(zip);
  };
  backend.settings.save({ installPath: path.join(backend.dataDir, 'games') });

  const files = (await call('GET', `/repos/${encodeURIComponent('sonicdcer/Starfox64Recomp')}/release?source=gitlab`)).body;
  assert.equal(files.tag, 'v1.0.3');
  assert.equal(files.auto, 'Starfox64Recompiled-v1.0.3-Windows-RelWithDebInfo');
  assert.equal(files.files[0].name, files.auto);
  assert.equal(files.choose, false);

  await call('GET', '/catalogs');
  const sf = (await call('GET', '/catalogs/curated/items')).body.items.find(i => i.repository === 'sonicdcer/Starfox64Recomp');
  assert.deepEqual((await call('GET', '/ports/updates')).body.updates, [], 'nothing installed yet');
  const r = await call('POST', '/installs', { id: sf.id });
  await backend.installs.wait(r.body.installs[0].id);
  assert.equal(backend.library.get(sf.id).version, 'v1.0.3');
  assert.deepEqual((await call('GET', '/ports/updates')).body.updates, [], 'the latest is installed');

  // A newer release: checked again only after an hour
  const newer = [{ ...releases[0], tag_name: 'v1.1.0' }, ...releases];
  state.routes[releasesRoute] = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(asFake(fake.base, newer)); };
  assert.deepEqual(await backend.installs.portUpdates([sf]), [], 'cached for an hour');
  assert.deepEqual(await backend.installs.portUpdates([sf], { now: Date.now() + 61 * 60 * 1000 }), [{ id: sf.id, installed: 'v1.0.3', latest: 'v1.1.0' }]);

  // Errors are skipped, not thrown
  state.routes[releasesRoute] = (req, res) => { res.writeHead(500); res.end(); };
  assert.deepEqual(await backend.installs.portUpdates([sf], { now: Date.now() + 3 * 60 * 60 * 1000 }), []);
  const failed = await call('GET', `/repos/${encodeURIComponent('sonicdcer/Starfox64Recomp')}/release?source=gitlab`);
  assert.deepEqual([failed.status, failed.body.error], [502, 'release_failed']);
});
