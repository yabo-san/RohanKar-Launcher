'use strict';
/**
 * Quiver-style catalogs: JSON files of ports ({ apps: [...] } or a bare
 * array) that the user subscribes to by URL. Each subscription is fetched on
 * demand, cached under catalogs/, and diffed against the copy the user last
 * reviewed. The collision catalog joins entries to archive.org data on
 * `repository` (lowercase owner/repo), never on title.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { getText } = require('./net');

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

// collisions.json: an array of entries with `repository`, or an object keyed by it
function parseCollisions(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data)
    ? data
    : Object.entries(data || {}).filter(([k]) => !k.startsWith('_')).map(([repository, v]) => ({ repository, ...v }));
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
  function collisionMap() {
    if (!collisions) {
      try { collisions = collisionsFile ? parseCollisions(fs.readFileSync(collisionsFile, 'utf8')) : new Map(); }
      catch (e) { log(`[catalogs] collisions unreadable (${e.message})`); collisions = new Map(); }
    }
    return collisions;
  }

  const subscriptions = () => (Array.isArray(settings.load().catalogs) ? settings.load().catalogs : []);
  const find = (id) => subscriptions().find(c => c.id === id) || null;

  function describe(sub) {
    const cache = readJson(file(sub.id, 'cache'), null);
    return {
      ...sub,
      entries:   cache ? cache.entries.length : 0,
      fetchedAt: cache?.fetchedAt ?? null,
      error:     cache?.error ?? null,
    };
  }

  const list = () => subscriptions().map(describe);
  const get  = (id) => { const s = find(id); return s ? describe(s) : null; };

  // Fetches and caches a subscription. A failed fetch keeps the last good copy.
  async function refresh(id) {
    const sub = find(id);
    if (!sub) return null;
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
    if (!find(id)) return false;
    settings.save({ catalogs: subscriptions().filter(c => c.id !== id) });
    for (const kind of ['cache', 'seen']) fs.rmSync(file(id, kind), { force: true });
    return true;
  }

  const entries = (id) => readJson(file(id, 'cache'), { entries: [] }).entries;

  function review(id) {
    if (!find(id)) return null;
    return diffEntries(readJson(file(id, 'seen'), []), entries(id));
  }

  function markSeen(id) {
    if (!find(id)) return false;
    writeJson(file(id, 'seen'), entries(id));
    return true;
  }

  // Normalized items for every subscribed catalog
  function items() {
    const subs = subscriptions();
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
        data:        data && { iaIdentifier: data.iaIdentifier || null, contentUrl: data.contentUrl || null, dataFiles: data.dataFiles || [] },
        entry:       e,
      };
    }));
  }

  return { list, get, subscribe, unsubscribe, refresh, entries, review, markSeen, items };
}

module.exports = { createCatalogs, parseCatalog, parseCollisions, diffEntries, catalogId, entryKey };
