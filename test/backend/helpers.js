'use strict';
/**
 * Test helpers: a local stand-in for archive.org (and anything else the
 * backend fetches), temp dirs, a stored-only zip writer, and a started API.
 * Nothing here touches the network.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const SEARCH = require('../../e2e/fixtures/search.json');

function tmpDir(t, prefix = 'rk-backend-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Zip with stored (uncompressed) entries: { 'Game/game.exe': 'MZ' }
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2048, 7)]);

// Fake archive.org. `state` can be changed by a test between requests:
//   search:   { [uploader]: docs[] }             (defaults to e2e/fixtures/search.json)
//   failures: { [uploader]: [status, ...] }      statuses served before the real answer
//   files:    { [identifier]: [{ name, size }] } (default: one <id>.zip)
//   zips:     { [identifier/file]: Buffer }      (default: an exe-bearing zip)
//   routes:   { [pathname]: (req, res) => void } overrides anything above
async function fakeArchive(t, state = {}) {
  state.search   ??= SEARCH;
  state.failures ??= {};
  state.files    ??= {};
  state.zips     ??= {};
  state.routes   ??= {};
  state.requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(url.pathname + url.search);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (state.routes[url.pathname]) return state.routes[url.pathname](req, res, url);

    if (url.pathname === '/advancedsearch.php') {
      const uploader = /uploader:(\S+)/.exec(url.searchParams.get('q') || '')?.[1];
      const queued = state.failures[uploader];
      if (queued?.length) {
        const status = queued.shift();
        return json(status, { error: 'nope' }, status === 429 ? { 'retry-after': '1' } : {});
      }
      const docs = state.search[uploader];
      if (!docs) return json(404, { error: 'no fixture' });
      const rows = Number(url.searchParams.get('rows'));
      const page = Number(url.searchParams.get('page'));
      return json(200, { response: { numFound: docs.length, docs: docs.slice((page - 1) * rows, page * rows) } });
    }

    const [, kind, id, ...rest] = url.pathname.split('/').map(decodeURIComponent);
    if (kind === 'metadata' && rest[0] === 'reviews') return json(200, { result: [{ reviewtitle: 'Works', stars: '5' }] });
    if (kind === 'metadata') return json(200, { files: state.files[id] || [{ name: `${id}.zip`, size: '100' }] });
    if (kind === 'download') {
      const zip = state.zips[`${id}/${rest.join('/')}`] || makeZip({ 'Game/game.exe': 'MZ', 'readme.txt': 'hello' });
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
      return res.end(zip);
    }
    if (kind === 'services' && id === 'img') {
      if (rest[0].startsWith('missing')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not in fixtures');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  state.base = `http://127.0.0.1:${server.address().port}`;
  return state;
}

// A backend on a temp data dir, talking to fakeArchive, with instant retries
async function testBackend(t, { state, ...opts } = {}) {
  const { createBackend } = require('../../src/backend');
  const fake = await fakeArchive(t, state);
  const dataDir = tmpDir(t);
  const backend = createBackend({
    dataDir,
    archiveBase: fake.base,
    overridesUrl: `${fake.base}/overrides.json`,
    uploadersUrl: `${fake.base}/uploaders.json`,
    githubApi: fake.base,
    featuredUrl: `${fake.base}/featured.json`,
    sleep: async () => {},
    log: () => {},
    ...opts,
  });
  t.after(() => backend.close());
  return { backend, fake, dataDir };
}

// Backend plus a listening API; call(method, path, body?, { token }) → { status, body, headers }
async function testApi(t, opts) {
  const { createServer } = require('../../src/backend/server');
  const ctx = await testBackend(t, opts);
  const api = createServer(ctx.backend, { token: 'test-token' });
  const info = await api.listen(0);
  t.after(() => api.close());
  const call = async (method, p, body, { token = 'test-token', raw = false } = {}) => {
    const res = await fetch(`${info.url}${p}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = raw ? null : await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, res };
  };
  return { ...ctx, api, info, call };
}

module.exports = { tmpDir, makeZip, fakeArchive, testBackend, testApi, JPEG, SEARCH };
