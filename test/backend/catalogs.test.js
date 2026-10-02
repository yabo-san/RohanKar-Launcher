'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createCatalogs, parseCatalog, diffEntries, entryKey } = require('../../src/backend/catalogs');
const { createSettings } = require('../../src/backend/settings');
const { fakeArchive, tmpDir } = require('./helpers');

// The curated shelf on a fake GitHub (curated.json on main), its bundled copy
// on disk, and the library's ids for old subscriptions
async function setup(t, { userSources, bundledApps = [{ name: 'Bundled', repository: 'a/bundled', tags: ['source only'] }] } = {}) {
  const catalog = { apps: [
    { name: 'Banjo Recomp', repository: 'BanjoRecomp/BanjoRecomp', appIconUrl: 'https://i/b.png', tags: ['n64'] },
    { name: 'Ship of Harkinian', repository: 'HarbourMasters/Shipwright' },
  ] };
  const fake = await fakeArchive(t, {
    routes: { '/curated.json': (req, res) => { res.writeHead(200); res.end(JSON.stringify(catalog)); } },
  });
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  const curatedFile = path.join(dir, 'bundled-curated.json');
  fs.writeFileSync(curatedFile, JSON.stringify({ apps: bundledApps }));
  const library = new Set();
  const netLog = [];
  const catalogs = createCatalogs({
    dir: path.join(dir, 'catalogs'), settings, ...(userSources ? { userSources } : {}),
    curatedUrl: `${fake.base}/curated.json`, curatedFile, libraryIds: () => library, netLog: (...a) => netLog.push(a),
  });
  return { fake, dir, settings, catalogs, catalog, library, netLog };
}

test('parse: apps wrapper or bare array', () => {
  assert.equal(parseCatalog('[{"name":"a"},{"x":1},null]').length, 1);
  assert.equal(parseCatalog('{"apps":[{"repository":"a/b"}]}').length, 1);
  assert.throws(() => parseCatalog('{"x":[]}'), /array/);
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

test('curated: the only shelf, from the bundled copy until a fetch lands, then cached', async (t) => {
  const { catalogs, fake, catalog, netLog } = await setup(t);
  const first = catalogs.list();
  assert.deepEqual(first.map(c => [c.id, c.shelf, c.entries, c.bundled]), [['curated', 'Curated', 1, true]]);
  assert.deepEqual(catalogs.items().map(i => [i.title, i.curated]), [['Bundled', true]]);
  assert.deepEqual(catalogs.review('curated'), { new: [], changed: [], removed: [] }, 'nothing to review before a fetch');

  await catalogs.warm();
  assert.equal(netLog[0][0], 'catalog');
  assert.deepEqual(catalogs.items().map(i => i.title), ['Banjo Recomp', 'Ship of Harkinian']);
  assert.equal(catalogs.list()[0].bundled, undefined, 'a fetched copy');
  assert.deepEqual(catalogs.review('curated'), { new: [], changed: [], removed: [] }, 'the first copy counts as reviewed');

  let fetches = 0;
  fake.routes['/curated.json'] = (req, res) => { fetches++; res.writeHead(200); res.end(JSON.stringify(catalog)); };
  await catalogs.warm();
  assert.equal(fetches, 0, 'warm only fetches a shelf never fetched');

  catalog.apps[0].tags = ['n64', 'recomp'];
  catalog.apps.pop();
  catalog.apps.push({ name: '2Ship2Harkinian', repository: 'HarbourMasters/2ship2harkinian' });
  await catalogs.refresh('curated');
  const review = catalogs.review('curated');
  assert.deepEqual([review.new.length, review.changed.length, review.removed.length], [1, 1, 1]);
  assert.equal(catalogs.markSeen('curated'), true);
  assert.deepEqual(catalogs.review('curated'), { new: [], changed: [], removed: [] });

  fake.routes['/curated.json'] = (req, res) => { res.writeHead(503); res.end(); };
  const failed = await catalogs.refresh('curated');
  assert.deepEqual([failed.entries, failed.error], [2, 'HTTP 503'], 'a failed fetch keeps the cached copy');
  assert.equal(await catalogs.refresh('nope'), null);
  assert.equal(catalogs.review('nope'), null);
  assert.equal(catalogs.markSeen('nope'), false);
});

test('curated: offline on a first run, the bundled copy stands and is cached with the error', async (t) => {
  const { catalogs, fake } = await setup(t);
  fake.routes['/curated.json'] = (req, res) => { res.writeHead(404); res.end(); };
  await catalogs.warm();
  const [shelf] = catalogs.list();
  assert.deepEqual([shelf.entries, shelf.error, shelf.bundled], [1, 'HTTP 404', true]);
  assert.deepEqual(catalogs.items().map(i => i.title), ['Bundled']);
});

test('curated: a catalog that is not a catalog is an error, and an unreadable bundled copy an empty shelf', async (t) => {
  const { catalogs, fake } = await setup(t);
  fake.routes['/curated.json'] = (req, res) => { res.writeHead(200); res.end('{"nope": 1}'); };
  assert.match((await catalogs.refresh('curated')).error, /array/);

  const { dir, settings } = await setup(t);
  const logs = [];
  const none = createCatalogs({ dir: path.join(dir, 'c2'), settings, curatedUrl: 'http://127.0.0.1:1/c.json', curatedFile: path.join(dir, 'missing.json'), log: m => logs.push(m) });
  assert.equal(none.list()[0].entries, 0);
  assert.match(logs[0], /bundled curated ports unreadable/);
  assert.deepEqual(createCatalogs({ dir: path.join(dir, 'c3'), settings }).list(), [], 'no curated shelf without a URL');
});

test('items: one per entry, a port binary with no game data, marked curated', async (t) => {
  const { catalogs } = await setup(t);
  await catalogs.warm();
  const banjo = catalogs.items().find(i => i.title === 'Banjo Recomp');
  assert.equal(banjo.id, 'quiver:curated:banjorecomp/banjorecomp');
  assert.deepEqual([banjo.shelf, banjo.icon, banjo.userSource, banjo.curated, 'data' in banjo], ['Curated', 'https://i/b.png', false, true, false]);
  assert.deepEqual([banjo.sourceOnly, banjo.workInProgress, banjo.role, banjo.repositoryUrl], [false, false, null, 'https://github.com/BanjoRecomp/BanjoRecomp']);
});

test('More ports: entries marked "more" show only with the setting on, or once the library holds one', async (t) => {
  const { catalogs, fake, catalog, settings, library } = await setup(t);
  catalog.apps.push({ name: 'BFBB', repository: 'bfbbdecomp/bfbb', more: true }, { name: 'SA2', repository: 'x/sa2', more: true });
  fake.routes['/curated.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify(catalog)); };
  await catalogs.refresh('curated');
  assert.equal(catalogs.morePorts(), false);
  assert.deepEqual(catalogs.items().map(i => i.title), ['Banjo Recomp', 'Ship of Harkinian']);
  assert.equal(catalogs.list()[0].entries, 2);

  library.add('quiver:curated:x/sa2');
  assert.deepEqual(catalogs.items().map(i => i.title), ['Banjo Recomp', 'Ship of Harkinian', 'SA2'], 'an installed one stays');

  settings.save({ morePorts: true });
  assert.deepEqual(catalogs.items().map(i => i.title), ['Banjo Recomp', 'Ship of Harkinian', 'BFBB', 'SA2']);
  assert.equal(catalogs.list()[0].entries, 4);
});

test('an old subscription is never fetched and lists only the ports the library holds from it', async (t) => {
  const { catalogs, settings, dir, library } = await setup(t);
  // An install from before the shelf became curated-only: Quiver's Nintendo list, subscribed and cached
  settings.save({ catalogs: [{ id: 'oldnintendo', url: 'https://quiver/Nintendo.json', name: 'Nintendo', shelf: 'Nintendo' }] });
  fs.writeFileSync(path.join(dir, 'catalogs', 'oldnintendo.cache.json'), JSON.stringify({ fetchedAt: 1, entries: [
    { name: 'Mario Kart 64', repository: 'harbourmasters/mk64' }, { name: 'Untested', repository: 'ai/port' },
  ], error: null }));
  assert.deepEqual(catalogs.list().map(c => c.id), ['curated'], 'nothing held: not a shelf');

  library.add('quiver:oldnintendo:harbourmasters/mk64');
  assert.deepEqual(catalogs.list().map(c => [c.shelf, c.entries, c.legacy]), [['Curated', 1, undefined], ['Nintendo', 1, true]]);
  const mk = catalogs.items().find(i => i.shelf === 'Nintendo');
  assert.deepEqual([mk.id, mk.title, mk.curated], ['quiver:oldnintendo:harbourmasters/mk64', 'Mario Kart 64', false]);
  assert.equal((await catalogs.refresh('oldnintendo')).fetchedAt, 1, 'not fetched');
  assert.deepEqual(catalogs.review('oldnintendo'), { new: [], changed: [], removed: [] });
  assert.equal(catalogs.markSeen('oldnintendo'), true);
});

test('your repos need additional sources and fill a Your ports shelf, unless the curated shelf lists the repo', async (t) => {
  const { catalogs, settings } = await setup(t);
  await catalogs.warm();

  assert.equal(catalogs.addRepo({ repository: 'me/port', name: 'My Port', folderName: 'MyPort', releaseAssetFilter: 'win', sources: [{ ia: 'x' }] }).ok, true);
  assert.equal(catalogs.addRepo({ repository: 'HarbourMasters/Shipwright', name: 'Mine' }).ok, true);
  assert.deepEqual(catalogs.localRepos().map(r => r.repository), ['me/port', 'HarbourMasters/Shipwright']);
  assert.equal(catalogs.list().some(c => c.id === 'local'), false, 'off until additional sources are allowed');

  settings.save({ allowAdditionalSources: true });
  const shelf = catalogs.list().find(c => c.id === 'local');
  assert.deepEqual([shelf.name, shelf.entries, shelf.url], ['Your ports', 1, null]);
  const port = catalogs.items().find(i => i.id === 'quiver:local:me/port');
  assert.deepEqual([port.title, port.shelf, port.entry.folderName, port.entry.releaseAssetFilter, port.userSource, port.curated], ['My Port', 'Your ports', 'MyPort', 'win', true, false]);
  assert.equal('sources' in port.entry, false);
  const soh = catalogs.items().filter(i => i.repository?.toLowerCase() === 'harbourmasters/shipwright');
  assert.deepEqual(soh.map(i => [i.shelf, i.userSource]), [['Curated', false]], 'a repo the curated shelf lists stays the shelf\'s');
  assert.deepEqual(catalogs.review('local'), { new: [], changed: [], removed: [] });
  assert.equal(catalogs.markSeen('local'), true);
  assert.equal((await catalogs.refresh('local')).entries, 1);

  assert.deepEqual(catalogs.addRepo({ repository: 'nope', name: 3 }).errors, ['repository must be owner/repo', 'name must be a string']);
  assert.equal(catalogs.removeRepo('ME/port'), true);
  assert.equal(catalogs.removeRepo('me/port'), false);
  assert.equal(catalogs.list().some(c => c.id === 'local'), false);
});

test('user.json github entries join Your ports; one the curated shelf lists is a conflict', async (t) => {
  const github = [{ repository: 'me/tool', assetPattern: '(?i)win64', sha1: 'A'.repeat(40) }, { repository: 'BanjoRecomp/BanjoRecomp' }];
  const { catalogs, settings } = await setup(t, { userSources: { entries: () => ({ archive: [], github }) } });
  await catalogs.warm();
  settings.save({ allowAdditionalSources: true });
  const tool = catalogs.items().find(i => i.repository === 'me/tool');
  assert.deepEqual([tool.title, tool.entry.assetPattern, tool.entry.sha1], ['tool', '(?i)win64', 'a'.repeat(40)]);
  assert.deepEqual(catalogs.userConflicts(), [{ from: 'user.json github', key: 'BanjoRecomp/BanjoRecomp', reason: 'a port shelf lists it' }]);
});

test('a repos list from before collisions were parked carries over once, repo fields only', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'catalogs'));
  fs.writeFileSync(path.join(dir, 'catalogs', 'collisions.local.json'), JSON.stringify([
    { repository: 'me/port', name: 'My Port', base: 'data', sources: [{ ia: 'x', path: 'y' }] }, { name: 'no repo' },
  ]));
  const logs = [];
  const catalogs = createCatalogs({ dir: path.join(dir, 'catalogs'), settings: createSettings(path.join(dir, 'settings.json')), log: m => logs.push(m) });
  assert.deepEqual(catalogs.localRepos(), [{ repository: 'me/port', name: 'My Port' }]);
  assert.match(logs[0], /carried 1 repo/);
  catalogs.removeRepo('me/port');
  assert.deepEqual(catalogs.localRepos(), [], 'not carried over again');
});
