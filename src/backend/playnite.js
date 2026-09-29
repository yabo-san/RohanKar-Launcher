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

const SCHEMA_VERSION = 1;
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

// A newer upload of the same title than the one installed
function updateAvailable(row, item) {
  if (!row.install_dir || !item?.versions?.length) return false;
  const mine = item.versions.find(v => v.id === row.identifier);
  if (!mine?.addeddate) return false;
  return item.versions.some(v => v.id !== mine.id && v.addeddate && v.addeddate > mine.addeddate);
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// rows: library.all(); items: loaded items keyed by any version id or catalog id;
// tagsFor(identifier): collection names; art(identifier, row): { cover, hero } paths on disk;
// exportIdFor(identifier): the stored UUID of a manual entry; previous: the last export,
// whose names and sources stand in for items that aren't loaded
function buildExport({
  rows, items = {}, tagsFor = () => [], art = () => ({}), exportIdFor = () => null,
  previous = null, launcherVersion = null, now = Date.now(),
}) {
  const before = new Map((previous?.games || []).map(g => [g.id, g]));
  const games = [];
  for (const r of Object.values(rows)) {
    const item = items[r.identifier] || null;
    const src = item?.source;
    let id, source, platform;
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
      source = src?.uploader ? `archive.org:${src.uploader}` : before.get(id)?.source || 'archive.org:';
      platform = 'PC';
    }
    const { cover = null, hero = null } = art(r.identifier, r) || {};
    games.push({
      id,
      name:            item?.title || before.get(id)?.name || r.identifier,
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
      tags:            tagsFor(r.identifier),
      lastPlayed:      iso(r.last_played_at),
      playtimeSeconds: r.playtime_secs || 0,
      favorite:        !!r.is_favorite,
    });
  }
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(now).toISOString(), launcherVersion, games };
}

// The library row an export id names, or null
function findRow(rows, exportId) {
  if (typeof exportId !== 'string' || !exportId) return null;
  const all = Object.values(rows);
  if (rows[exportId] && !isQuiverId(exportId)) return rows[exportId];
  if (isQuiverId(exportId)) return all.find(r => isQuiverId(r.identifier) && quiverExportId(r.identifier) === exportId) || null;
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

module.exports = { buildExport, findRow, readExport, writeExport, platformOf, SCHEMA_VERSION, PLATFORMS };
