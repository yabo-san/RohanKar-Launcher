'use strict';
/**
 * Quiver-style catalogs: JSON files of ports ({ apps: [...] } or a bare
 * array) that the user subscribes to by URL. Each subscription is fetched on
 * demand, cached under catalogs/, and diffed against the copy the user last
 * reviewed. The collision catalog joins entries to archive.org data on
 * `repository` (lowercase owner/repo), never on title. The user's own
 * collisions (collisions.local.json) win over the bundled ones, and those for
 * repositories no subscribed catalog lists make up a "Your ports" shelf.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { getText } = require('./net');
const { validateCollision } = require('./ports');
const { parseUploaders } = require('./feed');

const LOCAL = Object.freeze({ id: 'local', url: null, name: 'Your ports', shelf: 'Your ports', local: true });

const catalogId = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
const repoKey   = (repo) => (typeof repo === 'string' && repo.trim() ? repo.trim().toLowerCase() : null);

// The entry's identity within its catalog: repository when it has one, else name
const entryKey = (e) => repoKey(e.repository) || (e.name ? `name:${e.name}` : null);

function parseCatalog(text) {
  const data = JSON.parse(text);
  const apps = Array.isArray(data) ? data : data?.apps;
  if (!Array.isArray(apps)) throw new Error('catalog must be an array or { apps: [...] }');
  return apps.filter(e => e && typeof e === 'object' && entryKey(e));
}

// collisions.json: an array of entries with `repository`, { collisions: [...] },
// or an object keyed by repository (a feed's other keys aside)
const FEED_KEYS = ['schemaVersion', 'uploaders'];
function parseCollisions(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.collisions) ? data.collisions
    : Object.entries(data || {}).filter(([k]) => !k.startsWith('_') && !FEED_KEYS.includes(k)).map(([repository, v]) => ({ repository, ...v }));
  const out = new Map();
  for (const c of list) {
    const key = repoKey(c?.repository);
    if (key) out.set(key, c);
  }
  return out;
}

// Entries new, changed or removed in `current` relative to `seen`
function diffEntries(seen, current) {
  const before = new Map(seen.map(e => [entryKey(e), e]));
  const after  = new Map(current.map(e => [entryKey(e), e]));
  const out = { new: [], changed: [], removed: [] };
  for (const [k, e] of after) {
    if (!before.has(k)) out.new.push(e);
    else if (JSON.stringify(before.get(k)) !== JSON.stringify(e)) out.changed.push(e);
  }
  for (const [k, e] of before) if (!after.has(k)) out.removed.push(e);
  return out;
}

function createCatalogs({ dir, settings, collisionsFile = null, netLog = () => {}, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (id, kind) => path.join(dir, `${id}.${kind}.json`);
  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  const writeJson = (p, data) => {
    fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(p + '.tmp', p);
  };

  let collisions = null;
  function bundledCollisions() {
    if (!collisions) {
      try { collisions = collisionsFile ? parseCollisions(fs.readFileSync(collisionsFile, 'utf8')) : new Map(); }
      catch (e) { log(`[catalogs] collisions unreadable (${e.message})`); collisions = new Map(); }
    }
    return collisions;
  }

  // ─── The user's own collisions ────────────────────────────────────────────
  const localFile = path.join(dir, 'collisions.local.json');
  const localList = () => { const l = readJson(localFile, []); return Array.isArray(l) ? l : []; };
  const localMap = () => new Map(localList().filter(c => repoKey(c?.repository)).map(c => [repoKey(c.repository), c]));

  // ─── Collision feeds: other people's collisions, subscribed by URL ────────
  const feedList = () => (Array.isArray(settings.load().collisionFeeds) ? settings.load().collisionFeeds : []);
  const findFeed = (id) => feedList().find(f => f.id === id) || null;
  const feedCache = (id) => readJson(file(id, 'collisions'), null);
  const describeFeed = (f) => {
    const c = feedCache(f.id);
    return { ...f, entries: c?.entries.length ?? 0, rejected: c?.rejected ?? [], uploaders: c?.uploaders ?? [], fetchedAt: c?.fetchedAt ?? null, error: c?.error ?? null };
  };
  const feeds = () => feedList().map(describeFeed);

  // Fetches and caches a feed, keeping only entries that validate. A failed
  // fetch keeps the last good copy.
  async function refreshFeed(id) {
    const f = findFeed(id);
    if (!f) return null;
    const r = await getText(f.url, { kind: 'collisions', log: netLog });
    const prev = feedCache(id);
    let entries = null;
    let rejected = [];
    let uploaders = [];
    let error = null;
    if (r.status === 200) {
      try {
        uploaders = parseUploaders(JSON.parse(r.body)?.uploaders);
        const all = [...parseCollisions(r.body).values()];
        entries = all.filter(c => !validateCollision(c).length);
        rejected = all.filter(c => validateCollision(c).length).map(c => ({ repository: c.repository, errors: validateCollision(c) }));
      } catch (e) { error = e.message; }
    } else {
      error = r.status ? `HTTP ${r.status}` : (r.error || 'network error');
    }
    writeJson(file(id, 'collisions'), entries
      ? { fetchedAt: Date.now(), entries, rejected, uploaders, error: null }
      : { fetchedAt: prev?.fetchedAt ?? null, entries: prev?.entries ?? [], rejected: prev?.rejected ?? [], uploaders: prev?.uploaders ?? [], error });
    return describeFeed(f);
  }
  async function subscribeFeed({ url, name }) {
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'bad_url', detail: 'url must be an http(s) URL' };
    const id = catalogId(parsed.toString());
    const created = !findFeed(id);
    if (created) {
      const label = name || decodeURIComponent(parsed.pathname.split('/').pop() || parsed.host).replace(/\.json$/i, '');
      settings.save({ collisionFeeds: [...feedList(), { id, url: parsed.toString(), name: label }] });
    }
    return { ok: true, created, feed: created ? await refreshFeed(id) : describeFeed(findFeed(id)) };
  }
  function unsubscribeFeed(id) {
    if (!findFeed(id)) return false;
    settings.save({ collisionFeeds: feedList().filter(f => f.id !== id) });
    fs.rmSync(file(id, 'collisions'), { force: true });
    return true;
  }
  const feedMap = (f) => new Map((feedCache(f.id)?.entries || []).map(c => [repoKey(c.repository), c]));

  // Bundled, then each feed in order, then the user's own on top
  const collisionMap = () => new Map([...bundledCollisions(), ...feedList().flatMap(f => [...feedMap(f)]), ...localMap()]);

  // Saves one (replacing any for the same repository). { ok, entry } or { ok: false, errors }
  function saveCollision(entry) {
    const errors = validateCollision(entry);
    if (errors.length) return { ok: false, errors };
    const clean = { ...entry, repository: entry.repository.trim() };
    const key = repoKey(clean.repository);
    writeJson(localFile, [...localList().filter(c => repoKey(c?.repository) !== key), clean]);
    return { ok: true, entry: clean };
  }
  function deleteCollision(repository) {
    const key = repoKey(repository);
    const before = localList();
    const after = before.filter(c => repoKey(c?.repository) !== key);
    if (after.length === before.length) return false;
    writeJson(localFile, after);
    return true;
  }
  const collision = (repository) => {
    const key = repoKey(repository);
    const local = localMap().get(key);
    if (local) return { origin: 'local', entry: local };
    for (const f of feedList().slice().reverse()) {
      const e = feedMap(f).get(key);
      if (e) return { origin: 'feed', feed: { id: f.id, name: f.name, url: f.url }, entry: e };
    }
    const bundled = bundledCollisions().get(key);
    return bundled ? { origin: 'bundled', entry: bundled } : null;
  };

  const subscriptions = () => (Array.isArray(settings.load().catalogs) ? settings.load().catalogs : []);

  // User collisions for repositories no subscribed catalog lists, as catalog entries
  function localEntries() {
    const listed = new Set(subscriptions().flatMap(sub => cachedEntries(sub.id).map(e => repoKey(e.repository))).filter(Boolean));
    return localList().filter(c => repoKey(c?.repository) && !listed.has(repoKey(c.repository))).map(c => ({
      name: c.name || c.repository, repository: c.repository, folderName: c.folderName || '',
      ...(c.project ? { project: c.project } : {}), ...(c.appIconUrl ? { appIconUrl: c.appIconUrl } : {}),
      ...(Array.isArray(c.tags) ? { tags: c.tags } : {}), ...(c.releaseAssetFilter ? { releaseAssetFilter: c.releaseAssetFilter } : {}),
      ...(Array.isArray(c.filesToAdd) ? { filesToAdd: c.filesToAdd } : {}),
    }));
  }

  // Subscriptions, plus "Your ports" while it has anything on it
  const shelves = () => [...subscriptions(), ...(localEntries().length ? [LOCAL] : [])];
  const find = (id) => shelves().find(c => c.id === id) || null;

  function describe(sub) {
    if (sub.local) return { ...sub, entries: localEntries().length, fetchedAt: null, error: null };
    const cache = readJson(file(sub.id, 'cache'), null);
    return {
      ...sub,
      entries:   cache ? cache.entries.length : 0,
      fetchedAt: cache?.fetchedAt ?? null,
      error:     cache?.error ?? null,
    };
  }

  const list = () => shelves().map(describe);
  const get  = (id) => { const s = find(id); return s ? describe(s) : null; };

  // Fetches and caches a subscription. A failed fetch keeps the last good copy.
  async function refresh(id) {
    const sub = find(id);
    if (!sub) return null;
    if (sub.local) return describe(sub);
    const r = await getText(sub.url, { kind: 'catalog', log: netLog });
    const prev = readJson(file(id, 'cache'), null);
    let entries = null;
    let error = null;
    if (r.status === 200) {
      try { entries = parseCatalog(r.body); } catch (e) { error = e.message; }
    } else {
      error = r.status ? `HTTP ${r.status}` : (r.error || 'network error');
    }
    writeJson(file(id, 'cache'), entries
      ? { fetchedAt: Date.now(), entries, error: null }
      : { fetchedAt: prev?.fetchedAt ?? null, entries: prev?.entries ?? [], error });
    return describe(sub);
  }

  // Adds a subscription (idempotent per URL) and fetches it. The first copy
  // counts as reviewed, so review starts empty.
  async function subscribe({ url, name, shelf }) {
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'bad_url', detail: 'url must be an http(s) URL' };
    const id = catalogId(parsed.toString());
    if (!find(id)) {
      const label = name || decodeURIComponent(parsed.pathname.split('/').pop() || parsed.host).replace(/\.json$/i, '');
      settings.save({ catalogs: [...subscriptions(), { id, url: parsed.toString(), name: label, shelf: shelf || label }] });
      const described = await refresh(id);
      writeJson(file(id, 'seen'), entries(id));
      return { ok: true, created: true, catalog: described };
    }
    return { ok: true, created: false, catalog: get(id) };
  }

  function unsubscribe(id) {
    if (!find(id) || id === LOCAL.id) return false;
    settings.save({ catalogs: subscriptions().filter(c => c.id !== id) });
    for (const kind of ['cache', 'seen']) fs.rmSync(file(id, kind), { force: true });
    return true;
  }

  const cachedEntries = (id) => readJson(file(id, 'cache'), { entries: [] }).entries;
  const entries = (id) => (id === LOCAL.id ? localEntries() : cachedEntries(id));

  function review(id) {
    if (!find(id)) return null;
    if (id === LOCAL.id) return { new: [], changed: [], removed: [] };
    return diffEntries(readJson(file(id, 'seen'), []), entries(id));
  }

  function markSeen(id) {
    if (!find(id)) return false;
    if (id === LOCAL.id) return true;
    writeJson(file(id, 'seen'), entries(id));
    return true;
  }

  // Normalized items for every subscribed catalog
  function items() {
    const subs = shelves();
    if (!subs.length) return [];
    const joins = collisionMap();
    return subs.flatMap(sub => entries(sub.id).map(e => {
      const data = joins.get(repoKey(e.repository)) || null;
      return {
        id:          `quiver:${sub.id}:${entryKey(e)}`,
        title:       e.name || e.repository,
        source:      { type: 'quiver', catalog: sub.id, name: sub.name, url: sub.url },
        shelf:       sub.shelf,
        repository:  e.repository || null,
        icon:        e.appIconUrl || null,
        tags:        Array.isArray(e.tags) ? e.tags : [],
        description: e.description || null,
        data:        data && {
          iaIdentifier: data.iaIdentifier || data.sources?.[0]?.ia || null, contentUrl: data.contentUrl || null, assetPattern: data.assetPattern || null,
          dataFiles: data.dataFiles || [], sources: data.sources || [], base: data.base || 'binary', binaryTarget: data.binaryTarget || '',
        },
        entry:       e,
      };
    }));
  }

  return { list, get, subscribe, unsubscribe, refresh, entries, review, markSeen, items,
    collision, saveCollision, deleteCollision, localCollisions: localList, feeds, subscribeFeed, refreshFeed, unsubscribeFeed };
}

module.exports = { createCatalogs, parseCatalog, parseCollisions, diffEntries, catalogId, entryKey };
