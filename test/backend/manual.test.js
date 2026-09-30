'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createManualApp, INSTRUCTIONS_FILE } = require('../../src/backend/manual');
const { parseAnnouncement, currentAnnouncement } = require('../../src/backend/announcement');
const { findExes } = require('../../src/backend/disk');
const { createLibrary } = require('../../src/backend/library');
const { tmpDir, testApi } = require('./helpers');

const openLibrary = (t) => {
  const lib = createLibrary({ dbPath: path.join(tmpDir(t), 'library.db'), log: () => {} });
  t.after(() => lib.close());
  return lib;
};

test('manual app: a new folder with instructions, then files make it launchable', (t) => {
  const root = tmpDir(t);
  const library = openLibrary(t);
  const r = createManualApp({ name: '  Homebrew: Thing  ', root, library, findExes });
  assert.deepEqual(r, { ok: true, id: 'manual:Homebrew_ Thing' });
  const dir = path.join(root, 'Homebrew_ Thing');
  const row = library.get(r.id);
  assert.deepEqual([row.title, row.source, row.install_dir, row.exe_path], ['Homebrew: Thing', 'manual', dir, null]);
  assert.match(fs.readFileSync(path.join(dir, INSTRUCTIONS_FILE), 'utf8'), /put its files in this folder/);

  assert.deepEqual(createManualApp({ name: 'Homebrew: Thing', root, library, findExes }).code, 'exists');
  assert.equal(createManualApp({ name: '  ', root, library, findExes }).code, 'bad_request');
  assert.equal(createManualApp({ name: 'X', folder: path.join(root, 'nope'), root, library, findExes }).code, 'no_folder');
});

test('manual app: an existing folder with one exe is used as is, no instructions', (t) => {
  const root = tmpDir(t);
  const library = openLibrary(t);
  const folder = path.join(tmpDir(t), 'Already Here');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'game.exe'), 'MZ');
  const r = createManualApp({ name: 'Already Here', folder, root, library, findExes });
  assert.equal(r.id, 'manual:Already Here');
  assert.deepEqual([library.get(r.id).install_dir, library.get(r.id).exe_path], [folder, path.join(folder, 'game.exe')]);
  assert.equal(fs.existsSync(path.join(folder, INSTRUCTIONS_FILE)), false);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing made in the install folder');

  library.close();
  assert.equal(createManualApp({ name: 'Other', root, library, findExes }).code, 'library_unavailable');
});

test('announcement: Quiver shape, case-insensitive keys, disabled or incomplete is nothing', () => {
  assert.deepEqual(parseAnnouncement('{"id":"a","enabled":true,"message":"Hi"}'), { id: 'a', message: 'Hi' });
  assert.deepEqual(parseAnnouncement('{"Id":"a","Message":"Hi","Link":"https://x.test/r"}'), { id: 'a', message: 'Hi', link: 'https://x.test/r' });
  assert.deepEqual(parseAnnouncement('{"id":"a","message":"Hi","link":"javascript:alert(1)"}'), { id: 'a', message: 'Hi' }, 'only https links');
  for (const text of ['{"id":"a","enabled":false,"message":"Hi"}', '{"id":"","message":"Hi"}', '{"id":"a"}', '[]', 'null', 'nope']) {
    assert.equal(parseAnnouncement(text), null, text);
  }
});

test('announcement: dismissed ids are skipped; a failed fetch is no announcement', async () => {
  const fetchText = async () => '{"id":"Launch-1","message":"Hi"}';
  assert.equal((await currentAnnouncement({ fetchText })).id, 'Launch-1');
  assert.equal(await currentAnnouncement({ fetchText, dismissed: ['launch-1'] }), null);
  assert.equal((await currentAnnouncement({ fetchText, dismissed: 'garbage' })).id, 'Launch-1');
  assert.equal(await currentAnnouncement({ fetchText: async () => { throw new Error('offline'); } }), null);
});

test('API: POST /library/manual, rename; GET /announcement and dismiss', async (t) => {
  const { call, fake, backend } = await testApi(t);
  const root = path.join(backend.dataDir, 'mine');
  backend.settings.save({ installPath: root });

  assert.equal((await call('POST', '/library/manual', {})).status, 400);
  assert.equal((await call('POST', '/library/manual', { name: 'A', folder: 7 })).status, 400);
  assert.equal((await call('POST', '/library/manual', { name: 'A', folder: path.join(root, 'none') })).status, 422);
  const made = await call('POST', '/library/manual', { name: 'Homebrew Thing', folder: null });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.identifier, made.body.install_dir, made.body.title], ['manual:Homebrew Thing', path.join(root, 'Homebrew Thing'), 'Homebrew Thing']);
  assert.equal((await call('POST', '/library/manual', { name: 'Homebrew Thing' })).status, 409);

  const renamed = await call('PATCH', `/library/${encodeURIComponent('manual:Homebrew Thing')}`, { title: ' Better Name ' });
  assert.equal(renamed.body.title, 'Better Name');
  assert.equal((await call('PATCH', `/library/${encodeURIComponent('manual:Homebrew Thing')}`, { title: '' })).status, 400);

  // Announcements: none while the fetch fails, then one until dismissed
  assert.deepEqual((await call('GET', '/announcement')).body, { announcement: null });
  fake.routes['/announcement.json'] = (req, res) => { res.writeHead(200); res.end('{"id":"hello-1","enabled":true,"message":"Hello"}'); };
  assert.deepEqual((await call('GET', '/announcement')).body, { announcement: { id: 'hello-1', message: 'Hello' } });
  assert.equal((await call('POST', '/announcement/dismiss', {})).status, 400);
  assert.equal((await call('POST', '/announcement/dismiss', { id: 'hello-1' })).status, 204);
  assert.equal((await call('POST', '/announcement/dismiss', { id: 'HELLO-1' })).status, 204);
  assert.deepEqual(backend.settings.load().dismissedAnnouncements, ['hello-1'], 'dismissed once');
  assert.deepEqual((await call('GET', '/announcement')).body, { announcement: null });

  backend.library.close();
  assert.equal((await call('POST', '/library/manual', { name: 'Late' })).status, 503);
});
