'use strict';
// scripts/live-port.js against local stand-ins for GitHub and archive.org
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, fetchHead, run, DEFAULT_REPOS, DEFAULT_BYTES } = require('../scripts/live-port');
const { fakeArchive, tmpDir } = require('./backend/helpers');

const BIG = Buffer.alloc(64 * 1024, 1);

// Serves BIG, honouring Range like GitHub's and archive.org's CDNs, or ignoring it
function serveBig({ honourRange = true, seen = [] } = {}) {
  return (req, res) => {
    seen.push(req.headers.range);
    const m = honourRange && /^bytes=0-(\d+)$/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-length': BIG.length }); return res.end(BIG); }
    const part = BIG.subarray(0, Number(m[1]) + 1);
    res.writeHead(206, { 'content-length': part.length });
    res.end(part);
  };
}

test('live-port: two curated ports by default; repos, uploaders, --bytes and --keep from the command line', () => {
  assert.deepEqual(parseArgs([]), { repos: DEFAULT_REPOS, uploaders: [], bytes: DEFAULT_BYTES, keep: false });
  assert.deepEqual(parseArgs(['a/b', '--uploader', 'x@y', '--bytes', '10', '--keep']), { repos: ['a/b'], uploaders: ['x@y'], bytes: 10, keep: true });
  assert.equal(parseArgs(['--bytes', 'nope']).bytes, DEFAULT_BYTES);
});

test('live-port: fetchHead asks for a range and writes only that many bytes, even when the server sends everything', async (t) => {
  const seen = [];
  const fake = await fakeArchive(t, { routes: {
    '/ranged': serveBig({ seen }),
    '/whole':  serveBig({ honourRange: false }),
    '/hop':    (req, res) => { res.writeHead(302, { location: '/ranged' }); res.end(); },
    '/gone':   (req, res) => { res.writeHead(404); res.end(); },
    '/empty':  (req, res) => { res.writeHead(200); res.end(); },
  } });
  const dir = tmpDir(t);
  const f = (n) => path.join(dir, 'sub', n);

  assert.deepEqual(await fetchHead(`${fake.base}/hop`, f('a'), 100), { ok: true, status: 206, written: 100 });
  assert.equal(fs.statSync(f('a')).size, 100);
  assert.deepEqual(seen, ['bytes=0-99']);
  assert.deepEqual(await fetchHead(`${fake.base}/whole`, f('b'), 100), { ok: true, status: 200, written: 100 });
  assert.equal(fs.statSync(f('b')).size, 100);
  assert.deepEqual(await fetchHead(`${fake.base}/gone`, f('c'), 100), { ok: false, status: 404, written: 0, error: 'HTTP 404' });
  assert.deepEqual(await fetchHead(`${fake.base}/empty`, f('d'), 100), { ok: false, status: 200, written: 0, error: 'empty response' });
  assert.equal((await fetchHead('http://127.0.0.1:1/', f('e'), 100)).ok, false);
});

test('live-port: a port and an uploader each land their first bytes on disk', async (t) => {
  const auth = [];
  const fake = await fakeArchive(t, {
    search: { 'u@x': [{ identifier: 'rk-tiny' }] },
    files:  { 'rk-tiny': [{ name: 'big.zip', size: '900' }, { name: 'small.zip', size: '10' }, { name: 'readme.txt', size: '1' }] },
    routes: {
      '/repos/o/pd/releases': (req, res) => {
        auth.push(req.headers.authorization);
        res.writeHead(200);
        res.end(JSON.stringify([
          { tag_name: 'v2', draft: true, assets: [] },
          { tag_name: 'v1', assets: [{ name: 'pd-linux.AppImage', browser_download_url: `${fake.base}/x` }, { name: 'pd-windows.zip', size: BIG.length, browser_download_url: `${fake.base}/gh/pd-windows.zip` }] },
        ]));
      },
      '/gh/pd-windows.zip': serveBig(),
      '/download/rk-tiny/small.zip': serveBig(),
    },
  });
  const lines = [];
  const catalog = { apps: [
    { name: 'Perfect Dark', repository: 'o/pd' },
    { name: 'Star Fox 64', repository: 'o/sf', repositorySource: 'gitlab' },
    { name: 'Zelda3', repository: 'o/z3', tags: ['source only'] },
  ] };
  const failed = await run({ repos: ['O/PD', 'o/sf', 'o/z3'], uploaders: [], bytes: 512, keep: true }, {
    print: (l) => lines.push(l), catalog, githubApi: fake.base, archiveBase: fake.base, token: 'tok',
    uploadersCatalog: { uploaders: [{ handle: 'u', uploaderEmail: 'u@x', launcher: true }, { handle: 'off', uploaderEmail: 'off@x' }] },
  });
  const out = lines.join('\n');
  assert.equal(failed, 0, out);
  assert.deepEqual(auth, ['Bearer tok']);
  assert.match(out, /release v1, asset pd-windows\.zip/);
  assert.match(out, /skipped: gitlab/);
  assert.match(out, /skipped: source only/);
  assert.match(out, /item rk-tiny, file small\.zip \(10 bytes\)/);
  assert.match(out, /all checks passed/);
  const written = [...out.matchAll(/wrote 512 bytes to (\S+)/g)].map(m => m[1]);
  assert.equal(written.length, 2);
  for (const f of written) assert.equal(fs.statSync(f).size, 512);
  fs.rmSync(path.dirname(path.dirname(path.dirname(written[0]))), { recursive: true, force: true });
});

test('live-port: each failure is counted and named', async (t) => {
  const fake = await fakeArchive(t, {
    search: { 'empty@x': [], 'bad@x': [{ identifier: 'rk-txt' }] },
    files:  { 'rk-txt': [{ name: 'readme.txt', size: '1' }] },
    routes: {
      '/repos/o/linux/releases': (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ tag_name: 'v1', assets: [{ name: 'a.AppImage', browser_download_url: 'x' }] }])); },
      '/repos/o/none/releases':  (req, res) => { res.writeHead(200); res.end('[]'); },
      '/repos/o/404/releases':   (req, res) => { res.writeHead(404); res.end('{}'); },
      '/repos/o/gone/releases':  (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ tag_name: 'v1', assets: [{ name: 'game-windows.zip', browser_download_url: `${fake.base}/missing` }] }])); },
    },
  });
  const lines = [];
  const apps = ['linux', 'none', '404', 'gone'].map(n => ({ name: n, repository: `o/${n}` }));
  const failed = await run({ repos: ['o/linux', 'o/none', 'o/404', 'o/gone', 'o/unlisted'], uploaders: ['empty@x', 'bad@x', 'nofixture@x'], bytes: 16 }, {
    print: (l) => lines.push(l), catalog: { apps }, githubApi: fake.base, archiveBase: fake.base, token: '',
  });
  const out = lines.join('\n');
  assert.equal(failed, 8, out);
  assert.match(out, /FAILED: No Windows build/);
  assert.match(out, /FAILED: no published release/);
  assert.match(out, /FAILED: releases HTTP 404/);
  assert.match(out, /FAILED: download HTTP 404/);
  assert.match(out, /FAILED: not in catalog\/curated-ports\.json/);
  assert.match(out, /FAILED: no items/);
  assert.match(out, /FAILED: rk-txt has nothing installable/);
  assert.match(out, /FAILED: search HTTP 404/);
  assert.match(out, /8 check\(s\) failed/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('live-port-') && fs.existsSync(path.join(os.tmpdir(), n, 'github', 'o_gone'))), []);
});
