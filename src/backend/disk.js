'use strict';
/**
 * What the launcher reads from install folders: executables, readmes, and
 * pre-existing installs to adopt. Also clears Windows' downloaded-file mark,
 * and on Linux lets a build's programs run.
 */
const fs   = require('fs');
const path = require('path');

const IGNORED_SUBDIRS = new Set(['extras', 'extra', 'bonus', 'soundtrack', 'manuals', 'manual']);
const MAX_DEPTH = 5;

// Sanitize an archive.org identifier for safe use as a folder name.
// Windows forbids names ending with a dot or space.
function sanitizeFolderName(name) {
  return String(name).replace(/[.\s]+$/, '').replace(/[<>:"/\\|?*]/g, '_') || '_';
}

// A game title as a browser download would name its folder
function sanitizeTitle(title) {
  return String(title)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim();
}

const readdir = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
};

// A Linux program by its name: an AppImage, a .x86_64, or no extension at
// all; libraries and data never. isElf then checks a nameless file's bytes.
const LINUX_NAME = /\.(appimage|x86_64)$/i;
const NOT_PROGRAM = /\.so(\.\d+)*$|\.[a-z][a-z0-9]{0,4}$/i;
function isElf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const isLinuxProgram = (file) => LINUX_NAME.test(file) || (!NOT_PROGRAM.test(path.basename(file)) && isElf(file));

// The programs directly inside one directory (no recursion): .exe files, and
// on Linux its own programs first (a folder with only a Windows build runs
// that through Proton)
function exesInDir(dir, { platform = process.platform } = {}) {
  const files = (readdir(dir) || []).filter(e => e.isFile()).map(e => path.join(dir, e.name));
  if (platform === 'linux') {
    const native = files.filter(isLinuxProgram);
    if (native.length) return native;
  }
  return files.filter(f => f.toLowerCase().endsWith('.exe'));
}

// Executables to offer for an install folder:
//   - a collection (has _GAME_<title> folders): every game's executables
//   - a bin/ folder with exes: those
//   - exes at this level: those
//   - otherwise the first non-ignored subfolder (to MAX_DEPTH) that has any
// so a game's internal DOSBox/tool exes don't flood the picker.
function findExes(installDir, depth = 0, { platform = process.platform } = {}) {
  if (!installDir || depth > MAX_DEPTH) return [];
  const opts = { platform };
  const entries = readdir(installDir);
  if (!entries) return [];

  const gameFolders = entries.filter(e => e.isDirectory() && e.name.startsWith('_GAME_'));
  if (gameFolders.length > 0) {
    return gameFolders.flatMap(gf => findExes(path.join(installDir, gf.name), depth + 1, opts));
  }

  const bin = entries.find(e => e.isDirectory() && e.name.toLowerCase() === 'bin');
  if (bin) {
    const binExes = exesInDir(path.join(installDir, bin.name), opts);
    if (binExes.length) return binExes;
  }

  const local = exesInDir(installDir, opts);
  if (local.length) return local;

  for (const sub of entries.filter(e => e.isDirectory() && !IGNORED_SUBDIRS.has(e.name.toLowerCase()))) {
    const found = findExes(path.join(installDir, sub.name), depth + 1, opts);
    if (found.length) return found;
  }
  return [];
}

// Deletes the Zone.Identifier stream from every file under dir: what
// right-click → Unblock does. No-op off Windows.
function unblockDirectory(dir, { platform = process.platform, log = () => {} } = {}) {
  if (platform !== 'win32' || !dir) return 0;
  let count = 0;
  const walk = (d) => {
    for (const e of readdir(d) || []) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { fs.rmSync(full + ':Zone.Identifier'); count++; } catch { /* no stream */ }
      }
    }
  };
  walk(dir);
  log(`[unblock] Removed Zone.Identifier from ${count} files in ${dir}`);
  return count;
}

// Linux: a build unpacked from a zip made on Windows has lost its programs'
// run permission. Gives it back to every Linux program under dir (and .sh
// scripts), as Quiver does. No-op off Linux. Returns how many it changed.
function makeRunnable(dir, { platform = process.platform, log = () => {} } = {}) {
  if (platform !== 'linux' || !dir) return 0;
  let count = 0;
  const fix = (file) => {
    try {
      const mode = fs.statSync(file).mode;
      if ((mode & 0o111) === 0 && (isLinuxProgram(file) || /\.sh$/i.test(file))) { fs.chmodSync(file, (mode & 0o777) | 0o755); count++; }
    } catch { /* gone or not ours */ }
  };
  const walk = (d) => {
    for (const e of readdir(d) || []) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) fix(full);
    }
  };
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) fix(dir); else walk(dir);
  if (count) log(`[runnable] Allowed ${count} programs to run in ${dir}`);
  return count;
}

// A readme* text file in the folder's root. latin1 handles old DOS/Windows text.
function readReadme(installDir) {
  try {
    if (!installDir || !fs.existsSync(installDir)) return { ok: false, text: null };
    const entries = fs.readdirSync(installDir, { withFileTypes: true });
    const entry = entries.find(e => e.isFile() && /^readme/i.test(e.name) && /\.(txt|md|nfo|doc|rtf|htm|html|1st)$/i.test(e.name))
      || entries.find(e => e.isFile() && /^readme$/i.test(e.name));
    if (!entry) return { ok: true, text: null };
    return { ok: true, text: fs.readFileSync(path.join(installDir, entry.name), 'latin1'), fileName: entry.name };
  } catch (e) {
    return { ok: false, error: e.message, text: null };
  }
}

// Lowercase letters and digits only, so "Oni - Anniversary Edition" and
// "Oni: Anniversary Edition" compare equal. Trailing archive extensions go too.
function looseKey(name) {
  return String(name).normalize('NFKD').toLowerCase()
    .replace(/[\s._-]*(7z|zip|rar)$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// Shortest folder key the prefix rule accepts, so "Halo" can't claim "Halo 2"
// unless it's the only title starting that way.
const MIN_PREFIX = 4;

const SHELL_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const onlyFolders = (dir) => (readdir(dir) || []).every(e => e.isDirectory() || SHELL_FILES.has(e.name.toLowerCase()));

// Folders in scanDir that match a known item. In order: identifier, sanitized
// identifier, title (case-insensitive), then loose title or identifier (case,
// spaces and punctuation ignored), then a folder that is the loose prefix of
// exactly one item. titleMap is { title: identifier }. A folder that matches
// nothing and holds only folders (D:\games\rohan inside D:\games) is looked
// into too, `nested` levels deep; a game's own folder always has files.
// Returns [{ identifier, folderPath, matchedBy }] in directory order.
function matchInstallFolders(scanDir, knownIdentifiers, titleMap, { nested = 1 } = {}) {
  const entries = scanDir && fs.existsSync(scanDir) ? readdir(scanDir) : null;
  if (!entries) return [];

  const ids = new Set(knownIdentifiers || []);
  const titles = {};
  const loose = new Map(); // loose key -> identifier, first one wins
  const addLoose = (key, identifier) => { if (key && !loose.has(key)) loose.set(key, identifier); };
  for (const [title, identifier] of Object.entries(titleMap || {})) {
    const key = sanitizeTitle(title).toLowerCase();
    if (key) titles[key] = identifier;
    addLoose(looseKey(title), identifier);
  }
  for (const id of ids) addLoose(looseKey(id), id);

  const byPrefix = (key) => {
    if (key.length < MIN_PREFIX) return null;
    const hits = new Set();
    for (const [k, identifier] of loose) if (k.startsWith(key)) hits.add(identifier);
    return hits.size === 1 ? [...hits][0] : null;
  };

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    let identifier = null;
    let matchedBy  = null;
    if (ids.has(name)) {
      identifier = name; matchedBy = 'identifier';
    } else {
      for (const id of ids) {
        if (sanitizeFolderName(id) === name) { identifier = id; matchedBy = 'identifier-sanitized'; break; }
      }
    }
    if (!identifier) {
      // Upstream RohanKar named its installs "(id)Title"; the number is its catalog id, not ours
      const bare = name.replace(/^\(\d+\)\s*/, '');
      const key = sanitizeTitle(bare).toLowerCase();
      const lkey = looseKey(bare);
      if (titles[key]) { identifier = titles[key]; matchedBy = bare === name ? 'title' : 'title-prefixed'; }
      else if (loose.has(lkey)) { identifier = loose.get(lkey); matchedBy = 'loose'; }
      else if ((identifier = byPrefix(lkey))) matchedBy = 'prefix';
    }
    const folderPath = path.join(scanDir, name);
    if (identifier) out.push({ identifier, folderPath, matchedBy });
    else if (nested > 0 && onlyFolders(folderPath)) {
      out.push(...matchInstallFolders(folderPath, knownIdentifiers, titleMap, { nested: nested - 1 }));
    }
  }
  return out;
}

module.exports = {
  IGNORED_SUBDIRS, sanitizeFolderName, sanitizeTitle, exesInDir, findExes, unblockDirectory, makeRunnable, isLinuxProgram, readReadme,
  looseKey, matchInstallFolders,
};
