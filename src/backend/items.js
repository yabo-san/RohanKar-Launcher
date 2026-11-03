'use strict';
/**
 * The normalized model: one item per title. archive.org uploads from every
 * enabled source are grouped by titleKey (the first upload names the group,
 * the rest are its versions); catalog entries are one item each. Library
 * state is joined in at read time, so installs show up without a refetch.
 *
 * Built-in uploaders (catalog/uploaders.json) and the user's own (any other
 * uploader, and user.json's "archive" entries) all load; the user's versions
 * carry user: true, which decides how their files are checked (user-sources.js).
 *
 * An upload whose overrides.json entry has hidden: true is left out of every
 * list (wall, shelves, search) unless it's installed.
 */
const { sourcesFromSettings, getTitle, titleKey, normalizeUploader, sourceKeys, titleAllowed, joinTerms, itemIdFrom } = require('./sources');
const { platformOf } = require('./playnite');

const truthy = (v) => v === true || v === 'true' || v === '1';

// Curated sources by every key they answer to (email, @handles)
function curatedByKey(defaults) {
  const map = new Map();
  for (const d of defaults) for (const k of sourceKeys(d)) if (!map.has(k)) map.set(k, d);
  return map;
}

// A saved source as loadArchive uses it. One matching a curated entry, by its
// email or any of its handles, takes the curated title filters on top of its
// own; any other is user: true. A label defaults to the handle, the part of
// the email before @, or the identifier. One that isn't an uploader at all is
// kept with invalid: <why>, and reported as a failed source.
function resolveSource(src, curated) {
  const n = normalizeUploader(src.uploader);
  if (n.error) return { ...src, invalid: n.error, user: !curated.has(String(src.uploader).toLowerCase()) };
  const c = curated.get(n.key);
  const out = { ...src, label: src.label || (n.kind === 'email' ? n.value.split('@')[0] : n.value) };
  const titleInclude = joinTerms(c?.titleInclude, src.titleInclude);
  const titleExclude = joinTerms(c?.titleExclude, src.titleExclude);
  if (titleInclude) out.titleInclude = titleInclude; else delete out.titleInclude;
  if (titleExclude) out.titleExclude = titleExclude; else delete out.titleExclude;
  if (!c) out.user = true;
  return out;
}
const NO_USER = { entries: () => ({ archive: [], github: [] }), read: () => ({ file: null, mtime: null }) };
const USER_LABEL = 'Your sources';

function createItems({ archive, settings, catalogs, library, getOverrides, userSources = NO_USER, getDefaultSources = async () => [], emit = () => {}, log = () => {} }) {
  let loaded = null;   // { groups, errors, conflicts, key, loadedAt }
  let loading = null;

  // What the loaded groups depend on besides the uploader list
  const userKey = () => {
    const f = userSources.read();
    return JSON.stringify([f.file, f.mtime]);
  };

  // One source at a time so archive.org sees a trickle, not a burst
  async function loadArchive() {
    const defaults = await getDefaultSources();
    const curated = curatedByKey(defaults);
    const s = settings.load();
    const enabled = sourcesFromSettings(s, defaults)
      .filter(src => src.enabled !== false)
      .map(src => resolveSource(src, curated));
    const overrides = await getOverrides();
    const results = [];
    for (const src of enabled) {
      if (src.invalid) {
        log(`[items] source ${src.uploader}: ${src.invalid}`);
        results.push({ error: src.invalid, src });
        continue;
      }
      try {
        const docs = await archive.fetchSource(src);
        // Uploads the source's title filters leave out are kept (an installed
        // one keeps its card) but marked, and list() skips them
        results.push(docs.map(d => ({ ...d, _source: src, ...(titleAllowed(d.title, src) ? {} : { _excluded: 'title' }) })));
      } catch (e) {
        log(`[items] source ${src.uploader} failed: ${e.message}`);
        results.push({ error: e.message, src });
      }
    }
    const errors = results.filter(r => r.error).map(r => ({ source: r.src.uploader, label: r.src.label || r.src.uploader, error: r.error }));
    if (enabled.length && errors.length === enabled.length) {
      const err = new Error(errors[0].error);
      err.errors = errors;
      throw err;
    }

    // user.json's standalone downloads, after every uploader. One a curated
    // uploader already has is ignored (curated wins) and listed as a conflict.
    const docs = results.filter(Array.isArray).flat();
    const curatedIds = new Set(docs.filter(d => !d._source.user).map(d => d.identifier.toLowerCase()));
    const conflicts = [];
    for (const e of userSources.entries().archive) {
      if (curatedIds.has(e.identifier.toLowerCase())) {
        conflicts.push({ from: 'user.json archive', key: e.identifier, reason: 'a built-in uploader has it' });
        continue;
      }
      const r = await archive.item(e.identifier);
      if (!r.ok || !Object.keys(r.metadata).length) {
        const error = r.ok ? `${e.identifier} isn't an archive.org item` : r.error;
        log(`[items] user.json ${e.identifier} failed: ${error}`);
        errors.push({ source: 'user.json', label: e.identifier, error });
      }
      const m = r.metadata;
      docs.push({
        identifier: e.identifier, title: e.title || m.title || e.identifier,
        description: m.description ?? null, date: m.date ?? null, addeddate: m.addeddate ?? null, subject: m.subject ?? null,
        _source: { uploader: m.uploader || 'user.json', label: USER_LABEL, user: true },
        _userEntry: e,
      });
    }

    // Flatten in source order, drop repeated identifiers, then group by title
    const seen = new Set();
    const groups = new Map();
    for (const doc of docs) {
      if (seen.has(doc.identifier)) continue;
      seen.add(doc.identifier);
      if (overrides[doc.identifier]) doc._override = overrides[doc.identifier];
      const key = titleKey(doc) || doc.identifier;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }
    return { groups: [...groups.values()], errors, conflicts };
  }

  // Reloads when asked, and when the setting or user.json changed
  function load({ refresh = false } = {}) {
    if (loaded && !refresh && loaded.key === userKey()) return Promise.resolve(loaded);
    const key = userKey();
    loading ??= loadArchive()
      .then(r => { loaded = { ...r, key, loadedAt: Date.now() }; emit('items', { count: r.groups.length, errors: r.errors }); return loaded; })
      .finally(() => { loading = null; });
    return loading;
  }

  // An upload's platform from its archive.org subjects ("ps2", "nintendo 64"),
  // else PC, as the Playnite export files every archive.org entry
  const platformOfSubjects = (subject) => {
    const list = (Array.isArray(subject) ? subject : [subject]).filter(Boolean).flatMap(s => String(s).split(/[;,]/));
    return list.map(platformOf).find(p => p !== 'Other') || 'PC';
  };

  const version = (doc) => ({
    id:          doc.identifier,
    title:       getTitle(doc),
    source:      { type: 'archive.org', uploader: doc._source.uploader, label: doc._source.label || doc._source.uploader },
    addeddate:   doc.addeddate || null,
    date:        doc.date || null,
    downloads:   doc.downloads ?? null,
    description: doc.description ?? null,
    subject:     doc.subject ?? null,
    platform:    platformOfSubjects(doc.subject),
    originalTitle: doc.title ?? null,
    override:    doc._override || null,
    user:        !!doc._source.user,
  });

  // A group as an item; `library` is the row of the installed version if any, else the first's
  function archiveItem(docs, lib) {
    const versions = docs.map(version);
    const installed = versions.find(v => lib[v.id]?.install_dir);
    const first = versions[0];
    return {
      ...first,
      id:        first.id,
      shelf:     'wall',
      override:  docs[0]._override || null,
      // every version from an additional source: the card says so
      userSource: versions.every(v => v.user),
      versions,
      installed: !!installed,
      library:   lib[(installed || first).id] || null,
    };
  }

  function catalogItem(it, lib) {
    const row = lib[it.id] || null;
    return { ...it, versions: [], installed: !!row?.install_dir, library: row };
  }

  // Single uploads the user excluded, lowercase identifiers: Settings' "- "
  // lines (settings.excludeItems, checked on save) and user.json's exclude list.
  // Read on every list, so a change needs no refetch.
  function excludedItems() {
    const saved = settings.load().excludeItems;
    const out = new Set(userSources.entries().exclude?.map(id => id.toLowerCase()));
    for (const x of Array.isArray(saved) ? saved : []) out.add(itemIdFrom(x)?.toLowerCase());
    out.delete(undefined);
    return out;
  }

  // filters: source (uploader, label or catalog id), shelf, search (title
  // substring, case-insensitive), installed (true/false), inLibrary (true/false)
  async function list(filters = {}) {
    const { groups, errors } = await load({ refresh: truthy(filters.refresh) });
    const lib = library.all();
    const excluded = excludedItems();
    // An upload overrides.json marks hidden, or the user excluded (by
    // identifier or a title filter), is left out unless it's installed, so an
    // installed copy keeps its card; a group with none left goes away
    const shown = groups
      .map(g => g.filter(d => !(d._override?.hidden || d._excluded || excluded.has(d.identifier.toLowerCase())) || lib[d.identifier]?.install_dir))
      .filter(g => g.length);
    let items = [
      ...shown.map(g => archiveItem(g, lib)),
      ...catalogs.items().map(it => catalogItem(it, lib)),
    ];
    if (filters.source) {
      const s = String(filters.source).toLowerCase();
      const from = (src) => [src.uploader, src.label, src.catalog, src.name].some(v => v && String(v).toLowerCase() === s);
      // A group matches when any of its versions came from that source
      items = items.filter(it => from(it.source) || it.versions.some(v => from(v.source)));
    }
    if (filters.shelf) items = items.filter(it => String(it.shelf).toLowerCase() === String(filters.shelf).toLowerCase());
    if (filters.search) {
      const q = String(filters.search).toLowerCase();
      items = items.filter(it => it.title.toLowerCase().includes(q) || it.versions.some(v => v.title.toLowerCase().includes(q)));
    }
    if (filters.installed != null && filters.installed !== '') items = items.filter(it => it.installed === truthy(filters.installed));
    if (filters.inLibrary != null && filters.inLibrary !== '') items = items.filter(it => !!it.library === truthy(filters.inLibrary));
    return { items, errors };
  }

  // Any version's identifier finds its group
  async function get(id) {
    const { items } = await list();
    return items.find(it => it.id === id || it.versions.some(v => v.id === id)) || null;
  }

  // Every archive.org upload loaded so far: the scan matches folders against these
  function loadedVersions() {
    return (loaded?.groups || []).flat();
  }

  // What an install of this identifier checks: null for a curated upload,
  // else the files' sha1s from user.json (a file with none is pinned)
  function userCheck(identifier) {
    const doc = loadedVersions().find(d => d.identifier === identifier);
    if (!doc?._source.user) return null;
    return { files: doc._userEntry?.files || [] };
  }

  // user.json archive entries a curated uploader already has, as of the last load
  const conflicts = () => loaded?.conflicts || [];

  return { load, list, get, loadedVersions, userCheck, conflicts };
}

module.exports = { createItems };
