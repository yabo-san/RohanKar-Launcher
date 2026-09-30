'use strict';
// scripts/live-port.js: only the parts that don't need the network
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, itemFor, n64Header } = require('../scripts/live-port');

test('live-port: Perfect Dark by default, repos and --keep from the command line', () => {
  assert.deepEqual(parseArgs([]), { repos: ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight'], keep: false, ia: [], zips: [] });
  assert.deepEqual(parseArgs(['a/b', '--keep', 'c/d']), { repos: ['a/b', 'c/d'], keep: true, ia: [], zips: [] });
  assert.deepEqual(parseArgs(['--ia', 'N64TOSEC:(?i)perfect']), { repos: ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight'], keep: false, ia: ['N64TOSEC:(?i)perfect'], zips: [] });
});

test('live-port: a collision becomes the catalog item the install engine takes', () => {
  const c = { repository: 'Owner/Repo', name: 'Game', folderName: 'Game', assetPattern: '(?i)win', exe: 'game.exe' };
  assert.deepEqual(itemFor(c), {
    id: 'quiver:live:owner/repo', title: 'Game', repository: 'Owner/Repo', entry: { folderName: 'Game' },
    data: { iaIdentifier: null, contentUrl: null, assetPattern: '(?i)win', dataFiles: [], sources: [], base: 'binary', binaryTarget: '', exe: 'game.exe' },
  });
  assert.equal(itemFor({ repository: 'a/b' }).title, 'a/b');
});

test('live-port: an N64 ROM reports its byte order, and a z64 its title and revision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n64-'));
  const z64 = Buffer.alloc(64);
  z64.writeUInt32BE(0x80371240, 0);
  z64.write('Perfect Dark        ', 0x20, 'latin1');
  z64.write('NPDE', 0x3b, 'latin1');
  z64[0x3f] = 1;
  fs.writeFileSync(path.join(dir, 'a.z64'), z64);
  assert.equal(n64Header(path.join(dir, 'a.z64')), 'z64 (big-endian), title "Perfect Dark", code NPDE, rev 1');
  const v64 = Buffer.alloc(64);
  v64.writeUInt32BE(0x37804012, 0);
  fs.writeFileSync(path.join(dir, 'b.v64'), v64);
  assert.equal(n64Header(path.join(dir, 'b.v64')), 'v64 (byteswapped)');
  fs.rmSync(dir, { recursive: true, force: true });
});
