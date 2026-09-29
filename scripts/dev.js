'use strict';
/**
 * Local development without Electron (`mise run backend | frontend | dev`):
 *   node scripts/dev.js backend    the standalone backend on 127.0.0.1:5170
 *   node scripts/dev.js frontend   src/frontend as static files on 127.0.0.1:5173
 *   node scripts/dev.js            both, and prints the page URLs
 * The backend keeps its data in .launcher-data/ and uses the token "dev"
 * unless LAUNCHER_TOKEN is set, so the page URLs survive restarts.
 * Ports: LAUNCHER_PORT and FRONTEND_PORT. OS actions answer 501 here.
 */
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { run } = require('../src/backend/main');

const ROOT     = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'src', 'frontend');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function settings(env = process.env) {
  return {
    backendPort:  Number(env.LAUNCHER_PORT ?? 5170),
    frontendPort: Number(env.FRONTEND_PORT ?? 5173),
    token:        env.LAUNCHER_TOKEN || 'dev',
    dataDir:      env.LAUNCHER_DATA_DIR || path.join(ROOT, '.launcher-data'),
  };
}

// The standalone backend, as the desktop app starts it (minus the OS actions)
function startBackend({ backendPort, token, dataDir }, extraArgs = [], print = () => {}) {
  return run(
    ['--data-dir', dataDir, '--heroes-dir', path.join(ROOT, 'assets', 'heroes'), '--port', String(backendPort), ...extraArgs],
    { ...process.env, LAUNCHER_TOKEN: token },
    print,
  );
}

// src/frontend as any static host would serve it; nothing outside it
async function startFrontend({ frontendPort }) {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = null; }
    if (rel?.endsWith('/')) rel += 'index.html';
    const file = rel && path.join(FRONTEND, path.normalize(rel));
    if (!file || !file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(frontendPort, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return { url, close };
}

// The pages, pointed at a backend
function pageUrls(frontendUrl, apiUrl, token) {
  const q = new URLSearchParams({ api: apiUrl, token });
  return { new: `${frontendUrl}/new/index.html?${q}`, classic: `${frontendUrl}/index.html?${q}` };
}

async function start(mode = 'dev', env = process.env, { extraArgs = [], print = (l) => process.stdout.write(l) } = {}) {
  const s = settings(env);
  const apiUrl = `http://127.0.0.1:${s.backendPort}/v1`;
  const stops = [];
  try {
    if (mode !== 'frontend') {
      const b = await startBackend(s, extraArgs);
      stops.push(b.stop);
      print(`backend   ${b.url}  token ${b.token}  data ${s.dataDir}\n`);
    }
    if (mode !== 'backend') {
      const f = await startFrontend(s);
      stops.push(f.close);
      const pages = pageUrls(f.url, apiUrl, s.token);
      print(`frontend  ${f.url}\n  new UI      ${pages.new}\n  classic UI  ${pages.classic}\n`);
      if (mode === 'frontend') print(`  (expects the backend at ${apiUrl}: mise run backend)\n`);
    }
  } catch (e) {
    await Promise.all(stops.map(stop => stop()));
    throw e;
  }
  return { stop: () => Promise.all(stops.map(stop => stop())) };
}

if (require.main === module) {
  const mode = process.argv[2] || 'dev';
  if (!['backend', 'frontend', 'dev'].includes(mode)) {
    process.stderr.write('usage: node scripts/dev.js [backend|frontend|dev]\n');
    process.exit(2);
  }
  start(mode).then(({ stop }) => {
    const quit = () => stop().then(() => process.exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  }).catch((e) => {
    process.stderr.write(`dev: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { settings, startFrontend, pageUrls, start };
