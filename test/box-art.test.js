'use strict';
// The box-art scripts' Home banner picks (scripts/box-art/banners.py), unit
// tested in Python on fixture data: test/box-art/test_banners.py
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const python = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0);

test('banners.py: favourite artists in priority order, pins win, top-voted fallback', { skip: !python && 'no python' }, () => {
  const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', path.join(__dirname, 'box-art'), '-p', 'test_*.py'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
