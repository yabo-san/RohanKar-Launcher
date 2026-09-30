'use strict';
/**
 * Admin mode (docs/ADMIN.md): the owner edits the curated collisions in place,
 * picks releases and archive.org items, and gates entries with hidden.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { testApi, tmpDir } = require('./helpers');

const enc = encodeURIComponent;
const CURATED = [{ repository: 'a/listed', iaIdentifier: 'x', contentUrl: 'https://archive.org/download/x/x.zip', dataFiles: [{ name: 'r.bin' }] }];
const TILE = {
  name: 'Perfect Dark', shelf: 'y4bo ports', folderName: 'PerfectDark', assetPattern: '(?i)^pd-x86_64-windows\\.zip$', exe: 'pd.x86_64.exe',
  sources: [{ ia: 'N64TOSEC', path: 'Perfect Dark (USA) (Rev A).zip', target: 'data', extract: true, as: 'pd.ntsc-final.z64' }],
};

async function setup(t, { admin = true } = {}) {
  const dir = tmpDir(t);
  const collisionsFile = path.join(dir, 'collisions.json');
  fs.writeFileSync(collisionsFile, JSON.stringify(CURATED, null, 2));
  const state = { routes: {
    '/repos/o/pd/releases': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { tag_name: 'draft', draft: true, assets: [] },
        { tag_name: 'v2.0.3', name: 'Two', published_at: '2026-09-01T00:00:00Z', assets: [
          { name: 'pd-v2.0.3-x86_64-linux.tar.gz', size: 5, browser_download_url: 'https://x/l' },
          { name: 'pd-v2.0.3-x86_64-windows.zip', size: 7, browser_download_url: 'https://x/w' },
        ] },
      ]));
    },
    '/advancedsearch.php': (req, res, url) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: { docs: [{ identifier: 'N64TOSEC', title: 'N64 TOSEC', uploader: 'someone@example.com', item_size: 123, q: url.searchParams.get('q') }] } }));
    },
  } };
  const ctx = await testApi(t, { collisionsFile, admin, state });
  return { ...ctx, collisionsFile };
}

test('admin off: /health says nothing, every /admin route is 403', async (t) => {
  const { call } = await setup(t, { admin: false });
  assert.equal((await call('GET', '/health')).body.admin, undefined);
  for (const [m, p, b] of [['GET', '/admin/collisions'], ['PUT', `/admin/collisions/${enc('o/pd')}`, TILE], ['DELETE', `/admin/collisions/${enc('a/listed')}`],
    ['GET', `/admin/releases/${enc('o/pd')}`], ['GET', '/admin/ia-search?q=x']]) {
    assert.equal((await call(m, p, b)).status, 403, `${m} ${p}`);
  }
});

test('admin: a tile saved into the curated file shows on its shelf; edits keep the order; hidden gates it', async (t) => {
  const { call, collisionsFile, backend } = await setup(t);
  assert.equal((await call('GET', '/health')).body.admin, true);
  assert.deepEqual((await call('GET', '/admin/collisions')).body, { file: collisionsFile, collisions: CURATED });

  const created = await call('PUT', `/admin/collisions/${enc('o/pd')}`, TILE);
  assert.equal(created.status, 201);
  const written = fs.readFileSync(collisionsFile, 'utf8');
  assert.ok(written.endsWith(']\n'));
  assert.deepEqual(JSON.parse(written), [...CURATED, { ...TILE, repository: 'o/pd' }]);

  const shelf = (await call('GET', '/catalogs')).body.catalogs.find(c => c.curated);
  assert.deepEqual([shelf.id, shelf.name, shelf.entries], ['curated-y4bo-ports', 'y4bo ports', 1]);
  const [item] = backend.catalogs.items().filter(i => i.shelf === 'y4bo ports');
  assert.equal(item.title, 'Perfect Dark');
  assert.equal(item.userSource, false, 'curated, so no "Your source" badge');
  assert.deepEqual([item.data.exe, item.data.sources[0].as], ['pd.x86_64.exe', 'pd.ntsc-final.z64']);

  // Editing an existing entry replaces it where it is
  assert.equal((await call('PUT', `/admin/collisions/${enc('A/Listed')}`, { ...CURATED[0], hidden: true })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(collisionsFile, 'utf8')).map(c => c.repository), ['A/Listed', 'o/pd']);

  // Hidden: the owner still sees the tile (flagged), everyone else doesn't
  await call('PUT', `/admin/collisions/${enc('o/pd')}`, { ...TILE, hidden: true });
  assert.equal(backend.catalogs.items().find(i => i.repository === 'o/pd').hidden, true);
  const { backend: user } = await setup(t, { admin: false });
  fs.copyFileSync(collisionsFile, user.collisionsFile);
  assert.deepEqual(user.catalogs.items().filter(i => i.repository === 'o/pd'), []);
  assert.equal(user.catalogs.list().some(c => c.curated), false);

  const bad = await call('PUT', `/admin/collisions/${enc('o/pd')}`, { ...TILE, hidden: 'yes', exe: '../x.exe' });
  assert.deepEqual([bad.status, bad.body.errors], [400, ['hidden must be true or false', 'exe must be a relative path to an .exe']]);

  assert.equal((await call('DELETE', `/admin/collisions/${enc('o/pd')}`)).status, 204);
  assert.equal((await call('DELETE', `/admin/collisions/${enc('o/pd')}`)).status, 404);
  assert.deepEqual(JSON.parse(fs.readFileSync(collisionsFile, 'utf8')).map(c => c.repository), ['A/Listed']);
});

test('admin: releases with a pattern per asset that survives version bumps; archive.org search', async (t) => {
  const { call } = await setup(t);
  const r = (await call('GET', `/admin/releases/${enc('o/pd')}?pattern=${enc('(?i)windows')}`)).body;
  assert.deepEqual([r.latest, r.picked, r.releases.map(x => x.tag)], ['v2.0.3', 'pd-v2.0.3-x86_64-windows.zip', ['v2.0.3']]);
  assert.deepEqual(r.releases[0].assets[1], { name: 'pd-v2.0.3-x86_64-windows.zip', size: 7, pattern: '(?i)^pd-.+-x86_64-windows\\.zip$' });
  assert.equal((await call('GET', `/admin/releases/${enc('o/missing')}`)).status, 502);

  const s = (await call('GET', `/admin/ia-search?q=${enc('perfect dark')}`)).body;
  assert.deepEqual(s.items, [{ identifier: 'N64TOSEC', title: 'N64 TOSEC', uploader: 'someone@example.com', size: 123 }]);
  assert.equal((await call('GET', '/admin/ia-search?q=')).status, 400);
});
