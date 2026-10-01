'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { testBackend } = require('./helpers');

test('items: shipped sources grouped by title, overrides applied, library joined', async (t) => {
  const { backend, fake } = await testBackend(t);
  fake.routes['/overrides.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify({ 'rk-e2e-the-sims': { title: 'The Sims: Complete' } })); };
  backend.library.recordInstall('rk-e2e-zoo-tycoon-pstriple', '/g/zoo', null);

  const events = [];
  backend.events.on('event', e => events.push(e.type));
  const { items, errors } = await backend.items.list();
  assert.deepEqual(errors, []);
  assert.equal(items.length, 6);
  assert.deepEqual(events, ['items']);

  const zoo = items.find(i => i.id === 'rk-e2e-zoo-tycoon');
  assert.deepEqual(zoo.versions.map(v => v.source.label), ['rohanjackson071', 'hailstormttv']);
  assert.equal(zoo.installed, true);
  assert.equal(zoo.library.identifier, 'rk-e2e-zoo-tycoon-pstriple');
  assert.equal(zoo.shelf, 'wall');
  const sims = items.find(i => i.id === 'rk-e2e-the-sims');
  assert.equal(sims.title, 'The Sims: Complete');
  assert.equal(sims.originalTitle, 'The Sims');
  assert.deepEqual(sims.override, { title: 'The Sims: Complete' });

  // Platform from the archive.org subjects (every fixture says "pc")
  assert.equal(zoo.platform, 'PC');
  assert.deepEqual(zoo.versions.map(v => v.platform), ['PC', 'PC']);
  assert.equal((await backend.items.get('rk-e2e-zoo-tycoon-pstriple')).id, 'rk-e2e-zoo-tycoon');
  assert.equal(await backend.items.get('nope'), null);
  assert.equal(backend.items.loadedVersions().length, 7);
});

test('items: filters by source, shelf, search, installed, inLibrary', async (t) => {
  const { backend } = await testBackend(t);
  backend.library.recordInstall('rk-e2e-halo-ce', '/g/halo', null);
  backend.library.setFavorite('rk-e2e-the-sims', true);
  const ids = async (f) => (await backend.items.list(f)).items.map(i => i.id).sort();
  assert.deepEqual(await ids({ source: 'HAILSTORMTTV' }), ['rk-e2e-rollercoaster-tycoon', 'rk-e2e-zoo-tycoon']);
  assert.deepEqual(await ids({ source: 'spideymaster661@gmail.com' }), ['rk-e2e-spider-man-2000', 'rk-e2e-the-sims']);
  assert.deepEqual(await ids({ search: 'tycoon' }), ['rk-e2e-rollercoaster-tycoon', 'rk-e2e-zoo-tycoon']);
  assert.deepEqual(await ids({ search: 'v1.0' }), ['rk-e2e-zoo-tycoon']);
  assert.deepEqual(await ids({ installed: 'true' }), ['rk-e2e-halo-ce']);
  assert.equal((await ids({ installed: 'false' })).length, 5);
  assert.deepEqual(await ids({ inLibrary: '1' }), ['rk-e2e-halo-ce', 'rk-e2e-the-sims']);
  assert.equal((await ids({ inLibrary: 'false' })).length, 4);
  assert.equal((await ids({ shelf: 'WALL' })).length, 6);
  assert.deepEqual(await ids({ shelf: 'Nintendo' }), []);
  assert.equal((await ids({ installed: '' })).length, 6);
});

test('items: a disabled source is never queried; one failing source is reported, all failing throws', async (t) => {
  const { backend, fake } = await testBackend(t);
  backend.settings.save({ allowAdditionalSources: true, sources: [
    { uploader: 'rohanjackson071@gmail.com', label: 'rj' },
    { uploader: 'frankiemiqueli1@gmail.com', label: 'ps', enabled: false },
    { uploader: 'nobody@example.invalid', label: 'nobody' },
  ] });
  const { items, errors } = await backend.items.list();
  assert.equal(items.length, 3);
  assert.deepEqual(errors, [{ source: 'nobody@example.invalid', label: 'nobody', error: 'HTTP 404' }]);
  assert.ok(!fake.requests.some(r => r.includes('frankiemiqueli1')));

  backend.settings.save({ sources: [{ uploader: 'nobody@example.invalid' }] });
  await assert.rejects(backend.items.list({ refresh: 'true' }), (e) => e.errors.length === 1);
});

test('items: loads once and shares an in-flight load; refresh refetches', async (t) => {
  const { backend, fake } = await testBackend(t);
  const searches = () => fake.requests.filter(r => r.startsWith('/advancedsearch')).length;
  await Promise.all([backend.items.list(), backend.items.list()]);
  assert.equal(searches(), 3);
  await backend.items.list();
  assert.equal(searches(), 3);
  await backend.items.list({ refresh: true });
  assert.equal(searches(), 6);
});

test('items: catalog entries sit on their shelf next to the wall', async (t) => {
  const { backend, fake } = await testBackend(t);
  fake.routes['/ps.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ name: 'SM64 PC', repository: 'x/sm64' }])); };
  const { catalog } = await backend.catalogs.subscribe({ url: `${fake.base}/ps.json`, name: 'PlayStation' });
  const shelf = (await backend.items.list({ shelf: 'playstation' })).items;
  assert.equal(shelf.length, 1);
  assert.deepEqual(shelf[0].versions, []);
  assert.equal(shelf[0].installed, false);
  assert.equal((await backend.items.list({ source: catalog.id })).items.length, 1);
  backend.library.add(shelf[0].id, catalog.url);
  assert.equal((await backend.items.get(shelf[0].id)).library.source, catalog.url);
});

test('items: platform from the subjects, PC when they name none', async (t) => {
  const { backend, fake } = await testBackend(t);
  const subjects = { 'rk-e2e-zoo-tycoon': ['PlayStation 2', 'tycoon'], 'rk-e2e-halo-ce': 'xbox;shooter', 'rk-e2e-age-of-empires-2': null };
  fake.search = Object.fromEntries(Object.entries(fake.search).map(([who, docs]) =>
    [who, docs.map(d => (d.identifier in subjects ? { ...d, subject: subjects[d.identifier] } : d))]));
  const { items } = await backend.items.list();
  const platform = (id) => items.find(i => i.id === id).platform;
  assert.equal(platform('rk-e2e-zoo-tycoon'), 'PlayStation');
  assert.equal(platform('rk-e2e-halo-ce'), 'Xbox');
  assert.equal(platform('rk-e2e-age-of-empires-2'), 'PC');
});
