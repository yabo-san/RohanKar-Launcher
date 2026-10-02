'use strict';
/**
 * A real port install against the real GitHub, for the curated ports the
 * fixtures can only imitate. Not part of the test suite: CI runs it as the
 * non-blocking "Live ports" job.
 *
 *   node scripts/live-port.js [owner/repo ...] [--keep]
 *
 * For each repository in catalog/curated-ports.json (default: the GitHub
 * tiles the brief's acceptance table names) it prints the releases GitHub
 * returns, then installs the port into a temp folder with the same install
 * engine the app uses, and lists what landed. Exits 1 if any install fails.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createInstalls, GITHUB_API } = require('../src/backend/installs');
const { createArchive } = require('../src/backend/archive');
const { createSettings } = require('../src/backend/settings');
const { createLibrary } = require('../src/backend/library');
const { getText } = require('../src/backend/net');

const ROOT = path.join(__dirname, '..');
const DEFAULT = ['Zelda64Recomp/Zelda64Recomp', 'andrei-drexler/ironwail', 'nstlaurent/DoomLauncher', 'ebkr/r2modmanPlus'];

function parseArgs(argv) {
  const repos = argv.filter(a => !a.startsWith('--'));
  return { repos: repos.length ? repos : DEFAULT, keep: argv.includes('--keep') };
}

// Why an entry can't be installed from here, or null
function skipReason(e) {
  if ((e.tags || []).includes('source only')) return 'source only, nothing to install';
  if (e.repositorySource && e.repositorySource !== 'github') return `${e.repositorySource} releases aren't supported yet`;
  return null;
}

// A curated-ports.json entry as the catalog item catalogs.items() would build for it
function itemFor(e) {
  return { id: `quiver:live:${e.repository.toLowerCase()}`, title: e.name || e.repository, repository: e.repository, entry: e };
}

function tree(dir, depth = 0, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ` (${fs.statSync(p).size} bytes)`}`);
    if (e.isDirectory() && depth < 1) tree(p, depth + 1, out);
  }
  return out;
}

async function releases(repository, print) {
  const r = await getText(`${GITHUB_API}/repos/${repository}/releases?per_page=10`, { kind: 'github', headers: { Accept: 'application/vnd.github+json' } });
  print(`releases: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  if (r.status !== 200) return;
  for (const rel of JSON.parse(r.body).slice(0, 5)) {
    print(`  ${rel.tag_name}${rel.draft ? ' [draft]' : ''}${rel.prerelease ? ' [prerelease]' : ''}: ${rel.assets.map(a => a.name).join(', ') || 'no assets'}`);
  }
}

async function run(opts, print = (l) => console.log(l)) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'curated-ports.json'), 'utf8')).apps;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-port-'));
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ installPath: path.join(dir, 'games'), downloadPath: path.join(dir, 'dl') });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  const installs = createInstalls({ settings, library, archive: createArchive({ log: () => {} }), gamesDir: dir, log: print });
  let failed = 0;
  try {
    for (const repo of opts.repos) {
      const e = catalog.find(x => x.repository?.toLowerCase() === repo.toLowerCase());
      print(`\n== ${repo}`);
      if (!e) { print('not in catalog/curated-ports.json'); failed++; continue; }
      const skip = skipReason(e);
      if (skip) { print(`skipped: ${skip}`); continue; }
      await releases(e.repository, print);
      const started = installs.startPort({ item: itemFor(e) });
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
        print(`installed ${job.file} to ${job.installDir}; exe ${job.exePath || '(several or none)'}`);
        print(tree(job.installDir).map(l => `  ${l}`).join('\n'));
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

module.exports = { parseArgs, skipReason, itemFor, run, DEFAULT };
