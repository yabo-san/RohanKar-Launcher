'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {
  QUIVER_CATALOGS, identityKey, normalizeCatalog, indexCollisions, indexCatalog,
  joinCollisions, diffCatalog, buildPorts,
} = require('../src/core/ports');
const { createPortsFeed } = require('../src/main/ports-feed');

// Cut from the real files: Quiver's Nintendo.json and this repo's catalog/
const nintendo = {
  name: 'Nintendo', description: 'Nintendo platform ports and recreations', preferredTagFilters: ['recomp', 'n64'],
  apps: [
    { name: 'Banjo-Kazooie', project: 'Banjo: Recompiled', repository: 'BanjoRecomp/BanjoRecomp', folderName: 'BanjoKazooie-BanjoRecompiled',
      appIconUrl: 'https://example.invalid/banjo.png', tags: ['recomp', 'n64'], filesToAdd: ['portable.txt'] },
    { name: 'Mario Kart 64', project: 'Mario Kart 64: Recompiled', repository: 'sonicdcer/MarioKart64Recomp', folderName: 'MarioKart64-MarioKart64Recompiled', tags: ['recomp', 'n64'] },
    { name: 'AeroGauge', project: 'AeroGauge: Recompiled', repository: 'alondero/aerogauge-recomp', folderName: 'AeroGauge-AeroGaugeRecompiled' },
    { name: 'No repository' },
  ],
};
const collisions = [
  { name: 'Banjo-Kazooie: Recompiled', repository: 'banjorecomp/banjorecomp', iaIdentifier: 'banjo-kazooie-recompiled.-7z',
    contentUrl: 'https://archive.org/download/x/y.7z', dataFiles: [{ name: 'bk.n64.us.1.0.z64', targetSubpath: '', sha1: 'abc' }] },
];
const catalog = { apps: [
  { name: 'Mario Kart 64', repository: 'sonicdcer/MarioKart64Recomp', dataFiles: [{ name: 'mk64.us.z64', sha1: 'def' }, { name: 'extra.bin', optional: true }] },
  { name: 'Banjo', repository: 'BanjoRecomp/BanjoRecomp', iaUploader: 'rohanjackson071@gmail.com' },
] };
const shelf = QUIVER_CATALOGS[0];

test('there are four shelves in sidebar order, each pointing at its Quiver list', () => {
  assert.deepStrictEqual(QUIVER_CATALOGS.map(c => c.name), ['Nintendo', 'PlayStation', 'Xbox', 'Other']);
  assert.match(QUIVER_CATALOGS[3].url, /community-app-catalog\/OtherPlatforms\.json$/);
});

test('normalizeCatalog maps Quiver entries to shelf items and drops ones without a repository', () => {
  const items = normalizeCatalog(nintendo, shelf);
  assert.strictEqual(items.length, 3);
  const b = items[0];
  assert.strictEqual(b.id, 'quiver:nintendo:banjorecomp/banjorecomp::banjokazooie-banjorecompiled');
  assert.strictEqual(b.iconUrl, 'https://example.invalid/banjo.png');
  assert.deepStrictEqual(b.filesToAdd, ['portable.txt']);
  assert.strictEqual(b.shelfName, 'Nintendo');
  assert.strictEqual(b.catalogUrl, shelf.url);
  assert.deepStrictEqual(items[2].tags, []);
  assert.strictEqual(items[2].iconUrl, null);
  assert.deepStrictEqual(normalizeCatalog(null, shelf), []);
});

test('joinCollisions matches on repository case-insensitively, never on title', () => {
  const items = normalizeCatalog(nintendo, shelf);
  const joined = joinCollisions(items, indexCollisions(collisions), indexCatalog(catalog));
  assert.deepStrictEqual(joined[0].data, {
    status: 'available', iaIdentifier: 'banjo-kazooie-recompiled.-7z', contentUrl: 'https://archive.org/download/x/y.7z',
    uploader: 'rohanjackson071', files: ['bk.n64.us.1.0.z64'],
  });
  // Mario Kart has no collision, so it reports the non-optional data it needs
  assert.deepStrictEqual(joined[1].data, { status: 'missing', files: ['mk64.us.z64'] });
  assert.deepStrictEqual(joined[2].data, { status: 'none', files: [] });

  // Same title, different repository: no match
  const renamed = [{ ...items[0], repository: 'someone/else' }];
  assert.strictEqual(joinCollisions(renamed, indexCollisions(collisions)).at(0).data.status, 'none');
});

test('indexers tolerate missing or malformed input', () => {
  assert.strictEqual(indexCollisions(null).size, 0);
  assert.strictEqual(indexCollisions([{ name: 'no repo' }]).size, 0);
  assert.strictEqual(indexCatalog({}).size, 0);
  const noUploader = joinCollisions(normalizeCatalog(nintendo, shelf).slice(0, 1),
    indexCollisions([{ ...collisions[0], dataFiles: undefined, contentUrl: undefined }]));
  assert.deepStrictEqual(noUploader[0].data.files, []);
  assert.strictEqual(noUploader[0].data.uploader, null);
  assert.strictEqual(noUploader[0].data.contentUrl, null);
});

test('diffCatalog reports added, changed and removed entries by identity', () => {
  const a = { name: 'A', repository: 'o/a', folderName: 'A' };
  const b = { name: 'B', repository: 'o/b', folderName: 'B', tags: ['x'] };
  const c = { name: 'C', repository: 'o/c', folderName: 'C' };
  const b2 = { tags: ['x', 'y'], folderName: 'B', repository: 'O/B', name: 'B' };
  const d = diffCatalog([a, b], [b2, c]);
  assert.deepStrictEqual(d.added.map(x => x.name), ['C']);
  assert.deepStrictEqual(d.changed.map(x => x.name), ['B']);
  assert.deepStrictEqual(d.removed.map(x => x.name), ['A']);
  // Key order alone is not a change
  assert.deepStrictEqual(diffCatalog([b], [{ tags: ['x'], folderName: 'B', name: 'B', repository: 'o/b' }]).changed, []);
  assert.deepStrictEqual(diffCatalog(undefined, undefined), { added: [], changed: [], removed: [] });
  assert.strictEqual(identityKey({ repository: 'O/A', folderName: 'X' }), 'o/a::x');
});

test('buildPorts builds shelves with counts and carries fetch errors through', () => {
  const m = buildPorts({
    lists: { nintendo: { json: nintendo, fetchedAt: 1, fromCache: true }, xbox: { json: null, error: 'HTTP 500' } },
    collisions, catalog,
  });
  assert.strictEqual(m.shelves.length, 4);
  assert.deepStrictEqual(m.shelves[0], {
    id: 'nintendo', name: 'Nintendo', url: shelf.url, description: 'Nintendo platform ports and recreations',
    preferredTags: ['recomp', 'n64'], count: 3, withData: 1, error: null, fetchedAt: 1, fromCache: true,
  });
  assert.strictEqual(m.shelves[2].error, 'HTTP 500');
  assert.strictEqual(m.shelves[1].count, 0);
  assert.strictEqual(m.items.length, 3);
  assert.strictEqual(m.collisions, 1);
});

// ─── ports-feed: fetch, cache, fall back, review ──────────────────────────────

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rk-ports-')); }

function feedWith(responses, dirs = { cacheDir: tmpdir(), bundledDir: tmpdir() }) {
  const fetched = [];
  const feed = createPortsFeed({
    fetchText: async (url) => {
      fetched.push(url);
      const hit = Object.entries(responses).find(([k]) => url.endsWith(k));
      if (!hit || hit[1] instanceof Error) throw hit?.[1] || new Error('HTTP 404');
      return typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
    },
    ...dirs,
  });
  return { feed, fetched, dirs };
}

test('the feed fetches all six inputs and builds the model', async () => {
  const { feed, fetched } = feedWith({ 'Nintendo.json': nintendo, 'collisions.json': collisions, 'catalog.json': catalog });
  const m = await feed.get();
  assert.strictEqual(fetched.length, 6);
  assert.strictEqual(m.shelves[0].count, 3);
  assert.strictEqual(m.shelves[1].error, 'HTTP 404');
  assert.strictEqual(m.items[0].data.status, 'available');
  // get() reuses the model; refresh() fetches again
  await feed.get();
  assert.strictEqual(fetched.length, 6);
  await feed.refresh();
  assert.strictEqual(fetched.length, 12);
});

test('a failed fetch falls back to the cache, then to the bundled catalog files', async () => {
  const dirs = { cacheDir: tmpdir(), bundledDir: tmpdir() };
  await feedWith({ 'Nintendo.json': nintendo }, dirs).feed.get();
  fs.writeFileSync(path.join(dirs.bundledDir, 'collisions.json'), JSON.stringify(collisions));

  const { feed } = feedWith({ 'Nintendo.json': new Error('offline'), 'catalog.json': 'not json' }, dirs);
  const m = await feed.get();
  assert.strictEqual(m.shelves[0].count, 3);
  assert.strictEqual(m.shelves[0].fromCache, true);
  assert.strictEqual(m.collisions, 1);
  assert.strictEqual(m.items[0].data.status, 'available');
});

test('the review starts empty, shows changes, and clears on mark seen', async () => {
  const dirs = { cacheDir: tmpdir(), bundledDir: tmpdir() };
  const first = feedWith({ 'Nintendo.json': nintendo }, dirs).feed;
  let review = await first.review();
  assert.deepStrictEqual(review.map(r => r.added.length + r.changed.length + r.removed.length), [0, 0, 0, 0]);
  assert.strictEqual(review[1].error, 'HTTP 404');

  const next = { ...nintendo, apps: [...nintendo.apps.slice(1), { name: 'New', repository: 'o/new', folderName: 'New' }] };
  const second = feedWith({ 'Nintendo.json': next }, dirs).feed;
  review = await second.review();
  assert.deepStrictEqual(review[0].added.map(a => a.name), ['New']);
  assert.deepStrictEqual(review[0].removed.map(a => a.name), ['Banjo-Kazooie']);

  assert.deepStrictEqual(await second.markSeen('xbox'), { ok: true });
  assert.strictEqual((await second.review())[0].added.length, 1);
  await second.markSeen();
  review = await second.review();
  assert.strictEqual(review[0].added.length + review[0].removed.length, 0);
});

test('markSeen on a fresh feed loads the catalogs first', async () => {
  const { feed, fetched } = feedWith({ 'Nintendo.json': nintendo });
  await feed.markSeen();
  assert.strictEqual(fetched.length, 6);
});
