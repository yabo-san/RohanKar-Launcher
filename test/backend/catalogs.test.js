'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createCatalogs, parseCatalog, diffEntries, entryKey } = require('../../src/backend/catalogs');
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
