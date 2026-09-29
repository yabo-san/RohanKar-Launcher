'use strict';
/**
 * library.db handle. better-sqlite3 in Electron (built for its ABI by
 * postinstall); node:sqlite when the backend runs under plain Node, where that
 * native build can't load (tests, the dev loop). Both expose exec/prepare with
 * all/get/run, which is all library.js uses.
 */

function openDatabase(file, { preferNative = true } = {}) {
  if (preferNative) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(file);
      db.pragma('journal_mode = WAL');
      return db;
    } catch { /* wrong ABI or not installed: fall through */ }
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

// BEGIN/COMMIT by hand: node:sqlite has no db.transaction()
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDatabase, transaction };
