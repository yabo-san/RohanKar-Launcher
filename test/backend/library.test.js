'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createLibrary } = require('../../src/backend/library');
const { openDatabase, transaction } = require('../../src/backend/sqlite');
const { tmpDir } = require('./helpers');

const open = (t, opts = {}) => {
  const dir = tmpDir(t);
  const changes = [];
  const lib = createLibrary({ dbPath: path.join(dir, 'library.db'), onChange: c => changes.push(c), log: () => {}, ...opts(dir) });
  t.after(() => lib.close());
  return { lib, dir, changes };
};

test('games: add, favourite, notes, category, exe path, install, remove', (t) => {
  const { lib, changes } = open(t, () => ({}));
  assert.equal(lib.available, true);
  assert.deepEqual(lib.all(), {});
  assert.equal(lib.get('a'), null);

  assert.deepEqual(lib.add('a', 'https://cat/apps.json'), { ok: true });
  lib.add('a', 'other');  // first source sticks
  assert.equal(lib.get('a').source, 'https://cat/apps.json');

  lib.setFavorite('b', true);
  lib.setNotes('b', 'good');
  lib.setCategory('b', 'rpg');
  lib.setExePath('b', '/g/b.exe');
  assert.deepEqual({ ...lib.get('b'), added_at: 0 }, {
    identifier: 'b', install_dir: null, exe_path: '/g/b.exe', category: 'rpg', playtime_secs: 0,
    added_at: 0, is_favorite: 1, notes: 'good', source: null,
  });
  lib.setNotes('b', '');
  lib.setExePath('b', '');
  assert.equal(lib.get('b').notes, null);
  assert.equal(lib.get('b').exe_path, null);

  lib.recordInstall('c', '/g/c', null);
  assert.equal(lib.get('c').install_dir, '/g/c');
  lib.adoptInstall('b', '/g/b', '/g/b/b.exe');
  assert.equal(lib.get('b').is_favorite, 1, 'adopting keeps the rest of the row');
  assert.deepEqual(Object.keys(lib.all()).sort(), ['a', 'b', 'c']);

  lib.remove('c');
  assert.equal(lib.get('c'), null);
  assert.ok(changes.length >= 10);
});

test('clearMissingInstalls clears rows whose folder is gone', (t) => {
  const { lib, dir } = open(t, () => ({}));
  const here = path.join(dir, 'here');
  fs.mkdirSync(here);
  lib.recordInstall('here', here, null);
  lib.recordInstall('gone', path.join(dir, 'gone'), '/x.exe');
  assert.deepEqual(lib.clearMissingInstalls(), { cleared: 1 });
  assert.equal(lib.get('gone').install_dir, null);
  assert.equal(lib.get('gone').exe_path, null);
  assert.equal(lib.get('here').install_dir, here);
  assert.deepEqual(lib.clearMissingInstalls(), { cleared: 0 });
});

test('collections: create, rename, colour, membership, duplicate name, delete', (t) => {
  const { lib } = open(t, () => ({}));
  const a = lib.createCollection('  Faves ');
  assert.equal(a.ok, true);
  assert.equal(lib.createCollection('Faves').ok, false);
  const b = lib.createCollection('Backlog');
  lib.addToCollection(a.id, 'x');
  lib.addToCollection(a.id, 'x');
  lib.addToCollection(a.id, 'y');
  lib.removeFromCollection(a.id, 'y');
  lib.setCollectionColor(a.id, '#f00');
  assert.deepEqual(lib.renameCollection(b.id, 'Faves').ok, false);
  lib.renameCollection(b.id, 'Later');
  const cols = lib.collections();
  assert.deepEqual(cols.map(c => [c.name, c.games, c.color]), [['Faves', ['x'], '#f00'], ['Later', [], null]]);
  lib.setCollectionColor(a.id, '');
  lib.deleteCollection(a.id);
  assert.deepEqual(lib.collections().map(c => c.name), ['Later']);
});

test('migrates an old database and imports legacy library.json once', (t) => {
  const { dir } = { dir: tmpDir(t) };
  const dbPath = path.join(dir, 'library.db');
  const old = openDatabase(dbPath);
  old.exec('CREATE TABLE games (identifier TEXT PRIMARY KEY, install_dir TEXT); CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at INTEGER);');
  old.prepare('INSERT INTO games (identifier, install_dir) VALUES (?, ?)').run('old', '/o');
  old.close();
  const legacy = path.join(dir, 'library.json');
  fs.writeFileSync(legacy, JSON.stringify({ old: { installDir: '/ignored' }, fresh: { installDir: '/f', exePath: '/f/f.exe', category: 'c', playtimeSecs: 9 } }));

  const logs = [];
  const lib = createLibrary({ dbPath, legacyJsonPath: legacy, log: m => logs.push(m) });
  t.after(() => lib.close());
  assert.equal(lib.get('old').install_dir, '/o');
  assert.equal(lib.get('old').is_favorite, 0);
  assert.equal(lib.get('fresh').playtime_secs, 9);
  assert.ok(fs.existsSync(legacy + '.migrated'));
  assert.ok(logs.some(l => l.includes('added column collections.color')));
  assert.ok(logs.some(l => l.includes('added column games.source')));

  fs.writeFileSync(legacy, '{broken');
  const again = createLibrary({ dbPath, legacyJsonPath: legacy, log: m => logs.push(m) });
  again.close();
  assert.ok(logs.some(l => l.startsWith('Migration error')));
});

test('an unopenable database reads empty and refuses writes', (t) => {
  const logs = [];
  const lib = createLibrary({ dbPath: '/nope', open: () => { throw new Error('no sqlite'); }, log: m => logs.push(m) });
  assert.equal(lib.available, false);
  assert.deepEqual(lib.all(), {});
  assert.equal(lib.get('a'), null);
  assert.deepEqual(lib.collections(), []);
  assert.deepEqual(lib.clearMissingInstalls(), { cleared: 0 });
  for (const r of [lib.add('a'), lib.setCategory('a', 'c'), lib.setFavorite('a', 1), lib.setNotes('a', 'n'),
    lib.setExePath('a', 'e'), lib.recordInstall('a', 'd'), lib.adoptInstall('a', 'd'), lib.remove('a'),
    lib.createCollection('x'), lib.deleteCollection(1)]) {
    assert.equal(r.ok, false);
  }
  assert.match(logs[0], /no sqlite/);
  lib.close();
  t.diagnostic('closed twice is fine');
});

test('sqlite: transaction rolls back on error; node:sqlite when native is skipped', (t) => {
  const db = openDatabase(path.join(tmpDir(t), 'x.db'), { preferNative: false });
  db.exec('CREATE TABLE t (v INTEGER)');
  assert.throws(() => transaction(db, () => { db.exec('INSERT INTO t VALUES (1)'); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  assert.equal(transaction(db, () => { db.exec('INSERT INTO t VALUES (1)'); return 'ok'; }), 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  db.close();
});
