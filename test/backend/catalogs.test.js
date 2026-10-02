'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createCatalogs, parseCatalog, diffEntries, entryKey, catalogId } = require('../../src/backend/catalogs');
const { createSettings } = require('../../src/backend/settings');
const { fakeArchive, tmpDir } = require('./helpers');

async function setup(t, { userSources } = {}) {
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
  const settings = createSettings(path.join(dir, 'settings.json'));
  const netLog = [];
  const catalogs = createCatalogs({ dir: path.join(dir, 'catalogs'), settings, ...(userSources ? { userSources } : {}), netLog: (...a) => netLog.push(a) });
  return { fake, dir, settings, catalogs, catalog, netLog };
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

test('items: one per entry, a port binary with no game data', async (t) => {
  const { fake, catalogs } = await setup(t);
  assert.deepEqual(catalogs.items(), []);
  const { catalog: sub } = await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });
  const items = catalogs.items();
  assert.equal(items.length, 2);
  const banjo = items.find(i => i.title === 'Banjo Recomp');
  assert.equal(banjo.id, `quiver:${sub.id}:banjorecomp/banjorecomp`);
  assert.equal(banjo.shelf, 'Nintendo');
  assert.equal(banjo.icon, 'https://i/b.png');
  assert.deepEqual([banjo.userSource, 'data' in banjo], [false, false]);
  assert.equal(catalogs.unsubscribe(sub.id), true);
  assert.equal(catalogs.unsubscribe(sub.id), false);
  assert.deepEqual(catalogs.list(), []);
});

test('your repos need additional sources and fill a Your ports shelf, unless a shelf lists the repo', async (t) => {
  const { fake, catalogs, settings } = await setup(t);
  const { catalog: sub } = await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });

  assert.equal(catalogs.addRepo({ repository: 'me/port', name: 'My Port', folderName: 'MyPort', releaseAssetFilter: 'win', sources: [{ ia: 'x' }] }).ok, true);
  assert.equal(catalogs.addRepo({ repository: 'HarbourMasters/Shipwright', name: 'Mine' }).ok, true);
  assert.deepEqual(catalogs.localRepos().map(r => r.repository), ['me/port', 'HarbourMasters/Shipwright']);
  assert.equal(catalogs.list().some(c => c.id === 'local'), false, 'off until additional sources are allowed');

  settings.save({ allowAdditionalSources: true });
  const shelf = catalogs.list().find(c => c.id === 'local');
  assert.deepEqual([shelf.name, shelf.entries, shelf.url], ['Your ports', 1, null]);
  const port = catalogs.items().find(i => i.id === 'quiver:local:me/port');
  assert.deepEqual([port.title, port.shelf, port.entry.folderName, port.entry.releaseAssetFilter, port.userSource], ['My Port', 'Your ports', 'MyPort', 'win', true]);
  assert.equal('sources' in port.entry, false);
  const soh = catalogs.items().filter(i => i.repository?.toLowerCase() === 'harbourmasters/shipwright');
  assert.deepEqual(soh.map(i => [i.shelf, i.userSource]), [['Nintendo', false]], 'a repo a shelf lists stays the shelf\'s');
  assert.deepEqual(catalogs.review('local'), { new: [], changed: [], removed: [] });
  assert.equal(catalogs.markSeen('local'), true);
  assert.equal(catalogs.unsubscribe('local'), false);
  assert.equal((await catalogs.refresh('local')).entries, 1);

  assert.deepEqual(catalogs.addRepo({ repository: 'nope', name: 3 }).errors, ['repository must be owner/repo', 'name must be a string']);
  assert.equal(catalogs.removeRepo('ME/port'), true);
  assert.equal(catalogs.removeRepo('me/port'), false);
  assert.equal(catalogs.list().some(c => c.id === 'local'), false);
  assert.equal(catalogs.unsubscribe(sub.id), true);
});

test('user.json github entries join Your ports; one a shelf lists is a conflict', async (t) => {
  const github = [{ repository: 'me/tool', assetPattern: '(?i)win64', sha1: 'A'.repeat(40) }, { repository: 'BanjoRecomp/BanjoRecomp' }];
  const { fake, catalogs, settings } = await setup(t, { userSources: { entries: () => ({ archive: [], github }) } });
  await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Nintendo' });
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

// The curated shelf and Quiver's four on a fake GitHub: curated.json on main,
// the bundled copy on disk, Quiver's lists under /quiver/
async function builtins(t, { bundledApps = [{ name: 'Bundled', repository: 'a/bundled', tags: ['source only'] }] } = {}) {
  const ctx = await setup(t);
  const curated = { apps: [{ name: 'Banjo Recomp', repository: 'BanjoRecomp/BanjoRecomp' }, { name: 'Zelda', repository: 'z/zelda' }] };
  ctx.fake.routes['/curated.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify(curated)); };
  ctx.fake.routes['/quiver/Nintendo.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify(ctx.catalog)); };
  const curatedFile = path.join(ctx.dir, 'bundled-curated.json');
  fs.writeFileSync(curatedFile, JSON.stringify({ apps: bundledApps }));
  const library = new Set();
  const make = () => createCatalogs({
    dir: path.join(ctx.dir, 'catalogs'), settings: ctx.settings,
    curatedUrl: `${ctx.fake.base}/curated.json`, curatedFile, quiverBase: `${ctx.fake.base}/quiver/`, libraryIds: () => library,
  });
  return { ...ctx, curated, curatedFile, library, make, catalogs: make() };
}

test('curated: the first shelf, from the bundled copy until a fetch lands, then cached', async (t) => {
  const { catalogs, fake, curated } = await builtins(t);
  const first = catalogs.list();
  assert.deepEqual(first.map(c => [c.id, c.shelf, c.entries, c.builtin]), [['curated', 'Curated', 1, true]]);
  assert.deepEqual(catalogs.items().map(i => [i.title, i.curated]), [['Bundled', true]]);
  assert.equal(catalogs.unsubscribe('curated'), false, 'built in');

  assert.equal(first[0].bundled, true);
  await catalogs.warm();
  assert.deepEqual(catalogs.items().map(i => i.title), ['Banjo Recomp', 'Zelda']);
  assert.equal(catalogs.list()[0].bundled, undefined, 'a fetched copy');
  assert.deepEqual(catalogs.review('curated'), { new: [], changed: [], removed: [] }, 'the first copy counts as reviewed');

  curated.apps.push({ name: 'New', repository: 'n/new' });
  let fetches = 0;
  const route = fake.routes['/curated.json'];
  fake.routes['/curated.json'] = (req, res) => { fetches++; route(req, res); };
  await catalogs.warm();
  assert.equal(fetches, 0, 'warm only fetches shelves never fetched');
  await catalogs.refresh('curated');
  assert.deepEqual(catalogs.review('curated').new.map(e => e.name), ['New']);

  fake.routes['/curated.json'] = (req, res) => { res.writeHead(503); res.end(); };
  const failed = await catalogs.refresh('curated');
  assert.deepEqual([failed.entries, failed.error], [3, 'HTTP 503'], 'a failed fetch keeps the cached copy');
});

test('curated: offline on a first run, the bundled copy stands and is cached with the error', async (t) => {
  const { catalogs, fake } = await builtins(t);
  fake.routes['/curated.json'] = (req, res) => { res.writeHead(404); res.end(); };
  await catalogs.warm();
  const [shelf] = catalogs.list();
  assert.deepEqual([shelf.entries, shelf.error, shelf.bundled], [1, 'HTTP 404', true]);
  assert.deepEqual(catalogs.items().map(i => i.title), ['Bundled']);
});

test('curated: an unreadable bundled copy is an empty shelf, logged', async (t) => {
  const { dir, settings } = await setup(t);
  const logs = [];
  const catalogs = createCatalogs({ dir: path.join(dir, 'catalogs'), settings, curatedUrl: 'http://127.0.0.1:1/c.json', curatedFile: path.join(dir, 'missing.json'), log: m => logs.push(m) });
  assert.equal(catalogs.list()[0].entries, 0);
  assert.match(logs[0], /bundled curated ports unreadable/);
});

test('full Quiver catalog: off by default, built in when on, and a held port stays while off', async (t) => {
  const { catalogs, settings, fake, library } = await builtins(t);
  const nintendoId = catalogId(`${fake.base}/quiver/Nintendo.json`);
  // An install from before: Quiver's lists subscribed in settings
  settings.save({ catalogs: [{ id: nintendoId, url: `${fake.base}/quiver/Nintendo.json`, name: 'Nintendo', shelf: 'Nintendo' }] });
  assert.deepEqual(catalogs.list().map(c => c.id), ['curated'], 'hidden while the setting is off');
  assert.equal(catalogs.fullQuiver(), false);

  settings.save({ showFullQuiver: true });
  assert.deepEqual(catalogs.list().map(c => c.shelf), ['Curated', 'Nintendo', 'PlayStation', 'Xbox', 'Other']);
  await catalogs.warm();
  const items = catalogs.items();
  assert.deepEqual(items.filter(i => i.shelf === 'Nintendo').map(i => [i.title, i.curated]),
    [['Banjo Recomp', true], ['Ship of Harkinian', false]], 'curated means the curated list has the repo, whatever the shelf');
  assert.equal(catalogs.list().find(c => c.shelf === 'Xbox').error, 'HTTP 404');
  assert.equal(catalogs.unsubscribe(nintendoId), false, 'built in');

  settings.save({ showFullQuiver: false });
  library.add(`quiver:${nintendoId}:harbourmasters/shipwright`);
  assert.deepEqual(catalogs.list().map(c => [c.shelf, c.entries]), [['Curated', 2], ['Nintendo', 1]]);
  assert.deepEqual(catalogs.items().filter(i => i.shelf === 'Nintendo').map(i => i.title), ['Ship of Harkinian']);
});

test('a subscription that is not one of Quiver\'s four shows whatever the setting', async (t) => {
  const { catalogs, fake } = await builtins(t);
  await catalogs.subscribe({ url: `${fake.base}/nintendo.json`, name: 'Mine' });
  assert.deepEqual(catalogs.list().map(c => c.shelf), ['Curated', 'Mine']);
});
