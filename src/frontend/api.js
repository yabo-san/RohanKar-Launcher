'use strict';
/**
 * y4bo — api.js
 * The frontend's only way out: fetch and EventSource against the backend's
 * /v1 API (docs/API.md). Where it runs:
 *   - the desktop app: preload.js sets window.launcher = { apiBase, token }
 *   - a plain browser: index.html?api=http://127.0.0.1:<port>/v1&token=<token>
 * Loaded as a plain <script> before renderer.js (the classic UI) or
 * new/app.js (the new one), which call `api.*`.
 */

const api = (() => {
  const params = new URLSearchParams(location.search);
  const apiBase = window.launcher?.apiBase || params.get('api') || '';
  const token   = window.launcher?.token   || params.get('token') || '';

  const enc = encodeURIComponent;
  const url = (p, query = {}) => {
    const q = new URLSearchParams({ ...query, token }).toString();
    return `${apiBase}${p}?${q}`;
  };

  // JSON request. Resolves { ok, status, body }; never rejects on HTTP errors.
  async function call(method, p, body, query) {
    try {
      const res = await fetch(url(p, query), {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
    } catch (e) {
      return { ok: false, status: 0, body: { error: 'network', detail: e.message } };
    }
  }
  const failure = (r) => ({ ok: false, error: r.body?.detail || r.body?.error || `HTTP ${r.status}` });

  // An image as an object URL, or null when the backend has none
  async function image(p, query) {
    try {
      const res = await fetch(url(p, query));
      return res.ok ? URL.createObjectURL(await res.blob()) : null;
    } catch {
      return null;
    }
  }

  // One EventSource shared by every listener
  let events = null;
  const listeners = {};
  function on(type, cb) {
    if (!events) events = new EventSource(url('/events'));
    if (!listeners[type]) {
      listeners[type] = [];
      events.addEventListener(type, (e) => {
        const data = JSON.parse(e.data);
        for (const fn of listeners[type]) fn(data);
      });
    }
    listeners[type].push(cb);
  }

  // Installs report progress over /events; finished jobs resolve waiters
  const jobWaiters = new Map();   // job id → { onProgress, resolve }
  let watchingInstalls = false;
  function watchInstalls() {
    if (watchingInstalls) return;
    watchingInstalls = true;
    on('install', (job) => {
      const w = jobWaiters.get(job.id);
      if (!w) return;
      if (job.status === 'downloading') w.onProgress(job.percent, job);
      if (job.status === 'extracting' || job.status === 'verifying') w.onExtracting(job);
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        jobWaiters.delete(job.id);
        w.resolve(job);
      }
    });
  }

  return {
    apiBase, token, url,

    // Window and OS (the desktop app does these; a browser tab has none)
    windowMinimize: () => call('POST', '/os/window', { action: 'minimize' }),
    windowMaximize: () => call('POST', '/os/window', { action: 'maximize' }),
    windowClose:    () => call('POST', '/os/window', { action: 'close' }),
    openExternal:   (href) => call('POST', '/os/open-external', { url: href }),
    chooseFolder:   async () => (await call('POST', '/os/choose-folder')).body?.path || null,
    addToSteam:     async (opts) => { const r = await call('POST', '/os/add-to-steam', opts); return r.ok ? r.body : failure(r); },
    getAppVersion:  async () => (await call('GET', '/health')).body?.version || '',
    getHealth:      async () => (await call('GET', '/health')).body || {},
    updaterInstall: () => call('POST', '/os/updater-install'),
    // Reports the latest status now, if any, then each new one
    onUpdaterStatus: (cb) => {
      on('updater', cb);
      call('GET', '/os/updater').then(r => { if (r.body?.status) cb(r.body.status); });
    },
    // Playnite asking to show an item: the pending request now, if any, then each new one
    onOpenItem: (cb) => {
      on('open-item', cb);
      call('GET', '/os/open-item').then(r => { if (r.body?.identifier) cb({ identifier: r.body.identifier }); });
    },
    clearOpenItem: () => call('DELETE', '/os/open-item'),

    // Settings and sources
    getSettings:  async () => (await call('GET', '/settings')).body || {},
    saveSettings: (s) => call('PUT', '/settings', s),
    getSources:   async () => (await call('GET', '/sources')).body || { defaults: [], sources: [] },
    // Additional sources: user.json's state, invalid entries and conflicts
    getUserSources: async () => (await call('GET', '/user-sources')).body || null,
    getFeatured:  async () => (await call('GET', '/featured')).body?.picks || [],
    getAnnouncement:     async () => (await call('GET', '/announcement')).body?.announcement || null,
    dismissAnnouncement: (id) => call('POST', '/announcement/dismiss', { id }),

    // Items: { items, errors }; throws when every source failed
    getItems: async (query = {}) => {
      const r = await call('GET', '/items', undefined, query);
      if (!r.ok) throw new Error(r.body?.detail || `HTTP ${r.status}`);
      return r.body;
    },
    fetchFileList: async ({ identifier }) => {
      const r = await call('GET', `/items/${enc(identifier)}/files`);
      return r.ok ? { ok: true, files: r.body.files } : { ...failure(r), files: [] };
    },
    fetchReviews: async ({ identifier }) => (await call('GET', `/items/${enc(identifier)}/reviews`)).body?.reviews || [],
    getThumb:        ({ identifier }) => image(`/items/${enc(identifier)}/cover`),
    getOverrideHero: ({ identifier }) => image(`/items/${enc(identifier)}/hero`, { from: 'override' }),
    getInstallHero:  ({ identifier }) => image(`/items/${enc(identifier)}/hero`, { from: 'install' }),
    // A URL to try as an <img> src: the hero shipped with the app, 404 if none
    bundledHeroUrl:  (identifier) => url(`/items/${enc(identifier)}/hero`, { from: 'bundled' }),

    // Library
    getLibrary:  async () => (await call('GET', '/library')).body?.library || {},
    setFavorite: ({ identifier, isFavorite }) => call('PATCH', `/library/${enc(identifier)}`, { favorite: !!isFavorite }),
    setNotes:    ({ identifier, notes }) => call('PATCH', `/library/${enc(identifier)}`, { notes }),
    setExePath:  ({ identifier, exePath }) => call('PATCH', `/library/${enc(identifier)}`, { exePath }),
    setInstallDir: async ({ identifier, installDir }) => {
      const r = await call('PATCH', `/library/${enc(identifier)}`, { installDir });
      return r.ok ? { ok: true, row: r.body } : failure(r);
    },
    // Out of the library; with trash, the install folder goes to the Recycle Bin
    deleteGame: async ({ identifier, trash }) => {
      const r = await call('DELETE', `/library/${enc(identifier)}`, undefined, trash ? { files: 'trash' } : {});
      return r.ok || r.status === 404 ? { ok: true } : failure(r);
    },
    findExes:   async ({ identifier }) => (await call('GET', `/library/${enc(identifier)}/exes`)).body?.exes || [],
    readReadme: async ({ identifier }) => {
      const r = await call('GET', `/library/${enc(identifier)}/readme`);
      return r.ok ? { ok: true, ...r.body } : { ok: false, text: null };
    },
    launchGame: async ({ identifier, exePath }) => {
      const r = await call('POST', `/library/${enc(identifier)}/launch`, { exePath });
      return r.ok ? { ok: true } : failure(r);
    },
    openGameLocation: ({ identifier }) => call('POST', `/library/${enc(identifier)}/reveal`),
    scanForGames: async () => {
      const r = await call('POST', '/library/scan', {});
      return r.ok ? r.body : { found: [], error: r.body?.detail };
    },

    // A manually managed app: a named folder (made, or an existing one) to fill
    createManualApp: async ({ name, folder = null }) => {
      const r = await call('POST', '/library/manual', { name, folder });
      return r.ok ? { ok: true, row: r.body } : failure(r);
    },
    renameEntry: async ({ identifier, title }) => {
      const r = await call('PATCH', `/library/${enc(identifier)}`, { title });
      return r.ok ? { ok: true } : failure(r);
    },
    setTags: async ({ identifier, tags }) => {
      const r = await call('PATCH', `/library/${enc(identifier)}`, { tags });
      return r.ok ? { ok: true, row: r.body } : failure(r);
    },

    // A Quiver folder (apps.json + Apps/): the plan, or with apply the import
    importQuiver: async ({ dir, apply = false }) => {
      const r = await call('POST', '/library/import/quiver', { dir, apply });
      return r.ok ? { ok: true, ...r.body } : failure(r);
    },

    // Library rows for items that aren't installed (catalog ports)
    addToLibrary:      ({ id, source }) => call('POST', '/library', { id, source }),
    removeFromLibrary: async ({ id }) => {
      const r = await call('DELETE', `/library/${enc(id)}`);
      return r.ok || r.status === 404 ? { ok: true } : failure(r);
    },

    fetchItemFiles: async (identifier) => {
      const r = await call('GET', `/items/${enc(identifier)}/files`);
      return r.ok ? { ok: true, files: r.body.files, folders: r.body.folders || [] } : { ...failure(r), files: [], folders: [] };
    },

    // Collisions (docs/COLLISIONS.md): a port's GitHub release bound to archive.org data
    getCollision: async (repo) => { const r = await call('GET', `/collisions/${enc(repo)}`); return r.ok ? r.body : null; },
    saveCollision: async (repo, entry) => { const r = await call('PUT', `/collisions/${enc(repo)}`, entry); return r.ok ? { ok: true, entry: r.body } : failure(r); },
    deleteCollision: async (repo) => { const r = await call('DELETE', `/collisions/${enc(repo)}`); return r.ok || r.status === 404 ? { ok: true } : failure(r); },
    exportCollisions: async () => (await call('GET', '/collisions/export')).body,
    previewCollision: async (sources) => { const r = await call('POST', '/collisions/preview', { sources }); return r.ok ? r.body.sources : null; },
    getCollisionFeeds: async () => (await call('GET', '/collision-feeds')).body?.feeds || [],

    // Admin mode (docs/ADMIN.md): the curated collisions, edited in place
    getCuratedCollisions: async () => { const r = await call('GET', '/admin/collisions'); return r.ok ? r.body : null; },
    saveCuratedCollision: async (repo, entry) => { const r = await call('PUT', `/admin/collisions/${enc(repo)}`, entry); return r.ok ? { ok: true, entry: r.body } : failure(r); },
    deleteCuratedCollision: async (repo) => { const r = await call('DELETE', `/admin/collisions/${enc(repo)}`); return r.ok ? { ok: true } : failure(r); },
    getReleases: async (repo, pattern) => { const r = await call('GET', `/admin/releases/${enc(repo)}`, undefined, pattern ? { pattern } : undefined); return r.ok ? { ok: true, ...r.body } : failure(r); },
    searchArchive: async (q) => { const r = await call('GET', '/admin/ia-search', undefined, { q }); return r.ok ? { ok: true, items: r.body.items } : { ...failure(r), items: [] }; },
    addCollisionFeed: async ({ url, name }) => { const r = await call('POST', '/collision-feeds', { url, name }); return r.ok ? { ok: true, feed: r.body } : failure(r); },
    refreshCollisionFeed: async (id) => (await call('POST', `/collision-feeds/${enc(id)}/refresh`)).body,
    removeCollisionFeed: (id) => call('DELETE', `/collision-feeds/${enc(id)}`),
    importFeed: async (text) => { const r = await call('POST', '/feed/import', { text }); return r.ok ? { ok: true, ...r.body } : failure(r); },
    trustUploader: async ({ uploader, label }) => { const r = await call('POST', '/sources/trust', { uploader, label }); return r.ok ? { ok: true, sources: r.body.sources } : failure(r); },

    // Catalogs (Quiver lists) and what changed in them
    getCatalogs:      async () => (await call('GET', '/catalogs')).body?.catalogs || [],
    subscribeCatalog: async ({ url, name, shelf }) => {
      const r = await call('POST', '/catalogs', { url, name, shelf });
      return r.ok ? r.body : null;
    },
    refreshCatalog:  async (id) => (await call('POST', `/catalogs/${enc(id)}/refresh`)).body,
    getCatalogItems: async (id) => (await call('GET', `/catalogs/${enc(id)}/items`)).body?.items || [],
    reviewCatalog:   async (id) => (await call('GET', `/catalogs/${enc(id)}/review`)).body || { new: [], changed: [], removed: [] },
    markCatalogSeen: (id) => call('POST', `/catalogs/${enc(id)}/seen`),

    // Collections
    getCollections:   async () => (await call('GET', '/collections')).body?.collections || [],
    createCollection: async ({ name }) => { const r = await call('POST', '/collections', { name }); return r.ok ? { ok: true, id: r.body.id } : failure(r); },
    deleteCollection: ({ id }) => call('DELETE', `/collections/${id}`),
    renameCollection: async ({ id, name }) => { const r = await call('PATCH', `/collections/${id}`, { name }); return r.ok ? { ok: true } : failure(r); },
    setCollectionColor: ({ id, color }) => call('PATCH', `/collections/${id}`, { color: color || null }),
    addGameToCollection:      ({ collectionId, identifier }) => call('PUT', `/collections/${collectionId}/items/${enc(identifier)}`),
    removeGameFromCollection: ({ collectionId, identifier }) => call('DELETE', `/collections/${collectionId}/items/${enc(identifier)}`),

    // Installs one file of an item (download, extract, record), or a catalog
    // port when identifier is its quiver: id and fileName is left out. Resolves
    // the finished job ({ status: done | error | cancelled, error, ... }).
    // onStart(job) gets the job at once, so the caller can cancel it; a port's
    // job says which step (binary, data) onProgress and onExtracting are for.
    // acceptHashChange: the user accepted a changed file from their own source
    // (a job that stopped with hashChange)
    install: async ({ identifier, fileName, acceptHashChange, onStart = () => {}, onProgress = () => {}, onExtracting = () => {} }) => {
      watchInstalls();
      const r = await call('POST', '/installs', { id: identifier, ...(fileName ? { files: [fileName] } : {}), ...(acceptHashChange ? { acceptHashChange: true } : {}) });
      if (!r.ok) return { status: 'error', error: r.body?.detail || `HTTP ${r.status}` };
      const job = r.body.installs[0];
      onStart(job);
      const finished = new Promise(resolve => jobWaiters.set(job.id, { onProgress, onExtracting, resolve }));
      // The job may have finished before the listener was in place
      const now = await call('GET', `/installs/${job.id}`);
      if (now.ok && ['done', 'error', 'cancelled'].includes(now.body.status)) {
        jobWaiters.delete(job.id);
        return now.body;
      }
      return finished;
    },
    cancelInstall: ({ jobId }) => call('DELETE', `/installs/${jobId}`),
  };
})();

