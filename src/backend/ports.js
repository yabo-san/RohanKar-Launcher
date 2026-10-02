'use strict';
/**
 * Port installs, the pieces that aren't downloading or extracting: which
 * GitHub release and asset to take, and laying the release down. A port
 * installs its release binary only; game data is the user's job.
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

// A .NET-style pattern (a user.json github entry's assetPattern), e.g. "(?i)x86_64-windows"
function toRegExp(pattern) {
  const insensitive = /^\(\?i\)/.test(pattern);
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), insensitive ? 'i' : '');
}

// Picks the Windows asset of a release.
//   pattern: an assetPattern (a regex), wins when set
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

// A release archive that holds one folder and nothing else (Perfect Dark's
// pd-x86_64-windows/) is that folder's contents: returns the folder to copy
// from, dir itself otherwise
function releaseRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory() ? path.join(dir, entries[0].name) : dir;
}

module.exports = { pickRelease, pickAsset, toRegExp, sha1File, inside, releaseRoot, ARCHIVE_EXT };
