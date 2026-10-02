'use strict';
/**
 * The launcher's backend: everything that isn't a window or an OS dialog.
 * createBackend() wires the modules to one data directory (Electron's
 * userData, or any folder when run standalone). Electron's main process calls
 * it in-process for now; server.js puts it behind the HTTP API.
 */
const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const { createSettings } = require('./settings');
const { createNetLog }   = require('./netlog');
const { createLibrary }  = require('./library');
const { createArchive }  = require('./archive');
const { createCovers }   = require('./covers');
const { createInstalls, GITHUB_API } = require('./installs');
const { createCatalogs, CURATED_PORTS_URL } = require('./catalogs');
const { createItems }    = require('./items');
const { createUserSources, createPins } = require('./user-sources');
const { loadOverrides, OVERRIDES_URL } = require('./overrides');
const { loadFeatured, FEATURED_URL } = require('./featured');
const { currentAnnouncement, isDismissed, ANNOUNCEMENT_URL } = require('./announcement');
const { getText } = require('./net');
const { sourcesFromCatalog } = require('./sources');
const playnite = require('./playnite');
const disk = require('./disk');

const REPO_ROOT = path.join(__dirname, '..', '..');

const readVersion = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch { return null; }
};
const UPLOADERS_URL = 'https://raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/catalog/uploaders.json';

// OS actions when no Electron host is attached (standalone backend). Electron
// replaces them with shell, dialog, window, Steam and updater calls.
function defaultHost(platform = process.platform) {
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  const unsupported = (what) => () => { const e = new Error(`${what} needs the desktop app`); e.code = 'unsupported'; throw e; };
  return {
    openPath: (p) => new Promise((resolve) => {
      execFile(opener, [p], (err) => resolve(err ? err.message : ''));
    }),
    revealPath: (p) => { execFile(opener, [p]); },
    trashItem:      unsupported('Moving files to the trash'),
    chooseFolder:   unsupported('Choosing a folder'),
    openExternal:   unsupported('Opening a browser'),
    window:         unsupported('Window controls'),
    addToSteam:     unsupported('Add to Steam'),
    updaterInstall: unsupported('Updating'),
  };
}

function createBackend({
  dataDir,
  appDir = REPO_ROOT,
  heroesDir = path.join(appDir, 'assets', 'heroes'),
  appVersion = readVersion(appDir),
  archiveBase = 'https://archive.org',
  overridesUrl = OVERRIDES_URL,
  uploadersUrl = UPLOADERS_URL,
  githubApi = GITHUB_API,
  featuredUrl = FEATURED_URL,
  curatedPortsUrl = CURATED_PORTS_URL,
  quiverBase,
  announcementUrl = ANNOUNCEMENT_URL,
  playniteExportDelayMs = 250,
  host = {},
  platform = process.platform,
  sleep,
  log = (msg) => console.log(msg),
}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const gamesDir = path.join(dataDir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });

  const events = new EventEmitter();
  events.setMaxListeners(0);
  const emit = (type, data) => events.emit('event', { type, data });

  const os       = { ...defaultHost(platform), ...host };
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const netlog   = createNetLog(path.join(dataDir, 'archive-net.log'));
  const library  = createLibrary({
    dbPath: path.join(dataDir, 'library.db'),
    legacyJsonPath: path.join(dataDir, 'library.json'),
    onChange: (d) => { emit('library', d); schedulePlayniteExport(); },
    log,
  });
  const archive = createArchive({ base: archiveBase, log: netlog.log, ...(sleep ? { sleep } : {}) });

  let overridesPromise = null;
  const getOverrides = () => (overridesPromise ??= loadOverrides({
    url: overridesUrl,
    fetchText: (url) => getText(url, { kind: 'overrides', timeoutMs: 5000, log: netlog.log })
      .then(r => (r.status === 200 ? r.body : Promise.reject(new Error(r.error || `HTTP ${r.status}`)))),
    readBundled: () => fs.readFileSync(path.join(appDir, 'overrides.json'), 'utf8'),
    log,
  }));

  let featuredPromise = null;
  const getFeatured = () => (featuredPromise ??= loadFeatured({
    url: featuredUrl,
    fetchText: (url) => getText(url, { kind: 'featured', timeoutMs: 5000, log: netlog.log })
      .then(r => (r.status === 200 ? r.body : Promise.reject(new Error(r.error || `HTTP ${r.status}`)))),
    readBundled: () => fs.readFileSync(path.join(appDir, 'catalog', 'featured.json'), 'utf8'),
    log,
  }));

  // The message on main's announcement.json, unless dismissed; fetched each
  // time the window asks, so a new one shows without a restart
  const getAnnouncement = () => currentAnnouncement({
    url: announcementUrl,
    fetchText: (url) => getText(url, { kind: 'announcement', timeoutMs: 5000, log: netlog.log })
      .then(r => (r.status === 200 ? r.body : Promise.reject(new Error(r.error || `HTTP ${r.status}`)))),
    dismissed: settings.load().dismissedAnnouncements,
  });
  function dismissAnnouncement(id) {
    const dismissed = Array.isArray(settings.load().dismissedAnnouncements) ? settings.load().dismissedAnnouncements : [];
    if (!isDismissed(id, dismissed)) settings.save({ dismissedAnnouncements: [...dismissed, id] });
  }

  // Where new installs and manual apps' folders go
  const installRoot = () => settings.load().installPath || gamesDir;

  // Default sources: catalog/uploaders.json on main at launch, the bundled copy as fallback
  let defaultSourcesPromise = null;
  const getDefaultSources = () => (defaultSourcesPromise ??= (async () => {
    const r = await getText(uploadersUrl, { kind: 'uploaders', timeoutMs: 5000, log: netlog.log });
    try {
      if (r.status !== 200) throw new Error(r.error || `HTTP ${r.status}`);
      const list = sourcesFromCatalog(JSON.parse(r.body));
      if (!list.length) throw new Error('no uploaders');
      log(`[uploaders] ${list.length} from ${uploadersUrl}`);
      return list;
    } catch (e) {
      log(`[uploaders] fetch failed (${e.message}), using bundled copy`);
    }
    try {
      return sourcesFromCatalog(JSON.parse(fs.readFileSync(path.join(appDir, 'catalog', 'uploaders.json'), 'utf8')));
    } catch (e) {
      log(`[uploaders] no bundled copy (${e.message}), no default sources`);
      return [];
    }
  })());

  const covers   = createCovers({ cacheDir: path.join(dataDir, 'thumbcache'), appDir, heroesDir, archive, getOverrides, log: netlog.log });
  const userSources = createUserSources({ settings, log });
  const pins     = createPins(path.join(dataDir, 'pins.json'));
  const installs = createInstalls({ settings, library, archive, gamesDir, pins, emit, log, netLog: netlog.log, platform, githubApi });
  const catalogs = createCatalogs({
    dir: path.join(dataDir, 'catalogs'), settings, userSources, netLog: netlog.log, log,
    curatedUrl: curatedPortsUrl, curatedFile: path.join(appDir, 'catalog', 'curated-ports.json'),
    ...(quiverBase ? { quiverBase } : {}), libraryIds: () => new Set(Object.keys(library.all())),
  });
  const items    = createItems({ archive, settings, catalogs, library, getOverrides, userSources, getDefaultSources, emit, log });

  // ─── Actions that combine a module with the OS ────────────────────────────

  async function launch(identifier, exePath) {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Executable not found: ' + exePath };
    try {
      // Unblock on every launch: covers games installed before unblocking existed
      disk.unblockDirectory(library.get(identifier)?.install_dir || path.dirname(exePath), { platform, log });
      const errMsg = await os.openPath(exePath);
      if (errMsg) return { ok: false, error: errMsg };
      library.markPlayed(identifier);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function openFolder(installDir) {
    try {
      if (!installDir || !fs.existsSync(installDir)) return { ok: false, error: 'Folder not found' };
      os.revealPath(installDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Takes an entry out of the library; with trash, moves its folder to the
  // Recycle Bin first (recoverable, and no EPERM on locked folders)
  async function removeFromLibrary(identifier, { installDir = null, trash = false } = {}) {
    try {
      if (trash && installDir) {
        if (fs.existsSync(installDir)) {
          await os.trashItem(installDir);
          log(`[delete] Moved to Recycle Bin: ${installDir}`);
        } else {
          log(`[delete] Folder not found on disk (already gone?): ${installDir}`);
        }
      }
      library.remove(identifier);
      return { ok: true };
    } catch (e) {
      log(`[delete] Failed: ${e.message}`);
      return { ok: false, error: e.message, code: e.code };
    }
  }

  // Uninstall: the folder goes to the Recycle Bin, the entry stays in the library
  async function uninstall(identifier) {
    const row = library.get(identifier);
    if (!row) return { ok: false, error: 'not_in_library' };
    try {
      if (row.install_dir && fs.existsSync(row.install_dir)) {
        await os.trashItem(row.install_dir);
        log(`[uninstall] Moved to Recycle Bin: ${row.install_dir}`);
      }
      library.clearInstall(identifier);
      return { ok: true };
    } catch (e) {
      log(`[uninstall] Failed: ${e.message}`);
      return { ok: false, error: e.message, code: e.code };
    }
  }

  // ─── Playnite export ──────────────────────────────────────────────────────

  const playniteFile = path.join(dataDir, 'playnite-export.json');

  // loadItems: false uses only what is already loaded (and the last export for
  // the rest), so a library change never fetches from archive.org
  async function exportPlaynite(file = playniteFile, { loadItems = true } = {}) {
    const byId = {};
    const loaded = loadItems || items.loadedVersions().length > 0;
    try {
      const list = loaded ? (await items.list()).items : catalogs.items();
      for (const it of list) {
        byId[it.id] = it;
        for (const v of it.versions || []) byId[v.id] = it;
      }
    } catch { /* sources down: names come from the last export, else identifiers */ }
    let overrides = {};
    try { overrides = await getOverrides(); } catch { /* no override art */ }
    const cols = library.collections();
    const data = playnite.buildExport({
      rows: library.all(),
      items: byId,
      tagsFor: (id) => cols.filter(c => c.games.includes(id)).map(c => c.name),
      art: (id, row) => covers.localArt(id, row.install_dir, overrides),
      exportIdFor: (id) => library.exportId(id),
      previous: playnite.readExport(file),
      launcherVersion: appVersion,
    });
    return { file: playnite.writeExport(file, data), count: data.games.length };
  }

  // Every library change rewrites the export, batched so a scan writes it once
  let exportTimer = null;
  let exportRunning = Promise.resolve();
  let closed = false;
  function schedulePlayniteExport() {
    if (closed) return;
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => { exportTimer = null; runPlayniteExport(); }, playniteExportDelayMs);
    exportTimer.unref?.();
  }
  function runPlayniteExport() {
    exportRunning = exportRunning
      .then(() => (closed ? null : exportPlaynite(playniteFile, { loadItems: false })))
      .catch(e => log(`[playnite] export failed: ${e.message}`));
    return exportRunning;
  }
  // Writes a pending export now: the CLI calls this before it exits
  function flushPlayniteExport() {
    if (exportTimer) { clearTimeout(exportTimer); exportTimer = null; return runPlayniteExport(); }
    return exportRunning;
  }

  // The desktop app's updater reports here; the frontend reads it over SSE,
  // or from GET /os/updater if it connected after the report
  let updaterStatus = null;
  function setUpdaterStatus(status) {
    updaterStatus = status;
    emit('updater', status);
  }

  // Playnite asked the window to show an item (--launch on one not installed);
  // the frontend reads it over SSE, or from GET /os/open-item if it connected later
  let openRequest = null;
  function requestOpen(identifier) {
    openRequest = identifier;
    emit('open-item', { identifier });
  }

  function close() {
    closed = true;
    clearTimeout(exportTimer);
    library.close();
    events.removeAllListeners();
  }

  return {
    dataDir, appDir, appVersion, events, emit, os,
    setUpdaterStatus, get updaterStatus() { return updaterStatus; },
    requestOpen, get openRequest() { return openRequest; }, clearOpenRequest: () => { openRequest = null; },
    settings, netlog, library, archive, covers, installs, catalogs, items, userSources, getOverrides, getDefaultSources, getFeatured,
    getAnnouncement, dismissAnnouncement, installRoot,
    launch, openFolder, removeFromLibrary, uninstall, exportPlaynite, flushPlayniteExport, close,
  };
}

module.exports = { createBackend, defaultHost };
