'use strict';
// scripts/live-port.js: only the parts that don't need the network
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, itemFor } = require('../scripts/live-port');

test('live-port: Perfect Dark by default, repos and --keep from the command line', () => {
  assert.deepEqual(parseArgs([]), { repos: ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight'], keep: false, ia: [] });
  assert.deepEqual(parseArgs(['a/b', '--keep', 'c/d']), { repos: ['a/b', 'c/d'], keep: true, ia: [] });
  assert.deepEqual(parseArgs(['--ia', 'N64TOSEC:(?i)perfect']), { repos: ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight'], keep: false, ia: ['N64TOSEC:(?i)perfect'] });
});

test('live-port: a collision becomes the catalog item the install engine takes', () => {
  const c = { repository: 'Owner/Repo', name: 'Game', folderName: 'Game', assetPattern: '(?i)win', exe: 'game.exe' };
  assert.deepEqual(itemFor(c), {
    id: 'quiver:live:owner/repo', title: 'Game', repository: 'Owner/Repo', entry: { folderName: 'Game' },
    data: { iaIdentifier: null, contentUrl: null, assetPattern: '(?i)win', dataFiles: [], sources: [], base: 'binary', binaryTarget: '', exe: 'game.exe' },
  });
  assert.equal(itemFor({ repository: 'a/b' }).title, 'a/b');
});
