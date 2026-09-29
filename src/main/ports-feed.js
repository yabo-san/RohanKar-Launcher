'use strict';
/**
 * RohanKar Launcher — ports-feed.js
 * Fetches the Ports inputs (Quiver's four lists, collisions.json, catalog.json),
 * caches each to disk, and builds the model with src/core/ports.js. Quiver lists
 * fall back to the last cached copy; the two catalog files fall back to the
 * copy bundled with the app.
 */
const fs   = require('fs');
const path = require('path');
const { QUIVER_CATALOGS, CATALOG_BASE, buildPorts, diffCatalog } = require('../core/ports');

// fetchText(url) resolves to the body or rejects. cacheDir holds one file per input.
function createPortsFeed({ fetchText, cacheDir, bundledDir, log = () => {} }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = (name) => path.join(cacheDir, name);
  const seenPath  = cachePath('seen.json');
  let current = null;

  async function fetchJson(url, name) {
    try {
      const json = JSON.parse(await fetchText(url));
      fs.writeFileSync(cachePath(name), JSON.stringify(json));
      log(`[ports] ${name} from ${url}`);
      return { json, fetchedAt: Date.now(), fromCache: false };
    } catch (e) {
      try {
        const file = cachePath(name);
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        log(`[ports] ${name} fetch failed (${e.message}), using cache`);
        return { json, fetchedAt: fs.statSync(file).mtimeMs, fromCache: true };
      } catch {
        log(`[ports] ${name} fetch failed (${e.message}), no cache`);
        return { json: null, error: e.message };
      }
    }
  }

  async function fetchCatalogFile(file) {
    const r = await fetchJson(CATALOG_BASE + file, `rk-${file}`);
    if (r.json) return r.json;
    try { return JSON.parse(fs.readFileSync(path.join(bundledDir, file), 'utf8')); } catch { return null; }
  }

  async function refresh() {
    const lists = {};
    // One at a time: four small files, no reason to burst GitHub
    for (const c of QUIVER_CATALOGS) lists[c.id] = await fetchJson(c.url, `quiver-${c.file}`);
    const collisions = await fetchCatalogFile('collisions.json');
    const catalog    = await fetchCatalogFile('catalog.json');
    const model = buildPorts({ lists, collisions, catalog });
    current = { model, lists };

    // First sight of a list records it as seen, so the review starts empty
    const seen = readSeen();
    let wrote = false;
    for (const c of QUIVER_CATALOGS) {
      if (!seen[c.id] && lists[c.id].json) { seen[c.id] = lists[c.id].json.apps || []; wrote = true; }
    }
    if (wrote) writeSeen(seen);
    return model;
  }

  function readSeen() {
    try { return JSON.parse(fs.readFileSync(seenPath, 'utf8')); } catch { return {}; }
  }
  function writeSeen(seen) {
    const tmp = seenPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, seenPath);
  }

  async function get() { return current ? current.model : refresh(); }

  // New, changed and removed entries per list since it was last marked seen
  async function review() {
    if (!current) await refresh();
    const seen = readSeen();
    return QUIVER_CATALOGS.map(c => {
      const now = current.lists[c.id].json?.apps;
      if (!now) return { id: c.id, name: c.name, added: [], changed: [], removed: [], error: current.lists[c.id].error };
      return { id: c.id, name: c.name, ...diffCatalog(seen[c.id] || [], now) };
    });
  }

  async function markSeen(id) {
    if (!current) await refresh();
    const seen = readSeen();
    for (const c of QUIVER_CATALOGS) {
      if ((!id || id === c.id) && current.lists[c.id].json) seen[c.id] = current.lists[c.id].json.apps || [];
    }
    writeSeen(seen);
    return { ok: true };
  }

  return { get, refresh, review, markSeen };
}

module.exports = { createPortsFeed };
