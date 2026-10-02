'use strict';
/**
 * Quiver-style catalogs: JSON files of ports ({ apps: [...] } or a bare
 * array) that the user subscribes to by URL. Each subscription is fetched on
 * demand, cached under catalogs/, and diffed against the copy the user last
 * reviewed. GitHub repos the user adds on their own (and user.json's github
 * entries) that no subscribed catalog lists make up a "Your ports" shelf.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { getText } = require('./net');
const { additionalAllowed } = require('./user-sources');

const LOCAL = Object.freeze({ id: 'local', url: null, name: 'Your ports', shelf: 'Your ports', local: true });
const REPO = /^[\w.-]+\/[\w.-]+$/;

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

const NO_USER = { entries: () => ({ archive: [], github: [] }) };

// userSources: createUserSources(), for user.json
function createCatalogs({ dir, settings, userSources = NO_USER, netLog = () => {}, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (id, kind) => path.join(dir, `${id}.${kind}.json`);
  const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  const writeJson = (p, data) => {
    fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(p + '.tmp', p);
  };

  // ─── The user's own GitHub repos ──────────────────────────────────────────
  // repos.local.json. A repos list from before collisions were parked
  // (collisions.local.json) carries over once, keeping only the repo fields.
  const reposFile = path.join(dir, 'repos.local.json');
  const REPO_FIELDS = ['repository', 'name', 'folderName', 'releaseAssetFilter', 'assetPattern', 'appIconUrl', 'tags', 'filesToAdd'];
  const pickRepo = (c) => Object.fromEntries(REPO_FIELDS.filter(k => c[k] != null).map(k => [k, c[k]]));
  function localList() {
    if (!fs.existsSync(reposFile)) {
      const old = readJson(path.join(dir, 'collisions.local.json'), null);
      if (Array.isArray(old)) {
        const repos = old.filter(c => repoKey(c?.repository)).map(pickRepo);
        writeJson(reposFile, repos);
        log(`[catalogs] carried ${repos.length} repo(s) over from collisions.local.json`);
      }
    }
    const l = readJson(reposFile, []);
    return Array.isArray(l) ? l.filter(c => repoKey(c?.repository)) : [];
  }

  // Adds one (replacing any for the same repository). { ok, entry } or { ok: false, errors }
  function addRepo(entry) {
    const errors = [];
    if (!entry || typeof entry !== 'object' || typeof entry.repository !== 'string' || !REPO.test(entry.repository.trim())) errors.push('repository must be owner/repo');
    for (const k of ['name', 'folderName', 'releaseAssetFilter']) if (entry?.[k] != null && typeof entry[k] !== 'string') errors.push(`${k} must be a string`);
    if (errors.length) return { ok: false, errors };
    const clean = pickRepo({ ...entry, repository: entry.repository.trim() });
    const key = repoKey(clean.repository);
    writeJson(reposFile, [...localList().filter(c => repoKey(c.repository) !== key), clean]);
    return { ok: true, entry: clean };
  }
  function removeRepo(repository) {
    const key = repoKey(repository);
    const before = localList();
    const after = before.filter(c => repoKey(c.repository) !== key);
    if (after.length === before.length) return false;
    writeJson(reposFile, after);
    return true;
  }

  // ─── Additional sources: everything that isn't curated ────────────────────
  // user.json's github entries, then the user's own repos on top, and only
  // while Settings allows additional sources. A repository a port shelf
  // already lists is left out and reported as a conflict.
  const additional = () => additionalAllowed(settings);
  function userLayers() {
    const out = { map: new Map(), conflicts: [] };
    if (!additional()) return out;
    const listed = listedRepos();
    const githubEntry = (g) => ({ ...g, name: g.name || g.repository.split('/')[1] });
    const layers = [
      ['user.json github', userSources.entries().github.map(githubEntry)],
      ['your repos', localList()],
    ];
    for (const [from, list] of layers) {
      for (const c of list) {
        const k = repoKey(c?.repository);
        if (!k) continue;
        if (listed.has(k)) {
          if (from === 'user.json github') out.conflicts.push({ from, key: c.repository, reason: 'a port shelf lists it' });
          continue;
        }
        out.map.set(k, c);
      }
    }
    return out;
  }

  const userConflicts = () => userLayers().conflicts;

  const subscriptions = () => (Array.isArray(settings.load().catalogs) ? settings.load().catalogs : []);

  // Repositories the port shelves list
  function listedRepos() {
    return new Set(subscriptions().flatMap(sub => cachedEntries(sub.id).map(e => repoKey(e.repository))).filter(Boolean));
  }

  // The user's repos no port shelf lists, as catalog entries: the "Your
  // ports" shelf. Empty while additional sources are off.
  function localEntries() {
    return [...userLayers().map.values()].map(c => ({
      name: c.name || c.repository, repository: c.repository, folderName: c.folderName || '',
      ...(c.appIconUrl ? { appIconUrl: c.appIconUrl } : {}),
      ...(Array.isArray(c.tags) ? { tags: c.tags } : {}), ...(c.releaseAssetFilter ? { releaseAssetFilter: c.releaseAssetFilter } : {}),
      ...(c.assetPattern ? { assetPattern: c.assetPattern } : {}),
      ...(Array.isArray(c.filesToAdd) ? { filesToAdd: c.filesToAdd } : {}),
      ...(c.sha1 ? { sha1: String(c.sha1).toLowerCase() } : {}),
    }));
  }

  // Subscriptions, and "Your ports" while it has anything on it
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
    return shelves().flatMap(sub => entries(sub.id).map(e => ({
      // not reviewed by us: a "Your ports" entry
      userSource:  !!sub.local,
      id:          `quiver:${sub.id}:${entryKey(e)}`,
      title:       e.name || e.repository,
      source:      { type: 'quiver', catalog: sub.id, name: sub.name, url: sub.url },
      shelf:       sub.shelf,
      repository:  e.repository || null,
      icon:        e.appIconUrl || null,
      tags:        Array.isArray(e.tags) ? e.tags : [],
      description: e.description || null,
      entry:       e,
    })));
  }

  return { list, get, subscribe, unsubscribe, refresh, entries, review, markSeen, items,
    localRepos: localList, addRepo, removeRepo, userConflicts, additionalAllowed: additional };
}

module.exports = { createCatalogs, parseCatalog, diffEntries, catalogId, entryKey };
