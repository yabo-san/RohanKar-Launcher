'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { getText, getFollow } = require('../../src/backend/net');
const { createArchive, installableFiles } = require('../../src/backend/archive');
const { fakeArchive } = require('./helpers');

const follow = (url, opts = {}) => new Promise((resolve) => {
  getFollow(url, { ...opts, onResponse: (res) => { res.resume(); resolve({ status: res.statusCode }); }, onError: (e) => resolve({ error: e.message }) });
});

test('getText: body and status, logged; network error and timeout come back as status 0', async (t) => {
  const fake = await fakeArchive(t, {
    routes: { '/slow': () => { /* never answers */ } },
  });
  const logged = [];
  const log = (...a) => logged.push(a);
  const ok = await getText(`${fake.base}/metadata/x`, { kind: 'metadata', log });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).files[0].name, 'x.zip');
  assert.equal(logged[0][0], 'metadata');

  const slow = await getText(`${fake.base}/slow`, { timeoutMs: 50, log });
  assert.deepEqual([slow.status, slow.error], [0, 'timed out']);

  const refused = await getText('http://127.0.0.1:1/', { log });
  assert.equal(refused.status, 0);
  assert.ok(refused.error);

  const bad = await getText('http://[bad', { log });
  assert.equal(bad.status, 0);
});

test('getFollow: follows absolute and relative redirects, gives up after the limit', async (t) => {
  const fake = await fakeArchive(t, {
    routes: {
      '/hop':  (req, res) => { res.writeHead(302, { location: '/hop2' }); res.end(); },
      '/hop2': (req, res) => { res.writeHead(301, { location: `${fake.base}/metadata/x` }); res.end(); },
      '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
      '/slow': () => {},
    },
  });
  assert.deepEqual(await follow(`${fake.base}/hop`), { status: 200 });
  assert.deepEqual(await follow(`${fake.base}/loop`, { maxRedirects: 2 }), { error: 'Too many redirects' });
  assert.deepEqual(await follow(`${fake.base}/slow`, { timeoutMs: 50 }), { error: 'Connection timed out' });
  assert.ok((await follow('http://127.0.0.1:1/')).error);
  assert.ok((await follow('http://[bad')).error);
});

test('getFollow: an aborted request reports nothing', async (t) => {
  const fake = await fakeArchive(t, { routes: { '/slow': () => {} } });
  let called = false;
  const h = getFollow(`${fake.base}/slow`, { onResponse: () => { called = true; }, onError: () => { called = true; } });
  await new Promise(r => setTimeout(r, 20));
  h.aborted = true;
  h.req.destroy(new Error('x'));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(called, false);
});

test('search: pages until a short page, labels nothing, logs each response', async (t) => {
  const docs = Array.from({ length: 501 }, (_, i) => ({ identifier: `g${i}`, title: `G${i}` }));
  const fake = await fakeArchive(t, { search: { 'big@x': docs } });
  const log = [];
  const archive = createArchive({ base: fake.base, log: (...a) => log.push(a), sleep: async () => {} });
  const got = await archive.fetchSource({ uploader: 'big@x' });
  assert.equal(got.length, 501);
  assert.equal(fake.requests.filter(r => r.startsWith('/advancedsearch')).length, 2);
  assert.ok(log.every(l => l[0] === 'search'));
});

test('searchWithRetry: waits Retry-After on 429, backs off on 5xx, fails fast on 4xx', async (t) => {
  const fake = await fakeArchive(t, { failures: { 'rohanjackson071@gmail.com': [429, 503], 'frankiemiqueli1@gmail.com': [404] } });
  const waits = [];
  const archive = createArchive({ base: fake.base, sleep: async (ms) => { waits.push(ms); } });
  const docs = await archive.fetchSource({ uploader: 'rohanjackson071@gmail.com' });
  assert.equal(docs.length, 3);
  assert.deepEqual(waits, [1000, 4000]);
  await assert.rejects(archive.fetchSource({ uploader: 'frankiemiqueli1@gmail.com' }), /HTTP 404/);

  fake.failures['spideymaster661@gmail.com'] = [500, 500, 500, 429];
  await assert.rejects(archive.fetchSource({ uploader: 'spideymaster661@gmail.com' }), /rate limited/);
});

test('searchWithRetry: network errors and non-JSON 200s are retried then reported', async (t) => {
  const fake = await fakeArchive(t, { routes: { '/advancedsearch.php': (req, res) => { res.writeHead(200); res.end('<html>'); } } });
  const archive = createArchive({ base: fake.base, sleep: async () => {} });
  await assert.rejects(archive.searchWithRetry({ q: 'x' }), /HTTP 200/);
  const down = createArchive({ base: 'http://127.0.0.1:1', sleep: async () => {} });
  await assert.rejects(down.searchWithRetry({ q: 'x' }));
});

test('fileList, reviews, URLs', async (t) => {
  const fake = await fakeArchive(t, {
    files: { multi: [{ name: 'a.zip' }, { name: 'b.7z' }, { name: 'setup.exe' }] },
    routes: {
      '/metadata/junk':         (req, res) => { res.writeHead(200); res.end('nope'); },
      '/metadata/junk/reviews': (req, res) => { res.writeHead(200); res.end('nope'); },
    },
  });
  const archive = createArchive({ base: fake.base });
  assert.deepEqual((await archive.fileList('multi')).files.map(f => f.name), ['a.zip', 'b.7z', 'setup.exe']);
  assert.equal((await archive.fileList('junk')).ok, false);
  assert.equal((await createArchive({ base: 'http://127.0.0.1:1' }).fileList('x')).ok, false);
  assert.deepEqual(await archive.reviews('x'), [{ reviewtitle: 'Works', stars: '5' }]);
  assert.deepEqual(await archive.reviews('junk'), []);
  assert.equal(archive.downloadUrl('id', 'dir/a b.zip'), `${fake.base}/download/id/dir/a%20b.zip`);
  assert.equal(archive.thumbUrl('id'), `${fake.base}/services/img/id`);
});

test('installableFiles: archives, or a bare exe only when there is no archive', () => {
  assert.deepEqual(installableFiles([{ name: 'a.ZIP' }, { name: 'b.exe' }, { name: 'c.txt' }]).map(f => f.name), ['a.ZIP']);
  assert.deepEqual(installableFiles([{ name: 'b.exe' }, { name: 'c.txt' }]).map(f => f.name), ['b.exe']);
});

test('default sleep really waits', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(429, { 'retry-after': '0' });
    res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const archive = createArchive({ base: `http://127.0.0.1:${srv.address().port}` });
  const orig = global.setTimeout;
  global.setTimeout = (fn) => orig(fn, 0);  // backoff 2s/4s/8s collapses to ticks
  try {
    await assert.rejects(archive.searchWithRetry({ q: 'x' }), /429/);
  } finally {
    global.setTimeout = orig;
    srv.close();
  }
});
