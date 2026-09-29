'use strict';
/**
 * window.electronAPI for the browser preview (scripts/ui-preview.js). Reads go
 * to the preview server; anything that would touch the disk or launch a game
 * says so and does nothing.
 */
(function () {
  const call = (route, body) => fetch(`/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
  const artById = {};
  const noop = (what) => () => Promise.resolve({ ok: false, error: `${what} is not available in the browser preview` });
  let settings = {};

  window.electronAPI = {
    windowMinimize() {}, windowMaximize() {}, windowClose() {},
    getSettings: () => Promise.resolve(settings),
    saveSettings: (s) => { settings = { ...settings, ...s }; return Promise.resolve({ ok: true }); },
    chooseFolder: () => Promise.resolve(null),
    getLibrary: () => Promise.resolve({}),
    getOverrides: () => fetch('/overrides.json').then(r => r.json()).catch(() => ({})),
    archiveSearch: async ({ params }) => {
      const r = await call('archive-search', { params });
      // The catalog fallback carries each item's art so the preview has covers
      for (const d of r.json?.response?.docs || []) if (d._art) artById[d.identifier] = d._art;
      return r;
    },
    getThumb: ({ identifier }) => Promise.resolve(artById[identifier] || `https://archive.org/services/img/${identifier}`),
    getPorts: () => call('ports'),
    refreshPorts: () => call('ports-refresh'),
    reviewPorts: () => call('ports-review'),
    markPortsSeen: (o) => call('ports-mark-seen', o),
    getPortLibrary: () => call('port-library'),
    addPortToLibrary: (o) => call('port-library-add', o),
    removePortFromLibrary: (o) => call('port-library-remove', o),
    getAppVersion: () => Promise.resolve('preview'),
    onDownloadProgress() {},
    fetchFileList: noop('Installing'),
    downloadStart: noop('Installing'),
    downloadCancel: noop('Installing'),
    extractArchive: noop('Installing'),
    installGame: noop('Installing'),
    findExes: () => Promise.resolve([]),
    launchGame: noop('Launching'),
    openGameLocation: noop('Opening folders'),
    deleteGame: noop('Deleting'),
    addToSteam: noop('Add to Steam'),
    switchUi: noop('The classic interface'),
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
  };
})();
