'use strict';
/**
 * Local stores: folders (a NAS share like N:\games\pc) holding archive.org
 * downloads as <identifier>\<original file>. An install reads from a store
 * before it downloads, and a download can be kept there ("back up to local
 * store"). Stores are only read, except when backing up into the first one.
 */
const fs   = require('fs');
const path = require('path');
const { ARCHIVE_FILE } = require('./archive');

const IA_ID = /^[\w.-]+$/;
const readdir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

// settings.localStores as a list of folder paths
function storeDirs(settings) {
  const list = settings?.localStores;
  return (Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

// The files of one store folder: [{ name, size }], plain files at its top level
function storeFiles(dir) {
  return readdir(dir).filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, size: String(fs.statSync(path.join(dir, e.name)).size), source: 'original' }));
}

// identifier's folder in the first store that has one with files: { dir, store, files } or null
function findCopy(dirs, identifier) {
  if (!IA_ID.test(String(identifier))) return null;
  for (const store of dirs) {
    const dir = path.join(store, identifier);
    const files = storeFiles(dir);
    if (files.length) return { dir, store, files };
  }
  return null;
}

// Every stored download: Map identifier -> { dir, store, files, title }. A
// folder that isn't named like an identifier, or holds no files, isn't one.
// title: the largest archive's name without its extension ("PROTOTYPE 2")
function scan(dirs) {
  const out = new Map();
  for (const store of dirs) {
    for (const e of readdir(store)) {
      if (!e.isDirectory() || !IA_ID.test(e.name) || out.has(e.name)) continue;
      const dir = path.join(store, e.name);
      const files = storeFiles(dir);
      if (!files.length) continue;
      const main = files.filter(f => ARCHIVE_FILE.test(f.name)).sort((a, b) => Number(b.size) - Number(a.size))[0] || files[0];
      out.set(e.name, { dir, store, files, title: main.name.replace(/\.[^.]+$/, '') });
    }
  }
  return out;
}

// Copies a downloaded file into <first store>/<identifier>/; the path, or null with no store
function keep(dirs, identifier, filePath) {
  if (!dirs.length || !IA_ID.test(String(identifier))) return null;
  const dest = path.join(dirs[0], identifier, path.basename(filePath));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);
  return dest;
}

module.exports = { storeDirs, storeFiles, findCopy, scan, keep };
