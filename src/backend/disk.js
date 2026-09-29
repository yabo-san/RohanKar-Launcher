'use strict';
/**
 * What the launcher reads from install folders: executables, readmes, and
 * pre-existing installs to adopt. Also clears Windows' downloaded-file mark.
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

// .exe files directly inside one directory (no recursion)
function exesInDir(dir) {
  return (readdir(dir) || [])
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.exe'))
    .map(e => path.join(dir, e.name));
}

// Executables to offer for an install folder:
//   - a collection (has _GAME_<title> folders): every game's executables
//   - a bin/ folder with exes: those
//   - exes at this level: those
//   - otherwise the first non-ignored subfolder (to MAX_DEPTH) that has any
// so a game's internal DOSBox/tool exes don't flood the picker.
function findExes(installDir, depth = 0) {
  if (!installDir || depth > MAX_DEPTH) return [];
  const entries = readdir(installDir);
  if (!entries) return [];

  const gameFolders = entries.filter(e => e.isDirectory() && e.name.startsWith('_GAME_'));
  if (gameFolders.length > 0) {
    return gameFolders.flatMap(gf => findExes(path.join(installDir, gf.name), depth + 1));
  }

  const bin = entries.find(e => e.isDirectory() && e.name.toLowerCase() === 'bin');
  if (bin) {
    const binExes = exesInDir(path.join(installDir, bin.name));
    if (binExes.length) return binExes;
  }

  const local = exesInDir(installDir);
  if (local.length) return local;

  for (const sub of entries.filter(e => e.isDirectory() && !IGNORED_SUBDIRS.has(e.name.toLowerCase()))) {
    const found = findExes(path.join(installDir, sub.name), depth + 1);
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

// Folders in scanDir that match a known item by identifier, sanitized
// identifier, or title (case-insensitive). titleMap is { title: identifier }.
// Returns [{ identifier, folderPath, matchedBy }] in directory order.
function matchInstallFolders(scanDir, knownIdentifiers, titleMap) {
  const entries = scanDir && fs.existsSync(scanDir) ? readdir(scanDir) : null;
  if (!entries) return [];

  const ids = new Set(knownIdentifiers || []);
  const titles = {};
  for (const [title, identifier] of Object.entries(titleMap || {})) {
    const key = sanitizeTitle(title).toLowerCase();
    if (key) titles[key] = identifier;
  }

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
    if (!identifier && titles[sanitizeTitle(name).toLowerCase()]) {
      identifier = titles[sanitizeTitle(name).toLowerCase()]; matchedBy = 'title';
    }
    if (identifier) out.push({ identifier, folderPath: path.join(scanDir, name), matchedBy });
  }
  return out;
}

module.exports = {
  IGNORED_SUBDIRS, sanitizeFolderName, sanitizeTitle, exesInDir, findExes, unblockDirectory, readReadme,
  matchInstallFolders,
};
