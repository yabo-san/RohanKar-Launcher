'use strict';
/**
 * y4bo — src/backend/portable.js
 * Portable data (brief Step 6.3): library.db, settings, caches and installed
 * games in a y4bo-data folder beside the executable instead of %APPDATA%, so
 * one folder is the whole install and can be moved or carried.
 *
 * - The app is portable when <exe folder>/y4bo-data holds launcher data; the
 *   desktop app checks that before it picks its data folder (user-data.js).
 * - Not offered in an installed copy (an "Uninstall *.exe" beside the
 *   executable): the installer deletes its folder on every update, data
 *   included. A copy run from the release's zip, or any folder of its own, can.
 * - Switching is a move, not a copy, done on the next start before library.db
 *   is opened: Settings asks (requestMove writes move-data.json into the data
 *   folder), the app restarts, and the backend's startup runs moveData.
 *   Install paths in library.db and settings.json that pointed into the old
 *   folder are rewritten to the new one.
 * - A games folder that can't be renamed (another drive) stays where it is and
 *   settings keep pointing at it, so nothing is copied for hours at startup.
 */

const fs   = require('fs');
const path = require('path');
const { openDatabase } = require('./sqlite');

const PORTABLE_DIR = 'y4bo-data';
const REQUEST_FILE = 'move-data.json';
// What the backend keeps in its data folder; Chromium's own files stay put
const DATA_ENTRIES = [
  'settings.json', 'library.db', 'library.db-wal', 'library.db-shm', 'library.json', 'pins.json',
  'playnite-export.json', 'archive-net.log', 'catalogs', 'thumbcache', 'games',
];
// settings.json keys holding a folder
const PATH_SETTINGS = ['downloadPath', 'installPath'];

const portableDirOf = (exeDir) => path.join(exeDir, PORTABLE_DIR);

// The NSIS installer leaves "Uninstall <name>.exe" beside the executable
function isInstalledCopy(exeDir, { readdir = fs.readdirSync } = {}) {
  try { return readdir(exeDir).some(f => /^uninstall .*\.exe$/i.test(f)); } catch { return false; }
}

function canWrite(dir, { access = fs.accessSync } = {}) {
  try { access(dir, fs.constants.W_OK); return true; } catch { return false; }
}

// Where the app stands, for Settings. exeDir is null outside the packaged app.
function portableStatus({ exeDir, dataDir, defaultDir = null }, deps = {}) {
  if (!exeDir) return { available: false, portable: false, reason: 'not_packaged', dataDir };
  const portableDir = portableDirOf(exeDir);
  const portable = path.resolve(dataDir) === path.resolve(portableDir);
  const out = { portable, dataDir, portableDir, defaultDir, pending: pendingMove(dataDir, deps), error: moveError(dataDir, deps) };
  if (!portable && isInstalledCopy(exeDir, deps)) return { ...out, available: false, reason: 'installed' };
  if (!portable && !canWrite(exeDir, deps)) return { ...out, available: false, reason: 'read_only' };
  if (portable && !defaultDir) return { ...out, available: false, reason: 'no_default' };
  return { ...out, available: true, reason: null };
}

// Asks for the move on the next start
function requestMove(dataDir, to, { writeFile = fs.writeFileSync } = {}) {
  writeFile(path.join(dataDir, REQUEST_FILE), JSON.stringify({ to: path.resolve(to), requestedAt: new Date().toISOString() }, null, 2));
}

function cancelMove(dataDir, { rm = fs.rmSync } = {}) {
  rm(path.join(dataDir, REQUEST_FILE), { force: true });
}

const readRequest = (dataDir, readFile = fs.readFileSync) => {
  try { return JSON.parse(readFile(path.join(dataDir, REQUEST_FILE), 'utf8')) || null; } catch { return null; }
};

// Where a requested move goes; null once it failed (the request then only
// keeps the error for Settings)
function pendingMove(dataDir, { readFile = fs.readFileSync } = {}) {
  const r = readRequest(dataDir, readFile);
  return typeof r?.to === 'string' && r.to && !r.error ? path.resolve(r.to) : null;
}

function failMove(dataDir, error) {
  const r = readRequest(dataDir) || {};
  fs.writeFileSync(path.join(dataDir, REQUEST_FILE), JSON.stringify({ ...r, error, failedAt: new Date().toISOString() }, null, 2));
}

const moveError = (dataDir, deps = {}) => readRequest(dataDir, deps.readFile)?.error || null;

// p is dir or somewhere inside it
function isInside(p, dir) {
  const rel = path.relative(dir, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// p inside `from` (or `from` itself): the same path under `to`; anything else as is
function rebase(p, from, to) {
  if (typeof p !== 'string' || !p || !isInside(p, from)) return p;
  return path.join(to, path.relative(from, p));
}

function copyThenRemove(src, dest) {
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(src, { recursive: true, force: true });
}

const moveOne = (rename, src, dest) => {
  try { rename(src, dest); } catch (e) { if (e.code !== 'EXDEV') throw e; copyThenRemove(src, dest); }
};

/**
 * Moves the launcher's files from `from` to `to` and rewrites the paths that
 * pointed into `from`. Nothing moves when `to` already holds one of the same
 * files. Resumable: an entry already gone from `from` is skipped, so a move
 * cut short (power loss) finishes on the next start; one that fails is put
 * back and throws. Returns { moved: [names], kept: [{ name, why }] }.
 */
function moveData({ from, to, rename = fs.renameSync, log = () => {} }) {
  from = path.resolve(from);
  to = path.resolve(to);
  if (from === to) return { moved: [], kept: [] };
  if (isInside(to, from)) throw new Error(`Can't move the data folder into itself: ${to}`);
  const todo = DATA_ENTRIES.filter(name => fs.existsSync(path.join(from, name)));
  const clash = todo.filter(name => fs.existsSync(path.join(to, name)));
  if (clash.length) throw new Error(`${to} already has ${clash.join(', ')}; move or delete them first`);
  fs.mkdirSync(to, { recursive: true });
  const moved = [];
  const kept = [];
  try {
    for (const name of todo) {
      const src = path.join(from, name);
      const dest = path.join(to, name);
      // Another drive: games stay put rather than copying them at startup
      if (name === 'games') {
        try { rename(src, dest); } catch (e) { if (e.code !== 'EXDEV') throw e; kept.push({ name, why: 'other_drive' }); continue; }
      } else {
        moveOne(rename, src, dest);
      }
      moved.push(name);
    }
  } catch (e) {
    for (const name of moved.reverse()) {
      try { moveOne(rename, path.join(to, name), path.join(from, name)); } catch { /* left in `to`; the error says so */ }
    }
    throw new Error(`Couldn't move the data to ${to}: ${e.message}`, { cause: e });
  }
  // Games left on the old drive: paths into them stay, and settings keep
  // installing and downloading there
  const keptGames = kept.some(k => k.name === 'games' && k.why === 'other_drive') ? path.join(from, 'games') : null;
  const move = (p) => (keptGames && typeof p === 'string' && p && isInside(p, keptGames) ? p : rebase(p, from, to));
  rewriteSettings(path.join(to, 'settings.json'), move, keptGames);
  rewriteLibrary(path.join(to, 'library.db'), move);
  cancelMove(from);
  // An emptied portable folder goes, so the next start isn't portable
  try { fs.rmdirSync(from); } catch { /* not empty: Chromium's files, or kept games */ }
  log(`[portable] moved ${moved.join(', ') || 'nothing'} from ${from} to ${to}${kept.length ? `; kept ${kept.map(k => `${k.name} (${k.why})`).join(', ')}` : ''}`);
  return { moved, kept };
}

function rewriteSettings(file, move, keptGames) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = null; }
  if (!s && !keptGames) return;
  s ||= {};
  let changed = false;
  for (const k of PATH_SETTINGS) {
    const next = s[k] ? move(s[k]) : keptGames;
    if (next && next !== s[k]) { s[k] = next; changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

function rewriteLibrary(file, move) {
  if (!fs.existsSync(file)) return;
  const db = openDatabase(file);
  try {
    const rows = db.prepare('SELECT identifier, install_dir, exe_path FROM games').all();
    const upd = db.prepare('UPDATE games SET install_dir = ?, exe_path = ? WHERE identifier = ?');
    for (const r of rows) {
      const dir = move(r.install_dir);
      const exe = move(r.exe_path);
      if (dir !== r.install_dir || exe !== r.exe_path) upd.run(dir ?? null, exe ?? null, r.identifier);
    }
  } finally {
    db.close();
  }
}

module.exports = {
  PORTABLE_DIR, REQUEST_FILE, DATA_ENTRIES,
  portableDirOf, isInstalledCopy, portableStatus, requestMove, cancelMove, pendingMove, failMove, moveData, rebase, isInside,
};
