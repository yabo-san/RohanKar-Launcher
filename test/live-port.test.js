'use strict';
// scripts/live-port.js: only the parts that don't need the network
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseArgs, itemFor, n64Header, parseListing, summarizeListing, checkInstall } = require('../scripts/live-port');

test('live-port: Perfect Dark by default, repos and --keep from the command line', () => {
  assert.deepEqual(parseArgs([]), { repos: ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight', 'ZDoom/Raze'], keep: false, ia: [], zips: [] });
  assert.deepEqual(parseArgs(['a/b', '--keep', 'c/d']), { repos: ['a/b', 'c/d'], keep: true, ia: [], zips: [] });
  assert.deepEqual(parseArgs(['--ia', 'N64TOSEC:(?i)perfect']), { repos: ['perfect-dark-pc-port/perfect_dark', 'TwilitRealm/dusklight', 'ZDoom/Raze'], keep: false, ia: ['N64TOSEC:(?i)perfect'], zips: [] });
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

test('live-port: a short archive listing prints whole; a long one is summed per folder with its key files', () => {
  assert.deepEqual(summarizeListing([{ path: 'a', size: null }, { path: 'a/b.exe', size: 3 }]), ['a', 'a/b.exe (3 bytes)']);
  const long = [
    { path: 'Pack/Blood/BLOOD.RFF', size: 10 }, { path: 'Pack/Blood/readme.txt', size: 1 },
    { path: 'Pack/raze.exe', size: 5 }, { path: 'top.txt', size: 2 }, { path: 'Pack/Blood', size: null },
    { path: 'Pack/mods/a/b/c/deep.grp', size: 7 },
  ];
  assert.deepEqual(summarizeListing(long, { limit: 3 }), [
    '6 entries; by folder:',
    '  (top) 1 files, 2 bytes',
    '  Pack/ 1 files, 5 bytes',
    '  Pack/Blood/ 2 files, 11 bytes',
    '  Pack/mods/ 1 files, 7 bytes',
    'key files (2):',
    '  Pack/Blood/BLOOD.RFF (10 bytes)',
    '  Pack/raze.exe (5 bytes)',
  ]);
});

test('live-port: archive.org\'s archive listing page parses into paths and sizes', () => {
  const html = '<table><tr><th>file</th><th>as jpg</th><th>timestamp</th><th>size</th></tr>'
    + '<tr><td><a href="x">Raze Package/</a><td><td>2021-12-27 18:15<td></tr>'
    + '<tr><td><a href="y">Raze Package/Blood &amp; Guts/BLOOD.RFF</a><td><td>2021-12-25 19:31<td id="size">9570681</tr>'
    + '<tr><td>Warrior/SW.GRP</td><td></td><td>2018-07-06 23:30:34</td><td>47536148</td></tr></table>';
  assert.deepEqual(parseListing(html), [
    { path: 'Raze Package', size: null },
    { path: 'Raze Package/Blood & Guts/BLOOD.RFF', size: 9570681 },
    { path: 'Warrior/SW.GRP', size: 47536148 },
  ]);
});

test('live-port: an install is checked for the exe and the expected files, anywhere, with sha1 and size', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Duke3D'));
  fs.writeFileSync(path.join(dir, 'raze.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'Duke3D', 'duke3d.grp'), 'GRP');
  const c = { repository: 'ZDoom/Raze', exe: 'raze.exe' };
  assert.deepEqual(checkInstall(dir, c, [{ name: 'DUKE3D.GRP', sha1: crypto.createHash('sha1').update('GRP').digest('hex') }]), []);
  assert.deepEqual(checkInstall(dir, { ...c, exe: 'bin/raze.exe' }, [{ name: 'BLOOD.RFF' }, { path: 'duke3d/DUKE3D.GRP', minSize: 10 }, { name: 'duke3d.grp', sha1: '0'.repeat(40) }]), [
    'bin/raze.exe is missing', 'BLOOD.RFF is missing', 'Duke3D/duke3d.grp is 3 bytes, expected at least 10',
    `Duke3D/duke3d.grp has sha1 ${crypto.createHash('sha1').update('GRP').digest('hex')}, expected ${'0'.repeat(40)}`,
  ]);
  assert.deepEqual(checkInstall(dir, { repository: 'x/y' }), [], 'nothing expected of an unknown port');
});
