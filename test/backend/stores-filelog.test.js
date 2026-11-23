'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const stores = require('../../src/backend/stores');
const { createFileLog } = require('../../src/backend/filelog');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-sf-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('stores: dirs, findCopy, scan, keep', (t) => {
  const root = tmp(t);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(path.join(a, 'prototype-2_20260115'), { recursive: true });
  fs.writeFileSync(path.join(a, 'prototype-2_20260115', 'PROTOTYPE 2.zip'), 'x');
  fs.mkdirSync(path.join(b, 'duke_202603'), { recursive: true });
  fs.writeFileSync(path.join(b, 'duke_202603', 'duke.7z'), 'xx');
  fs.mkdirSync(path.join(a, 'empty-folder'), { recursive: true });        // no files: not a copy
  fs.mkdirSync(path.join(a, 'not an id!'), { recursive: true });          // not an identifier
  fs.writeFileSync(path.join(a, 'not an id!', 'x.zip'), 'x');

  assert.deepEqual(stores.storeDirs({ localStores: [a, '', b, 5] }), [a, b]);
  assert.deepEqual(stores.storeDirs({}), []);

  const copy = stores.findCopy([a, b], 'duke_202603');
  assert.deepEqual([copy.store, copy.files.map(f => f.name)], [b, ['duke.7z']]);
  assert.equal(stores.findCopy([a, b], 'nope'), null);
  assert.equal(stores.findCopy([a, b], 'bad id'), null);

  const scan = stores.scan([a, b]);
  assert.deepEqual([...scan.keys()].sort(), ['duke_202603', 'prototype-2_20260115']);
  assert.equal(scan.get('prototype-2_20260115').title, 'PROTOTYPE 2');
  assert.ok(!scan.has('empty-folder') && !scan.has('not an id!'));

  // keep copies a download into the first store
  const src = path.join(root, 'dl', 'Game.zip');
  fs.mkdirSync(path.dirname(src)); fs.writeFileSync(src, 'data');
  const dest = stores.keep([a, b], 'new-item_1', src);
  assert.equal(dest, path.join(a, 'new-item_1', 'Game.zip'));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'data');
  assert.equal(stores.keep([], 'x', src), null);
  // Already there: not recopied, no throw
  fs.writeFileSync(dest, 'kept');
  assert.equal(fs.readFileSync(stores.keep([a], 'new-item_1', src), 'utf8'), 'kept');
});

test('filelog: writes timestamped lines and rotates past maxBytes', (t) => {
  const dir = tmp(t);
  let n = 0;
  const log = createFileLog(dir, { maxBytes: 80, keep: 2, now: () => new Date(1700000000000 + n++) });
  log('first line here');
  assert.match(fs.readFileSync(log.file, 'utf8'), /^20\d\d-.*first line here\n$/);
  for (let i = 0; i < 10; i++) log(`line ${i} with enough text to pass the small cap`);
  assert.ok(fs.existsSync(`${log.file}.1`), 'rotated');
  assert.ok(!fs.existsSync(`${log.file}.3`), 'keeps at most 2 old files');
  // A write to an impossible dir is swallowed
  const bad = createFileLog(path.join(log.file, 'nope'));   // file as a parent dir
  assert.doesNotThrow(() => bad('x'));
});
