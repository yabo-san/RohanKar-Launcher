'use strict';
// What users type for a source (email, @handle, profile and item URLs), an
// account's uploads by handle, title filters, and excluded uploads.
// docs/USER-SOURCES.md. No network: the account uploads come from
// test/fixtures/archive/account-uploads.json through the fake archive.org.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { normalizeUploader, itemIdFrom, titleAllowed, joinTerms, sourceKeys, sourcesFromCatalog } = require('../../src/backend/sources');
const { createArchive, accountUploads, UPLOADS_PAGE_SIZE } = require('../../src/backend/archive');
const us = require('../../src/backend/user-sources');
const { fakeArchive, testBackend, testApi, tmpDir } = require('./helpers');

const ACCOUNT = require('../fixtures/archive/account-uploads.json');
const HITS = ACCOUNT.response.body.page_elements.uploads.hits.hits;
const hit = (identifier, title, mediatype = 'software') => ({ index: 'public', fields: { identifier, title, mediatype, addeddate: '2026-01-01T00:00:00Z' } });

test('itemIdFrom: identifiers and every archive.org item URL form; anything else is null', () => {
  const id = 'resident-evil-0-hd-remaster-pc.';
  for (const s of [
    id, ` ${id} `,
    `https://archive.org/details/${id}`, `https://archive.org/details/${id}/`,
    `http://archive.org/details/${id}`, `https://www.archive.org/details/${id}?tab=about#reviews`,
    `archive.org/details/${id}`, `https://archive.org/download/${id}/game%20disc.zip`,
    `https://archive.org/metadata/${id}`, `https://archive.org/embed/${id}`,
    `https://archive.org/details/${id}/disc1.iso?x=1`,
  ]) assert.equal(itemIdFrom(s), id, s);
  for (const s of [
    '', '   ', null, 42, 'has space', 'https://example.com/details/x', 'https://archive.org/',
    'https://archive.org/details/@someone', 'https://archive.org/search?query=x', 'https://archive.org/details/',
  ]) assert.equal(itemIdFrom(s), null, String(s));
});

test('normalizeUploader: emails, @handles, bare names and profile URLs', () => {
  const n = (s) => { const r = normalizeUploader(s); return r.error ? 'error' : `${r.kind}:${r.value}:${r.key}`; };
  assert.equal(n('frankiemiqueli1@gmail.com'), 'email:frankiemiqueli1@gmail.com:frankiemiqueli1@gmail.com');
  assert.equal(n(' Me@Example.com '), 'email:Me@Example.com:me@example.com');
  assert.equal(n('mailto:me@example.com'), 'email:me@example.com:me@example.com');
  assert.equal(n('@PSTRIPLE'), 'handle:PSTRIPLE:@pstriple');
  assert.equal(n('pstriple'), 'handle:pstriple:@pstriple', 'a bare name is a handle: uploader: only matches emails');
  assert.equal(n('goblan1.0'), 'handle:goblan1.0:@goblan1.0');
  for (const url of [
    'https://archive.org/details/@pstriple', 'https://archive.org/details/@pstriple/',
    'https://archive.org/details/@pstriple/uploads', 'https://archive.org/details/@pstriple?tab=uploads&sort=-publicdate',
    'http://www.archive.org/details/@pstriple#x', 'archive.org/details/@pstriple', 'https://archive.org/@pstriple',
    'https://archive.org/details/%40pstriple',
  ]) assert.equal(n(url), 'handle:pstriple:@pstriple', url);
  // catalog/uploaders.json's url field: an uploader search
  assert.equal(n('https://archive.org/search?query=uploader%3A%22frankiemiqueli1%40gmail.com%22'), 'email:frankiemiqueli1@gmail.com:frankiemiqueli1@gmail.com');
  assert.equal(n('https://archive.org/search.php?query=uploader:me@x.org'), 'email:me@x.org:me@x.org');
  // a single upload
  assert.equal(n('https://archive.org/details/sega-rally-2-25th-anniversary'), 'item:sega-rally-2-25th-anniversary:sega-rally-2-25th-anniversary');
  for (const bad of ['', null, 'two words', 'https://archive.org/search?query=creator%3AInfidelity', 'https://archive.org/', 'a@b@c', 'https://example.com/@x']) {
    assert.ok(normalizeUploader(bad).error, String(bad));
  }
});

test('sourceKeys: a curated entry answers to its email and every handle', () => {
  assert.deepEqual(sourceKeys({ uploader: 'f@x.com', handles: ['hailstormttv', '@TiredNonFire'] }), ['f@x.com', '@hailstormttv', '@tirednonfire']);
  assert.deepEqual(sourceKeys({ uploader: 'two words' }), []);
  assert.deepEqual(sourceKeys(null), []);
});

test('titleAllowed and joinTerms: pipe-separated substrings, case-insensitive', () => {
  const eldritch = { titleInclude: 'Windows|Linux|Wine|Batocera', titleExclude: 'DVD|MiSTer|WUP|GOD|XBLA|PS2|PS3|PSX' };
  assert.equal(titleAllowed('Wet Recompiled [Windows]', eldritch), true);
  assert.equal(titleAllowed('Wet Recompiled [windows]', eldritch), true);
  assert.equal(titleAllowed('Super Metroid [MiSTer]', eldritch), false, 'no include matches');
  assert.equal(titleAllowed('Some Game [Windows] [PS3]', eldritch), false, 'an exclude beats an include');
  assert.equal(titleAllowed('Black Sabbath Discography', { titleExclude: 'discography' }), false);
  assert.equal(titleAllowed(['Arr', 'ay'], { titleInclude: 'ay' }), true);
  assert.equal(titleAllowed('Anything', {}), true);
  assert.equal(titleAllowed(undefined, { titleExclude: 'x' }), true);
  assert.equal(titleAllowed('x', { titleInclude: ' | ' }), true, 'blank terms are no filter');
  assert.equal(joinTerms('DVD|ps2', ['PS2', ' wup '], undefined, ''), 'dvd|ps2|wup');
  assert.equal(joinTerms(), '');
});

test('sourcesFromCatalog: the bundled catalog carries titleInclude/titleExclude and every handle', () => {
  const list = sourcesFromCatalog(require('../../catalog/uploaders.json'));
  const by = (label) => list.find(s => s.label === label);
  assert.equal(by('thiago86').titleExclude, 'discography');
  assert.deepEqual([by('eldritchpenumbra').titleInclude, by('eldritchpenumbra').titleExclude], ['Windows|Linux|Wine|Batocera', 'DVD|MiSTer|WUP|GOD|XBLA|PS2|PS3|PSX']);
  assert.equal(by('spuntik80').titleInclude, 'USA|Europe');
  assert.deepEqual(by('hailstormttv').handles, ['hailstormttv', 'tirednonfire']);
  assert.equal(by('rohanjackson071').titleExclude, undefined);
  assert.equal(by('eldritchpenumbra').handles, undefined, 'no email: the handle is the uploader itself');
});

test('accountUploads: the page_production fixture as advancedsearch docs', () => {
  const { total, hits } = accountUploads(ACCOUNT);
  assert.equal(total, 4);
  assert.deepEqual(hits.map(h => [h.identifier, h.mediatype]), [
    ['rk-fx-uncharted-2-rpcs3', 'software'], ['rk-fx-skate-3-recomp', 'software'], ['rk-fx-showcase-video', 'movies'],
  ]);
  assert.deepEqual(hits[0].doc, {
    identifier: 'rk-fx-uncharted-2-rpcs3', title: 'Uncharted 2 (RPCS3 bundle) [Windows]', description: 'Preconfigured RPCS3 with the game.',
    date: '2026-06-14T00:00:00Z', addeddate: '2026-06-14T10:11:12Z', downloads: 1234, subject: ['ps3', 'rpcs3'],
  });
  assert.deepEqual(hits[1].doc, {
    identifier: 'rk-fx-skate-3-recomp', title: 'Skate 3 Recompiled [DVD]', description: null,
    date: null, addeddate: '2026-07-01T08:00:00Z', downloads: 56, subject: 'recomp',
  });
  // What the endpoint may vary, and junk
  assert.equal(accountUploads({ response: { body: { page_elements: { uploads: { hits: { total: { value: 7 }, hits: [] } } } } } }).total, 7);
  assert.equal(accountUploads({ body: { page_elements: { uploads: { hits: { total: '3', hits: [{ _source: { identifier: 'a' } }] } } } } }).hits[0].identifier, 'a');
  assert.deepEqual(accountUploads(null), { total: null, hits: [] });
  assert.deepEqual(accountUploads({ response: { body: { page_elements: {} } } }), { total: null, hits: [] });
});

test('fetchSource: an @handle or profile URL lists the account uploads, software only, paging to the total', async (t) => {
  const many = Array.from({ length: UPLOADS_PAGE_SIZE + 20 }, (_, i) => hit(`g${i}`, `G${i}`));
  const fake = await fakeArchive(t, { uploads: { pstriple: HITS, big: many } });
  const archive = createArchive({ base: fake.base, sleep: async () => {} });
  const ids = async (u) => (await archive.fetchSource({ uploader: u })).map(d => d.identifier);
  for (const u of ['@pstriple', 'PSTRIPLE', 'https://archive.org/details/@pstriple/uploads?sort=-publicdate']) {
    assert.deepEqual(await ids(u), ['rk-fx-uncharted-2-rpcs3', 'rk-fx-skate-3-recomp'], u);
  }
  const req = new URL(fake.requests.find(r => r.startsWith('/services/')), 'http://x');
  assert.deepEqual([req.searchParams.get('page_type'), req.searchParams.get('page_target'), req.searchParams.get('page_elements')],
    ['account_details', '@pstriple', '["uploads"]']);
  assert.ok(!fake.requests.some(r => r.startsWith('/advancedsearch')), 'uploader: is never asked for a handle');

  assert.equal((await ids('@big')).length, UPLOADS_PAGE_SIZE + 20);
  assert.equal(fake.requests.filter(r => r.includes('page_target=%40big')).length, 2);

  // An endpoint that ignores page and keeps sending page 1 stops instead of looping
  fake.routes['/services/search/beta/page_production/'] = (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ response: { body: { page_elements: { uploads: { hits: { total: 999, hits: many.slice(0, 50) } } } } } }));
  };
  assert.equal((await ids('@loop')).length, 50);
});

test('fetchSource: an unknown handle, a failing endpoint, an item URL, and junk', async (t) => {
  const fake = await fakeArchive(t, { failures: { '@flaky': [503, 404] }, metadata: { 'my-demo': { title: 'My Demo', date: '2024', uploader: 'me@x.com' } } });
  const archive = createArchive({ base: fake.base, sleep: async () => {} });
  await assert.rejects(archive.fetchSource({ uploader: '@nobody' }), /no uploads found for @nobody/);
  await assert.rejects(archive.fetchSource({ uploader: '@flaky' }), /HTTP 404/);
  assert.deepEqual(await archive.fetchSource({ uploader: 'https://archive.org/details/my-demo' }), [
    { identifier: 'my-demo', title: 'My Demo', description: null, date: '2024', addeddate: null, downloads: null, subject: null },
  ]);
  await assert.rejects(archive.fetchSource({ uploader: 'https://archive.org/details/missing' }), /isn't an archive.org item/);
  await assert.rejects(archive.fetchSource({ uploader: 'two words' }), /isn't an email, @handle or archive.org URL/);
});

test('items: a handle typed for a curated uploader is curated; title filters from the catalog and the line apply', async (t) => {
  const { backend, fake } = await testBackend(t);
  // hailstormttv is curated with email frankiemiqueli1@gmail.com; typed by its second handle it stays curated
  fake.uploads.tirednonfire = [hit('rk-tired-a', 'Demon\'s Souls [RPCS3]'), hit('rk-tired-b', 'Godzilla [shadPS4]')];
  fake.uploads.someone = [hit('rk-some-a', 'Keep Me [Windows]'), hit('rk-some-b', 'Drop Me [DVD]'), hit('rk-some-c', 'Other [Linux]')];
  backend.settings.save({ sources: [
    { uploader: 'https://archive.org/details/@tirednonfire', titleExclude: 'godzilla' },
    { uploader: '@someone', titleInclude: 'windows|dvd', titleExclude: 'dvd' },
  ] });
  let r = await backend.items.list();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items.map(i => i.id).sort(), ['rk-some-a', 'rk-tired-a']);
  const tired = r.items.find(i => i.id === 'rk-tired-a');
  assert.deepEqual([tired.userSource, tired.source.label], [false, 'tirednonfire']);
  assert.equal(r.items.find(i => i.id === 'rk-some-a').userSource, true);

  // The curated catalog's own filter applies even to a list saved without it
  backend.settings.save({ sources: [{ uploader: 'lawlessb991@gmail.com', label: 'thiago86' }] });
  fake.search['lawlessb991@gmail.com'] = [{ identifier: 'rk-gta', title: 'GTA III' }, { identifier: 'rk-disco', title: 'Some Band Discography' }];
  r = await backend.items.list({ refresh: true });
  assert.deepEqual(r.items.map(i => i.id), ['rk-gta']);
  assert.equal(r.items[0].userSource, false);

  // Filtered out but installed: the card stays
  backend.library.recordInstall('rk-disco', '/g/disco', null);
  assert.deepEqual((await backend.items.list()).items.map(i => i.id).sort(), ['rk-disco', 'rk-gta']);
});

test('items: an uploader line that is no uploader is reported, not queried', async (t) => {
  const { backend, fake } = await testBackend(t);
  backend.settings.save({ sources: [{ uploader: 'rohanjackson071@gmail.com' }, { uploader: 'two words', label: 'tw' }] });
  const { items, errors } = await backend.items.list();
  assert.equal(items.length, 3);
  assert.deepEqual(errors, [{ source: 'two words', label: 'tw', error: "two words isn't an email, @handle or archive.org URL" }]);
  assert.equal(fake.requests.filter(r => r.startsWith('/advancedsearch')).length, 1);
});

test('items: an upload pasted as a URL in the uploader list loads as that one upload', async (t) => {
  const { backend } = await testBackend(t, { state: { metadata: { 'rk-single': { title: 'Single Upload', uploader: 'x@y.z' } } } });
  backend.settings.save({ sources: [{ uploader: 'https://archive.org/details/rk-single/' }] });
  const { items } = await backend.items.list();
  assert.deepEqual(items.map(i => [i.id, i.title, i.userSource, i.source.label]), [['rk-single', 'Single Upload', true, 'rk-single']]);
});

test('API: excluded uploads (Settings and user.json) leave the wall unless installed, with no refetch', async (t) => {
  const { call, backend, fake } = await testApi(t);
  const ids = async () => (await call('GET', '/items')).body.items.map(i => i.id).sort();
  const all = await ids();
  assert.ok(all.includes('rk-e2e-halo-ce') && all.includes('rk-e2e-the-sims'));
  const searches = fake.requests.length;

  const put = await call('PUT', '/settings', { excludeItems: ['https://archive.org/details/rk-e2e-halo-ce?tab=about', 'RK-E2E-THE-SIMS', 'rk-e2e-halo-ce'] });
  assert.deepEqual(put.body.excludeItems, ['rk-e2e-halo-ce', 'RK-E2E-THE-SIMS'], 'URLs stored as identifiers, repeats dropped');
  assert.deepEqual(await ids(), all.filter(id => id !== 'rk-e2e-halo-ce' && id !== 'rk-e2e-the-sims'));
  assert.equal(fake.requests.length, searches, 'excluding needs no refetch');

  backend.library.recordInstall('rk-e2e-halo-ce', '/g/halo', null);
  assert.ok((await ids()).includes('rk-e2e-halo-ce'), 'an installed upload keeps its card');

  const bad = await call('PUT', '/settings', { excludeItems: ['ok-id', 'https://archive.org/details/@someone'] });
  assert.deepEqual([bad.status, bad.body.detail], [400, 'Not an archive.org upload: https://archive.org/details/@someone']);
  assert.equal((await call('PUT', '/settings', { excludeItems: 'x' })).status, 400);
  assert.deepEqual(backend.settings.load().excludeItems, ['rk-e2e-halo-ce', 'RK-E2E-THE-SIMS']);

  // user.json's exclude list
  await call('PUT', '/settings', { excludeItems: [] });
  const file = path.join(tmpDir(t), 'user.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, exclude: ['https://archive.org/download/rk-e2e-spider-man-2000/x.zip'] }));
  await call('PUT', '/settings', { userSourcesFile: file });
  assert.ok(!(await ids()).includes('rk-e2e-spider-man-2000'));
  assert.deepEqual((await call('GET', '/user-sources')).body.entries, { archive: 0, github: 0, exclude: 1 });
});

test('user.json: archive entries and excludes take item URLs; bad excludes are named', () => {
  const r = us.validateUserFile({ schemaVersion: 1,
    archive: [{ identifier: 'https://archive.org/details/my-demo/' }, { identifier: 'http://www.archive.org/download/My-Demo/a.zip' }, { identifier: 'https://archive.org/details/@me' }],
    exclude: ['some-item', 'https://archive.org/details/other-item?tab=about', 'SOME-ITEM', 'https://archive.org/details/@me', 42],
  });
  assert.deepEqual(r.entries.archive, [{ identifier: 'my-demo' }]);
  assert.deepEqual(r.entries.exclude, ['some-item', 'other-item']);
  assert.deepEqual(r.invalid, [
    { section: 'archive', index: 1, key: 'My-Demo', errors: ['repeats My-Demo, listed earlier in archive'] },
    { section: 'archive', index: 2, key: 'https://archive.org/details/@me', errors: ['identifier must be an archive.org identifier or item URL'] },
    { section: 'exclude', index: 2, key: 'SOME-ITEM', errors: ['repeats SOME-ITEM, listed earlier in exclude'] },
    { section: 'exclude', index: 3, key: 'https://archive.org/details/@me', errors: ['must be an archive.org identifier or item URL'] },
    { section: 'exclude', index: 4, key: null, errors: ['must be an archive.org identifier or item URL'] },
  ]);
  assert.deepEqual(us.validateUserFile({ schemaVersion: 1, exclude: 'x' }), { error: 'exclude must be an array' });
});
