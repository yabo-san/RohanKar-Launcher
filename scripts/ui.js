'use strict';
/**
 * `mise run ui`: the launcher's UI in a browser, no Electron and no Windows.
 *
 *   node scripts/ui.js [--live] [--port 5180] [--host 0.0.0.0]
 *
 * Builds the web preview (scripts/preview/build.js) into preview-site/ and
 * serves it. The pages talk to scripts/preview/preview.js instead of a
 * backend: it answers the /v1 API from saved JSON (sources, catalogs,
 * collisions joined into the port shelves, a made-up library), so the
 * shelves and cards render. Favourites and Add/Remove work for the tab;
 * installs, launching and folders answer 501.
 *
 * By default the JSON comes from the e2e fixtures, so nothing touches the
 * network. --live saves it from the real sources instead, as the Pages
 * preview does. It listens on 0.0.0.0 so a devcontainer's forwarded port
 * reaches it; UI_PORT and UI_HOST change the defaults.
 */
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { build } = require('./preview/build');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'preview-site');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function parseArgs(argv, env = process.env) {
  const out = { live: false, port: Number(env.UI_PORT ?? 5180), host: env.UI_HOST || '0.0.0.0', out: OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') out.live = true;
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
  }
  return out;
}

// dir as static files; / goes to the new UI
async function serve(dir, { port, host }) {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = null; }
    if (rel === '/') {
      res.writeHead(302, { location: '/new/' });
      return res.end();
    }
    if (rel?.endsWith('/')) rel += 'index.html';
    const file = rel && path.join(dir, path.normalize(rel));
    if (!file || !file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    url: `http://${shown}:${server.address().port}`,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}

async function start(opts, print = (l) => process.stdout.write(l)) {
  const info = await build({ out: opts.out, fixtures: !opts.live });
  const s = await serve(opts.out, opts);
  print(`ui  ${s.url}/new/  (${info.data} data: ${info.items} wall items, ${info.ports} ports)\n`);
  print(`    classic UI ${s.url}/index.html · no installs in this mode · Ctrl+C stops\n`);
  return s;
}

if (require.main === module) {
  start(parseArgs(process.argv.slice(2))).then(({ close }) => {
    const quit = () => close().then(() => process.exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  }).catch((e) => {
    process.stderr.write(`ui: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, serve, start };
