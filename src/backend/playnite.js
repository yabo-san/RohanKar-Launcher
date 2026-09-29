'use strict';
/**
 * playnite-export.json: one record per library entry, for the Playnite
 * library plugin. Ids are the library identifiers, so they stay stable across
 * re-exports. Written to a temp file then renamed, so a reader never sees
 * half a file.
 */
const fs   = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

// rows: library.all(); items: loaded items keyed by any version id;
// tagsFor(identifier): collection names; coverPath(identifier): cached cover or null
function buildExport({ rows, items = {}, tagsFor = () => [], coverPath = () => null, now = Date.now() }) {
  const records = Object.values(rows).map(r => {
    const item = items[r.identifier] || null;
    const src = item?.source;
    return {
      id:              r.identifier,
      name:            item?.title || r.identifier,
      source:          src?.type === 'quiver' ? { type: 'quiver', catalog: src.url }
                     : src ? { type: 'archive.org', uploader: src.uploader }
                     : r.source ? { type: 'other', value: r.source } : { type: 'archive.org', uploader: null },
      installDir:      r.install_dir || null,
      exe:             r.exe_path || null,
      args:            '',
      workingDir:      r.exe_path ? path.dirname(r.exe_path) : (r.install_dir || null),
      installed:       !!r.install_dir,
      version:         null,
      coverPath:       coverPath(r.identifier),
      heroPath:        null,
      platform:        src?.type === 'quiver' ? src.name : 'PC',
      tags:            tagsFor(r.identifier),
      favorite:        !!r.is_favorite,
      lastPlayed:      null,
      playtimeSeconds: r.playtime_secs || 0,
    };
  });
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(now).toISOString(), games: records };
}

function writeExport(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { buildExport, writeExport, SCHEMA_VERSION };
