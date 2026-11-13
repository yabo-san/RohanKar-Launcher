'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findSevenZip, WINDOWS_7ZIP } = require('../../src/backend/sevenzip');

const P = (...d) => d.join(path.delimiter);
const has = (...files) => (f) => files.includes(f);

test('findSevenZip: Program Files on Windows, as before', () => {
  assert.equal(findSevenZip({ platform: 'win32', bundled: '/app/7zzs', exists: () => true }), WINDOWS_7ZIP);
});

test('findSevenZip on Linux: 7-Zip\'s own on PATH, then the bundled copy, then p7zip, else none', () => {
  const env = { PATH: P('/usr/bin', '/home/deck/bin') };
  const bundled = '/app/resources/7zip/7zzs';
  const bin = (name) => path.join('/home/deck/bin', name);
  assert.equal(findSevenZip({ platform: 'linux', bundled, env, exists: has(bin('7zz'), bundled) }), bin('7zz'));
  assert.equal(findSevenZip({ platform: 'linux', bundled, env, exists: has(bin('7zzs')) }), bin('7zzs'));
  assert.equal(findSevenZip({ platform: 'linux', bundled, env, exists: has(bundled, path.join('/usr/bin', '7z')) }), bundled);
  assert.equal(findSevenZip({ platform: 'linux', bundled, env, exists: has(path.join('/usr/bin', '7z')) }), path.join('/usr/bin', '7z'));
  assert.equal(findSevenZip({ platform: 'linux', bundled, env, exists: () => false }), null);
  assert.equal(findSevenZip({ platform: 'linux', env: {}, exists: () => true }), null);
  assert.equal(typeof findSevenZip({ platform: 'linux' }), typeof findSevenZip({ platform: 'linux' }));
});
