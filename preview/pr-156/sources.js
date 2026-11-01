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

// Settings text format: one uploader per line, optional ", label", leading # disables.
function parseSources(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const enabled = !line.startsWith('#');
    const [uploader, ...rest] = line.replace(/^#\s*/, '').split(',');
    const label = rest.join(',').trim();
    return { uploader: uploader.trim(), label: label || uploader.trim().split('@')[0], enabled };
  }).filter(s => s.uploader);
}

function formatSources(list) {
  return list.map(s => `${s.enabled === false ? '# ' : ''}${s.uploader}${s.label ? ', ' + s.label : ''}`).join('\n');
}

// Uploaders in `next` that are neither on the curated list nor already saved:
// the ones Settings warns about before saving
function newUncurated(next, prev = [], curated = []) {
  const key = (s) => String(s.uploader).toLowerCase();
  const known = new Set([...curated, ...prev].map(key));
  return next.filter(s => !known.has(key(s))).map(s => s.uploader);
}

// The text of that warning, shared by both interfaces
function uncuratedWarning(uploaders, additionalOn) {
  const one = uploaders.length === 1;
  return `Warning: we do not monitor ${uploaders.join(', ')}. ${one ? 'It is' : 'They are'} not on our curated list. `
    + `Make sure you trust ${one ? 'this uploader' : 'these uploaders'} before you add ${one ? 'it' : 'them'}.`
    + (additionalOn ? '' : ` ${one ? 'It loads' : 'They load'} only while additional sources are allowed.`);
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
  module.exports = { getTitle, parseSources, formatSources, newUncurated, uncuratedWarning, preferredVersion, versionLabel };
}
