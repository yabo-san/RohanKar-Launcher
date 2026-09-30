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

// A release archive that holds one folder and nothing else (Perfect Dark's
// pd-x86_64-windows/) is that folder's contents: returns the folder to copy
// from, dir itself otherwise
// The n biggest files under dir, as paths relative to it, to say what an
// archive holds when the file a collision names isn't there
function largestFiles(dir, n) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([fs.statSync(p).size, path.relative(dir, p).split(path.sep).join('/')]);
    }
  };
  walk(dir);
  return out.sort((a, b) => b[0] - a[0]).slice(0, n).map(([, rel]) => rel);
}

function releaseRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory() ? path.join(dir, entries[0].name) : dir;
}

// ─── Data sources (docs/COLLISIONS.md) ───────────────────────────────────────

// archive.org's own bookkeeping files, never game data
const IA_METADATA = /(^|\/)(__ia_thumb\.jpg|[^/]*_(meta\.xml|meta\.sqlite|files\.xml|reviews\.xml|archive\.torrent))$/i;
const isGlob = (p) => p === '*' || p.endsWith('/*');

// One source's files in an archive.org item's file list:
//   "dir/file.bin"  that file, placed as file.bin
//   "dir/sub/*"     every file under dir/sub, keeping the layout below it
//   "*"             every file in the item
// Returns { files: [{ name, rel, sha1, size }], single } or { error }.
function expandSource(source, files) {
  const all = (Array.isArray(files) ? files : []).filter(f => f?.name && !IA_METADATA.test(f.name) && f.source !== 'metadata' && f.source !== 'derivative');
  const want = String(source.path || '').replace(/^\/+/, '');
  if (isGlob(want)) {
    const prefix = want.slice(0, -1);
    const out = all.filter(f => f.name.startsWith(prefix) && f.name.length > prefix.length)
      .map(f => ({ name: f.name, rel: f.name.slice(prefix.length), sha1: f.sha1 || null, size: Number(f.size) || 0 }));
    return out.length ? { files: out, single: false } : { error: `Nothing under ${want} in ${source.ia}` };
  }
  const f = all.find(x => x.name === want) || all.find(x => x.name.toLowerCase() === want.toLowerCase());
  if (!f) return { error: `${want} isn't in ${source.ia}` };
  return { files: [{ name: f.name, rel: path.posix.basename(f.name), sha1: f.sha1 || null, size: Number(f.size) || 0 }], single: true };
}

const SHA1 = /^[0-9a-f]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
// A relative path that stays relative: no drive, no leading slash, no ..
const safeRel = (p) => typeof p === 'string' && !/^([a-z]:|[\\/])/i.test(p) && !p.split(/[\\/]/).includes('..');

// Checks a collision entry (a user's own, or one bound for collisions.json).
// Returns a list of problems, empty when it's good.
function validateCollision(c) {
  const errs = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['entry must be an object'];
  if (typeof c.repository !== 'string' || !REPO.test(c.repository.trim())) errs.push('repository must be owner/repo');
  for (const k of ['name', 'folderName', 'releaseAssetFilter']) if (c[k] != null && typeof c[k] !== 'string') errs.push(`${k} must be a string`);
  if (c.assetPattern != null) {
    if (typeof c.assetPattern !== 'string') errs.push('assetPattern must be a string');
    else { try { toRegExp(c.assetPattern); } catch (e) { errs.push(`assetPattern: ${e.message}`); } }
  }
  if (c.base != null && !['binary', 'data'].includes(c.base)) errs.push('base must be "binary" or "data"');
  if (c.binaryTarget != null && !safeRel(c.binaryTarget)) errs.push('binaryTarget must be a relative folder');
  if (c.exe != null && !(typeof c.exe === 'string' && /\.exe$/i.test(c.exe) && safeRel(c.exe))) errs.push('exe must be a relative path to an .exe');
  if (c.keepReleaseFolder != null && typeof c.keepReleaseFolder !== 'boolean') errs.push('keepReleaseFolder must be true or false');
  if (c.sources != null && !Array.isArray(c.sources)) errs.push('sources must be an array');
  (Array.isArray(c.sources) ? c.sources : []).forEach((s, i) => {
    const at = `sources[${i}]`;
    if (!s || typeof s !== 'object') return errs.push(`${at} must be an object`);
    if (typeof s.ia !== 'string' || !/^[\w.-]+$/.test(s.ia)) errs.push(`${at}.ia must be an archive.org identifier`);
    if (typeof s.path !== 'string' || !s.path.trim() || !safeRel(s.path.replace(/^\/+/, ''))) errs.push(`${at}.path must be a file, folder/* or * in the item`);
    if (s.target != null && !safeRel(s.target)) errs.push(`${at}.target must be a relative folder`);
    if (s.sha1 != null && !SHA1.test(s.sha1)) errs.push(`${at}.sha1 must be 40 hex characters`);
    if (s.sha1 != null && typeof s.path === 'string' && isGlob(s.path)) errs.push(`${at}.sha1 only applies to a single file`);
    for (const k of ['extract', 'optional']) if (s[k] != null && typeof s[k] !== 'boolean') errs.push(`${at}.${k} must be true or false`);
  });
  if (!(Array.isArray(c.sources) && c.sources.length) && !(Array.isArray(c.dataFiles) && c.dataFiles.length) && !c.name) {
    errs.push('an entry with no data sources needs a name (it defines a port of its own)');
  }
  return errs;
}

module.exports = {
  pickRelease, pickAsset, toRegExp, archiveFile, findFile, sha1File, inside, releaseRoot, largestFiles, ARCHIVE_EXT,
  expandSource, isGlob, validateCollision, safeRel,
};
