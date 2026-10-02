'use strict';
/**
 * A check against the real GitHub and archive.org, which the fixture tests can
 * only imitate. Not part of the test suite: CI runs it as the non-blocking
 * "live ports" job.
 *
 *   node scripts/live-port.js [owner/repo ...] [--uploader email ...] [--bytes N] [--keep]
 *
 * For each port from catalog/curated-ports.json (default: Perfect Dark) it reads the releases, picks the asset the app would install,
 * and downloads only its first few KB to a temp folder. For each archive.org
 * uploader (default: the first one the app turns on) it finds one item, picks
 * the smallest file the app would install, and does the same. So it proves the
 * URLs answer and a file lands on disk, without downloading a game.
 * Exits 1 if any check fails.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { GITHUB_API } = require('../src/backend/installs');
const { createArchive, installableFiles } = require('../src/backend/archive');
const { pickRelease, pickAsset } = require('../src/backend/ports');
const { getText, getFollow } = require('../src/backend/net');
const { sourcesFromCatalog } = require('../src/backend/sources');

const ROOT = path.join(__dirname, '..');
const DEFAULT_REPOS = ['perfect-dark-pc-port/perfect_dark'];
const DEFAULT_BYTES = 4096;

function parseArgs(argv) {
  const repos = [];
  const uploaders = [];
  let bytes = DEFAULT_BYTES;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--uploader') uploaders.push(argv[++i]);
    else if (argv[i] === '--bytes') bytes = Number(argv[++i]) || DEFAULT_BYTES;
    else if (argv[i] === '--keep') keep = true;
    else if (!argv[i].startsWith('--')) repos.push(argv[i]);
  }
  return { repos: repos.length ? repos : DEFAULT_REPOS, uploaders, bytes, keep };
}

// The first `bytes` of a URL (following redirects) written to `file`, asking
// for just that range. A server that ignores the range is cut off there.
// { ok, status, written, error? }
function fetchHead(url, file, bytes, { headers = {} } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const handle = getFollow(url, {
      kind: 'live', headers: { ...headers, Range: `bytes=0-${bytes - 1}` },
      onError: (e) => finish({ ok: false, status: 0, written: 0, error: e.message }),
      onResponse: (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return finish({ ok: false, status: res.statusCode, written: 0, error: `HTTP ${res.statusCode}` });
        }
        const chunks = [];
        let got = 0;
        const done = () => {
          const body = Buffer.concat(chunks).subarray(0, bytes);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, body);
          finish({ ok: body.length > 0, status: res.statusCode, written: body.length, ...(body.length ? {} : { error: 'empty response' }) });
        };
        res.on('data', (c) => {
          chunks.push(c);
          got += c.length;
          if (got >= bytes) { handle.aborted = true; res.destroy(); done(); }
        });
        res.on('end', done);
        res.on('error', (e) => finish({ ok: false, status: res.statusCode, written: 0, error: e.message }));
      },
    });
  });
}

const safe = (s) => s.replace(/[^\w.-]+/g, '_');

// One port: releases → the asset the app would pick → its first bytes on disk
async function checkPort(app, { dir, bytes, githubApi, token, print }) {
  print(`\n== ${app.name} (${app.repository})`);
  if ((app.tags || []).includes('source only')) { print('skipped: source only, nothing to install'); return 0; }
  if (app.repositorySource && app.repositorySource !== 'github') {
    print(`skipped: ${app.repositorySource} releases aren't checked here`);
    return 0;
  }
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const r = await getText(`${githubApi}/repos/${app.repository}/releases?per_page=30`, {
    kind: 'github', timeoutMs: 15000, headers: { Accept: 'application/vnd.github+json', ...auth },
  });
  if (r.status !== 200) { print(`FAILED: releases HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`); return 1; }
  const release = pickRelease(JSON.parse(r.body));
  if (!release) { print('FAILED: no published release'); return 1; }
  const pick = pickAsset(release.assets, { pattern: app.assetPattern, filter: app.releaseAssetFilter });
  if (!pick.asset) { print(`FAILED: ${pick.error} (${release.tag_name}): ${pick.names.join(', ') || 'no assets'}`); return 1; }
  print(`release ${release.tag_name}, asset ${pick.asset.name} (${pick.asset.size ?? '?'} bytes)`);
  const file = path.join(dir, 'github', safe(app.repository), pick.asset.name);
  const got = await fetchHead(pick.asset.browser_download_url, file, bytes);
  print(got.ok ? `wrote ${got.written} bytes to ${file} (HTTP ${got.status})` : `FAILED: download ${got.error}`);
  return got.ok ? 0 : 1;
}

// One uploader: search → one item → the smallest file the app would install → its first bytes on disk
async function checkUploader(uploader, { dir, bytes, archive, print }) {
  print(`\n== archive.org uploader ${uploader}`);
  let json;
  try {
    json = await archive.searchWithRetry({ q: `uploader:${uploader} mediatype:software`, fl: 'identifier', rows: '1', page: '1', output: 'json' });
  } catch (e) {
    print(`FAILED: search ${e.message}`);
    return 1;
  }
  const id = json?.response?.docs?.[0]?.identifier;
  if (!id) { print('FAILED: no items'); return 1; }
  const item = await archive.item(id);
  if (!item.ok) { print(`FAILED: metadata of ${id}: ${item.error}`); return 1; }
  const [smallest] = installableFiles(item.files).sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
  if (!smallest) { print(`FAILED: ${id} has nothing installable`); return 1; }
  print(`item ${id}, file ${smallest.name} (${smallest.size ?? '?'} bytes)`);
  const file = path.join(dir, 'archive', safe(id), safe(smallest.name));
  const got = await fetchHead(archive.downloadUrl(id, smallest.name), file, bytes);
  print(got.ok ? `wrote ${got.written} bytes to ${file} (HTTP ${got.status})` : `FAILED: download ${got.error}`);
  return got.ok ? 0 : 1;
}

async function run(opts, {
  print = (l) => console.log(l),
  catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'curated-ports.json'), 'utf8')),
  uploadersCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'uploaders.json'), 'utf8')),
  githubApi = GITHUB_API,
  archiveBase = 'https://archive.org',
  token = process.env.GITHUB_TOKEN || '',
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-port-'));
  const archive = createArchive({ base: archiveBase, log: () => {} });
  const uploaders = opts.uploaders?.length ? opts.uploaders
    : sourcesFromCatalog(uploadersCatalog).filter(s => s.enabled).slice(0, 1).map(s => s.uploader);
  let failed = 0;
  try {
    for (const repo of opts.repos) {
      const app = (catalog.apps || []).find(a => a.repository?.toLowerCase() === repo.toLowerCase());
      if (!app) { print(`\n== ${repo}\nFAILED: not in catalog/curated-ports.json`); failed++; continue; }
      failed += await checkPort(app, { dir, bytes: opts.bytes, githubApi, token, print });
    }
    for (const u of uploaders) failed += await checkUploader(u, { dir, bytes: opts.bytes, archive, print });
  } finally {
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
  print(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  return failed;
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then((failed) => process.exit(failed ? 1 : 0))
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, fetchHead, run, DEFAULT_REPOS, DEFAULT_BYTES };
