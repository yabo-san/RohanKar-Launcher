'use strict';
/**
 * library.db: what the user has (installed, favourited, added), plus
 * collections. The schema and migrations are the ones main.js ran; `source`
 * is new and nullable (the archive.org rows written so far leave it empty).
 *
 * If the database can't be opened every read comes back empty and every
 * write reports { ok: false }, as before.
 */
const fs = require('fs');
const crypto = require('crypto');
const { openDatabase, transaction } = require('./sqlite');

const GAME_COLUMNS = {
  install_dir:   'TEXT',
  exe_path:      'TEXT',
  category:      'TEXT',
  playtime_secs: 'INTEGER DEFAULT 0',
  added_at:      'INTEGER',
  is_favorite:   'INTEGER DEFAULT 0',
  notes:         'TEXT',
  source:        'TEXT',
  export_id:     'TEXT',     // stable Playnite id for manual entries (a UUID)
  last_played_at: 'INTEGER',
  title:         'TEXT',     // name of an entry no item describes (manual, imported)
  tags:          'TEXT',     // JSON array of strings
  version:       'TEXT',     // installed release tag, when known
};

function migrate(db, log) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      identifier  TEXT PRIMARY KEY,
      install_dir TEXT,
      exe_path    TEXT,
      category    TEXT,
      playtime_secs INTEGER DEFAULT 0,
      added_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS collections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS collection_games (
      collection_id INTEGER NOT NULL,
      identifier    TEXT NOT NULL,
      PRIMARY KEY (collection_id, identifier)
    );
  `);

  const collectionCols = db.prepare('PRAGMA table_info(collections)').all().map(r => r.name);
  if (!collectionCols.includes('color')) {
    db.exec('ALTER TABLE collections ADD COLUMN color TEXT');
    log('DB migration: added column collections.color');
  }

  const existing = db.prepare('PRAGMA table_info(games)').all().map(r => r.name);
  for (const [col, type] of Object.entries(GAME_COLUMNS)) {
    if (!existing.includes(col)) {
      db.exec(`ALTER TABLE games ADD COLUMN ${col} ${type}`);
      log(`DB migration: added column games.${col}`);
    }
  }
}

// library.json from before SQLite: imported once, then renamed to .migrated
function importLegacyJson(db, legacyPath, log) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const insert = db.prepare(`
      INSERT OR IGNORE INTO games (identifier, install_dir, exe_path, category, playtime_secs, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    transaction(db, () => {
      for (const [id, g] of Object.entries(legacy)) {
        insert.run(id, g.installDir || null, g.exePath || null, g.category || null, g.playtimeSecs || 0, Date.now());
      }
    });
    fs.renameSync(legacyPath, legacyPath + '.migrated');
    log('Migrated library.json to SQLite');
  } catch (e) {
    log('Migration error: ' + e.message);
  }
}

// Plain objects: node:sqlite rows have a null prototype; tags come back as an array
const parseTags = (t) => { try { const a = JSON.parse(t); return Array.isArray(a) ? a : null; } catch { return null; } };
const plain = (row) => (row ? { ...row, ...(typeof row.tags === 'string' ? { tags: parseTags(row.tags) } : {}) } : null);

function createLibrary({ dbPath, legacyJsonPath = null, open = openDatabase, onChange = () => {}, log = console.log }) {
  let db = null;
  try {
    db = open(dbPath);
    migrate(db, log);
  } catch (e) {
    log('SQLite init failed: ' + e.message);
    db = null;
  }
  if (db) importLegacyJson(db, legacyJsonPath, log);

  const changed = (identifier) => onChange({ identifier });
  const ensureRow = (identifier) =>
    db.prepare('INSERT OR IGNORE INTO games (identifier, added_at) VALUES (?, ?)').run(identifier, Date.now());

  // ─── Games ────────────────────────────────────────────────────────────────

  function all() {
    if (!db) return {};
    const out = {};
    for (const r of db.prepare('SELECT * FROM games').all()) out[r.identifier] = plain(r);
    return out;
  }

  function get(identifier) {
    if (!db) return null;
    return plain(db.prepare('SELECT * FROM games WHERE identifier = ?').get(identifier));
  }

  // Add: the item is the user's now, installed or not
  function add(identifier, source = null) {
    if (!db) return { ok: false };
    ensureRow(identifier);
    if (source) db.prepare('UPDATE games SET source = COALESCE(source, ?) WHERE identifier = ?').run(source, identifier);
    changed(identifier);
    return { ok: true };
  }

  function setCategory(identifier, category) {
    if (!db) return { ok: false };
    db.prepare('UPDATE games SET category = ? WHERE identifier = ?').run(category ?? null, identifier);
    changed(identifier);
    return { ok: true };
  }

  // The row may not exist yet (favourited before installing)
  function setFavorite(identifier, isFavorite) {
    if (!db) return { ok: false };
    ensureRow(identifier);
    db.prepare('UPDATE games SET is_favorite = ? WHERE identifier = ?').run(isFavorite ? 1 : 0, identifier);
    changed(identifier);
    return { ok: true };
  }

  function setNotes(identifier, notes) {
    if (!db) return { ok: false };
    ensureRow(identifier);
    db.prepare('UPDATE games SET notes = ? WHERE identifier = ?').run(notes || null, identifier);
    changed(identifier);
    return { ok: true };
  }

  function setExePath(identifier, exePath) {
    if (!db) return { ok: false };
    db.prepare('UPDATE games SET exe_path = ? WHERE identifier = ?').run(exePath || null, identifier);
    changed(identifier);
    return { ok: true };
  }

  // Replaces the row, as the install-game IPC always has, keeping only the
  // ids Playnite knows it by and when it was last played
  function recordInstall(identifier, installDir, exePath) {
    if (!db) return { ok: false };
    const prev = db.prepare('SELECT export_id, last_played_at, title, tags FROM games WHERE identifier = ?').get(identifier);
    db.prepare(`
      INSERT OR REPLACE INTO games (identifier, install_dir, exe_path, added_at, export_id, last_played_at, title, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(identifier, installDir, exePath || null, Date.now(), prev?.export_id ?? null, prev?.last_played_at ?? null,
      prev?.title ?? null, prev?.tags ?? null);
    changed(identifier);
    return { ok: true };
  }

  // Registers an install found on disk, keeping the rest of the row
  function adoptInstall(identifier, installDir, exePath) {
    if (!db) return { ok: false };
    ensureRow(identifier);
    db.prepare('UPDATE games SET install_dir = ?, exe_path = ? WHERE identifier = ?').run(installDir, exePath || null, identifier);
    changed(identifier);
    return { ok: true };
  }

  // Fields an import carries over: title, tags (an array), version. Leaves
  // out what isn't given; creates the row
  function setDetails(identifier, { title, tags, version } = {}) {
    if (!db) return { ok: false };
    ensureRow(identifier);
    const set = (col, v) => db.prepare(`UPDATE games SET ${col} = ? WHERE identifier = ?`).run(v, identifier);
    if (title !== undefined) set('title', title || null);
    if (tags !== undefined) { const t = normalizeTags(tags); set('tags', t.length ? JSON.stringify(t) : null); }
    if (version !== undefined) set('version', version || null);
    changed(identifier);
    return { ok: true };
  }

  // Uninstalled: the entry stays in the library (favourite, collections, playtime)
  function clearInstall(identifier) {
    if (!db) return { ok: false };
    db.prepare('UPDATE games SET install_dir = NULL, exe_path = NULL WHERE identifier = ?').run(identifier);
    changed(identifier);
    return { ok: true };
  }

  function markPlayed(identifier, at = Date.now()) {
    if (!db) return { ok: false };
    db.prepare('UPDATE games SET last_played_at = ? WHERE identifier = ?').run(at, identifier);
    changed(identifier);
    return { ok: true };
  }

  // The Playnite id of an entry that has no archive.org or catalog id of its
  // own: a UUID made once and kept, so renames never change it
  function exportId(identifier) {
    if (!db) return null;
    const row = db.prepare('SELECT export_id FROM games WHERE identifier = ?').get(identifier);
    if (!row) return null;
    if (row.export_id) return row.export_id;
    const id = crypto.randomUUID();
    db.prepare('UPDATE games SET export_id = ? WHERE identifier = ?').run(id, identifier);
    return id;
  }

  function remove(identifier) {
    if (!db) return { ok: false };
    db.prepare('DELETE FROM games WHERE identifier = ?').run(identifier);
    changed(identifier);
    return { ok: true };
  }

  // Clears rows whose install folder was deleted outside the launcher
  function clearMissingInstalls() {
    if (!db) return { cleared: 0 };
    const rows = db.prepare('SELECT identifier, install_dir FROM games WHERE install_dir IS NOT NULL').all();
    let cleared = 0;
    for (const row of rows) {
      if (!fs.existsSync(row.install_dir)) {
        db.prepare('UPDATE games SET install_dir = NULL, exe_path = NULL WHERE identifier = ?').run(row.identifier);
        log(`[validate] Cleared missing install: ${row.identifier}`);
        cleared++;
      }
    }
    if (cleared > 0) {
      log(`[validate] Cleared ${cleared} missing installs`);
      onChange({});
    }
    return { cleared };
  }

  // ─── Collections ──────────────────────────────────────────────────────────

  function collections() {
    if (!db) return [];
    return db.prepare('SELECT * FROM collections ORDER BY name').all().map(c => ({
      ...c,
      games: db.prepare('SELECT identifier FROM collection_games WHERE collection_id = ?').all(c.id).map(r => r.identifier),
    }));
  }

  // Constraint errors (duplicate name) come back as { ok: false, error }
  const guarded = (fn) => (...args) => {
    if (!db) return { ok: false };
    try {
      const out = fn(...args);
      onChange({});
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const createCollection = guarded((name) => {
    const info = db.prepare('INSERT INTO collections (name, created_at) VALUES (?, ?)').run(String(name).trim(), Date.now());
    return { id: Number(info.lastInsertRowid) };
  });
  const renameCollection = guarded((id, name) => {
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(String(name).trim(), id);
  });
  const setCollectionColor = guarded((id, color) => {
    db.prepare('UPDATE collections SET color = ? WHERE id = ?').run(color || null, id);
  });
  const deleteCollection = guarded((id) => {
    db.prepare('DELETE FROM collection_games WHERE collection_id = ?').run(id);
    db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  });
  const addToCollection = guarded((collectionId, identifier) => {
    db.prepare('INSERT OR IGNORE INTO collection_games (collection_id, identifier) VALUES (?, ?)').run(collectionId, identifier);
  });
  const removeFromCollection = guarded((collectionId, identifier) => {
    db.prepare('DELETE FROM collection_games WHERE collection_id = ? AND identifier = ?').run(collectionId, identifier);
  });

  function close() {
    try { db?.close(); } catch { /* already closed */ }
    db = null;
  }

  return {
    get available() { return !!db; },
    all, get, add, setCategory, setFavorite, setNotes, setDetails, setExePath, recordInstall, adoptInstall, remove,
    clearInstall, markPlayed, exportId,
    clearMissingInstalls,
    collections, createCollection, renameCollection, setCollectionColor, deleteCollection,
    addToCollection, removeFromCollection,
    close,
  };
}

// A user's tags as stored: trimmed, inner spaces collapsed, no empties, the
// first spelling of each kept when two differ only by case, at most MAX_TAGS
// of at most MAX_TAG_LENGTH characters
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 40;
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const tag = t.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

module.exports = { createLibrary, normalizeTags, MAX_TAGS, MAX_TAG_LENGTH };
