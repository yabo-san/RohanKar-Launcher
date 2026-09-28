'use strict';
/**
 * RohanKar Launcher — sources.js
 * Pure helpers for sources and duplicate grouping. Loaded as a plain <script>
 * before renderer.js, and required as CommonJS by the node:test suite.
 */

function getTitle(game) {
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

// Same game from different uploaders → one entry. Key is the title with case,
// punctuation, "the", and trailing bracketed tags like "(v1.2)" removed.
function titleKey(game) {
  return getTitle(game).toLowerCase()
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
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
  module.exports = { getTitle, parseSources, formatSources, titleKey, preferredVersion, versionLabel };
}
