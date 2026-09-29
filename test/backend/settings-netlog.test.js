'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createSettings } = require('../../src/backend/settings');
const { createNetLog } = require('../../src/backend/netlog');
const { tmpDir } = require('./helpers');

test('settings: missing or broken file reads as empty; save merges', (t) => {
  const file = path.join(tmpDir(t), 'settings.json');
  const s = createSettings(file);
  assert.deepEqual(s.load(), {});
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(s.load(), {});
  fs.writeFileSync(file, JSON.stringify({ keep: 1, downloadPath: '/a' }));
  assert.deepEqual(s.save({ downloadPath: '/b' }), { keep: 1, downloadPath: '/b' });
  assert.deepEqual(s.load(), { keep: 1, downloadPath: '/b' });
});

test('netlog: 2xx keeps throttling headers only, errors keep all', (t) => {
  const file = path.join(tmpDir(t), 'archive-net.log');
  const { log } = createNetLog(file);
  log('search', 'https://a/1', 200, { date: 'd', 'retry-after': '3', 'set-cookie': 'x' });
  log('search', 'https://a/2', 503, { 'set-cookie': 'x' });
  log('thumb', 'https://a/3', 0, {}, 'timed out');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines[0].headers, { date: 'd', 'retry-after': '3' });
  assert.deepEqual(lines[1].headers, { 'set-cookie': 'x' });
  assert.equal(lines[2].error, 'timed out');
  assert.equal(lines[2].status, 0);
  assert.equal(lines[0].kind, 'search');
});

test('netlog: rotates a log over the limit at startup; a bad path never throws', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'archive-net.log');
  fs.writeFileSync(file, 'x'.repeat(50));
  createNetLog(file, { maxBytes: 10 }).log('k', 'u', 200);
  assert.equal(fs.readFileSync(file + '.old', 'utf8'), 'x'.repeat(50));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);
  createNetLog(path.join(dir, 'no', 'such', 'dir.log')).log('k', 'u', 200);
});
