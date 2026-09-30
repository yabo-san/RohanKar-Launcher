'use strict';
/**
 * HTTP + SSE API over the backend, /v1/. Loopback only; every request carries
 * the per-launch token as `Authorization: Bearer <token>` or, where a header
 * can't be set (EventSource, <img>), as `?token=`. JSON in and out; errors
 * are { error, detail }. docs/API.md is the contract.
 *
 * Node's http module is enough: no framework, no new dependency.
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { installableFiles } = require('./archive');
const disk = require('./disk');
const ports = require('./ports');
const quiverImport = require('./quiver-import');
const { createManualApp } = require('./manual');
const { sourcesFromSettings } = require('./sources');
const { withNewer } = require('./updates');

const API_VERSION = 'v1';
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 15000;

class HttpError extends Error {
  constructor(status, error, detail, extra = {}) {
    super(detail || error);
    Object.assign(this, { status, error, detail: detail || null, extra });
  }
}

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const newToken = () => crypto.randomBytes(32).toString('hex');

function tokenMatches(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body_too_large', `Request body over ${MAX_BODY} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new HttpError(400, 'bad_json', e.message)); }
    });
    req.on('error', reject);
  });
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const requireObject = (body) => { if (!isObject(body)) throw new HttpError(400, 'bad_request', 'Body must be a JSON object'); return body; };
const requireString = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'bad_request', `${name} is required`);
  return v;
};

function createApi(backend) {
  const { library, items, installs, catalogs, covers, settings, archive } = backend;
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^/' + API_VERSION + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  const libraryRow = (id) => {
    const row = library.get(id);
    if (!row) throw new HttpError(404, 'not_in_library', `${id} is not in the library`);
    return row;
  };
  const installedRow = (id) => {
    const row = libraryRow(id);
    if (!row.install_dir) throw new HttpError(409, 'not_installed', `${id} is not installed`);
    return row;
  };
  const os = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e.code === 'unsupported') throw new HttpError(501, 'unsupported', e.message);
      throw e;
    }
  };

  route('GET', '/health', () => ({ body: { ok: true, api: API_VERSION, version: backend.appVersion } }));

  // ─── Items ────────────────────────────────────────────────────────────────

  route('GET', '/items', async ({ query }) => {
    try {
      const body = await items.list(query);
      return { body: { ...body, items: body.items.map(withNewer) } };
    } catch (e) {
      throw new HttpError(502, 'sources_failed', e.message, { errors: e.errors || [] });
    }
  });

  const findItem = async (id) => {
    let item;
    try { item = await items.get(id); } catch (e) { throw new HttpError(502, 'sources_failed', e.message, { errors: e.errors || [] }); }
    if (!item) throw new HttpError(404, 'not_found', `No item ${id}`);
    return item;
  };

  // The hand-picked games and ports that lead the New page, in order
  route('GET', '/announcement', async () => ({ body: { announcement: await backend.getAnnouncement() } }));
  route('POST', '/announcement/dismiss', ({ body }) => {
    backend.dismissAnnouncement(requireString(requireObject(body).id, 'id'));
    return { status: 204 };
  });
  route('GET', '/featured', async () => ({ body: { picks: await backend.getFeatured() } }));
  route('GET', '/items/:id', async ({ params }) => ({ body: withNewer(await findItem(params.id)) }));

  route('GET', '/items/:id/files', async ({ params }) => {
    const r = await archive.fileList(params.id);
    if (!r.ok) throw new HttpError(502, 'file_list_failed', r.error);
    const folders = [...new Set(r.files.flatMap(f => String(f.name || '').split('/').slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join('/'))))].sort();
    return { body: { files: r.files, folders, installable: installableFiles(r.files) } };
  });

  route('GET', '/items/:id/reviews', async ({ params }) => ({ body: { reviews: await archive.reviews(params.id) } }));

  const image = (p) => {
    if (!p || !fs.existsSync(p)) throw new HttpError(404, 'no_image', 'No image for this item');
    return { file: p, type: IMAGE_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream' };
  };
  route('GET', '/items/:id/cover', async ({ params }) => image(await covers.thumb(params.id)));
  route('GET', '/items/:id/hero', async ({ params, query }) => {
    if (query.from && !['override', 'install', 'bundled'].includes(query.from)) {
      throw new HttpError(400, 'bad_request', 'from must be override, install or bundled');
    }
    return image(await covers.hero(params.id, library.get(params.id)?.install_dir, query.from || null));
  });

  // ─── Catalogs ─────────────────────────────────────────────────────────────

  const catalog = (id) => {
    const c = catalogs.get(id);
    if (!c) throw new HttpError(404, 'not_found', `No catalog ${id}`);
    return c;
  };

  route('GET', '/catalogs', () => ({ body: { catalogs: catalogs.list() } }));
  route('POST', '/catalogs', async ({ body }) => {
    const { url, name, shelf } = requireObject(body);
    const r = await catalogs.subscribe({ url: requireString(url, 'url'), name, shelf });
    if (!r.ok) throw new HttpError(400, r.error, r.detail);
    return { status: r.created ? 201 : 200, body: r.catalog };
  });
  route('GET', '/catalogs/:id', ({ params }) => ({ body: catalog(params.id) }));
  route('DELETE', '/catalogs/:id', ({ params }) => { catalog(params.id); catalogs.unsubscribe(params.id); return { status: 204 }; });
  route('POST', '/catalogs/:id/refresh', async ({ params }) => { catalog(params.id); return { body: await catalogs.refresh(params.id) }; });
  // One catalog's entries as items, with library state; doesn't wait on archive.org
  route('GET', '/catalogs/:id/items', ({ params }) => {
    catalog(params.id);
    const lib = library.all();
    const items = catalogs.items().filter(it => it.source.catalog === params.id)
      .map(it => ({ ...it, versions: [], installed: !!lib[it.id]?.install_dir, library: lib[it.id] || null }));
    return { body: { items } };
  });
  route('GET', '/catalogs/:id/review', ({ params }) => { catalog(params.id); return { body: catalogs.review(params.id) }; });
  route('POST', '/catalogs/:id/seen', ({ params }) => { catalog(params.id); catalogs.markSeen(params.id); return { status: 204 }; });

  // ─── Collisions: the user's own port + archive.org data bindings ────────
  // docs/COLLISIONS.md. :repo is owner/repo, URL-encoded (owner%2Frepo).

  route('GET', '/collisions', () => ({ body: { local: catalogs.localCollisions() } }));
  // Yours as a feed file (the same shape as catalog/collisions.json) to share
  route('GET', '/collisions/export', () => ({ body: { schemaVersion: 1, collisions: catalogs.localCollisions() } }));

  route('GET', '/collisions/:repo', ({ params }) => {
    const c = catalogs.collision(params.repo);
    if (!c) throw new HttpError(404, 'not_found', `No collision for ${params.repo}`);
    return { body: c };
  });
  route('PUT', '/collisions/:repo', ({ params, body }) => {
    const entry = { ...requireObject(body), repository: params.repo };
    const r = catalogs.saveCollision(entry);
    if (!r.ok) throw new HttpError(400, 'bad_collision', r.errors.join('; '), { errors: r.errors });
    return { body: r.entry };
  });
  route('DELETE', '/collisions/:repo', ({ params }) => {
    if (!catalogs.deleteCollision(params.repo)) throw new HttpError(404, 'not_found', `No collision of yours for ${params.repo}`);
    return { status: 204 };
  });
  // Collision feeds: other people's, subscribed by URL, merged under yours
  const feed = (id) => {
    const f = catalogs.feeds().find(x => x.id === id);
    if (!f) throw new HttpError(404, 'not_found', `No collision feed ${id}`);
    return f;
  };
  route('GET', '/collision-feeds', () => ({ body: { feeds: catalogs.feeds() } }));
  route('POST', '/collision-feeds', async ({ body }) => {
    const { url, name } = requireObject(body);
    const r = await catalogs.subscribeFeed({ url: requireString(url, 'url'), name });
    if (!r.ok) throw new HttpError(400, r.error, r.detail);
    return { status: r.created ? 201 : 200, body: r.feed };
  });
  route('POST', '/collision-feeds/:id/refresh', async ({ params }) => { feed(params.id); return { body: await catalogs.refreshFeed(params.id) }; });
  route('DELETE', '/collision-feeds/:id', ({ params }) => { feed(params.id); catalogs.unsubscribeFeed(params.id); return { status: 204 }; });

  // What a list of sources would place, file by file, before saving it
  route('POST', '/collisions/preview', async ({ body }) => {
    const { sources } = requireObject(body);
    if (!Array.isArray(sources)) throw new HttpError(400, 'bad_request', 'sources must be an array');
    const listed = new Map();
    const out = [];
    for (const s of sources) {
      const ia = s?.ia;
      if (typeof ia !== 'string' || !ia) { out.push({ source: s, error: 'ia is required' }); continue; }
      if (!listed.has(ia)) listed.set(ia, await archive.fileList(ia));
      const list = listed.get(ia);
      if (!list.ok) { out.push({ source: s, error: `Couldn't list ${ia} (${list.error})` }); continue; }
      const x = ports.expandSource(s, list.files);
      out.push(x.error ? { source: s, error: x.error }
        : { source: s, files: x.files.map(f => ({ ...f, to: path.posix.join(s.target || '', f.rel) })), bytes: x.files.reduce((n, f) => n + f.size, 0) });
    }
    return { body: { sources: out } };
  });

  // ─── Library ──────────────────────────────────────────────────────────────

  const needDb = (r) => { if (!r.ok) throw new HttpError(503, 'library_unavailable', r.error || 'library.db could not be opened'); return r; };

  route('GET', '/library', () => ({ body: { library: library.all() } }));

  route('POST', '/library', ({ body }) => {
    const { id, source } = requireObject(body);
    requireString(id, 'id');
    const existed = !!library.get(id);
    needDb(library.add(id, typeof source === 'string' ? source : null));
    return { status: existed ? 200 : 201, body: library.get(id) };
  });

  route('GET', '/library/:id', ({ params }) => ({ body: libraryRow(params.id) }));

  const PATCHABLE = {
    category: (id, v) => library.setCategory(id, v),
    favorite: (id, v) => library.setFavorite(id, !!v),
    notes:    (id, v) => library.setNotes(id, v),
    exePath:  (id, v) => library.setExePath(id, v),
    title:    (id, v) => { requireString(v, 'title'); return library.setDetails(id, { title: v.trim() }); },
    // Locate an existing install: point the row at a folder already on disk
    installDir: (id, v) => {
      requireString(v, 'installDir');
      if (!fs.existsSync(v) || !fs.statSync(v).isDirectory()) throw new HttpError(422, 'no_folder', `Not a folder: ${v}`);
      const exes = disk.findExes(v);
      return library.adoptInstall(id, v, exes.length === 1 ? exes[0] : null);
    },
  };
  route('PATCH', '/library/:id', ({ params, body }) => {
    const fields = requireObject(body);
    const unknown = Object.keys(fields).filter(k => !PATCHABLE[k]);
    if (unknown.length) throw new HttpError(400, 'bad_request', `Unknown fields: ${unknown.join(', ')}`);
    // favorite, notes and installDir create the row; category and exePath need one
    if (!('favorite' in fields || 'notes' in fields || 'installDir' in fields)) libraryRow(params.id);
    for (const [k, v] of Object.entries(fields)) needDb(PATCHABLE[k](params.id, v));
    return { body: library.get(params.id) };
  });

  route('DELETE', '/library/:id', async ({ params, query }) => {
    const row = libraryRow(params.id);
    const r = await backend.removeFromLibrary(params.id, { installDir: row.install_dir, trash: query.files === 'trash' });
    if (!r.ok) throw r.code === 'unsupported' ? new HttpError(501, 'unsupported', r.error) : new HttpError(500, 'delete_failed', r.error);
    return { status: 204 };
  });

  route('GET', '/library/:id/exes', ({ params }) => ({ body: { exes: disk.findExes(installedRow(params.id).install_dir) } }));
  route('GET', '/library/:id/readme', ({ params }) => {
    const r = disk.readReadme(installedRow(params.id).install_dir);
    if (!r.ok) throw new HttpError(404, 'no_folder', r.error || 'Install folder not found');
    return { body: { text: r.text, fileName: r.fileName || null } };
  });

  route('POST', '/library/:id/launch', async ({ params, body }) => {
    const row = installedRow(params.id);
    let exePath = requireObject(body).exePath || row.exe_path;
    if (!exePath) {
      const exes = disk.findExes(row.install_dir);
      if (exes.length !== 1) {
        throw new HttpError(exes.length ? 409 : 422, exes.length ? 'choose_exe' : 'no_exe',
          exes.length ? 'Several executables; pass exePath' : 'No executable found', exes.length ? { choices: exes } : {});
      }
      exePath = exes[0];
    }
    const r = await backend.launch(params.id, exePath);
    if (!r.ok) throw new HttpError(422, 'launch_failed', r.error);
    return { body: { ok: true, exePath } };
  });

  route('POST', '/library/:id/reveal', ({ params }) => {
    const r = backend.openFolder(installedRow(params.id).install_dir);
    if (!r.ok) throw new HttpError(404, 'no_folder', r.error);
    return { body: { ok: true } };
  });

  route('POST', '/library/scan', async ({ body }) => {
    const s = settings.load();
    const dir = requireObject(body).dir || s.installPath || s.downloadPath;
    if (!dir) throw new HttpError(400, 'bad_request', 'Set an install folder in settings or pass dir');
    try { await items.load(); } catch (e) { throw new HttpError(502, 'sources_failed', e.message); }
    const versions = items.loadedVersions();
    const titleMap = {};
    for (const v of versions) {
      const t = Array.isArray(v.title) ? v.title[0] : v.title;
      if (t && String(t).trim()) titleMap[String(t).trim()] = v.identifier;
    }
    return { body: installs.scan({ scanDir: dir, knownIdentifiers: versions.map(v => v.identifier), titleMap }) };
  });

  // A manually managed app: a named folder the user fills; folder is an
  // existing one to use instead of making one in the install folder
  route('POST', '/library/manual', ({ body }) => {
    const { name, folder } = requireObject(body);
    requireString(name, 'name');
    if (folder !== undefined && folder !== null) requireString(folder, 'folder');
    const r = createManualApp({ name, folder, root: backend.installRoot(), library, findExes: disk.findExes });
    if (!r.ok) {
      const status = { bad_request: 400, no_folder: 422, exists: 409, library_unavailable: 503 }[r.code];
      throw new HttpError(status, r.code, r.error);
    }
    return { status: 201, body: library.get(r.id) };
  });

  // A Quiver library (apps.json + Apps/): what an import would do, or, with
  // apply, the import itself. Nothing is downloaded.
  route('POST', '/library/import/quiver', ({ body }) => {
    const { dir, apply } = requireObject(body);
    const read = quiverImport.readQuiverLibrary(requireString(dir, 'dir'), { findExes: disk.findExes });
    if (read.error) throw new HttpError(400, 'not_quiver', read.error);
    const plan = quiverImport.planImport(read, { items: catalogs.items(), rows: library.all() });
    if (!apply) return { body: plan };
    if (!library.available) needDb({ ok: false });
    return { body: { ...plan, result: quiverImport.applyImport(plan, { library, catalogs }) } };
  });

  // ─── Collections ──────────────────────────────────────────────────────────

  const collectionId = (raw) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || !library.collections().some(c => c.id === id)) throw new HttpError(404, 'not_found', `No collection ${raw}`);
    return id;
  };
  const conflictOr = (r) => {
    if (r.ok) return r;
    if (/UNIQUE/i.test(r.error || '')) throw new HttpError(409, 'name_taken', r.error);
    return needDb(r);
  };

  route('GET', '/collections', () => ({ body: { collections: library.collections() } }));
  route('POST', '/collections', ({ body }) => {
    const r = conflictOr(library.createCollection(requireString(requireObject(body).name, 'name')));
    return { status: 201, body: library.collections().find(c => c.id === r.id) };
  });
  route('PATCH', '/collections/:id', ({ params, body }) => {
    const id = collectionId(params.id);
    const { name, color } = requireObject(body);
    if (name !== undefined) conflictOr(library.renameCollection(id, requireString(name, 'name')));
    if (color !== undefined) needDb(library.setCollectionColor(id, color));
    return { body: library.collections().find(c => c.id === id) };
  });
  route('DELETE', '/collections/:id', ({ params }) => { needDb(library.deleteCollection(collectionId(params.id))); return { status: 204 }; });
  route('PUT', '/collections/:id/items/:itemId', ({ params }) => {
    needDb(library.addToCollection(collectionId(params.id), params.itemId));
    return { status: 204 };
  });
  route('DELETE', '/collections/:id/items/:itemId', ({ params }) => {
    needDb(library.removeFromCollection(collectionId(params.id), params.itemId));
    return { status: 204 };
  });

  // ─── Installs ─────────────────────────────────────────────────────────────

  const INSTALL_ERRORS = { choose_files: 409, unknown_file: 400, no_installable_file: 422, file_list_failed: 502 };

  route('POST', '/installs', async ({ body }) => {
    const { id, files } = requireObject(body);
    requireString(id, 'id');
    if (id.startsWith('quiver:')) {
      const item = catalogs.items().find(i => i.id === id);
      if (!item) throw new HttpError(404, 'not_found', `No catalog item ${id}`);
      const r = installs.startPort({ item });
      if (!r.ok) throw new HttpError(422, r.error, r.detail);
      return { status: 202, body: { installs: r.jobs } };
    }
    if (files !== undefined && !(Array.isArray(files) && files.every(f => typeof f === 'string'))) {
      throw new HttpError(400, 'bad_request', 'files must be an array of file names');
    }
    const r = await installs.start({ itemId: id, files });
    if (!r.ok) throw new HttpError(INSTALL_ERRORS[r.error] || 500, r.error, r.detail, r.choices ? { choices: r.choices } : {});
    return { status: 202, body: { installs: r.jobs } };
  });
  route('GET', '/installs', () => ({ body: { installs: installs.list() } }));
  route('GET', '/installs/:id', ({ params }) => {
    const job = installs.get(params.id);
    if (!job) throw new HttpError(404, 'not_found', `No install ${params.id}`);
    return { body: job };
  });
  route('DELETE', '/installs/:id', ({ params }) => {
    const job = installs.cancel(params.id);
    if (!job) throw new HttpError(404, 'not_found', `No install ${params.id}`);
    return { body: job };
  });

  // ─── Settings, export, OS ─────────────────────────────────────────────────

  route('GET', '/sources', async () => {
    const defaults = await backend.getDefaultSources();
    return { body: { defaults, sources: sourcesFromSettings(settings.load(), defaults) } };
  });

  route('GET', '/settings', () => ({ body: settings.load() }));
  route('PUT', '/settings', ({ body }) => ({ body: settings.save(requireObject(body)) }));

  route('POST', '/export/playnite', async ({ body }) => {
    const { path: target } = requireObject(body);
    if (target !== undefined && (typeof target !== 'string' || !path.isAbsolute(target))) {
      throw new HttpError(400, 'bad_request', 'path must be absolute');
    }
    return { body: await backend.exportPlaynite(target) };
  });

  route('POST', '/os/choose-folder', async () => ({ body: { path: await os(() => backend.os.chooseFolder()) } }));

  route('POST', '/os/open-external', async ({ body }) => {
    const url = requireString(requireObject(body).url, 'url');
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'bad_request', 'url must be http(s)');
    await os(() => backend.os.openExternal(url));
    return { body: { ok: true } };
  });

  const WINDOW_ACTIONS = ['minimize', 'maximize', 'close'];
  route('POST', '/os/window', async ({ body }) => {
    const { action } = requireObject(body);
    if (!WINDOW_ACTIONS.includes(action)) throw new HttpError(400, 'bad_request', `action must be ${WINDOW_ACTIONS.join(', ')}`);
    await os(() => backend.os.window(action));
    return { body: { ok: true } };
  });

  // Add to Steam: { appName, exePath, startDir }; the reply is the desktop app's
  route('POST', '/os/add-to-steam', async ({ body }) => {
    const { appName, exePath, startDir } = requireObject(body);
    for (const [k, v] of Object.entries({ appName, exePath, startDir })) requireString(v, k);
    return { body: await os(() => backend.os.addToSteam({ appName, exePath, startDir })) };
  });

  route('GET', '/os/updater', () => ({ body: { status: backend.updaterStatus } }));
  route('GET', '/os/open-item', () => ({ body: { identifier: backend.openRequest } }));
  route('DELETE', '/os/open-item', () => { backend.clearOpenRequest(); return { status: 204 }; });
  route('POST', '/os/updater-install', async () => {
    await os(() => backend.os.updaterInstall());
    return { body: { ok: true } };
  });

  // SSE: install progress, library changes, item reloads
  route('GET', '/events', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const onEvent = ({ type, data }) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    backend.events.on('event', onEvent);
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    beat.unref();
    req.on('close', () => { clearInterval(beat); backend.events.off('event', onEvent); });
    return { stream: true };
  });

  return { routes };
}

function createServer(backend, { token = newToken(), log = () => {} } = {}) {
  const { routes } = createApi(backend);

  const send = (res, status, body, headers = {}) => {
    if (res.headersSent) return res.end();
    if (status === 204 || body === undefined) { res.writeHead(status, headers); return res.end(); }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    // Any origin: the token, not the origin, is what's checked
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url, `http://${HOST}`);
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!tokenMatches(bearer ?? url.searchParams.get('token'), token)) {
      return send(res, 401, { error: 'unauthorized', detail: 'Missing or wrong token' });
    }

    const matches = routes.filter(r => r.re.test(url.pathname));
    if (!matches.length) return send(res, 404, { error: 'not_found', detail: `No route ${url.pathname}` });
    const r = matches.find(m => m.method === req.method);
    if (!r) return send(res, 405, { error: 'method_not_allowed', detail: `${req.method} ${url.pathname}` }, { Allow: matches.map(m => m.method).join(', ') });

    try {
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'token'));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const out = await r.handler({ req, res, params, query, body });
      if (out.stream) return;
      if (out.file) {
        res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'max-age=3600' });
        return fs.createReadStream(out.file).on('error', () => res.destroy()).pipe(res);
      }
      send(res, out.status || 200, out.body);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, detail: e.detail, ...e.extra });
      log(`[api] ${req.method} ${url.pathname} failed: ${e.stack || e.message}`);
      send(res, 500, { error: 'internal', detail: e.message });
    }
  });

  // Resolves once listening on 127.0.0.1 (port 0 = any free port)
  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        const actual = server.address().port;
        resolve({ port: actual, token, url: `http://${HOST}:${actual}/${API_VERSION}` });
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  return { server, token, listen, close };
}

module.exports = { createServer, createApi, newToken, HttpError, API_VERSION, HOST };
