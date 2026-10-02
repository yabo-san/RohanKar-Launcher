'use strict';
/**
 * A real port install against the real GitHub and archive.org, for the ports
 * the fixtures can only imitate (Perfect Dark first). Not part of the test
 * suite: CI runs it as the non-blocking "live ports" job.
 *
 *   node scripts/live-port.js [owner/repo ...] [--keep] [--ia item[:regex] ...] [--zip item/file.zip ...]
 *
 * For each repository (or, archive.org-only, name) in catalog/collisions.json (default: Perfect Dark and Dusklight) it
 * prints the releases GitHub returns and the asset it would pick, then
 * installs the port into a temp folder with the same install engine the app
 * uses, lists what landed and checks it against EXPECT (on Windows it also
 * tries starting the exe). --ia lists an archive.org item's files (those
 * whose path matches the regex), to find the file a collision should use.
 * Exits 1 if any install fails or misses a file it should have.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createInstalls, GITHUB_API } = require('../src/backend/installs');
const { createArchive } = require('../src/backend/archive');
const { createSettings } = require('../src/backend/settings');
const { createLibrary } = require('../src/backend/library');
const { getText } = require('../src/backend/net');
const { itemData } = require('../src/backend/catalogs');

const ROOT = path.join(__dirname, '..');
const DEFAULT = ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight', 'ZDoom/Raze'];

// What a good install of each default port holds: files found anywhere in the
// install folder (case-insensitive), with a sha1 or a minimum size where one
// is known. The exe the collision names must be there too.
const EXPECT = {
  'perfect-dark-pc-port/perfect_dark': [{ path: 'data/pd.ntsc-final.z64', sha1: 'af8788ac4d1a57260eae9c53ffe851fcf2a3319b' }],
  'twilitrealm/dusklight': [{ name: 'Legend of Zelda, The - Twilight Princess (USA).ciso', minSize: 1_000_000_000 }],
  'zdoom/raze': [{ name: 'raze.pk3' }, { name: 'DUKE3D.GRP' }, { name: 'BLOOD.RFF' }],
};

function parseArgs(argv) {
  const ia = [];
  const zips = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ia') ia.push(argv[++i]);
    else if (argv[i] === '--zip') zips.push(argv[++i]);
    else rest.push(argv[i]);
  }
  const repos = rest.filter(a => !a.startsWith('--'));
  return { repos: repos.length ? repos : DEFAULT, keep: rest.includes('--keep'), ia, zips };
}

// "item" or "item:regex" → the item's files whose path matches, to pick a data source from
async function listIa(spec, print) {
  const at = spec.indexOf(':');
  const id = at < 0 ? spec : spec.slice(0, at);
  const match = at < 0 ? null : new RegExp(spec.slice(at + 1).replace(/^\(\?i\)/, ''), /^\(\?i\)/.test(spec.slice(at + 1)) ? 'i' : '');
  const r = await getText(`https://archive.org/metadata/${encodeURIComponent(id)}`, { kind: 'archive' });
  print(`\n== archive.org ${id}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  if (r.status !== 200) return 1;
  const meta = JSON.parse(r.body);
  const files = meta.files || [];
  print(`uploader ${meta.metadata?.uploader || '?'}, title ${meta.metadata?.title || '?'}`);
  const hits = files.filter(f => !match || match.test(f.name));
  print(`${files.length} files, ${hits.length} match`);
  for (const f of hits.slice(0, 200)) print(`  ${f.name} (${f.size || '?'} bytes, sha1 ${f.sha1 || '?'})`);
  return 0;
}

// A collision as the catalog item catalogs.items() would build for it
function itemFor(c) {
  return {
    id: `quiver:live:${(c.repository || c.name).toLowerCase()}`, title: c.name || c.repository, repository: c.repository || null,
    entry: { folderName: c.folderName || '', ...(c.releaseAssetFilter ? { releaseAssetFilter: c.releaseAssetFilter } : {}) },
    data: itemData(c), // as the app's port shelves hand it to the install
  };
}

function tree(dir, depth = 0, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const size = e.isDirectory() ? 0 : fs.statSync(p).size;
    // sha1 for the small files, so a staged ROM can be checked against a known dump
    const sum = !e.isDirectory() && size < 128 * 1024 * 1024 ? `, sha1 ${require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex')}` : '';
    out.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ` (${size} bytes${sum})`}${/\.(z64|n64|v64)$/i.test(e.name) ? `, ${n64Header(p)}` : ''}`);
    if (e.isDirectory() && depth < 2) tree(p, depth + 1, out);
  }
  return out;
}

// An N64 ROM's byte order and header, so a dump can be told apart from a byteswapped copy or another revision
function n64Header(file) {
  const b = Buffer.alloc(64);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, 64, 0); } finally { fs.closeSync(fd); }
  const magic = b.readUInt32BE(0).toString(16);
  const order = { 80371240: 'z64 (big-endian)', 37804012: 'v64 (byteswapped)', 40123780: 'n64 (little-endian)' }[magic] || `unknown order ${magic}`;
  if (!order.startsWith('z64')) return order;
  return `${order}, title "${b.toString('latin1', 0x20, 0x34).trim()}", code ${b.toString('latin1', 0x3b, 0x3f)}, rev ${b[0x3f]}`;
}

// Every file under dir, relative, forward slashes
function allFiles(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) allFiles(dir, r, out); else out.push(r);
  }
  return out;
}

// The install checked against EXPECT and the collision's exe → problems, empty when it's good
function checkInstall(dir, c, expect = EXPECT[String(c.repository).toLowerCase()] || []) {
  const files = allFiles(dir);
  const errs = [];
  const want = [...(c.exe ? [{ path: c.exe }] : []), ...expect];
  for (const w of want) {
    const hit = w.path ? files.find(f => f.toLowerCase() === w.path.toLowerCase()) : files.find(f => path.posix.basename(f).toLowerCase() === w.name.toLowerCase());
    if (!hit) { errs.push(`${w.path || w.name} is missing`); continue; }
    const p = path.join(dir, hit);
    if (w.minSize && fs.statSync(p).size < w.minSize) errs.push(`${hit} is ${fs.statSync(p).size} bytes, expected at least ${w.minSize}`);
    if (w.sha1) {
      const sum = require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
      if (sum !== w.sha1) errs.push(`${hit} has sha1 ${sum}, expected ${w.sha1}`);
    }
  }
  return errs;
}

// Windows only: starts the exe and says whether it's still running after a
// few seconds (a game that can't find its data usually quits at once). Only
// reported: a CI runner has no GPU, so a crash here isn't proof of a bad install
async function tryLaunch(exe, print, seconds = 8) {
  if (process.platform !== 'win32' || !exe) return;
  const { spawn } = require('child_process');
  const child = spawn(exe, [], { cwd: path.dirname(exe), stdio: 'ignore' });
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), seconds * 1000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: e.message }); });
  });
  if (exited) print(`launch: ${path.basename(exe)} exited within ${seconds}s (code ${exited.code})`);
  else { print(`launch: ${path.basename(exe)} still running after ${seconds}s`); child.kill(); }
}

async function releases(repository, print) {
  const r = await getText(`${GITHUB_API}/repos/${repository}/releases?per_page=10`, { kind: 'github', headers: { Accept: 'application/vnd.github+json' } });
  print(`releases: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  if (r.status !== 200) return;
  for (const rel of JSON.parse(r.body).slice(0, 5)) {
    print(`  ${rel.tag_name}${rel.draft ? ' [draft]' : ''}${rel.prerelease ? ' [prerelease]' : ''}: ${rel.assets.map(a => a.name).join(', ') || 'no assets'}`);
  }
}

// An archive listing as { path, size } rows → lines to print. A long one is
// summed per folder (two levels down), plus the files that say what it is:
// executables and libraries, and Build-engine and id-style game data
const KEY_FILE = /\.(exe|dll|grp|pk3|ipk3|rff|con|ssi|wad|z64|n64|v64|iso|ciso)$/i;
function summarizeListing(entries, { limit = 150 } = {}) {
  if (entries.length <= limit) return entries.map(e => `${e.path}${e.size != null ? ` (${e.size} bytes)` : ''}`);
  const dirs = new Map();
  for (const e of entries) {
    if (e.size == null) continue;
    const parts = e.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') + '/' : '(top)';
    const d = dirs.get(dir) || { files: 0, bytes: 0 };
    d.files++; d.bytes += e.size;
    dirs.set(dir, d);
  }
  const out = [`${entries.length} entries; by folder:`];
  for (const [dir, d] of [...dirs].sort()) out.push(`  ${dir} ${d.files} files, ${d.bytes} bytes`);
  const keys = entries.filter(e => e.size != null && KEY_FILE.test(e.path) && e.path.split('/').length <= 4);
  out.push(`key files (${keys.length}):`);
  for (const e of keys.slice(0, limit)) out.push(`  ${e.path} (${e.size} bytes)`);
  if (keys.length > limit) out.push(`  … ${keys.length - limit} more`);
  return out;
}

// archive.org's archive listing page → { path, size } rows. Each row reads
// "path date time [size]"; folders have no size
function parseListing(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .map(row => row.match(/^(.+?) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)(?: (\d+))?$/))
    .filter(Boolean)
    .map(([, p, , size]) => ({ path: p.replace(/\/$/, ''), size: size ? Number(size) : null }));
}

// "item/file.zip" → what the archive holds, from archive.org's own listing
async function listZip(spec, print) {
  const at = spec.indexOf('/');
  const url = `https://archive.org/download/${encodeURIComponent(spec.slice(0, at))}/${encodeURIComponent(spec.slice(at + 1))}/`;
  let r = await getText(url, { kind: 'archive' });
  if ([301, 302, 303, 307, 308].includes(r.status) && r.headers?.location) r = await getText(new URL(r.headers.location, url).toString(), { kind: 'archive' });
  print(`\n== zip ${spec}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  if (r.status !== 200) return 1;
  const entries = parseListing(r.body);
  for (const line of summarizeListing(entries)) print(`  ${line}`);
  return 0;
}

async function run(opts, print = (l) => console.log(l)) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'collisions.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-port-'));
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ installPath: path.join(dir, 'games'), downloadPath: path.join(dir, 'dl') });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  const installs = createInstalls({ settings, library, archive: createArchive({ log: () => {} }), gamesDir: dir, log: print });
  let failed = 0;
  for (const spec of opts.ia || []) failed += await listIa(spec, print);
  for (const spec of opts.zips || []) failed += await listZip(spec, print);
  try {
    for (const repo of opts.repos) {
      // owner/repo, or the name of an archive.org-only entry
      const c = catalog.find(x => (x.repository || x.name || '').toLowerCase() === repo.toLowerCase());
      print(`\n== ${repo}`);
      if (!c) { print('not in catalog/collisions.json'); failed++; continue; }
      if (c.repository) await releases(c.repository, print);
      const item = itemFor(c);
      const started = installs.startPort({ item });
      if (!started.ok) { print(`can't start: ${started.detail}`); failed++; continue; }
      let last = '';
      const id = started.jobs[0].id;
      const tick = setInterval(() => {
        const j = installs.get(id);
        const line = `${j.step || ''} ${j.status} ${j.percent}%${j.file ? ` ${j.file}` : ''}`;
        if (line !== last) print(`  ${(last = line)}`);
      }, 2000);
      await installs.wait(id);
      clearInterval(tick);
      const job = installs.get(id);
      if (job.status === 'done') {
        print(`installed to ${job.installDir}; exe ${job.exePath || '(several or none)'}`);
        print(tree(job.installDir).map(l => `  ${l}`).join('\n'));
        const errs = checkInstall(job.installDir, c);
        if (errs.length) { print(`CHECK FAILED: ${errs.join('; ')}`); failed++; } else print('check: every expected file is there');
        await tryLaunch(job.exePath, print);
      } else {
        print(`FAILED at ${job.step || 'start'}: ${job.error}`);
        failed++;
      }
    }
  } finally {
    library.close();
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then((failed) => process.exit(failed ? 1 : 0))
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, itemFor, n64Header, parseListing, summarizeListing, checkInstall, run };
