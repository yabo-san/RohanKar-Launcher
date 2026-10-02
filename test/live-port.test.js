'use strict';
// scripts/live-port.js against local stand-ins for GitHub and archive.org
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ports = require('../src/backend/ports');
const { parseArgs, skipReason, itemFor, fetchHead, summaryTable, run, ACCEPTANCE, DEFAULT_BYTES } = require('../scripts/live-port');
const { fakeArchive, tmpDir, makeZip } = require('./backend/helpers');

const BIG = Buffer.alloc(64 * 1024, 1);
const CURATED = require('../catalog/curated-ports.json');

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

// body, or a function returning it, so it can name the fake server's own URL
const releases = (body) => (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(typeof body === 'function' ? body() : body)); };

test('live-port: check mode by default; --install, repos, uploaders, --bytes, --summary and --keep from the command line', () => {
  assert.deepEqual(parseArgs([]), { install: false, keep: false, repos: [], uploaders: [], bytes: DEFAULT_BYTES, summary: null });
  assert.deepEqual(parseArgs(['--install', 'a/b', '--uploader', 'x@y', '--bytes', '10', '--summary', 's.md', '--keep']),
    { install: true, keep: true, repos: ['a/b'], uploaders: ['x@y'], bytes: 10, summary: 's.md' });
  assert.equal(parseArgs(['--bytes', 'nope']).bytes, DEFAULT_BYTES);
});

test('live-port: the Acceptance ports are curated entries that can be installed', () => {
  for (const repo of ACCEPTANCE) {
    const e = CURATED.apps.find(a => a.repository === repo);
    assert.ok(e, `${repo} is in catalog/curated-ports.json`);
    assert.ok(!(e.tags || []).includes('source only'), `${repo} has a release to install`);
  }
});

test('live-port: source-only entries are skipped, and GitLab ones until GitLab releases exist', () => {
  assert.equal(skipReason({ tags: ['source only'] }), 'source only');
  assert.equal(skipReason({ tags: ['recomp'] }), null);
  assert.equal(skipReason({ repositorySource: 'gitlab' }), typeof ports.releasesFromGitlab === 'function' ? null : 'GitLab releases need #111');
  const item = itemFor({ name: 'Game', repository: 'Owner/Repo', folderName: 'G' });
  assert.deepEqual([item.id, item.title, item.repository, item.entry.folderName], ['quiver:live:owner/repo', 'Game', 'Owner/Repo', 'G']);
  assert.equal(itemFor({ repository: 'a/b' }).title, 'a/b');
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

test('live-port: every curated port and turned-on uploader gets a row; the table goes to the summary file', async (t) => {
  const auth = [];
  const fake = await fakeArchive(t, {
    search: { 'u@x': [{ identifier: 'rk-tiny' }] },
    files:  { 'rk-tiny': [{ name: 'big.zip', size: '900' }, { name: 'small.zip', size: '10' }, { name: 'readme.txt', size: '1' }] },
    routes: {
      '/repos/o/pd/releases': (req, res) => {
        auth.push(req.headers.authorization);
        releases(() => [
          { tag_name: 'v2', draft: true, assets: [] },
          { tag_name: 'v1', assets: [{ name: 'pd-linux.AppImage', browser_download_url: `${fake.base}/x` }, { name: 'pd-windows.zip', browser_download_url: `${fake.base}/gh/pd-windows.zip` }] },
        ])(req, res);
      },
      // A moved repository: GitHub redirects its API to the new one
      '/repos/old/name/releases': (req, res) => { res.writeHead(301, { location: '/repositories/7/releases' }); res.end(); },
      '/repositories/7/releases': releases(() => [{ tag_name: 'v3', html_url: 'https://github.com/new/name/releases/tag/v3', assets: [{ name: 'game-win64.zip', browser_download_url: `${fake.base}/gh/pd-windows.zip` }] }]),
      '/gh/pd-windows.zip': serveBig(),
      '/download/rk-tiny/small.zip': serveBig(),
    },
  });
  const lines = [];
  const catalog = { apps: [
    { name: 'Perfect Dark', repository: 'o/pd' },
    { name: 'Moved', repository: 'old/name' },
    { name: 'Zelda3', repository: 'o/z3', tags: ['source only'] },
  ] };
  const summary = path.join(tmpDir(t), 'summary.md');
  const failed = await run({ repos: [], uploaders: [], bytes: 512, summary }, {
    print: (l) => lines.push(l), catalog, githubApi: fake.base, archiveBase: fake.base, token: 'tok',
    uploadersCatalog: { uploaders: [{ handle: 'u', uploaderEmail: 'u@x', launcher: true }, { handle: 'off', uploaderEmail: 'off@x' }] },
  });
  assert.equal(failed, 0, lines.join('\n'));
  assert.deepEqual(auth, ['Bearer tok']);
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /4 checked, 0 failed/);
  assert.match(md, /\| Perfect Dark \(o\/pd\) \| pd-windows\.zip \(v1\) \| OK: 512 bytes \|/);
  assert.match(md, /\| Moved \(old\/name\) \| game-win64\.zip \(v3\) \| renamed: now new\/name \|/);
  assert.match(md, /\| Zelda3 \(o\/z3\) \| - \| skipped: source only \|/);
  assert.match(md, /\| archive\.org u@x \| rk-tiny\/small\.zip \| OK: 512 bytes \|/);
  assert.doesNotMatch(md, /off@x/, 'uploaders the app leaves off are not checked');
});

test('live-port: no match and HTTP errors are counted and named', async (t) => {
  const fake = await fakeArchive(t, {
    search: { 'empty@x': [], 'bad@x': [{ identifier: 'rk-txt' }] },
    files:  { 'rk-txt': [{ name: 'readme.txt', size: '1' }] },
    routes: {
      '/repos/o/linux/releases': releases([{ tag_name: 'v1', assets: [{ name: 'a.AppImage', browser_download_url: 'x' }] }]),
      '/repos/o/none/releases':  releases([]),
      '/repos/o/404/releases':   (req, res) => { res.writeHead(404); res.end('{}'); },
      '/repos/o/junk/releases':  (req, res) => { res.writeHead(200); res.end('<html>'); },
      '/repos/o/gone/releases':  releases(() => [{ tag_name: 'v1', assets: [{ name: 'game-windows.zip', browser_download_url: `${fake.base}/missing` }] }]),
    },
  });
  const lines = [];
  const apps = ['linux', 'none', '404', 'junk', 'gone'].map(n => ({ name: n, repository: `o/${n}` }));
  const failed = await run({ repos: [...apps.map(a => a.repository), 'o/unlisted'], uploaders: ['empty@x', 'bad@x', 'nofixture@x'], bytes: 16 }, {
    print: (l) => lines.push(l), catalog: { apps }, githubApi: fake.base, archiveBase: fake.base, token: '',
  });
  const out = lines.join('\n');
  assert.equal(failed, 9, out);
  assert.match(out, /no match +linux \(o\/linux\) \(v1: a\.AppImage\)/);
  assert.match(out, /no match +none \(o\/none\) \(no published release\)/);
  assert.match(out, /HTTP error +404 \(o\/404\) \(HTTP 404 reading releases\)/);
  assert.match(out, /HTTP error +junk \(o\/junk\) \(releases are not JSON\)/);
  assert.match(out, /HTTP error +gone \(o\/gone\) → game-windows\.zip \(v1\) \(download: HTTP 404\)/);
  assert.match(out, /no match +o\/unlisted \(not in catalog\/curated-ports\.json\)/);
  assert.match(out, /no match +archive\.org empty@x \(no items\)/);
  assert.match(out, /no match +archive\.org bad@x \(rk-txt has nothing installable\)/);
  assert.match(out, /HTTP error +archive\.org nofixture@x \(search: HTTP 404\)/);
  assert.match(out, /9 failed/);
});

test('live-port: --install installs the port for real with the app engine and lists what landed', async (t) => {
  const fake = await fakeArchive(t, {
    routes: {
      '/repos/o/pd/releases': releases(() => [{ tag_name: 'v1', assets: [{ name: 'pd-windows.zip', browser_download_url: `${fake.base}/gh/pd.zip` }] }]),
      '/repos/o/bad/releases': releases([{ tag_name: 'v1', assets: [{ name: 'a.AppImage', browser_download_url: 'x' }] }]),
      '/gh/pd.zip': (req, res) => { const z = makeZip({ 'pd.exe': 'MZ', 'data/readme.txt': 'hi' }); res.writeHead(200, { 'content-length': z.length }); res.end(z); },
    },
  });
  const lines = [];
  const summary = path.join(tmpDir(t), 'summary.md');
  const failed = await run({ install: true, repos: ['o/pd', 'o/bad', 'o/src'], summary }, {
    print: (l) => lines.push(l), githubApi: fake.base, archiveBase: fake.base,
    catalog: { apps: [{ name: 'PD', repository: 'o/pd', folderName: 'PD' }, { name: 'Bad', repository: 'o/bad' }, { name: 'Src', repository: 'o/src', tags: ['source only'] }] },
  });
  const out = lines.join('\n');
  assert.equal(failed, 1, out);
  assert.match(out, /pd\.exe \(2 bytes\)/);
  assert.match(out, /data\//);
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /## Live ports: full installs/);
  assert.match(md, /\| PD \(o\/pd\) \| pd-windows\.zip \| OK: exe pd\.exe \|/);
  assert.match(md, /\| Bad \(o\/bad\) \| - \| failed: at binary: No Windows build/);
  assert.match(md, /\| Src \(o\/src\) \| - \| skipped: source only \|/);
});

test('live-port: table cells escape pipes and newlines', () => {
  const md = summaryTable('T', [{ entry: 'a|b', asset: 'x\ny', status: 'OK', detail: '' }]);
  assert.match(md, /\| a\\\|b \| x y \| OK \|/);
  assert.match(md, /1 checked, 0 failed/);
});
