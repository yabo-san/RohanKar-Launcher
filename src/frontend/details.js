'use strict';
/**
 * y4bo — details.js
 * The model behind the new UI's album-style details page and its history:
 * what goes on the meta line, the versions track list, the "More from" row,
 * the series albums (several games as one card),
 * and the back/forward stack that remembers each page's scroll position.
 * Pure: no DOM, no network. Loaded as a plain <script> before new/app.js,
 * and required as CommonJS by the node:test suite.
 */

// archive.org subjects that name a platform, as the meta line shows them
const PLATFORMS = {
  pc: 'PC', windows: 'PC', win: 'PC', 'pc game': 'PC', dos: 'DOS', 'ms-dos': 'DOS', msdos: 'DOS', mac: 'Mac', macos: 'Mac',
  linux: 'Linux', ps1: 'PlayStation', psx: 'PlayStation', playstation: 'PlayStation', ps2: 'PlayStation 2', 'playstation 2': 'PlayStation 2',
  ps3: 'PlayStation 3', psp: 'PSP', n64: 'Nintendo 64', 'nintendo 64': 'Nintendo 64', gamecube: 'GameCube', wii: 'Wii',
  snes: 'SNES', nes: 'NES', gba: 'Game Boy Advance', gb: 'Game Boy', nds: 'Nintendo DS', xbox: 'Xbox', 'xbox 360': 'Xbox 360',
  dreamcast: 'Dreamcast', genesis: 'Genesis', 'mega drive': 'Mega Drive', saturn: 'Saturn',
};

function subjectList(subject) {
  const list = Array.isArray(subject) ? subject : String(subject || '').split(/[;,]/);
  return list.map(s => String(s).trim().toLowerCase()).filter(Boolean);
}

// The first subject that names a platform, or ''
function platformOf(subject) {
  for (const s of subjectList(subject)) if (PLATFORMS[s]) return PLATFORMS[s];
  return '';
}

function yearOf(v) {
  const m = /^(\d{4})/.exec(String(v?.date || v?.addeddate || ''));
  return m ? m[1] : '';
}

function sizeLabel(n) {
  n = Number(n) || 0;
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

// What an install downloads: the largest of the installable files (the
// backend's /items/:id/files `installable`), in bytes; 0 when unknown
function installBytes(installable) {
  return (installable || []).reduce((max, f) => Math.max(max, Number(f.size) || 0), 0);
}

const countLabel = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;

// The line under the subtitle: platform · year · size · downloads, each only when known
function gameMeta(v, { bytes = 0 } = {}) {
  return [
    platformOf(v.subject),
    yearOf(v),
    sizeLabel(bytes),
    v.downloads ? countLabel(v.downloads, 'download') : '',
  ].filter(Boolean);
}

function portMeta(p) {
  return [
    p.shelfName ? `${p.shelfName} port` : 'Port',
    'Windows',
    p.tags?.length ? p.tags.slice(0, 3).join(', ') : '',
  ].filter(Boolean);
}

const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// One row per version, newest upload first, numbered like tracks. `selected`
// is the identifier the page shows; `library` is keyed by identifier.
function versionRows(versions, { selected = null, library = {} } = {}) {
  const list = (versions || []).slice().sort((a, b) => String(b.addeddate || '').localeCompare(String(a.addeddate || '')));
  const newer = new Set(list.filter(v => v._newer && library[v.identifier]?.install_dir).map(v => v._newer));
  return list.map((v, i) => ({
    n: i + 1,
    identifier: v.identifier,
    uploader: v._sourceLabel || v._uploader || '',
    date: isoDay(v.addeddate),
    downloads: Number(v.downloads) || 0,
    installed: !!library[v.identifier]?.install_dir,
    newer: newer.has(v.identifier),
    user: !!v._user,
    on: v.identifier === selected,
  }));
}

// Other titles from the same uploader, most downloaded first; `games` are
// the wall's titles (each with _versions), `except` the one on the page
function moreFrom(games, uploader, { except = null, limit = 20 } = {}) {
  if (!uploader) return [];
  return (games || [])
    .filter(g => g !== except && (g._versions || [g]).some(v => v._uploader === uploader))
    .sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0))
    .slice(0, limit);
}

// More ports from the same catalog shelf, in catalog order
function morePorts(items, port, { limit = 20 } = {}) {
  return (items || [])
    .filter(p => p.shelf === port.shelf && p.id !== port.id)
    .slice(0, limit);
}

// ─── series ──────────────────────────────────────────────────────────────────
// overrides.json can put an upload in a series ("series": "FIFA"); the wall
// then shows the series as one card (an album) and its games as the tracks.

const seriesCardId = (name) => `series:${name}`;

// The wall's titles with each series folded into one card, where its first
// game was. A series with one game here stays that game's own card.
// The card: { _seriesCard, identifier, title, _games, _sourceLabel, addeddate, date, downloads, platform, _cover }
function collapseSeries(games) {
  const by = new Map();
  for (const g of games || []) {
    if (!g._series) continue;
    if (!by.has(g._series)) by.set(g._series, []);
    by.get(g._series).push(g);
  }
  const out = [];
  const done = new Set();
  for (const g of games || []) {
    const list = g._series && by.get(g._series);
    if (!list || list.length < 2) { out.push(g); continue; }
    if (done.has(g._series)) continue;
    done.add(g._series);
    out.push(seriesCard(g._series, list));
  }
  return out;
}

function seriesCard(name, games) {
  const newest = games.map(g => String(g.addeddate || '')).sort().pop() || null;
  const top = games.slice().sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0))[0];
  const labels = [...new Set(games.map(g => g._sourceLabel).filter(Boolean))];
  const platforms = [...new Set(games.map(g => g.platform || ''))];
  return {
    _seriesCard: true,
    identifier: seriesCardId(name),
    title: name,
    _games: games,
    _sourceLabel: labels.length === 1 ? labels[0] : `${labels.length} uploaders`,
    addeddate: newest,
    date: games.map(g => g.date).filter(Boolean).map(String).sort()[0] || null,
    downloads: games.reduce((n, g) => n + (Number(g.downloads) || 0), 0),
    platform: platforms.length === 1 ? platforms[0] : '',
    // the most downloaded game's art stands for the series
    _cover: top.identifier,
  };
}

// A series' games as tracks: oldest first (by the game's own year, then
// title), numbered. `titleOf` names a game; `library` is keyed by identifier.
function seriesRows(games, { titleOf = (g) => g.title, library = {} } = {}) {
  const rows = (games || []).map(g => {
    const versions = g._versions || [g];
    return {
      identifier: g.identifier,
      title: titleOf(g),
      year: yearOf(g),
      uploader: g._sourceLabel || g._uploader || '',
      downloads: versions.reduce((n, v) => n + (Number(v.downloads) || 0), 0),
      versions: versions.length,
      installed: versions.some(v => library[v.identifier]?.install_dir),
    };
  });
  rows.sort((a, b) => a.year.localeCompare(b.year) || a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' }));
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}

// The series' meta line: years, games, downloads
function seriesMeta(rows) {
  const years = rows.map(r => r.year).filter(Boolean).sort();
  const span = years.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[0]}–${years[years.length - 1]}`) : '';
  const downloads = rows.reduce((n, r) => n + r.downloads, 0);
  return [span, countLabel(rows.length, 'game'), downloads ? countLabel(downloads, 'download') : ''].filter(Boolean);
}

// Back and forward through the pages visited. An entry is whatever the
// caller shows ({ name, arg, query, scroll }); leaving a page records where
// it was scrolled to, so going back lands in the same place.
function createHistory() {
  const back = [], fwd = [];
  const same = (a, b) => a.name === b.name && (a.arg || null) === (b.arg || null) && (a.query || '') === (b.query || '');
  return {
    // Going from `current` to `next`: current joins the back stack unless it is the same page
    push(current, next) {
      if (current && !same(current, next)) { back.push({ ...current }); fwd.length = 0; return true; }
      return false;
    },
    // Step back (dir -1) or forward (1) from `current`; the entry to show, or null
    step(current, dir) {
      const from = dir < 0 ? back : fwd;
      const to = from.pop();
      if (!to) return null;
      (dir < 0 ? fwd : back).push({ ...current });
      return to;
    },
    get canBack() { return back.length > 0; },
    get canForward() { return fwd.length > 0; },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    platformOf, yearOf, sizeLabel, installBytes, gameMeta, portMeta, versionRows, moreFrom, morePorts, createHistory,
    seriesCardId, collapseSeries, seriesRows, seriesMeta,
  };
}
