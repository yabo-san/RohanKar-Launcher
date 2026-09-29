'use strict';
/**
 * Port installs, the pieces that aren't downloading or extracting: which
 * GitHub release and asset to take, where a collision's game data lives on
 * archive.org, and finding and checking a data file once it's unpacked.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;
const NOT_WINDOWS = /linux|macos|mac-|[-_.]mac\b|osx|darwin|android|ios\b|appimage|flatpak|\.deb$|\.rpm$|\.dmg$|\.pkg$|\.tar(\.\w+)?$|\.apk$/i;
const LOOKS_WINDOWS = /win|windows|x64|x86_64|amd64|\.exe$/i;
const PREFER_64 = /x64|x86_64|amd64|win64/i;
const NOT_64 = /x86(?!_64)|win32|arm|i686/i;

// The newest release that is neither a draft nor a prerelease, from the
// GitHub API's /releases list (newest first)
function pickRelease(releases) {
  return (Array.isArray(releases) ? releases : []).find(r => r && !r.draft && !r.prerelease) || null;
}

// A .NET-style pattern from the collision catalog, e.g. "(?i)x86_64-windows"
function toRegExp(pattern) {
  const insensitive = /^\(\?i\)/.test(pattern);
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), insensitive ? 'i' : '');
}

// Picks the Windows asset of a release.
//   pattern: the collision catalog's assetPattern (a regex), wins when set
//   filter:  Quiver's releaseAssetFilter, a substring of the asset name
// Otherwise any asset that looks like a Windows build. Among several, an
// archive or exe beats anything else and 64-bit beats 32-bit/ARM.
// Returns { asset } or { error, names }.
function pickAsset(assets, { pattern = null, filter = null } = {}) {
  const all = (Array.isArray(assets) ? assets : []).filter(a => a && a.name && a.browser_download_url);
  let pool;
  if (pattern) {
    let re;
    try { re = toRegExp(pattern); } catch (e) { return { error: `Bad asset pattern ${pattern}: ${e.message}`, names: all.map(a => a.name) }; }
    pool = all.filter(a => re.test(a.name));
  } else if (filter) {
    pool = all.filter(a => a.name.toLowerCase().includes(String(filter).toLowerCase()));
  } else {
    pool = all.filter(a => LOOKS_WINDOWS.test(a.name) && !NOT_WINDOWS.test(a.name));
  }
  const usable = pool.filter(a => ARCHIVE_EXT.test(a.name) || /\.exe$/i.test(a.name));
  const ranked = (usable.length ? usable : pool).slice().sort((a, b) => rank(b.name) - rank(a.name));
  if (!ranked.length) return { error: 'No Windows build in the latest release', names: all.map(a => a.name) };
  return { asset: ranked[0] };
}
const rank = (name) => (PREFER_64.test(name) ? 2 : 0) - (NOT_64.test(name) ? 1 : 0);

// "https://archive.org/download/<identifier>/<path>" → { identifier, file }
function archiveFile(contentUrl) {
  let u;
  try { u = new URL(contentUrl); } catch { return null; }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'download' || parts.length < 3) return null;
  return { identifier: parts[1], file: parts.slice(2).join('/') };
}

// First file named `name` (any case) under dir, breadth first
function findFile(dir, name, maxDepth = 8) {
  const want = name.toLowerCase();
  let level = [dir];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const d of level) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name.toLowerCase() === want) return p;
        if (e.isDirectory()) next.push(p);
      }
    }
    level = next;
  }
  return null;
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// root joined with a catalog-supplied relative path, or null if it escapes root
function inside(root, ...rel) {
  const p = path.resolve(root, ...rel.map(r => String(r || '')));
  return p === path.resolve(root) || p.startsWith(path.resolve(root) + path.sep) ? p : null;
}

module.exports = { pickRelease, pickAsset, toRegExp, archiveFile, findFile, sha1File, inside, ARCHIVE_EXT };
