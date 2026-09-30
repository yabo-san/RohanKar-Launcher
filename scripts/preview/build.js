'use strict';
/**
 * The web preview: both UIs as static files, for GitHub Pages.
 *
 *   node scripts/preview/build.js [--out preview-site] [--fixtures]
 *
 * Starts the standalone backend, subscribes it to the same Quiver lists the
 * new UI subscribes to on a first run, and saves every GET the UIs make at
 * start (items, covers, catalogs, library, settings...) under
 * <out>/preview-data/, with manifest.json mapping each request to its file.
 * src/frontend is copied next to it, and both pages load preview.js before
 * api.js: it answers the API from those files, so no backend is needed.
 *
 * By default the backend reads the live sources (archive.org, the Quiver
 * lists, the catalogs on main), as the app does. --fixtures uses the e2e
 * fixtures instead (no network), and gives the preview a small made-up
 * library (seedLibrary) so the Library page has something on it.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { run } = require('../../src/backend/main');

const ROOT     = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'src', 'frontend');

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'preview-site'), fixtures: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixtures') out.fixtures = true;
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
  }
  return out;
}

// The Quiver lists new/app.js subscribes to on a first run, read from it so
// the two can't drift
function quiverLists() {
  const src  = fs.readFileSync(path.join(FRONTEND, 'new', 'app.js'), 'utf8');
  const base = /const QUIVER_BASE = '([^']+)'/.exec(src)?.[1];
  const block = /const QUIVER_CATALOGS = \[([\s\S]*?)\];/.exec(src)?.[1] || '';
  const lists = [...block.matchAll(/shelf:\s*'([^']+)',\s*file:\s*'([^']+)'/g)].map(m => ({ shelf: m[1], file: m[2] }));
  if (!base || !lists.length) throw new Error('QUIVER_BASE / QUIVER_CATALOGS not found in src/frontend/new/app.js');
  return { base, lists };
}

// The request as preview.js keys it: path under /v1, sorted query, no token
// or refresh
function key(p, query = {}) {
  const q = new URLSearchParams(Object.entries(query).filter(([k]) => k !== 'token' && k !== 'refresh').sort());
  return `GET ${p}${q.size ? `?${q}` : ''}`;
}

// Runs fn over items, n at a time
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function startBackend({ fixtures }, dataDir) {
  const args = ['--data-dir', dataDir, '--heroes-dir', path.join(ROOT, 'assets', 'heroes')];
  if (!fixtures) {
    const backend = await run(args, {}, () => {});
    return { backend, catalogUrl: (base, file) => base + file, close: backend.stop };
  }
  const { startFixtures } = require('../../e2e/fixture-server');
  const f = await startFixtures();
  const backend = await run([...args,
    '--archive-base', f.base,
    '--overrides-url', `${f.base}/overrides.json`,
    '--uploaders-url', `${f.base}/uploaders.json`,
    '--github-api', f.base,
    '--collisions-file', path.join(ROOT, 'e2e', 'fixtures', 'collisions.json'),
    '--featured-url', `${f.base}/featured.json`,
  ], {}, () => {});
  return { backend, catalogUrl: (_, file) => `${f.base}/quiver/${file}`, close: async () => { await backend.stop(); await f.close(); } };
}

// A made-up library for the fixtures preview: two wall games installed (one
// a favourite), the first port of each catalog added, and a collection.
// Nothing is on disk; the paths only have to look real.
function seedLibrary(backend, wallItems) {
  const { library, catalogs } = backend;
  wallItems.slice(0, 2).forEach((it, i) => {
    const id = it.versions?.[0]?.id || it.id;
    library.adoptInstall(id, `C:\\Games\\${id}`, `C:\\Games\\${id}\\game.exe`);
    if (i === 0) library.setFavorite(id, true);
  });
  const seen = new Set();
  for (const it of catalogs.items()) {
    if (seen.has(it.source.catalog)) continue;
    seen.add(it.source.catalog);
    library.add(it.id, it.source.url);
  }
  const c = library.createCollection('Weekend');
  if (c.ok && wallItems[0]) library.addToCollection(c.id, wallItems[0].versions?.[0]?.id || wallItems[0].id);
}

async function build(opts) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-preview-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}');
  const { backend, catalogUrl, close } = await startBackend(opts, dataDir);

  fs.rmSync(opts.out, { recursive: true, force: true });
  fs.cpSync(FRONTEND, opts.out, { recursive: true });
  const dataOut = path.join(opts.out, 'preview-data');
  fs.mkdirSync(dataOut, { recursive: true });

  const manifest = {};
  let n = 0;
  async function save(p, query = {}, { binary = false } = {}) {
    const q = new URLSearchParams(query);
    const res = await fetch(`${backend.url}${p}${q.size ? `?${q}` : ''}`, { headers: { Authorization: `Bearer ${backend.token}` } });
    const type = res.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await res.arrayBuffer());
    const ext = binary ? (/png/.test(type) ? '.png' : /webp/.test(type) ? '.webp' : /jpe?g/.test(type) ? '.jpg' : '.bin') : '.json';
    const file = `r${++n}${ext}`;
    fs.writeFileSync(path.join(dataOut, file), body);
    manifest[key(p, query)] = { file, status: res.status, type };
    return binary || !body.length ? null : JSON.parse(body);
  }

  try {
    const { base, lists } = quiverLists();
    for (const c of lists) {
      try { await backend.backend.catalogs.subscribe({ url: catalogUrl(base, c.file), name: c.shelf, shelf: c.shelf }); }
      catch (e) { console.warn(`catalog ${c.shelf}: ${e.message}`); }
    }

    const health = await save('/health');
    await save('/settings');
    await save('/sources');
    await save('/featured');
    await save('/os/updater');
    await save('/os/open-item');
    const wall = await save('/items', { shelf: 'wall' });
    for (const e of wall?.errors || []) console.warn(`source ${e.label || e.source}: ${e.error}`);
    // Better no new preview than an empty wall over the last good one
    if (!wall?.items?.length) throw new Error('the wall is empty: every source failed');
    if (opts.fixtures) seedLibrary(backend.backend, wall.items);
    await save('/library');
    await save('/collections');
    const catalogs = (await save('/catalogs'))?.catalogs || [];
    for (const c of catalogs) {
      await save(`/catalogs/${encodeURIComponent(c.id)}/items`);
      await save(`/catalogs/${encodeURIComponent(c.id)}/review`);
    }

    // Covers and file lists: each version of each wall item
    const ids = [...new Set((wall?.items || []).flatMap(it => [it.id, ...(it.versions || []).map(v => v.id)]))];
    await pool(ids, 6, async (id) => {
      const enc = encodeURIComponent(id);
      await save(`/items/${enc}/cover`, {}, { binary: true });
      await save(`/items/${enc}/files`);
    });

    const info = {
      builtAt: new Date().toISOString(),
      data: opts.fixtures ? 'fixtures' : 'live',
      version: health?.version || '',
      commit: process.env.PREVIEW_COMMIT || process.env.GITHUB_SHA || '',
      ref: process.env.PREVIEW_LABEL || '',
      repo: process.env.GITHUB_REPOSITORY || '',
      items: wall?.items?.length || 0,
      ports: catalogs.reduce((s, c) => s + (c.entries || 0), 0),
      sourceErrors: wall?.errors?.length || 0,
    };
    fs.writeFileSync(path.join(dataOut, 'manifest.json'), JSON.stringify({ info, responses: manifest }));

    // preview.js before api.js in both pages
    fs.copyFileSync(path.join(__dirname, 'preview.js'), path.join(opts.out, 'preview.js'));
    for (const [page, src] of [['index.html', 'preview.js'], ['new/index.html', '../preview.js']]) {
      const file = path.join(opts.out, page);
      const html = fs.readFileSync(file, 'utf8');
      const tag = /^(\s*)<script src="(\.\.\/)?api\.js"><\/script>/m;
      if (!tag.test(html)) throw new Error(`${page}: no api.js script tag`);
      fs.writeFileSync(file, html.replace(tag, (m, indent) => `${indent}<script src="${src}"></script>\n${m}`));
    }
    fs.writeFileSync(path.join(opts.out, '.nojekyll'), '');
    console.log(`preview: ${info.items} wall items, ${catalogs.length} catalogs, ${ids.length} covers, ${n} responses → ${path.relative(process.cwd(), opts.out) || '.'}`);
    return info;
  } finally {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  build(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { build, key, quiverLists, seedLibrary };
