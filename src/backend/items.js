'use strict';
/**
 * The normalized model: one item per title. archive.org uploads from every
 * enabled source are grouped by titleKey (the first upload names the group,
 * the rest are its versions); catalog entries are one item each. Library
 * state is joined in at read time, so installs show up without a refetch.
 */
const { sourcesFromSettings, getTitle, titleKey } = require('./sources');

const truthy = (v) => v === true || v === 'true' || v === '1';

function createItems({ archive, settings, catalogs, library, getOverrides, getDefaultSources = async () => [], emit = () => {}, log = () => {} }) {
  let loaded = null;   // { groups, errors, loadedAt }
  let loading = null;

  // One source at a time so archive.org sees a trickle, not a burst
  async function loadArchive() {
    const enabled = sourcesFromSettings(settings.load(), await getDefaultSources()).filter(s => s.enabled !== false);
    const overrides = await getOverrides();
    const results = [];
    for (const src of enabled) {
      try {
        const docs = await archive.fetchSource(src);
        results.push(docs.map(d => ({ ...d, _source: src })));
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

    // Flatten in source order, drop repeated identifiers, then group by title
    const seen = new Set();
    const groups = new Map();
    for (const doc of results.filter(Array.isArray).flat()) {
      if (seen.has(doc.identifier)) continue;
      seen.add(doc.identifier);
      if (overrides[doc.identifier]) doc._override = overrides[doc.identifier];
      const key = titleKey(doc) || doc.identifier;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }
    return { groups: [...groups.values()], errors };
  }

  function load({ refresh = false } = {}) {
    if (loaded && !refresh) return Promise.resolve(loaded);
    loading ??= loadArchive()
      .then(r => { loaded = { ...r, loadedAt: Date.now() }; emit('items', { count: r.groups.length, errors: r.errors }); return loaded; })
      .finally(() => { loading = null; });
    return loading;
  }

  const version = (doc) => ({
    id:          doc.identifier,
    title:       getTitle(doc),
    source:      { type: 'archive.org', uploader: doc._source.uploader, label: doc._source.label || doc._source.uploader },
    addeddate:   doc.addeddate || null,
    date:        doc.date || null,
    downloads:   doc.downloads ?? null,
    description: doc.description ?? null,
    subject:     doc.subject ?? null,
    originalTitle: doc.title ?? null,
    override:    doc._override || null,
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
      versions,
      installed: !!installed,
      library:   lib[(installed || first).id] || null,
    };
  }

  function catalogItem(it, lib) {
    const row = lib[it.id] || null;
    return { ...it, versions: [], installed: !!row?.install_dir, library: row };
  }

  // filters: source (uploader, label or catalog id), shelf, search (title
  // substring, case-insensitive), installed (true/false), inLibrary (true/false)
  async function list(filters = {}) {
    const { groups, errors } = await load({ refresh: truthy(filters.refresh) });
    const lib = library.all();
    let items = [
      ...groups.map(g => archiveItem(g, lib)),
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

  return { load, list, get, loadedVersions };
}

module.exports = { createItems };
