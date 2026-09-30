'use strict';
// Additional sources: user.json read and validated, gated by the setting,
// curated entries winning, and sha1s checked or pinned on install.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const us = require('../../src/backend/user-sources');
const { createInstalls } = require('../../src/backend/installs');
const { createArchive } = require('../../src/backend/archive');
const { createSettings } = require('../../src/backend/settings');
const { createLibrary } = require('../../src/backend/library');
const { fakeArchive, testApi, tmpDir, makeZip } = require('./helpers');

const FIX = path.join(__dirname, '..', 'fixtures', 'user-sources');
const fixture = (name) => path.join(FIX, `${name}.json`);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

test('user.json: a valid file gives its three sections', () => {
  const r = us.readUserFile(fixture('valid'));
  assert.equal(r.error, null);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.entries.collisions.map(c => c.repository), ['me/my-port']);
  assert.deepEqual(r.entries.archive.map(a => a.identifier), ['my-homebrew', 'my-demo']);
  assert.deepEqual(r.entries.github.map(g => g.repository), ['me/tool']);
  assert.deepEqual(us.githubAsCollision(r.entries.github[0]), { repository: 'me/tool', name: 'My Tool', assetPattern: '(?i)windows' });
  assert.deepEqual(us.githubAsCollision({ repository: 'a/b', folderName: 'B', sha1: 'A'.repeat(40) }), { repository: 'a/b', name: 'b', folderName: 'B', sha1: 'a'.repeat(40) });
});

test('user.json: every invalid entry is named with why; the good ones still load', () => {
  const r = us.readUserFile(fixture('invalid'));
  assert.equal(r.error, null);
  assert.deepEqual(r.entries.collisions.map(c => c.repository), ['me/fine-port']);
  assert.deepEqual(r.entries.archive.map(a => a.identifier), ['ok-item']);
  assert.deepEqual(r.entries.github, []);
  const at = (section, index) => r.invalid.find(i => i.section === section && i.index === index);
  assert.equal(r.invalid.length, 6);
  assert.deepEqual(at('collisions', 0).errors, ['repository must be owner/repo']);
  assert.deepEqual(at('archive', 0).errors, ['identifier must be an archive.org identifier']);
  assert.deepEqual(at('archive', 1), { section: 'archive', index: 1, key: 'my-demo', errors: ['files[0].sha1 must be 40 hex characters'] });
  assert.deepEqual(at('archive', 3).errors, ['repeats OK-item, listed earlier in archive']);
  assert.deepEqual(at('archive', 4), { section: 'archive', index: 4, key: null, errors: ['entry must be an object'] });
  assert.equal(at('github', 0).errors[0], 'folderName must be a string');
  assert.match(at('github', 0).errors[1], /^assetPattern: /);
});

test('user.json: a file that is not one says why', (t) => {
  const dir = tmpDir(t);
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  assert.equal(us.readUserFile(null).error, null);
  assert.match(us.readUserFile('https://example.com/user.json').error, /not a URL/);
  assert.match(us.readUserFile('user.json').error, /full path/);
  assert.match(us.readUserFile(path.join(dir, 'none.json')).error, /^No file at /);
  assert.match(us.readUserFile(write('bad.json', '{ nope')).error, /^Not valid JSON/);
  assert.equal(us.readUserFile(write('bom.json', '﻿{"schemaVersion":1}')).error, null);
  assert.match(us.readUserFile(write('v2.json', '{"schemaVersion":2}')).error, /schemaVersion must be 1 \(found 2\)/);
  assert.match(us.readUserFile(write('arr.json', '[]')).error, /must be an object/);
  assert.equal(us.validateUserFile({ schemaVersion: 1, archive: {}, github: 'x' }).error, 'archive, github must be arrays');
  assert.equal(us.validateUserFile({ schemaVersion: 1, collisions: 1 }).error, 'collisions must be an array');
  assert.deepEqual(us.dropCurated('archive', [{ identifier: 'A' }, { identifier: 'b' }], new Set(['a'])),
    { kept: [{ identifier: 'b' }], conflicts: [{ section: 'archive', key: 'A' }] });
});

test('createUserSources: off unless allowed, re-read when the file changes', (t) => {
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  const logs = [];
  const u = us.createUserSources({ settings, log: m => logs.push(m) });
  const file = path.join(dir, 'user.json');
  fs.copyFileSync(fixture('valid'), file);
  settings.save({ userSourcesFile: file });
  assert.equal(u.enabled(), false);
  assert.equal(u.entries().archive.length, 0);
  assert.equal(u.read().entries.archive.length, 2, 'Settings can still show the file');
  settings.save({ allowAdditionalSources: true });
  assert.equal(u.entries().archive.length, 2);
  fs.writeFileSync(file, '{"schemaVersion":1,"archive":[{"identifier":"one"}]}');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(u.entries().archive, [{ identifier: 'one' }]);
  settings.save({ userSourcesFile: path.join(dir, 'gone.json') });
  assert.match(u.read().error, /No file/);
  assert.match(logs.at(-1), /\[user\.json\] No file/);
});

test('checkPin: expected sha1 must match; else pin, keep, or stop on a change', (t) => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.deepEqual(us.checkPin({ file: 'f', expected: a.toUpperCase(), actual: a }), { ok: true });
  assert.match(us.checkPin({ file: 'f', expected: a, actual: b }).error, /doesn't match your source's sha1/);
  assert.deepEqual(us.checkPin({ file: 'f', pinned: null, actual: a }), { ok: true, pin: a });
  assert.deepEqual(us.checkPin({ file: 'f', pinned: a, actual: a }), { ok: true, pin: a });
  assert.deepEqual(us.checkPin({ file: 'f', pinned: a, actual: b }),
    { ok: false, error: 'f changed since you first installed it', changed: { file: 'f', before: a, after: b } });
  assert.deepEqual(us.checkPin({ file: 'f', pinned: a, actual: b, accept: true }), { ok: true, pin: b });

  const pins = us.createPins(path.join(tmpDir(t), 'pins.json'));
  assert.equal(pins.get('x', 'f'), null);
  pins.set('x', 'f', a);
  pins.set('x', 'g', b);
  assert.deepEqual([pins.get('x', 'f'), pins.get('x', 'g'), pins.get('y', 'f')], [a, b, null]);
});

test('a port from your own source pins its release binary per tag and stops when it changes', async (t) => {
  const state = { routes: {} };
  const fake = await fakeArchive(t, state);
  let tag = 'v1';
  let bin = makeZip({ 'tool.exe': 'MZ1' });
  state.routes['/repos/me/tool/releases'] = (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify([{ tag_name: tag, assets: [{ name: 'tool-windows.zip', browser_download_url: `${fake.base}/gh/tool-windows.zip` }] }]));
  };
  state.routes['/gh/tool-windows.zip'] = (req, res) => { res.writeHead(200, { 'content-length': bin.length }); res.end(bin); };
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ downloadPath: path.join(dir, 'dl'), installPath: path.join(dir, 'games') });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const pins = us.createPins(path.join(dir, 'pins.json'));
  const installs = createInstalls({ settings, library, archive: createArchive({ base: fake.base }), gamesDir: dir, githubApi: fake.base, pins });
  const item = { id: 'quiver:local:me/tool', title: 'My Tool', repository: 'me/tool', userSource: true, entry: { folderName: 'MyTool' }, data: null };
  const run = async (it, opts = {}) => { const r = installs.startPort({ item: it, ...opts }); await installs.wait(r.jobs[0].id); return installs.get(r.jobs[0].id); };

  assert.equal((await run(item)).status, 'done');
  assert.equal(pins.get('github:me/tool@v1', 'tool-windows.zip'), sha1(bin));
  bin = makeZip({ 'tool.exe': 'MZ2' });
  const changed = await run(item);
  assert.deepEqual([changed.status, changed.error], ['error', 'tool-windows.zip changed since you first installed it']);
  assert.deepEqual(changed.hashChange, { file: 'tool-windows.zip', before: pins.get('github:me/tool@v1', 'tool-windows.zip'), after: sha1(bin), itemId: item.id });
  assert.equal((await run(item, { acceptHashChange: true })).status, 'done');
  assert.equal(pins.get('github:me/tool@v1', 'tool-windows.zip'), sha1(bin));
  tag = 'v2';
  bin = makeZip({ 'tool.exe': 'MZ3' });
  assert.equal((await run(item)).status, 'done', 'a new release pins afresh');
  assert.equal((await run({ ...item, entry: { ...item.entry, sha1: 'c'.repeat(40) } })).error,
    `tool-windows.zip doesn't match your source's sha1 (sha1 ${sha1(bin)}, expected ${'c'.repeat(40)})`);
  assert.equal((await run({ ...item, userSource: false, entry: { ...item.entry, sha1: 'c'.repeat(40) } })).status, 'done', 'curated ports are not pinned');
});

// A backend with user.json at `file` and archive.org answering for its items
async function userApi(t, name) {
  const zip = makeZip({ 'game.exe': 'MZ' });
  const ctx = await testApi(t, { state: {
    metadata: {
      'my-homebrew': { title: 'Homebrew (archive.org title)', uploader: 'me@example.com' },
      'my-demo': { title: 'My Demo', uploader: 'me@example.com', date: '2024' },
    },
    files: { 'my-homebrew': [{ name: 'my-homebrew.zip', size: '9' }], 'my-demo': [{ name: 'my-demo.zip', size: '9' }] },
    zips: { 'my-homebrew/my-homebrew.zip': zip, 'my-demo/my-demo.zip': zip },
  } });
  const file = path.join(tmpDir(t), 'user.json');
  fs.copyFileSync(fixture(name), file);
  await ctx.call('PUT', '/settings', { userSourcesFile: file });
  return { ...ctx, file, zip };
}

test('API: off by default, the file is still checked, and turning it on shows your entries with their flag', async (t) => {
  const { call, backend } = await userApi(t, 'valid');
  const ids = async () => (await call('GET', '/items')).body.items.map(i => i.id);
  let us1 = (await call('GET', '/user-sources')).body;
  assert.deepEqual([us1.enabled, us1.error, us1.invalid, us1.entries, us1.conflicts], [false, null, [], { collisions: 1, archive: 2, github: 1 }, []]);
  assert.equal((await ids()).includes('my-demo'), false);
  assert.equal((await call('GET', '/catalogs/local/items')).status, 404);

  await call('PUT', '/settings', { allowAdditionalSources: true });
  const items = (await call('GET', '/items')).body.items;
  const demo = items.find(i => i.id === 'my-demo');
  assert.deepEqual([demo.title, demo.userSource, demo.versions[0].user, demo.source.label], ['My Demo', true, true, 'Your sources']);
  assert.equal(items.find(i => i.id === 'my-homebrew').title, 'My Homebrew', 'your title wins over archive.org');
  assert.equal(items.find(i => i.id === 'rk-e2e-halo-ce').userSource, false, 'curated cards never carry the flag');
  const ports = (await call('GET', '/catalogs/local/items')).body.items;
  assert.deepEqual(ports.map(p => [p.repository, p.userSource]).sort(), [['me/my-port', true], ['me/tool', true]]);
  assert.equal((await call('GET', `/collisions/${encodeURIComponent('me/tool')}`)).body.origin, 'user.json');

  // Off again: hidden, and nothing on disk is touched
  backend.library.recordInstall('my-demo', '/g/demo', null);
  await call('PUT', '/settings', { allowAdditionalSources: false });
  assert.equal((await ids()).includes('my-demo'), false);
  assert.equal(backend.library.all()['my-demo'].install_dir, '/g/demo');
  us1 = (await call('GET', '/user-sources')).body;
  assert.equal(us1.enabled, false);
});

test('API: uploaders not in the curated list load only with additional sources on', async (t) => {
  const { call, backend, fake } = await testApi(t);
  fake.search = { ...fake.search, 'friend@example.com': [{ identifier: 'friend-game', title: 'Friend Game' }] };
  backend.settings.save({ sources: [{ uploader: 'rohanjackson071@gmail.com' }, { uploader: 'friend@example.com' }] });
  const find = async () => (await call('GET', '/items?refresh=1')).body.items.find(i => i.id === 'friend-game');
  assert.equal(await find(), undefined);
  assert.ok(!fake.requests.some(r => r.includes('friend%40example.com')), 'never queried while off');
  await call('PUT', '/settings', { allowAdditionalSources: true });
  const friend = await find();
  assert.deepEqual([friend.userSource, friend.versions[0].user], [true, true]);
});

test('API: an invalid file lists each bad entry; a bad path or a URL is refused', async (t) => {
  const { call } = await userApi(t, 'invalid');
  const r = (await call('GET', '/user-sources')).body;
  assert.equal(r.invalid.length, 6);
  assert.deepEqual(r.entries, { collisions: 1, archive: 1, github: 0 });
  const refused = await call('PUT', '/settings', { userSourcesFile: 'https://example.com/user.json' });
  assert.deepEqual([refused.status, refused.body.detail], [400, 'user.json must be a file on this computer, not a URL']);
  assert.equal((await call('PUT', '/settings', { userSourcesFile: 'user.json' })).status, 400);
  assert.equal((await call('PUT', '/settings', { userSourcesFile: 5 })).status, 400);
  assert.equal((await call('PUT', '/settings', { allowAdditionalSources: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/settings', { userSourcesFile: '  ' })).body.userSourcesFile, null);
  assert.equal((await call('GET', '/user-sources')).body.file, null);
});

test('API: curated wins; a user entry for a curated repo or identifier is a conflict', async (t) => {
  const { call } = await userApi(t, 'conflicting');
  await call('PUT', '/settings', { allowAdditionalSources: true });
  const items = (await call('GET', '/items')).body.items;
  const halo = items.find(i => i.id === 'rk-e2e-halo-ce');
  assert.deepEqual([halo.title, halo.userSource, halo.versions.length], ['Halo: Combat Evolved', false, 1]);
  assert.equal(items.find(i => i.id === 'my-demo').userSource, true);
  const { conflicts } = (await call('GET', '/user-sources')).body;
  assert.deepEqual(conflicts.map(c => [c.from, c.key, c.reason]), [
    ['user.json collisions', 'BanjoRecomp/BanjoRecomp', 'the curated collisions have it'],
    ['user.json github', 'perfect-dark-pc-port/perfect_dark', 'the curated collisions have it'],
    ['user.json archive', 'rk-e2e-halo-ce', 'a curated uploader has it'],
  ]);
  assert.equal((await call('GET', `/collisions/${encodeURIComponent('BanjoRecomp/BanjoRecomp')}`)).body.origin, 'bundled');
  const put = await call('PUT', `/collisions/${encodeURIComponent('banjorecomp/banjorecomp')}`, { sources: [{ ia: 'x', path: 'a' }] });
  assert.deepEqual([put.status, put.body.error], [409, 'curated']);
});

test('API: installs from user.json check the sha1 given, else pin it and ask before a changed file', async (t) => {
  const { call, backend, fake, zip } = await userApi(t, 'valid');
  await call('PUT', '/settings', { allowAdditionalSources: true, installPath: path.join(backend.dataDir, 'games') });
  const install = async (id, extra = {}) => {
    const r = await call('POST', '/installs', { id, ...extra });
    assert.equal(r.status, 202);
    await backend.installs.wait(r.body.installs[0].id);
    return (await call('GET', `/installs/${r.body.installs[0].id}`)).body;
  };
  const wrong = await install('my-homebrew');
  assert.deepEqual([wrong.status, wrong.error], ['error', `my-homebrew.zip doesn't match your source's sha1 (sha1 ${sha1(zip)}, expected 0123456789abcdef0123456789abcdef01234567)`]);

  assert.equal((await install('my-demo')).status, 'done');
  const pins = JSON.parse(fs.readFileSync(path.join(backend.dataDir, 'pins.json'), 'utf8'));
  assert.deepEqual(pins, { 'archive:my-demo\nmy-demo.zip': sha1(zip) });
  const other = makeZip({ 'game.exe': 'MZ2' });
  fake.zips['my-demo/my-demo.zip'] = other;
  const changed = await install('my-demo');
  assert.deepEqual(changed.hashChange, { file: 'my-demo.zip', before: sha1(zip), after: sha1(other), itemId: 'my-demo' });
  assert.equal((await install('my-demo', { acceptHashChange: true })).status, 'done');
  assert.equal((await call('POST', '/installs', { id: 'my-demo', acceptHashChange: 'yes' })).status, 400);
  assert.equal((await install('rk-e2e-halo-ce')).status, 'done', 'curated uploads are not pinned');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(backend.dataDir, 'pins.json'), 'utf8'))), ['archive:my-demo\nmy-demo.zip']);
});
