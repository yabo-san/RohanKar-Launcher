'use strict';
/**
 * y4bo — sources.js
 * Pure display helpers for titles, versions and the Settings sources text.
 * Default sources and grouping by title come from the backend (/v1/sources,
 * /v1/items). Loaded as a plain <script> before renderer.js, and required as
 * CommonJS by the node:test suite.
 */

// An overrides.json title (attached as _override) replaces the archive.org one
function getTitle(game) {
  if (game._override?.title) return game._override.title;
  const t = Array.isArray(game.title) ? game.title[0] : game.title;
  return (t && String(t).trim()) || game.identifier?.replace(/-/g, ' ') || 'Unknown';
}

// Settings text format (docs/USER-SOURCES.md), one line each:
//   <uploader>[, label][, -exclude|words][, +include|words]
//     uploader: an email, @handle, profile URL or item URL (the backend
//     resolves it); -words: leave out uploads whose title has any of them;
//     +words: keep only uploads whose title has one of them
//   - <identifier or item URL>   leave that one upload out (parseExcludes)
//   a leading # turns a line off
function parseSources(text) {
  return sourceLines(text).map(line => {
    const enabled = !line.startsWith('#');
    const [uploader, ...rest] = line.replace(/^#\s*/, '').split(',');
    if (uploader.trim().startsWith('-')) return null;
    const pick = (sign) => rest.map(f => f.trim()).filter(f => f.startsWith(sign)).map(f => f.slice(1).trim()).filter(Boolean).join('|');
    const label = rest.filter(f => !/^\s*[-+]/.test(f)).join(',').trim();
    const src = { uploader: uploader.trim(), label: label || defaultLabel(uploader.trim()), enabled };
    if (pick('-')) src.titleExclude = pick('-');
    if (pick('+')) src.titleInclude = pick('+');
    return src;
  }).filter(s => s && s.uploader);
}

// The "- <identifier or URL>" lines: single uploads to leave out
function parseExcludes(text) {
  return sourceLines(text).filter(l => l.startsWith('-')).map(l => l.slice(1).trim()).filter(Boolean);
}

const sourceLines = (text) => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

// What a line with no label is called: the handle, the part of an email
// before @, an item URL's identifier, else what was typed
function defaultLabel(uploader) {
  const handle = /(?:^|\/)@([^/?#\s]+)/.exec(uploader);
  if (handle) return handle[1];
  const item = /\/(?:details|download)\/([^/?#\s]+)/.exec(uploader);
  if (item) return item[1];
  return uploader.split('@')[0] || uploader;
}

function formatSources(list, excludes = []) {
  return [
    ...list.map(s => `${s.enabled === false ? '# ' : ''}${s.uploader}${s.label ? ', ' + s.label : ''}`
      + `${s.titleExclude ? ', -' + s.titleExclude : ''}${s.titleInclude ? ', +' + s.titleInclude : ''}`),
    ...(Array.isArray(excludes) ? excludes : []).map(x => `- ${x}`),
  ].join('\n');
}

// The version to show for a grouped entry: the installed one if any, else the entry itself
function preferredVersion(game, library) {
  const versions = game._versions || [game];
  return versions.find(v => library[v.identifier]?.install_dir) || game;
}

function versionLabel(v) {
  const date = v.addeddate ? new Date(v.addeddate).toISOString().slice(0, 10) : '';
  return [v._sourceLabel, date].filter(Boolean).join(' — ');
}

if (typeof module !== 'undefined') {
  module.exports = { getTitle, parseSources, parseExcludes, formatSources, preferredVersion, versionLabel };
}
