'use strict';
/**
 * Serves the new UI (src/ui/) in a plain browser, no Electron and no Windows:
 *   npm run ui   then open http://localhost:5174/
 *
 * window.electronAPI is replaced by scripts/ui-preview-stub.js, which talks to
 * this server. The Ports shelves are built by the same src/core code the app
 * uses, from Quiver's live lists (cached under .cache/ui-preview/). archive.org
 * searches are proxied live; when archive.org can't be reached, the wall falls
 * back to the catalog/catalog.json entries recorded for that uploader and says
 * so. Installs, launches and Steam are no-ops here.
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { createPortsFeed } = require('../src/main/ports-feed');

const ROOT  = path.join(__dirname, '..');
const PORT  = Number(process.env.PORT) || 5174;
const CACHE = path.join(ROOT, '.cache', 'ui-preview');
fs.mkdirSync(CACHE, { recursive: true });

function get(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'RohanKar-Launcher-preview' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), timeoutMs));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const feed = createPortsFeed({
  fetchText: async (url) => {
    const r = await get(url, 15000);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return r.body.toString('utf8');
  },
  cacheDir: path.join(CACHE, 'catalog-cache'),
  bundledDir: path.join(ROOT, 'catalog'),
  log: (m) => console.log(m),
});

// archive.org advanced search, or the catalog's record of that uploader's items
async function archiveSearch(params) {
  const url = `https://archive.org/advancedsearch.php?${new URLSearchParams(params)}`;
  try {
    const r = await get(url, 30000);
    if (r.status === 200) return { status: 200, json: JSON.parse(r.body.toString('utf8')) };
    console.log(`[preview] archive.org ${r.status}, using catalog fallback`);
  } catch (e) {
    console.log(`[preview] archive.org unreachable (${e.message}), using catalog fallback`);
  }
  const uploader = /uploader:(\S+)/.exec(params.q || '')?.[1];
  const apps = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'catalog.json'), 'utf8')).apps;
  const docs = apps
    .filter(a => a.iaIdentifier && (a.iaUploader === uploader || `${a.iaSource}@gmail.com` === uploader))
    .map(a => ({ identifier: a.iaIdentifier, title: a.name, downloads: a.iaDownloads || 0,
      addeddate: a.iaYear ? `${a.iaYear}-01-01T00:00:00Z` : null, _art: a.artUrl || null }));
  if (!docs.length) return { status: 0, json: null, error: 'archive.org unreachable from the preview, and the catalog has no record of this uploader' };
  const page = Number(params.page) || 1;
  return { status: 200, json: { response: { numFound: docs.length, docs: page === 1 ? docs : [] } }, fallback: true };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const library = { ports: [] };

async function api(req, res, route, body) {
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  switch (route) {
    case 'ports':          return send(await feed.get());
    case 'ports-refresh':  return send(await feed.refresh());
    case 'ports-review':   return send(await feed.review());
    case 'ports-mark-seen': return send(await feed.markSeen(body?.id));
    case 'archive-search': return send(await archiveSearch(body.params));
    case 'port-library':   return send(library.ports);
    case 'port-library-add':
      if (!library.ports.some(p => p.id === body.id)) library.ports.unshift({ ...body, added_at: Date.now() });
      return send({ ok: true });
    case 'port-library-remove':
      library.ports = library.ports.filter(p => p.id !== body.id);
      return send({ ok: true });
    default:
      res.writeHead(404); res.end('no such route');
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => api(req, res, url.pathname.slice(5), raw ? JSON.parse(raw) : null)
      .catch(e => { res.writeHead(500); res.end(e.message); }));
    return;
  }
  if (url.pathname === '/') { res.writeHead(302, { location: '/src/ui/index.html' }); return res.end(); }
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  let data = fs.readFileSync(file);
  // The stub stands in for preload.js, so it has to run before the UI's scripts
  if (file.endsWith(path.join('src', 'ui', 'index.html'))) {
    data = data.toString('utf8').replace('<script src="../renderer/sources.js">',
      '<script src="/scripts/ui-preview-stub.js"></script>\n  <script src="../renderer/sources.js">');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(data);
}).listen(PORT, () => console.log(`RohanKar UI preview on http://localhost:${PORT}/`));
