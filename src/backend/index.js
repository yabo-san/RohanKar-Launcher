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
const { createInstalls } = require('./installs');
const { createCatalogs } = require('./catalogs');
const { createItems }    = require('./items');
const { loadOverrides, OVERRIDES_URL } = require('./overrides');
const { getText } = require('./net');
const playnite = require('./playnite');
const disk = require('./disk');

const REPO_ROOT = path.join(__dirname, '..', '..');

// OS actions when no Electron host is attached (standalone backend). Electron
// replaces openPath, trashItem and chooseFolder with shell/dialog calls.
function defaultHost(platform = process.platform) {
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  const unsupported = (what) => () => { const e = new Error(`${what} needs the desktop app`); e.code = 'unsupported'; throw e; };
  return {
    openPath: (p) => new Promise((resolve) => {
      execFile(opener, [p], (err) => resolve(err ? err.message : ''));
    }),
    revealPath: (p) => { execFile(opener, [p]); },
    trashItem:    unsupported('Moving files to the trash'),
    chooseFolder: unsupported('Choosing a folder'),
    openExternal: unsupported('Opening a browser'),
  };
}

function createBackend({
  dataDir,
  appDir = REPO_ROOT,
  archiveBase = 'https://archive.org',
  overridesUrl = OVERRIDES_URL,
  collisionsFile = path.join(appDir, 'catalog', 'collisions.json'),
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
    onChange: (d) => emit('library', d),
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

  const covers   = createCovers({ cacheDir: path.join(dataDir, 'thumbcache'), appDir, archive, getOverrides, log: netlog.log });
  const installs = createInstalls({ settings, library, archive, gamesDir, emit, log, netLog: netlog.log, platform });
  const catalogs = createCatalogs({ dir: path.join(dataDir, 'catalogs'), settings, collisionsFile, netLog: netlog.log, log });
  const items    = createItems({ archive, settings, catalogs, library, getOverrides, emit, log });

  // ─── Actions that combine a module with the OS ────────────────────────────

  async function launch(identifier, exePath) {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: 'Executable not found: ' + exePath };
    try {
      // Unblock on every launch: covers games installed before unblocking existed
      disk.unblockDirectory(library.get(identifier)?.install_dir || path.dirname(exePath), { platform, log });
      const errMsg = await os.openPath(exePath);
      return errMsg ? { ok: false, error: errMsg } : { ok: true };
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

  async function exportPlaynite(file = path.join(dataDir, 'playnite-export.json')) {
    const byId = {};
    try {
      for (const it of (await items.list()).items) {
        byId[it.id] = it;
        for (const v of it.versions) byId[v.id] = it;
      }
    } catch { /* sources down: export names fall back to identifiers */ }
    const cols = library.collections();
    const thumbDir = path.join(dataDir, 'thumbcache');
    const data = playnite.buildExport({
      rows: library.all(),
      items: byId,
      tagsFor: (id) => cols.filter(c => c.games.includes(id)).map(c => c.name),
      coverPath: (id) => { const p = path.join(thumbDir, `${id}.jpg`); return fs.existsSync(p) ? p : null; },
    });
    return { file: playnite.writeExport(file, data), count: data.games.length };
  }

  function close() {
    library.close();
    events.removeAllListeners();
  }

  return {
    dataDir, appDir, events, emit, os,
    settings, netlog, library, archive, covers, installs, catalogs, items, getOverrides,
    launch, openFolder, removeFromLibrary, exportPlaynite, close,
  };
}

module.exports = { createBackend, defaultHost };
