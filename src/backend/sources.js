'use strict';
/**
 * Sources and title grouping for the backend. Same rules as
 * src/renderer/sources.js, which the renderer still loads until it reads
 * grouped items from the API; test/backend/sources.test.js keeps the two in step.
 */

// Shipped sources, used when settings.json has no `sources` key
const DEFAULT_SOURCES = [
  { uploader: 'rohanjackson071@gmail.com', label: 'rohanjackson071', enabled: true },
  { uploader: 'frankiemiqueli1@gmail.com', label: 'pstriple',        enabled: true },
  { uploader: 'spideymaster661@gmail.com', label: 'r4zel1ght',       enabled: true },
];

function sourcesFromSettings(settings) {
  return Array.isArray(settings.sources) ? settings.sources.filter(x => x && x.uploader) : DEFAULT_SOURCES;
}

// An overrides.json title (attached as _override) replaces the archive.org one
function getTitle(game) {
  if (game._override?.title) return game._override.title;
  const t = Array.isArray(game.title) ? game.title[0] : game.title;
  return (t && String(t).trim()) || game.identifier?.replace(/-/g, ' ') || 'Unknown';
}

// Same game from different uploaders → one entry. Key is the title with case,
// punctuation, "the", and trailing bracketed tags like "(v1.2)" removed.
function titleKey(game) {
  return getTitle(game).toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

module.exports = { DEFAULT_SOURCES, sourcesFromSettings, getTitle, titleKey };
