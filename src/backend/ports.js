'use strict';
/**
 * Port installs, the pieces that aren't downloading or extracting: which
 * GitHub, GitLab or Codeberg release and asset to take, and laying the release
 * down. A port installs its release binary only; game data is the user's job.
 * A repo whose download is a PowerShell script (an install wizard) installs
 * that script, and Play runs it.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;
const NOT_WINDOWS = /linux|macos|mac-|[-_.]mac\b|osx|darwin|android|ios\b|appimage|flatpak|\.deb$|\.rpm$|\.dmg$|\.pkg$|\.tar(\.\w+)?$|\.apk$/i;
const LOOKS_WINDOWS = /win|windows|x64|x86_64|amd64|\.exe$/i;
const PREFER_64 = /x64|x86_64|amd64|win64/i;
const NOT_64 = /x86(?!_64)|win32|arm|i686/i;
const SCRIPT = /\.ps1$/i;

// Where a repository lives (repositorySource), and its web host
const HOSTS = Object.freeze({ github: 'github.com', gitlab: 'gitlab.com', codeberg: 'codeberg.org' });
const sourceOf = (s) => (Object.hasOwn(HOSTS, s) ? s : 'github');

// What the user typed in Add a repo: owner/repo (on GitHub unless source says), or a link to the
// repo on GitHub, GitLab (group/subgroup/repo too) or Codeberg, any page of
// it. { repository, repositorySource } or null.
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
function parseRepo(input, source = 'github') {
  const s = String(input || '').trim();
  // A GitLab project path may have subgroups: group/subgroup/repo
  if (OWNER_REPO.test(s) || (sourceOf(source) === 'gitlab' && /^[\w.-]+(\/[\w.-]+)+$/.test(s))) {
    return { repository: s.replace(/\.git$/i, ''), repositorySource: sourceOf(source) };
  }
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const repositorySource = Object.keys(HOSTS).find(k => HOSTS[k] === host);
  if (!repositorySource) return null;
  let parts = u.pathname.split('/').filter(Boolean);
  // GitLab pages hang off /-/ (…/repo/-/releases); GitHub and Codeberg repos are owner/repo
  parts = repositorySource === 'gitlab' ? parts.slice(0, parts.indexOf('-') < 0 ? parts.length : parts.indexOf('-')) : parts.slice(0, 2);
  if (parts.length < 2 || !parts.every(p => /^[\w.-]+$/.test(p))) return null;
  return { repository: parts.join('/').replace(/\.git$/i, ''), repositorySource };
}

// Codeberg (Forgejo) answers in GitHub's shape: tag_name, draft, prerelease,
// assets[].browser_download_url
const codebergReleasesUrl = (api, repository) => `${api}/repos/${repository}/releases?limit=30`;
// A repo's top-level files (GitHub and Codeberg alike: name, type, sha, download_url)
const contentsUrl = (api, repository) => `${api}/repos/${repository}/contents`;

// GitLab's top-level tree in that shape; a file's download is its raw contents on the default branch
const gitlabTreeUrl = (api, repository) => `${api}/projects/${encodeURIComponent(repository)}/repository/tree`;
function contentsFromGitlab(list, api, repository) {
  return (Array.isArray(list) ? list : []).filter(f => f && f.name).map(f => ({
    name: f.name, type: f.type === 'blob' ? 'file' : 'dir', sha: f.id,
    download_url: `${api}/projects/${encodeURIComponent(repository)}/repository/files/${encodeURIComponent(f.path || f.name)}/raw?ref=HEAD`,
  }));
}

// A repo with no Windows release whose top level holds a PowerShell script,
// like an install wizard: that script, as a release asset, or null. Several
// scripts: the one named install/setup, else none (we can't tell which).
function scriptFromContents(list) {
  const ps1 = (Array.isArray(list) ? list : []).filter(f => f && f.type === 'file' && SCRIPT.test(f.name || '') && f.download_url);
  const named = ps1.filter(f => /install|setup/i.test(f.name));
  const pick = ps1.length === 1 ? ps1[0] : named.length === 1 ? named[0] : null;
  return pick ? { tag_name: `script-${String(pick.sha || '').slice(0, 12)}`, assets: [{ name: pick.name, browser_download_url: pick.download_url }] } : null;
}

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
// none (GitLab package links like ...-Windows-RelWithDebInfo): '.zip', '.7z' or ''
const MAGIC = [['.zip', Buffer.from('504b0304', 'hex')], ['.7z', Buffer.from('377abcaf271c', 'hex')], ['.rar', Buffer.from('526172211a07', 'hex')]];
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

// Picks the Windows asset of a release.
//   pattern: an assetPattern (a regex), wins when set
//   filter:  Quiver's releaseAssetFilter, a substring of the asset name
// Otherwise any asset that looks like a Windows build, or failing that a
// PowerShell script. Among several, an archive or exe beats a script, a script
// beats anything else, and 64-bit beats 32-bit/ARM.
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
    if (!pool.length) pool = all.filter(a => SCRIPT.test(a.name));
  }
  const usable = pool.filter(a => ARCHIVE_EXT.test(a.name) || /\.exe$/i.test(a.name));
  const scripts = pool.filter(a => SCRIPT.test(a.name));
  const ranked = (usable.length ? usable : scripts.length ? scripts : pool).slice().sort((a, b) => rank(b.name) - rank(a.name));
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

// What a catalog entry's tags and source say about installing it:
//   sourceOnly:     "source only", a decompilation with no playable build; nothing to install
//   workInProgress: "work in progress", installs if a release exists
//   role:           "engine" or "launcher", a plain app the user brings data to (its
//                   description says what); no wiring between them
//   repositorySource, repositoryUrl: "gitlab" or "codeberg" as the entry says, else
//                   "github", and the project page there
const hasTag = (tags, tag) => tags.some(t => String(t).trim().toLowerCase() === tag);
function portTraits(entry = {}) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const source = sourceOf(entry.repositorySource);
  return {
    sourceOnly:     hasTag(tags, 'source only'),
    workInProgress: hasTag(tags, 'work in progress'),
    role:           hasTag(tags, 'engine') ? 'engine' : hasTag(tags, 'launcher') ? 'launcher' : null,
    repositorySource: source,
    repositoryUrl:  typeof entry.repository === 'string' && entry.repository.trim() ? `https://${HOSTS[source]}/${entry.repository.trim()}` : null,
  };
}

module.exports = { pickRelease, pickAsset, toRegExp, sha1File, inside, releaseRoot, portTraits,
  releasesFromGitlab, gitlabReleasesUrl, codebergReleasesUrl, contentsUrl, gitlabTreeUrl, contentsFromGitlab, scriptFromContents,
  parseRepo, sourceOf, HOSTS, sniffArchiveExt, ARCHIVE_EXT, SCRIPT };
