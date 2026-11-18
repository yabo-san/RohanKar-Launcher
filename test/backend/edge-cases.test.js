'use strict';
// Installs whose upload changes under them: pulled from archive.org,
// reuploaded, or installed before titles were saved. Silent Hill 3 is the
// real case: installed from Rohan's pack, then pulled from archive.org.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { testBackend, testApi, makeZip, tmpDir, SEARCH } = require('./helpers');
const { buildExport } = require('../../src/backend/playnite');
const { withNewer } = require('../../src/backend/updates');

const ROHAN = 'rohanjackson071@gmail.com';
const sh3 = (identifier, addeddate) => ({ identifier, title: 'Silent Hill 3', addeddate, downloads: 10, subject: ['pc'] });
const searchWith = (...docs) => ({ ...structuredClone(SEARCH), [ROHAN]: [...SEARCH[ROHAN], ...docs] });

async function install(call, backend, body) {
  const r = await call('POST', '/installs', body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await backend.installs.wait(r.body.installs[0].id);
  return backend.installs.get(r.body.installs[0].id);
}

test('install saves the title and upload date with the entry', async (t) => {
  const { backend, call } = await testApi(t, { state: { search: searchWith(sh3('sh3-rohan', '2024-06-01T10:00:00Z')) } });
  await backend.items.load();
  const job = await install(call, backend, { id: 'sh3-rohan' });
  assert.equal(job.status, 'done');
  const row = backend.library.get('sh3-rohan');
  assert.equal(row.title, 'Silent Hill 3');
  assert.equal(row.upload_date, '2024-06-01T10:00:00Z');
  assert.equal(row.upload, null);
});

test('an upload pulled from archive.org stays installed as a local copy with its name', async (t) => {
  const { backend, call, fake } = await testApi(t, { state: { search: searchWith(sh3('sh3-rohan', '2024-06-01T10:00:00Z')) } });
  await backend.items.load();
  const job = await install(call, backend, { id: 'sh3-rohan' });

  // Pulled: the next load no longer has it
  fake.search = structuredClone(SEARCH);
  const { items } = await backend.items.list({ refresh: true });
  const card = items.find(i => i.id === 'sh3-rohan');
  assert.ok(card, 'the installed copy keeps a card');
  assert.equal(card.title, 'Silent Hill 3');
  assert.equal(card.installed, true);
  assert.equal(card.versions[0].local, true);
  assert.equal(card.versions[0].source.uploader, null);
  // In no pack: a source filter doesn't list it
  assert.equal((await backend.items.list({ source: ROHAN })).items.some(i => i.id === 'sh3-rohan'), false);
  // Still in the library and on disk
  assert.equal(backend.library.get('sh3-rohan').install_dir, job.installDir);
  assert.ok(fs.existsSync(job.installDir));

  // The Playnite export names it, though no item describes it
  const exported = await backend.exportPlaynite(undefined, { loadItems: false });
  const data = JSON.parse(fs.readFileSync(exported.file, 'utf8'));
  const game = data.games.find(g => g.id === 'sh3-rohan');
  assert.equal(game.name, 'Silent Hill 3');
  assert.equal(game.installed, true);
});

test('a reupload of an installed game is its update, not a second game', async (t) => {
  const { backend, call, fake } = await testApi(t, { state: { search: searchWith(sh3('sh3-old', '2024-06-01T10:00:00Z')) } });
  fake.zips['sh3-new/sh3-new.zip'] = makeZip({ 'Game/game.exe': 'MZ2', 'Game/v2.txt': 'new' });
  await backend.items.load();
  const first = await install(call, backend, { id: 'sh3-old' });
  backend.library.setFavorite('sh3-old', true);
  backend.library.markPlayed('sh3-old', 1234);
  fs.writeFileSync(path.join(first.installDir, 'save.dat'), 'progress');

  // The old upload is deleted and the game uploaded again under a new identifier
  fake.search = searchWith(sh3('sh3-new', '2025-03-01T10:00:00Z'));
  const { items } = await backend.items.list({ refresh: true });
  const cards = items.filter(i => i.title === 'Silent Hill 3');
  assert.equal(cards.length, 1, 'one card');
  const item = withNewer(cards[0]);
  assert.deepEqual(item.versions.map(v => v.id), ['sh3-new', 'sh3-old']);
  assert.equal(item.installed, true);
  assert.equal(item.versions.find(v => v.id === 'sh3-old').newer, 'sh3-new');

  // Update: unpacked over the same folder, same library entry
  const up = await install(call, backend, { id: 'sh3-new', into: 'sh3-old' });
  assert.equal(up.status, 'done');
  assert.equal(up.into, 'sh3-old');
  assert.equal(up.installDir, first.installDir);
  assert.equal(fs.readFileSync(path.join(first.installDir, 'Game', 'v2.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(first.installDir, 'save.dat'), 'utf8'), 'progress');
  assert.equal(backend.library.get('sh3-new'), null, 'no second entry');
  const row = backend.library.get('sh3-old');
  assert.deepEqual([row.install_dir, row.upload, row.upload_date, row.is_favorite, row.last_played_at],
    [first.installDir, 'sh3-new', '2025-03-01T10:00:00Z', 1, 1234]);

  // No update left to offer; the new upload shows where it's installed
  const after = withNewer((await backend.items.list()).items.find(i => i.title === 'Silent Hill 3'));
  assert.equal(after.versions.find(v => v.id === 'sh3-old').newer, null);
  assert.equal(after.versions.find(v => v.id === 'sh3-new').installedIn, 'sh3-old');

  // An even newer upload is offered again, measured from what's installed
  fake.search = searchWith(sh3('sh3-new', '2025-03-01T10:00:00Z'), sh3('sh3-newest', '2025-09-01T10:00:00Z'));
  const again = withNewer((await backend.items.list({ refresh: true })).items.find(i => i.title === 'Silent Hill 3'));
  assert.equal(again.versions.find(v => v.id === 'sh3-old').newer, 'sh3-newest');

  // Uninstall forgets the update with the folder
  backend.os.trashItem = async (p) => fs.rmSync(p, { recursive: true, force: true });
  assert.equal((await backend.uninstall('sh3-old')).ok, true);
  assert.equal(backend.library.get('sh3-old').upload, null);
});

test('an update needs an installed copy to go into', async (t) => {
  const { backend, call } = await testApi(t);
  await backend.items.load();
  const r = await call('POST', '/installs', { id: 'rk-e2e-halo-ce', into: 'not-installed' });
  assert.deepEqual([r.status, r.body.error], [409, 'not_installed']);
  assert.equal((await call('POST', '/installs', { id: 'rk-e2e-halo-ce', into: 5 })).status, 400);
});

test('a pulled copy only joins a card with the same title', async (t) => {
  const { backend } = await testBackend(t);
  // Different games that share words stay apart, as two uploads of them would
  backend.library.recordInstall('spidey-sd', '/g/sd', null, { title: 'Spider-Man: Shattered Dimensions' });
  backend.library.recordInstall('no-title', '/g/nt', null);
  const { items } = await backend.items.list();
  const spidey = items.find(i => i.id === 'rk-e2e-spider-man-2000');
  assert.deepEqual(spidey.versions.map(v => v.id), ['rk-e2e-spider-man-2000']);
  const sd = items.find(i => i.id === 'spidey-sd');
  assert.deepEqual([sd.title, sd.versions.length, sd.versions[0].local], ['Spider-Man: Shattered Dimensions', 1, true]);
  // No saved title: its own card under the identifier, as before
  assert.equal(items.find(i => i.id === 'no-title').title, 'no-title');
  // Ports and manual entries aren't archive.org copies
  backend.library.recordInstall('quiver:local:me/port', '/g/p', null);
  backend.library.add('man', 'manual');
  backend.library.adoptInstall('man', '/g/m', null);
  const ids = (await backend.items.list()).items.map(i => i.id);
  assert.ok(!ids.includes('quiver:local:me/port') && !ids.includes('man'));
});

test('installs from before titles were saved get them when the uploads load', async (t) => {
  const { backend } = await testBackend(t);
  // An old row: no title, no date
  backend.library.adoptInstall('rk-e2e-halo-ce', '/g/halo', null);
  backend.library.recordInstall('rk-e2e-the-sims', '/g/sims', null, { title: 'My Sims' });
  await backend.items.load();
  assert.equal(backend.library.get('rk-e2e-halo-ce').title, 'Halo: Combat Evolved');
  assert.equal(backend.library.get('rk-e2e-halo-ce').upload_date, '2024-04-12T10:00:00Z');
  // A saved name is kept; the missing date is filled
  assert.equal(backend.library.get('rk-e2e-the-sims').title, 'My Sims');
  assert.equal(backend.library.get('rk-e2e-the-sims').upload_date, '2025-07-04T10:00:00Z');
  assert.deepEqual(backend.library.backfill({}), { filled: 0 });
});

test('Find installs here saves the matched title', async (t) => {
  const { backend } = await testBackend(t);
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'Halo Combat Evolved'));
  fs.writeFileSync(path.join(dir, 'Halo Combat Evolved', 'halo.exe'), 'MZ');
  const r = await backend.scanInstalls(dir);
  assert.deepEqual(r.found.map(f => f.identifier), ['rk-e2e-halo-ce']);
  assert.equal(backend.library.get('rk-e2e-halo-ce').title, 'Halo: Combat Evolved');
});

test('the Playnite name falls back to the saved title before the last export', () => {
  const rows = { gone: { identifier: 'gone', install_dir: '/g/gone', title: 'Silent Hill 3' } };
  const previous = { games: [{ id: 'gone', name: 'gone' }] };
  assert.equal(buildExport({ rows, previous }).games[0].name, 'Silent Hill 3');
  assert.equal(buildExport({ rows: { x: { identifier: 'x' } }, previous: { games: [{ id: 'x', name: 'Old Name' }] } }).games[0].name, 'Old Name');
});
