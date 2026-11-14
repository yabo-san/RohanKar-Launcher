'use strict';
/**
 * Port installs, the pieces that aren't downloading or extracting: which
 * GitHub or GitLab release and asset to take, and laying the release down. A port
 * installs its release binary only; game data is the user's job.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;
// Tarballs, which only Linux builds come as; the system's tar unpacks them
const TAR_EXT = /\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?)$/i;
const isArchive = (name) => ARCHIVE_EXT.test(name) || TAR_EXT.test(name);
const PREFER_64 = /x64|x86_64|amd64|win64/i;
const NOT_64 = /x86(?!_64)|win32|arm|i[3-6]86/i;

// Never the build itself: checksums, signatures, debug symbols, source archives
const AUXILIARY = /\.(json|sha\d*|md5|sig|asc|minisig|pdb|txt)$|(^|[._-])(checksums?|sha\d*sums?|source|src|debug|symbols|pdb)([._-]|$)|^source code/i;
// What an install can lay down: an archive, a program, or a file with no
// extension (a GitLab package link, or a bare Linux binary). A .tar.* only on
// Linux, where the system's tar unpacks it.
const INSTALLABLE = {
  windows: /\.(zip|7z|rar|exe)$|^(?!.*\.[a-z][a-z0-9]{0,4}$)/i,
  linux:   /\.(zip|7z|rar|exe|appimage|x86_64|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tar)$|^(?!.*\.[a-z][a-z0-9]{0,4}$)/i,
};

// Which system a release file is for, from its name, by Quiver's markers:
// 'windows', 'linux', 'macos', 'android', 'ios' or 'unknown'. Nothing marked
// is 'unknown', which counts as Windows' (a bare game.zip is a Windows build).
function platformOf(name) {
  const s = String(name).toLowerCase();
  if (/windows|(?<!dar)win(?:32|64)|(?:^|[^a-z])win(?:[^a-z]|$)|\.exe$|\.msi$/.test(s)) return 'windows';
  if (/linux|appimage|flatpak|steamdeck|steam-deck|\.deb$|\.rpm$/.test(s)) return 'linux';
  if (/macos|darwin|osx|(?:^|[^a-z])mac(?:[^a-z]|$)|\.dmg$/.test(s)) return 'macos';
  if (/android|\.apk$/.test(s)) return 'android';
  if (/(?:^|[^a-z])ios(?:[^a-z]|$)|iphone|ipados|\.ipa$/.test(s)) return 'ios';
  return 'unknown';
}

// The systems whose builds run here, best first. On Linux a Windows build is
// the last resort: it runs through Proton.
// A file an install can use on this system (os: 'windows' or 'linux'). A
// Flatpak bundle needs Flatpak to install it, so it doesn't count.
const isBuild = (name, os) => !AUXILIARY.test(name) && !/flatpak/i.test(name) && INSTALLABLE[os].test(name);

const tiersFor = (platform) => (platform === 'linux' ? ['linux', 'unknown', 'windows'] : ['windows', 'unknown']);
const osOf = (platform) => (platform === 'linux' ? 'linux' : 'windows');

// The newest release that is neither a draft nor a prerelease, from the
// GitHub API's /releases list (newest first)
function pickRelease(releases) {
  return (Array.isArray(releases) ? releases : []).find(r => r && !r.draft && !r.prerelease) || null;
}

// GitLab's /projects/:id/releases (newest first) in GitHub's shape, so
// pickRelease and pickAsset work on both. A release's downloads are its asset
// links; the source archives GitLab adds to every release aren't builds. An
// upcoming release (released_at in the future) counts as a prerelease.
function releasesFromGitlab(list) {
  return (Array.isArray(list) ? list : []).filter(r => r && r.tag_name).map(r => ({
    tag_name:   r.tag_name,
    name:       r.name || r.tag_name,
    draft:      false,
    prerelease: !!r.upcoming_release,
    assets:     (Array.isArray(r.assets?.links) ? r.assets.links : []).filter(l => l && l.name && (l.direct_asset_url || l.url))
      .map(l => ({ name: l.name, browser_download_url: l.direct_asset_url || l.url })),
  }));
}

// GitLab's releases API for a repository (owner/repo, or group/subgroup/repo)
const gitlabReleasesUrl = (api, repository) => `${api}/projects/${encodeURIComponent(repository)}/releases`;

// An archive's extension from its first bytes, for a download whose name has
// none (GitLab package links like ...-Windows-RelWithDebInfo): '.zip', '.7z',
// '.rar', a compressed tarball's, or ''
const MAGIC = [['.zip', Buffer.from('504b0304', 'hex')], ['.7z', Buffer.from('377abcaf271c', 'hex')], ['.rar', Buffer.from('526172211a07', 'hex')],
  ['.tar.gz', Buffer.from('1f8b', 'hex')], ['.tar.xz', Buffer.from('fd377a585a00', 'hex')], ['.tar.bz2', Buffer.from('425a68', 'hex')]];
function sniffArchiveExt(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return MAGIC.find(([, m]) => n >= m.length && head.subarray(0, m.length).equals(m))?.[0] || '';
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// A .NET-style pattern (a user.json github entry's assetPattern), e.g. "(?i)x86_64-windows"
function toRegExp(pattern) {
  const insensitive = /^\(\?i\)/.test(pattern);
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), insensitive ? 'i' : '');
}

// Picks the build of a release for this computer (platform: process.platform).
//   pattern: an assetPattern (a regex), wins when set
//   filter:  Quiver's releaseAssetFilter, a substring of the asset name
// Otherwise this system's build, then an unmarked one, then (on Linux only)
// Windows', which runs through Proton. Checksums, symbols and source archives
// never count. On Linux a filter that only matches Windows builds is set
// aside when the release has a Linux build: the shelf's filters pick Windows
// builds for Windows. Among several, 64-bit beats 32-bit and ARM, and on a
// Steam Deck (deck) a Steam Deck build beats a plain Linux one.
// Returns { asset } or { error, names }.
function pickAsset(assets, { pattern = null, filter = null, platform = 'win32', deck = false } = {}) {
  const all = (Array.isArray(assets) ? assets : []).filter(a => a && a.name && a.browser_download_url);
  const os = osOf(platform);
  const builds = all.filter(a => isBuild(a.name, os));
  const names = all.map(a => a.name);
  let pool;
  if (pattern) {
    let re;
    try { re = toRegExp(pattern); } catch (e) { return { error: `Bad asset pattern ${pattern}: ${e.message}`, names }; }
    pool = all.filter(a => re.test(a.name));
  } else {
    pool = builds;
    if (filter) {
      const f = String(filter).toLowerCase();
      const filtered = builds.filter(a => a.name.toLowerCase().includes(f));
      const native = builds.filter(a => platformOf(a.name) === 'linux');
      const setAside = os === 'linux' && native.length && filtered.every(a => platformOf(a.name) === 'windows');
      pool = setAside ? native : filtered;
    }
    pool = tiersFor(platform).map(t => pool.filter(a => platformOf(a.name) === t)).find(l => l.length) || [];
  }
  const usable = pool.filter(a => INSTALLABLE[os].test(a.name));
  const ranked = (usable.length ? usable : pool).slice().sort((a, b) => rank(b.name, deck) - rank(a.name, deck));
  if (!ranked.length) return { error: `No ${os === 'linux' ? 'Linux or Windows' : 'Windows'} build in the latest release`, names };
  return { asset: ranked[0] };
}
// A picked asset's name as an assetPattern that still matches the next
// release's: version numbers become \d+, the rest is literal.
// "pd-x86_64-windows-1.2.zip" -> "^pd-x\d+_\d+-windows-\d+\.\d+\.zip$"
function patternFor(name) {
  const lit = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${lit.replace(/\d+/g, '\\d+')}$`;
}

// What a release offers, for the file picker: every asset's name, the
// system it's for, and the pattern that would pick it again, the ones that
// run here first (best system first), and the one pickAsset takes on its own.
// choose: true when there's a real choice (several files for the best
// system that has any, or none at all).
function releaseFiles(release, { platform = 'win32', deck = false } = {}) {
  const all = (release?.assets || []).filter(a => a && a.name && a.browser_download_url);
  const os = osOf(platform);
  const tiers = tiersFor(platform);
  const tierOf = (a) => (isBuild(a.name, os) ? tiers.indexOf(platformOf(a.name)) : -1);
  const order = (a) => { const t = tierOf(a); return t < 0 ? tiers.length : t; };
  const sorted = all.slice().sort((a, b) => order(a) - order(b));
  const files = sorted.map(a => ({ name: a.name, size: a.size ?? null, platform: platformOf(a.name), here: tierOf(a) >= 0, pattern: patternFor(a.name) }));
  const auto = pickAsset(all, { platform, deck }).asset?.name || null;
  const best = sorted.length ? order(sorted[0]) : tiers.length;
  const choices = sorted.filter(a => order(a) === best && best < tiers.length).length;
  return { tag: release?.tag_name || null, files, auto, choose: choices !== 1 && files.length > 0 };
}
const rank = (name, deck = false) => (PREFER_64.test(name) ? 2 : 0) - (NOT_64.test(name) ? 1 : 0)
  + (/steam-?deck/i.test(name) ? (deck ? 1 : -1) : 0);

// A Steam Deck: SteamOS, or a Steam session that says so
function onSteamDeck({ env = process.env, osRelease = () => { try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; } } } = {}) {
  if (String(env.SteamDeck || '').trim() === '1') return true;
  return /^ID=["']?steamos["']?$/m.test(osRelease());
}

// Steam's Game Mode (the Deck's default session, or Big Picture on a gamescope
// session): the window should fill the screen and text boxes need Steam's keyboard
function steamGameMode(env = process.env) {
  return String(env.SteamGamepadUI || '').trim() === '1' || /\bgamescope\b/i.test(env.XDG_CURRENT_DESKTOP || '');
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
function releaseRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory() ? path.join(dir, entries[0].name) : dir;
}

// What a catalog entry's tags and source say about installing it:
//   sourceOnly:     "source only", a decompilation with no playable build; nothing to install
//   workInProgress: "work in progress", installs if a release exists
//   role:           "engine" or "launcher", a plain app the user brings data to (its
//                   description says what); no wiring between them
//   repositorySource, repositoryUrl: "gitlab" for repositorySource "gitlab", else "github",
//                   and the project page there
const hasTag = (tags, tag) => tags.some(t => String(t).trim().toLowerCase() === tag);
function portTraits(entry = {}) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const source = entry.repositorySource === 'gitlab' ? 'gitlab' : 'github';
  return {
    sourceOnly:     hasTag(tags, 'source only'),
    workInProgress: hasTag(tags, 'work in progress'),
    role:           hasTag(tags, 'engine') ? 'engine' : hasTag(tags, 'launcher') ? 'launcher' : null,
    repositorySource: source,
    repositoryUrl:  typeof entry.repository === 'string' && entry.repository.trim() ? `https://${source}.com/${entry.repository.trim()}` : null,
  };
}

module.exports = { pickRelease, pickAsset, platformOf, onSteamDeck, steamGameMode, patternFor, releaseFiles, toRegExp, sha1File, inside, releaseRoot, portTraits,
  releasesFromGitlab, gitlabReleasesUrl, sniffArchiveExt, isArchive, ARCHIVE_EXT, TAR_EXT };
