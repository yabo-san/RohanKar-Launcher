'use strict';
/**
 * playnite-export.json: one record per library entry, for the y4bo Playnite
 * library plugin. Schema in docs/PLAYNITE-EXPORT.md. Ids never change once
 * written (archive.org identifier, quiver:<repository>, or a UUID kept in
 * library.db for manual entries), so Playnite keeps its own metadata across
 * re-exports. Written to a temp file then renamed, so a reader never sees
 * half a file.
 */
const fs   = require('fs');
const path = require('path');
const { updateAvailable } = require('./updates');

// 2: per game sourceLabel, itemId, legacyId, state, upstreamState,
// sourceState, localStorePath and alternatives (docs/PLAYNITE-EXPORT.md)
const SCHEMA_VERSION = 2;
// Tags on an installed archive.org game: where it came from, and why no
// loaded pack has it any more (items.js localReason). source-unavailable (a
// failed load) isn't a state worth a tag: the last export's tags stay.
const STATE_TAGS = ['removed-upstream', 'source-disabled', 'source-removed', 'provenance-unknown'];
const isSourceTag = (t) => typeof t === 'string' && (t.startsWith('source:') || STATE_TAGS.includes(t));
const PLATFORMS = ['PC', 'Nintendo', 'PlayStation', 'Xbox', 'Other'];

// A catalog's shelf or name ("Nintendo", "Switch ports", "PS2") as one of PLATFORMS
function platformOf(shelf) {
  const s = String(shelf || '').toLowerCase();
  if (!s) return 'Other';
  if (/nintendo|switch|wii|gamecube|\bn64\b|\bsnes\b|\bnes\b|\bgba\b|\b3?ds\b|game ?boy/.test(s)) return 'Nintendo';
  if (/playstation|\bps[1-5p]?\b|\bpsx\b|\bpsp\b|vita/.test(s)) return 'PlayStation';
  if (/xbox/.test(s)) return 'Xbox';
  if (/\bpc\b|windows|\bdos\b/.test(s)) return 'PC';
  return 'Other';
}

// quiver:<catalog>:<entry key> is the library id; quiver:<entry key> the export id,
// so the same port keeps its id if it moves to another catalog
const isQuiverId = (id) => typeof id === 'string' && id.startsWith('quiver:');
const quiverExportId = (identifier) => `quiver:${identifier.split(':').slice(2).join(':')}`;

// The source tags of an installed archive.org row: source:<label> and its
// state from the loaded item; with nothing loaded (or its source down), the
// last export's
function sourceTags(r, item, previous) {
  if (!r.install_dir) return [];
  const v = item?.versions?.find(x => x.id === r.identifier);
  if (!v || v.localReason === 'source-unavailable') return (previous?.tags || []).filter(isSourceTag);
  const label = v.local ? v.origin?.label : v.source?.label;
  return [...(label ? [`source:${label}`] : []), ...(STATE_TAGS.includes(v.localReason) ? [v.localReason] : [])];
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// Several library rows can share one export id: the same port held from two
// catalogs (an old local catalog and the built-in shelf). The one to keep is
// the installed row, then the most recently played; on a tie, the first.
const outranks = (a, b) => {
  if (!!a.install_dir !== !!b.install_dir) return !!a.install_dir;
  return (a.last_played_at || 0) > (b.last_played_at || 0);
};

// rows: library.all(); items: loaded items keyed by any version id or catalog id;
// tagsFor(identifier): collection names; art(identifier, row): { cover, hero } paths on disk;
// exportIdFor(identifier): the stored UUID of a manual entry; previous: the last export,
// whose names and sources stand in for items that aren't loaded
// Where an entry stands (schema 2). r: its library row; item: the loaded item
// holding it, if any; previous: its record in the last export, which stands
// in when nothing is loaded or its source failed to load; storePath: its
// download's folder in a local store
function standing(r, item, previous, { isArchive, storePath }) {
  if (!isArchive) {
    return {
      sourceLabel: item?.source?.name || item?.source?.label || previous?.sourceLabel || null, itemId: r.identifier, legacyId: null,
      state: r.install_dir ? 'installed' : item ? 'downloadable' : 'local-only',
      upstreamState: item ? 'available' : 'unknown', sourceState: item ? 'active' : 'unknown',
      localStorePath: null, alternatives: [],
    };
  }
  const found = item?.versions?.find(x => x.id === r.identifier);
  const v = found?.localReason === 'source-unavailable' ? null : found;
  const live = !!v && !v.local;
  const reason = v?.localReason;
  const legacyId = r.uploader === 'upstream' && /^\d+$/.test(r.identifier) ? r.identifier : null;
  const SOURCE_STATES = { 'source-disabled': 'disabled', 'source-removed': 'removed' };
  return {
    sourceLabel: (live ? v.source?.label : v?.origin?.label) || r.source_label || previous?.sourceLabel || null,
    itemId: r.uploader === 'upstream' ? null : (r.upload || r.identifier),
    legacyId,
    state: r.install_dir ? 'installed' : storePath ? 'in-local-store' : live ? 'downloadable' : 'local-only',
    upstreamState: live ? 'available' : reason === 'removed-upstream' ? 'removed' : (!v && previous?.upstreamState) || 'unknown',
    // Taken down while its pack is still on: the source itself is fine
    sourceState: live || (reason === 'removed-upstream' && v.origin) ? 'active' : SOURCE_STATES[reason] || (!v && previous?.sourceState) || 'unknown',
    localStorePath: storePath || null,
    // The same game from other uploads that are up now
    alternatives: (item?.versions || []).filter(x => x.id !== r.identifier && x.id !== r.upload && !x.local)
      .map(x => ({ sourceLabel: x.source?.label || null, itemId: x.id })),
  };
}

// storePathOf(identifier): its download's folder in a local store, or null
function buildExport({
  rows, items = {}, tagsFor = () => [], art = () => ({}), exportIdFor = () => null,
  previous = null, launcherVersion = null, now = Date.now(), storePathOf = () => null,
}) {
  const before = new Map((previous?.games || []).map(g => [g.id, g]));
  const byId = new Map(); // export id -> { row, game }
  for (const r of Object.values(rows)) {
    const item = items[r.identifier] || null;
    const src = item?.source;
    let id, source, platform, isArchive = false;
    if (r.source === 'manual') {
      id = exportIdFor(r.identifier);
      if (!id) continue;
      source = 'manual';
      platform = 'PC';
    } else if (src?.type === 'quiver' || isQuiverId(r.identifier)) {
      id = quiverExportId(r.identifier);
      const url = src?.url || (/^https?:/.test(r.source || '') ? r.source : null);
      source = url ? `quiver:${url}` : before.get(id)?.source || 'quiver:';
      platform = item ? platformOf(item.shelf || src.name) : before.get(id)?.platform || 'Other';
    } else {
      id = r.identifier;
      isArchive = true;
      // The uploader of the version installed, else the one saved at install
      const v = item?.versions?.find(x => x.id === r.identifier);
      const uploader = v?.source?.uploader || v?.origin?.uploader || (r.uploader !== 'upstream' && r.uploader) || src?.uploader;
      source = uploader ? `archive.org:${uploader}` : before.get(id)?.source || 'archive.org:';
      platform = 'PC';
    }
    const kept = byId.get(id);
    if (kept && !outranks(r, kept.row)) continue;
    const { cover = null, hero = null } = art(r.identifier, r) || {};
    // Map.set on an existing key keeps its place, so the export order stays the library's
    byId.set(id, { row: r, game: {
      id,
      // The saved name before the last export's: an export written while
      // nothing was loaded may hold the bare identifier
      name:            item?.title || r.title || before.get(id)?.name || r.identifier,
      source,
      platform,
      installed:       !!r.install_dir,
      installDir:      r.install_dir || null,
      exe:             r.exe_path || null,
      args:            '',
      workingDir:      r.exe_path ? path.dirname(r.exe_path) : (r.install_dir || null),
      version:         null,
      updateAvailable: updateAvailable(r, item),
      coverPath:       cover,
      heroPath:        hero,
      tags:            [...tagsFor(r.identifier), ...(isArchive ? sourceTags(r, item, before.get(id)) : [])],
      lastPlayed:      iso(r.last_played_at),
      playtimeSeconds: r.playtime_secs || 0,
      favorite:        !!r.is_favorite,
      ...standing(r, item, before.get(id), { isArchive, storePath: isArchive ? storePathOf(r.identifier) : null }),
    } });
  }
  const games = [...byId.values()].map(e => e.game);
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(now).toISOString(), launcherVersion, games };
}

// The library row an export id names, or null
function findRow(rows, exportId) {
  if (typeof exportId !== 'string' || !exportId) return null;
  const all = Object.values(rows);
  if (rows[exportId] && !isQuiverId(exportId)) return rows[exportId];
  if (isQuiverId(exportId)) {
    return all.filter(r => isQuiverId(r.identifier) && quiverExportId(r.identifier) === exportId)
      .reduce((best, r) => (!best || outranks(r, best) ? r : best), null);
  }
  return all.find(r => r.source === 'manual' && r.export_id === exportId) || null;
}

function readExport(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeExport(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { buildExport, findRow, readExport, writeExport, platformOf, SCHEMA_VERSION, PLATFORMS, STATE_TAGS };
