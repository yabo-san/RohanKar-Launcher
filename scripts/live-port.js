'use strict';
/**
 * Checks against the real GitHub, GitLab and archive.org, which the fixture
 * tests can only imitate. Not part of the test suite: CI runs it as the
 * non-blocking "Live ports" workflow.
 *
 *   node scripts/live-port.js [owner/repo ...] [--uploader email ...] [--bytes N] [--summary file]
 *   node scripts/live-port.js --install [owner/repo ...] [--keep] [--summary file]
 *
 * Check (default, nightly): for every entry in catalog/curated-ports.json
 * except "source only" ones, it resolves the release asset the app would
 * install and downloads only its first 4 KB; for every archive.org uploader
 * the app turns on, it finds one item, picks the smallest file the app would
 * install, and does the same. Each row ends OK, renamed (the repository moved;
 * it still works, but the catalog should follow), no match (nothing in the
 * latest release passes the filter) or HTTP error.
 *
 * --install (by hand, before a release): really installs the Acceptance ports
 * from the brief into a temp folder with the app's own install engine and
 * lists what landed. No game data.
 *
 * --summary appends a markdown table to that file (the job summary in CI).
 * Exits 1 if any row is a no match, an HTTP error or a failed install.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createInstalls, GITHUB_API } = require('../src/backend/installs');
const { createArchive, installableFiles } = require('../src/backend/archive');
const { createSettings } = require('../src/backend/settings');
const { createLibrary } = require('../src/backend/library');
const ports = require('../src/backend/ports');
const { getText, getFollow } = require('../src/backend/net');
const { sourcesFromCatalog } = require('../src/backend/sources');

const ROOT = path.join(__dirname, '..');
const GITLAB_API = 'https://gitlab.com/api/v4';
// The brief's Acceptance ports, installed in full by --install
const ACCEPTANCE = ['Zelda64Recomp/Zelda64Recomp', 'sonicdcer/Starfox64Recomp', 'andrei-drexler/ironwail', 'nstlaurent/DoomLauncher', 'ebkr/r2modmanPlus'];
const DEFAULT_BYTES = 4096;
const FAILED = new Set(['no match', 'HTTP error', 'failed']);

function parseArgs(argv) {
  const repos = [];
  const uploaders = [];
  let bytes = DEFAULT_BYTES;
  let summary = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--uploader') uploaders.push(argv[++i]);
    else if (argv[i] === '--bytes') bytes = Number(argv[++i]) || DEFAULT_BYTES;
    else if (argv[i] === '--summary') summary = argv[++i] || null;
    else if (!argv[i].startsWith('--')) repos.push(argv[i]);
  }
  return { install: argv.includes('--install'), keep: argv.includes('--keep'), repos, uploaders, bytes, summary };
}

const isGitlab = (e) => e.repositorySource === 'gitlab';
// GitLab releases come with #111; until then a GitLab entry is skipped
const gitlabSupported = () => typeof ports.releasesFromGitlab === 'function';

// Why an entry isn't checked, or null
function skipReason(e) {
  if ((e.tags || []).includes('source only')) return 'source only';
  if ((e.tags || []).includes('download page')) return 'download page';
  if (isGitlab(e) && !gitlabSupported()) return 'GitLab releases need #111';
  return null;
}

// A curated-ports.json entry as the catalog item catalogs.items() builds for it
function itemFor(e) {
  return {
    id: `quiver:live:${e.repository.toLowerCase()}`, title: e.name || e.repository, repository: e.repository, entry: e,
    ...(typeof ports.portTraits === 'function' ? ports.portTraits(e) : {}),
  };
}

// The first `bytes` of a URL (following redirects) written to `file`, asking
// for just that range. A server that ignores the range is cut off there.
// { ok, status, written, error? }
function fetchHead(url, file, bytes) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const handle = getFollow(url, {
      kind: 'live', headers: { Range: `bytes=0-${bytes - 1}` },
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
const REDIRECT = [301, 302, 307, 308];

// The latest release of an entry. GitHub answers a moved repository with a
// redirect, followed once and reported as `movedTo` (from the release's own
// URL). { release, movedTo } or { error }
async function latestRelease(e, { githubApi, gitlabApi, token }) {
  const gitlab = isGitlab(e);
  const auth = token && !gitlab ? { Authorization: `Bearer ${token}` } : {};
  const opts = { kind: gitlab ? 'gitlab' : 'github', timeoutMs: 15000, headers: { Accept: gitlab ? 'application/json' : 'application/vnd.github+json', ...auth } };
  let url = gitlab ? ports.gitlabReleasesUrl(gitlabApi, e.repository) : `${githubApi}/repos/${e.repository}/releases?per_page=30`;
  let r = await getText(url, opts);
  let redirected = false;
  if (REDIRECT.includes(r.status) && r.headers.location) {
    url = new URL(r.headers.location, url).toString();
    r = await getText(url, opts);
    redirected = true;
  }
  if (r.status !== 200) return { error: `HTTP ${r.status}${r.error ? ` ${r.error}` : ''} reading releases` };
  let list;
  try { list = JSON.parse(r.body); } catch { return { error: 'releases are not JSON' }; }
  const release = ports.pickRelease(gitlab ? ports.releasesFromGitlab(list) : list);
  if (!release) return { release: null };
  const movedTo = redirected ? (/github\.com\/([^/]+\/[^/]+)\/releases/.exec(release.html_url || '')?.[1] || 'a new name') : null;
  return { release, movedTo };
}

// One port: the asset the app would pick, and its first bytes on disk → a row
async function checkPort(e, { dir, bytes, githubApi, gitlabApi, token }) {
  const row = { entry: `${e.name} (${e.repository})`, asset: '' };
  const skip = skipReason(e);
  if (skip) return { ...row, status: 'skipped', detail: skip };
  const { release, movedTo, error } = await latestRelease(e, { githubApi, gitlabApi, token });
  if (error) return { ...row, status: 'HTTP error', detail: error };
  if (!release) return { ...row, status: 'no match', detail: 'no published release' };
  const pick = ports.pickAsset(release.assets, { pattern: e.assetPattern, filter: e.releaseAssetFilter });
  if (!pick.asset) return { ...row, status: 'no match', detail: `${release.tag_name}: ${pick.names.join(', ') || 'no assets'}` };
  row.asset = `${pick.asset.name} (${release.tag_name})`;
  const got = await fetchHead(pick.asset.browser_download_url, path.join(dir, 'ports', safe(e.repository), safe(pick.asset.name)), bytes);
  if (!got.ok) return { ...row, status: 'HTTP error', detail: `download: ${got.error}` };
  if (movedTo) return { ...row, status: 'renamed', detail: `now ${movedTo}` };
  return { ...row, status: 'OK', detail: `${got.written} bytes` };
}

// One uploader: one item, the smallest file the app would install, its first bytes on disk → a row
async function checkUploader(uploader, { dir, bytes, archive }) {
  const row = { entry: `archive.org ${uploader}`, asset: '' };
  let json;
  try {
    json = await archive.searchWithRetry({ q: `uploader:${uploader} mediatype:software`, fl: 'identifier', rows: '1', page: '1', output: 'json' });
  } catch (err) {
    return { ...row, status: 'HTTP error', detail: `search: ${err.message}` };
  }
  const id = json?.response?.docs?.[0]?.identifier;
  if (!id) return { ...row, status: 'no match', detail: 'no items' };
  const item = await archive.item(id);
  if (!item.ok) return { ...row, status: 'HTTP error', detail: `metadata of ${id}: ${item.error}` };
  const [smallest] = installableFiles(item.files).sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
  if (!smallest) return { ...row, status: 'no match', detail: `${id} has nothing installable` };
  row.asset = `${id}/${smallest.name}`;
  const got = await fetchHead(archive.downloadUrl(id, smallest.name), path.join(dir, 'archive', safe(id), safe(smallest.name)), bytes);
  if (!got.ok) return { ...row, status: 'HTTP error', detail: `download: ${got.error}` };
  return { ...row, status: 'OK', detail: `${got.written} bytes` };
}

// One full install with the app's engine → a row
async function installPort(e, { installs, print }) {
  const row = { entry: `${e.name} (${e.repository})`, asset: '' };
  const skip = skipReason(e);
  if (skip) return { ...row, status: 'skipped', detail: skip };
  const started = installs.startPort({ item: itemFor(e) });
  if (!started.ok) return { ...row, status: 'failed', detail: started.detail || started.error || "couldn't start" };
  const id = started.jobs[0].id;
  let last = '';
  const tick = setInterval(() => {
    const j = installs.get(id);
    const line = `${j.step || ''} ${j.status} ${j.percent}%${j.file ? ` ${j.file}` : ''}`;
    if (line !== last) print(`  ${(last = line)}`);
  }, 2000);
  await installs.wait(id);
  clearInterval(tick);
  const job = installs.get(id);
  row.asset = job.file || '';
  if (job.status !== 'done') return { ...row, status: 'failed', detail: `at ${job.step || 'start'}: ${job.error}` };
  print(tree(job.installDir).map(l => `  ${l}`).join('\n'));
  return { ...row, status: 'OK', detail: `exe ${job.exePath ? path.basename(job.exePath) : '(several or none)'}` };
}

function tree(dir, depth = 0, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    out.push(`${'  '.repeat(depth)}${d.name}${d.isDirectory() ? '/' : ` (${fs.statSync(p).size} bytes)`}`);
    if (d.isDirectory() && depth < 1) tree(p, depth + 1, out);
  }
  return out;
}

const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// Rows → the markdown table for the job summary
function summaryTable(title, rows) {
  const failed = rows.filter(r => FAILED.has(r.status)).length;
  return [
    `## ${title}`, '',
    `${rows.length} checked, ${failed} failed`, '',
    '| Entry | Asset picked | Result |',
    '|---|---|---|',
    ...rows.map(r => `| ${cell(r.entry)} | ${cell(r.asset) || '-'} | ${cell(r.status)}${r.detail ? `: ${cell(r.detail)}` : ''} |`),
    '',
  ].join('\n');
}

async function run(opts, {
  print = (l) => console.log(l),
  catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'curated-ports.json'), 'utf8')),
  uploadersCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'uploaders.json'), 'utf8')),
  githubApi = GITHUB_API,
  gitlabApi = GITLAB_API,
  archiveBase = 'https://archive.org',
  token = process.env.GITHUB_TOKEN || '',
} = {}) {
  const apps = catalog.apps || [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-port-'));
  const wanted = opts.repos?.length ? opts.repos : opts.install ? ACCEPTANCE : apps.filter(e => e.repository).map(e => e.repository);
  const rows = [];
  const report = (row) => { rows.push(row); print(`${row.status.padEnd(10)} ${row.entry}${row.asset ? ` → ${row.asset}` : ''}${row.detail ? ` (${row.detail})` : ''}`); };
  const find = (repo) => apps.find(e => e.repository?.toLowerCase() === repo.toLowerCase());
  const unlisted = (repo) => ({ entry: repo, asset: '', status: 'no match', detail: 'not in catalog/curated-ports.json' });
  try {
    if (opts.install) {
      const settings = createSettings(path.join(dir, 'settings.json'));
      settings.save({ installPath: path.join(dir, 'games'), downloadPath: path.join(dir, 'dl') });
      const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
      const installs = createInstalls({ settings, library, archive: createArchive({ base: archiveBase, log: () => {} }), gamesDir: dir, log: () => {}, githubApi, ...(gitlabSupported() ? { gitlabApi } : {}) });
      try {
        for (const repo of wanted) {
          const e = find(repo);
          print(`\n== ${repo}`);
          report(e ? await installPort(e, { installs, print }) : unlisted(repo));
        }
      } finally {
        library.close();
      }
    } else {
      const archive = createArchive({ base: archiveBase, log: () => {} });
      const uploaders = opts.uploaders?.length ? opts.uploaders
        : sourcesFromCatalog(uploadersCatalog).filter(s => s.enabled).map(s => s.uploader);
      for (const repo of wanted) {
        const e = find(repo);
        report(e ? await checkPort(e, { dir, bytes: opts.bytes || DEFAULT_BYTES, githubApi, gitlabApi, token }) : unlisted(repo));
      }
      for (const u of uploaders) report(await checkUploader(u, { dir, bytes: opts.bytes || DEFAULT_BYTES, archive }));
    }
  } finally {
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
  const table = summaryTable(opts.install ? 'Live ports: full installs' : 'Live ports: first 4 KB of every curated port and uploader', rows);
  if (opts.summary) fs.appendFileSync(opts.summary, `${table}\n`);
  const failed = rows.filter(r => FAILED.has(r.status)).length;
  print(`\n${failed ? `${failed} failed` : 'all passed'}`);
  return failed;
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then((failed) => process.exit(failed ? 1 : 0))
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, skipReason, itemFor, fetchHead, summaryTable, run, ACCEPTANCE, DEFAULT_BYTES };
