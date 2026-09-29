'use strict';
/**
 * Sources and title grouping for the backend. Same rules as
 * src/renderer/sources.js, which the renderer still loads until it reads
 * grouped items from the API; test/backend/sources.test.js keeps the two in step.
 */

// Default sources from catalog/uploaders.json. An entry is on only when it is
// marked launcher: true, not track: false, and has an uploaderEmail (what
// archive.org's uploader: field matches); everything else ships off.
function sourcesFromCatalog(data) {
  const list = Array.isArray(data?.uploaders) ? data.uploaders : [];
  return list.map(u => {
    const uploader = u?.uploaderEmail || u?.handle;
    if (!uploader) return null;
    const enabled = u.launcher === true && u.track !== false && !!u.uploaderEmail;
    return { uploader, label: u.handle || uploader.split('@')[0], enabled };
  }).filter(Boolean);
}

// The saved list when settings.json has one, else the catalog defaults
function sourcesFromSettings(settings, defaults = []) {
  return Array.isArray(settings.sources) ? settings.sources.filter(x => x && x.uploader) : defaults;
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

module.exports = { sourcesFromCatalog, sourcesFromSettings, getTitle, titleKey };
