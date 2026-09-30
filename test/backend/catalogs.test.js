'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createCatalogs, parseCatalog, parseCollisions, diffEntries, entryKey } = require('../../src/backend/catalogs');
const { createSettings } = require('../../src/backend/settings');
const { fakeArchive, tmpDir } = require('./helpers');

// Cut from catalog/collisions.json
const COLLISIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../catalog/collisions.json'), 'utf8')).slice(0, 2);

async function setup(t, { collisions = COLLISIONS } = {}) {
  const catalog = { apps: [
    { name: 'Banjo Recomp', repository: 'BanjoRecomp/BanjoRecomp', appIconUrl: 'https://i/b.png', tags: ['n64'] },
    { name: 'Ship of Harkinian', repository: 'HarbourMasters/Shipwright' },
  ] };
  const fake = await fakeArchive(t, {
    routes: {
      '/nintendo.json': (req, res) => { res.writeHead(200); res.end(JSON.stringify(catalog)); },
      '/broken.json':   (req, res) => { res.writeHead(200); res.end('{"nope": 1}'); },
    },
  });
  const dir = tmpDir(t);
  const collisionsFile = path.join(dir, 'collisions.json');
  fs.writeFileSync(collisionsFile, JSON.stringify(collisions));
  const settings = createSettings(path.join(dir, 'settings.json'));
  const netLog = [];
  const catalogs = createCatalogs({ dir: path.join(dir, 'catalogs'), settings, collisionsFile, netLog: (...a) => netLog.push(a) });
  return { fake, dir, settings, catalogs, catalog, netLog };
}

test('items: a collision\'s exe and keepReleaseFolder reach the install', async (t) => {
  const { fake, catalogs } = await setup(t, { collisions: [{ ...COLLISIONS[0], exe: 'bin/game.exe', keepReleaseFolder: true }, COLLISIONS[1]] });
  await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });
  const banjo = catalogs.items().find(i => i.title === 'Banjo Recomp');
  assert.deepEqual([banjo.data.exe, banjo.data.keepReleaseFolder], ['bin/game.exe', true]);
});

test('parse: apps wrapper or bare array; collisions as array or keyed object', () => {
  assert.equal(parseCatalog('[{"name":"a"},{"x":1},null]').length, 1);
  assert.equal(parseCatalog('{"apps":[{"repository":"a/b"}]}').length, 1);
  assert.throws(() => parseCatalog('{"x":[]}'), /array/);
  const keyed = parseCollisions(JSON.stringify({ _comment: 'x', 'Owner/Repo': { iaIdentifier: 'i' } }));
  assert.deepEqual([...keyed.keys()], ['owner/repo']);
  assert.equal(parseCollisions('[{"repository":"  A/B "},{"name":"no repo"}]').size, 1);
  assert.equal(entryKey({ repository: 'A/B' }), 'a/b');
  assert.equal(entryKey({ name: 'N' }), 'name:N');
});

test('diffEntries: new, changed, removed by repository', () => {
  const d = diffEntries(
    [{ repository: 'a/a', v: 1 }, { repository: 'b/b', v: 1 }, { name: 'gone' }],
    [{ repository: 'A/A', v: 2 }, { repository: 'b/b', v: 1 }, { name: 'fresh' }]);
  assert.deepEqual(d.new.map(e => e.name), ['fresh']);
  assert.deepEqual(d.changed.map(e => e.v), [2]);
  assert.deepEqual(d.removed.map(e => e.name), ['gone']);
});

test('subscribe: fetches, caches, logs, and is idempotent per URL', async (t) => {
  const { fake, catalogs, settings, netLog } = await setup(t);
  const url = `${fake.base}/nintendo.json`;
  const r = await catalogs.subscribe({ url, shelf: 'Nintendo' });
  assert.equal(r.created, true);
  assert.equal(r.catalog.entries, 2);
  assert.equal(r.catalog.name, 'nintendo');
  assert.equal(r.catalog.shelf, 'Nintendo');
  assert.equal(netLog[0][0], 'catalog');
  const again = await catalogs.subscribe({ url });
  assert.equal(again.created, false);
  assert.equal(settings.load().catalogs.length, 1);
  assert.deepEqual(catalogs.review(r.catalog.id), { new: [], changed: [], removed: [] });
  assert.equal((await catalogs.subscribe({ url: 'ftp://x/y.json' })).error, 'bad_url');
  assert.equal((await catalogs.subscribe({ url: 'not a url' })).error, 'bad_url');
});

test('refresh and review: changes since last seen; a failed fetch keeps the last copy', async (t) => {
  const { fake, catalogs, catalog } = await setup(t);
  const { catalog: sub } = await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });
  catalog.apps[0].tags = ['n64', 'recomp'];
  catalog.apps.pop();
  catalog.apps.push({ name: '2Ship2Harkinian', repository: 'HarbourMasters/2ship2harkinian' });
  await catalogs.refresh(sub.id);
  const review = catalogs.review(sub.id);
  assert.deepEqual([review.new.length, review.changed.length, review.removed.length], [1, 1, 1]);
  assert.equal(catalogs.markSeen(sub.id), true);
  assert.deepEqual(catalogs.review(sub.id), { new: [], changed: [], removed: [] });

  fake.routes['/nintendo.json'] = (req, res) => { res.writeHead(503); res.end(); };
  const failed = await catalogs.refresh(sub.id);
  assert.equal(failed.error, 'HTTP 503');
  assert.equal(failed.entries, 2);
  assert.equal(catalogs.list()[0].error, 'HTTP 503');
  assert.equal(await catalogs.refresh('nope'), null);
  assert.equal(catalogs.review('nope'), null);
  assert.equal(catalogs.markSeen('nope'), false);
  assert.equal(catalogs.get('nope'), null);
});

test('a catalog that is not a catalog is an error with no entries', async (t) => {
  const { fake, catalogs } = await setup(t);
  const r = await catalogs.subscribe({ url: `${fake.base}/broken.json` });
  assert.match(r.catalog.error, /array/);
  assert.equal(r.catalog.entries, 0);
  const down = await catalogs.subscribe({ url: 'http://127.0.0.1:1/x.json' });
  assert.ok(down.catalog.error);
});

test('items: one per entry, joined to collisions on repository only', async (t) => {
  const { fake, catalogs } = await setup(t);
  assert.deepEqual(catalogs.items(), []);
  const { catalog: sub } = await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });
  const items = catalogs.items();
  assert.equal(items.length, 2);
  const banjo = items.find(i => i.title === 'Banjo Recomp');
  assert.equal(banjo.id, `quiver:${sub.id}:banjorecomp/banjorecomp`);
  assert.equal(banjo.shelf, 'Nintendo');
  assert.equal(banjo.icon, 'https://i/b.png');
  assert.equal(banjo.data.iaIdentifier, COLLISIONS[0].iaIdentifier);
  assert.equal(banjo.data.dataFiles[0].sha1, COLLISIONS[0].dataFiles[0].sha1);
  assert.equal(items.find(i => i.title === 'Ship of Harkinian').data, null);
  assert.equal(catalogs.unsubscribe(sub.id), true);
  assert.equal(catalogs.unsubscribe(sub.id), false);
  assert.deepEqual(catalogs.list(), []);
});

test('an unreadable collisions file joins nothing', async (t) => {
  const { fake, dir, settings } = await setup(t);
  const logs = [];
  const catalogs = createCatalogs({ dir: path.join(dir, 'c2'), settings, collisionsFile: path.join(dir, 'missing.json'), log: m => logs.push(m) });
  await catalogs.subscribe({ url: `${fake.base}/nintendo.json` });
  assert.ok(catalogs.items().every(i => i.data === null));
  assert.match(logs[0], /collisions unreadable/);
  const none = createCatalogs({ dir: path.join(dir, 'c3'), settings });
  assert.ok(none.items().every(i => i.data === null));
});

test('every collision joins a catalog entry on repository', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../catalog', f), 'utf8'));
  const catalog = read('catalog.json');
  const repos = new Set((catalog.apps || catalog).map(e => entryKey({ repository: e.repository })));
  const orphans = read('collisions.json').filter(c => !repos.has(entryKey({ repository: c.repository })));
  assert.deepEqual(orphans.map(c => c.repository), []);
});

test('curated collisions win over your own, which need additional sources and fill a Your ports shelf', async (t) => {
  const { fake, catalogs, settings } = await setup(t);
  const { catalog: sub } = await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });
  assert.equal(catalogs.collision('banjorecomp/banjorecomp').origin, 'bundled');

  // A bundled repository can't be overridden: curated wins
  const mine = { repository: 'BanjoRecomp/BanjoRecomp', base: 'data', binaryTarget: 'bin', sources: [{ ia: 'banjo-full', path: 'Banjo.zip', extract: true }] };
  const refused = catalogs.saveCollision(mine);
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0], /curated collisions/);
  assert.equal(catalogs.isCurated('banjorecomp/BANJORECOMP'), true);
  assert.equal(catalogs.items().find(i => i.repository === 'BanjoRecomp/BanjoRecomp').userSource, false);

  // Your own for a repo a shelf lists binds its data, but only with additional sources on
  assert.equal(catalogs.saveCollision({ repository: 'HarbourMasters/Shipwright', sources: [{ ia: 'soh-data', path: 'oot.z64' }] }).ok, true);
  assert.equal(catalogs.collision('harbourmasters/shipwright'), null);
  assert.equal(catalogs.items().find(i => i.repository === 'HarbourMasters/Shipwright').data, null);
  settings.save({ allowAdditionalSources: true });
  assert.equal(catalogs.collision('harbourmasters/shipwright').origin, 'local');
  const soh = catalogs.items().find(i => i.repository === 'HarbourMasters/Shipwright');
  assert.deepEqual([soh.data.iaIdentifier, soh.userSource], ['soh-data', true]);
  assert.equal(catalogs.list().length, 1, 'a repo a catalog lists makes no shelf of its own');

  // A repository no catalog lists becomes a port on "Your ports"
  assert.equal(catalogs.saveCollision({ repository: 'me/port', name: 'My Port', folderName: 'MyPort', sources: [{ ia: 'my-data', path: 'roms/*', target: 'roms' }] }).ok, true);
  const shelf = catalogs.list().find(c => c.id === 'local');
  assert.deepEqual([shelf.name, shelf.entries, shelf.url], ['Your ports', 1, null]);
  const port = catalogs.items().find(i => i.id === 'quiver:local:me/port');
  assert.deepEqual([port.title, port.shelf, port.entry.folderName, port.data.sources[0].target], ['My Port', 'Your ports', 'MyPort', 'roms']);
  assert.deepEqual(catalogs.review('local'), { new: [], changed: [], removed: [] });
  assert.equal(catalogs.markSeen('local'), true);
  assert.equal(catalogs.unsubscribe('local'), false);
  assert.equal((await catalogs.refresh('local')).entries, 1);

  // Bad entries are refused with every problem named; deletes are per repository
  const bad = catalogs.saveCollision({ repository: 'nope', base: 'up', sources: [{ ia: 'a b', path: '../x', sha1: 'zz', target: '/abs' }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    'repository must be owner/repo', 'base must be "binary" or "data"', 'sources[0].ia must be an archive.org identifier',
    'sources[0].path must be a file, folder/* or * in the item', 'sources[0].target must be a relative folder', 'sources[0].sha1 must be 40 hex characters',
  ]);
  assert.equal(catalogs.deleteCollision('ME/port'), true);
  assert.equal(catalogs.deleteCollision('me/port'), false);
  assert.equal(catalogs.list().some(c => c.id === 'local'), false);
  assert.equal(catalogs.unsubscribe(sub.id), true);
});
