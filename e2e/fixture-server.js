'use strict';
/**
 * What the browser e2e tests run against, all on 127.0.0.1:
 *   - one HTTP server that is archive.org (fixtures.js) and also serves
 *     src/frontend under /app/, the way any static host would
 *   - the standalone backend (src/backend/main.js) on a fresh data dir,
 *     pointed at that server for archive.org, overrides.json, uploaders.json,
 *     featured.json and GitHub's releases, with the collision catalog from
 *     fixtures/
 * No Electron: the frontend is opened in a plain Chromium page.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { answer } = require('./fixtures');
const { run }    = require('../src/backend/main');

const FRONTEND = path.join(__dirname, '..', 'src', 'frontend');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function startFixtures() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/app/')) {
      const file = path.join(FRONTEND, path.normalize(decodeURIComponent(url.pathname.slice(5))));
      if (!file.startsWith(FRONTEND) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    const { status, type, body } = answer(url, `http://127.0.0.1:${server.address().port}`);
    res.writeHead(status, { 'content-type': type, 'content-length': body.length });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return { base, close };
}

// Fixtures + backend on a fresh data dir holding `settings`.
//   page:     the page to open under src/frontend/ (index.html is the classic UI)
//   catalogs: Quiver list files to subscribe to first, as [{ file, shelf }]
// Resolves { dataDir, pageUrl, base, close }; pageUrl opens the page on that backend.
async function startStack(settings, { page = 'index.html', catalogs = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-e2e-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const fixtures = await startFixtures();
  const backend = await run([
    '--data-dir', dataDir,
    '--archive-base', fixtures.base,
    '--overrides-url', `${fixtures.base}/overrides.json`,
    '--uploaders-url', `${fixtures.base}/uploaders.json`,
    '--github-api', fixtures.base,
    '--collisions-file', path.join(__dirname, 'fixtures', 'collisions.json'),
    '--featured-url', `${fixtures.base}/featured.json`,
  ], {}, () => {});
  for (const c of catalogs) {
    await backend.backend.catalogs.subscribe({ url: `${fixtures.base}/quiver/${c.file}`, name: c.shelf, shelf: c.shelf });
  }
  const pageUrl = `${fixtures.base}/app/${page}?${new URLSearchParams({ api: backend.url, token: backend.token })}`;
  const close = async () => {
    await backend.stop();
    await fixtures.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, pageUrl, base: fixtures.base, close };
}

module.exports = { startFixtures, startStack };
