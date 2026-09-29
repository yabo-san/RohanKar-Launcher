'use strict';
/**
 * RohanKar Launcher — core/ports.js
 * The Ports half of the model: Quiver's community catalogs as shelves, joined
 * to this repo's collision catalog on `repository`. Pure functions, no DOM and
 * no network, so the main process and the browser preview share them.
 */

const QUIVER_BASE = 'https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/community-app-catalog/';
const CATALOG_BASE = 'https://raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/catalog/';

// One shelf per console the ports came from, in the order the sidebar shows them
const QUIVER_CATALOGS = [
  { id: 'nintendo',    name: 'Nintendo',    file: 'Nintendo.json' },
  { id: 'playstation', name: 'PlayStation', file: 'PlayStation.json' },
  { id: 'xbox',        name: 'Xbox',        file: 'Xbox.json' },
  { id: 'other',       name: 'Other',       file: 'OtherPlatforms.json' },
].map(c => ({ ...c, url: QUIVER_BASE + c.file }));

const repoKey = (repository) => String(repository || '').trim().toLowerCase();

// Stable across catalog edits that don't move the entry: the repository plus
// the folder it installs into (two entries can share a repository).
function identityKey(entry) {
  return `${repoKey(entry.repository)}::${String(entry.folderName || '').toLowerCase()}`;
}

// A Quiver list file ({ name, description, apps: [...] }) as shelf items
function normalizeCatalog(json, catalog) {
  const apps = Array.isArray(json?.apps) ? json.apps : [];
  return apps.filter(a => a && a.name && a.repository).map(a => ({
    id:                 `quiver:${catalog.id}:${identityKey(a)}`,
    kind:               'port',
    name:               a.name,
    project:            a.project || '',
    repository:         a.repository,
    folderName:         a.folderName || '',
    iconUrl:            a.appIconUrl || null,
    tags:               Array.isArray(a.tags) ? a.tags : [],
    releaseAssetFilter: a.releaseAssetFilter || null,
    filesToAdd:         Array.isArray(a.filesToAdd) ? a.filesToAdd : [],
    shelf:              catalog.id,
    shelfName:          catalog.name,
    catalogUrl:         catalog.url,
    raw:                a,
  }));
}

// collisions.json (a list) keyed by lowercase repository
function indexCollisions(list) {
  const out = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    if (c?.repository) out.set(repoKey(c.repository), c);
  }
  return out;
}

// catalog.json entries that declare dataFiles or an uploader, keyed by lowercase repository
function indexCatalog(json) {
  const out = new Map();
  for (const a of Array.isArray(json?.apps) ? json.apps : []) {
    if (a?.repository) out.set(repoKey(a.repository), a);
  }
  return out;
}

// Adds `data` to each item: where its game data comes from, or what it needs.
// Joined on repository only, never on title.
function joinCollisions(items, collisions, catalogIndex = new Map()) {
  return items.map(item => {
    const key = repoKey(item.repository);
    const hit = collisions.get(key);
    const entry = catalogIndex.get(key);
    if (hit) {
      return { ...item, data: {
        status:       'available',
        iaIdentifier: hit.iaIdentifier,
        contentUrl:   hit.contentUrl || null,
        uploader:     entry?.iaSource || entry?.iaUploader?.split('@')[0] || null,
        files:        (hit.dataFiles || []).map(f => f.name),
      } };
    }
    const needed = (entry?.dataFiles || []).filter(f => !f.optional).map(f => f.name);
    if (needed.length) return { ...item, data: { status: 'missing', files: needed } };
    return { ...item, data: { status: 'none', files: [] } };
  });
}

// Entries new, changed or removed since `before` was seen. Both sides are raw
// Quiver apps arrays; the comparison ignores key order.
function diffCatalog(before, after) {
  const stable = (v) => JSON.stringify(v, Object.keys(v).sort());
  const prev = new Map((before || []).map(a => [identityKey(a), a]));
  const next = new Map((after || []).map(a => [identityKey(a), a]));
  const added = [], changed = [], removed = [];
  for (const [k, a] of next) {
    if (!prev.has(k)) added.push(a);
    else if (stable(prev.get(k)) !== stable(a)) changed.push(a);
  }
  for (const [k, a] of prev) if (!next.has(k)) removed.push(a);
  return { added, changed, removed };
}

// The whole Ports model from the fetched files. `lists` maps catalog id to
// { json, error, fetchedAt, fromCache } for each Quiver list.
function buildPorts({ lists, collisions, catalog }) {
  const cIndex = indexCollisions(collisions);
  const aIndex = indexCatalog(catalog);
  const shelves = [];
  let items = [];
  for (const c of QUIVER_CATALOGS) {
    const l = lists[c.id] || {};
    const shelfItems = joinCollisions(normalizeCatalog(l.json, c), cIndex, aIndex);
    items = items.concat(shelfItems);
    shelves.push({
      id: c.id, name: c.name, url: c.url,
      description: l.json?.description || '',
      preferredTags: l.json?.preferredTagFilters || [],
      count: shelfItems.length,
      withData: shelfItems.filter(i => i.data.status === 'available').length,
      error: l.error || null, fetchedAt: l.fetchedAt || null, fromCache: !!l.fromCache,
    });
  }
  return { shelves, items, collisions: cIndex.size };
}

module.exports = {
  QUIVER_CATALOGS, CATALOG_BASE, repoKey, identityKey, normalizeCatalog,
  indexCollisions, indexCatalog, joinCollisions, diffCatalog, buildPorts,
};
