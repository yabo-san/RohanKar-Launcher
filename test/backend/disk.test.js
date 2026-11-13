'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const disk = require('../../src/backend/disk');
const { tmpDir } = require('./helpers');

// Builds a tree from { 'a/b.exe': 'x', 'c/': null }
function tree(root, spec) {
  for (const [p, content] of Object.entries(spec)) {
    const full = path.join(root, p);
    if (p.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content ?? ''); }
  }
  return root;
}

test('sanitize names for Windows folders', () => {
  assert.equal(disk.sanitizeFolderName('a:b/c. '), 'a_b_c');
  assert.equal(disk.sanitizeFolderName('...'), '_');
  assert.equal(disk.sanitizeTitle('Zoo: Tycoon?. '), 'Zoo_ Tycoon_');
});

test('findExes: local exes, bin/, nested, ignored folders, collections, depth limit', (t) => {
  const root = tmpDir(t);
  const local = tree(path.join(root, 'local'), { 'game.exe': '', 'setup.EXE': '', 'sub/other.exe': '' });
  assert.deepEqual(disk.findExes(local).map(p => path.basename(p)).sort(), ['game.exe', 'setup.EXE']);

  const bin = tree(path.join(root, 'bin'), { 'launch.exe': '', 'BIN/real.exe': '' });
  assert.deepEqual(disk.findExes(bin).map(p => path.basename(p)), ['real.exe']);
  const emptyBin = tree(path.join(root, 'emptybin'), { 'bin/': null, 'launch.exe': '' });
  assert.deepEqual(disk.findExes(emptyBin).map(p => path.basename(p)), ['launch.exe']);

  const nested = tree(path.join(root, 'nested'), { 'Extras/tool.exe': '', 'Game/Game/play.exe': '', 'hero.png': '' });
  assert.deepEqual(disk.findExes(nested).map(p => path.basename(p)), ['play.exe']);

  const coll = tree(path.join(root, 'coll'), { '_GAME_A/a.exe': '', '_GAME_B/x/b.exe': '', 'loose.exe': '' });
  assert.deepEqual(disk.findExes(coll).map(p => path.basename(p)).sort(), ['a.exe', 'b.exe']);

  const deep = tree(path.join(root, 'deep'), { '1/2/3/4/5/6/7/deep.exe': '' });
  assert.deepEqual(disk.findExes(deep), []);
  assert.deepEqual(disk.findExes(path.join(root, 'missing')), []);
  assert.deepEqual(disk.findExes(null), []);
  assert.deepEqual(disk.exesInDir(path.join(root, 'missing')), []);
});

test('readReadme: readme.* first, bare README next, latin1', (t) => {
  const root = tmpDir(t);
  const a = tree(path.join(root, 'a'), { 'README.nfo': 'caf\xe9', 'readme': 'bare' });
  fs.writeFileSync(path.join(a, 'README.nfo'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.deepEqual(disk.readReadme(a), { ok: true, text: 'café', fileName: 'README.nfo' });
  const b = tree(path.join(root, 'b'), { 'README': 'bare', 'readme.exe': '' });
  assert.equal(disk.readReadme(b).fileName, 'README');
  const c = tree(path.join(root, 'c'), { 'notes.txt': '' });
  assert.deepEqual(disk.readReadme(c), { ok: true, text: null });
  assert.deepEqual(disk.readReadme(path.join(root, 'zzz')), { ok: false, text: null });
  const d = tree(path.join(root, 'd'), { 'readme.txt/': null });
  assert.equal(disk.readReadme(path.join(d)).text, null);
  fs.chmodSync(tree(path.join(root, 'e'), { 'readme.txt': 'x' }) + '/readme.txt', 0);
  const locked = disk.readReadme(path.join(root, 'e'));
  if (process.getuid?.() !== 0) assert.equal(locked.ok, false);
});

test('unblockDirectory: only on Windows; removes Zone.Identifier streams', (t) => {
  const root = tree(tmpDir(t), { 'a.exe': '', 'sub/b.dll': '' });
  assert.equal(disk.unblockDirectory(root, { platform: 'linux' }), 0);
  // On a non-NTFS disk the stream is just a sibling file with that name
  fs.writeFileSync(path.join(root, 'a.exe:Zone.Identifier'), '');
  const logs = [];
  assert.equal(disk.unblockDirectory(root, { platform: 'win32', log: m => logs.push(m) }), 1);
  assert.match(logs[0], /Removed Zone.Identifier from 1 files/);
  assert.equal(disk.unblockDirectory(null, { platform: 'win32' }), 0);
});

test('matchInstallFolders: by identifier, sanitized identifier, then title', (t) => {
  const root = tree(tmpDir(t), {
    'rk-halo/': null, 'odd_id/': null, 'Zoo Tycoon - Complete/': null, '(28)Blur/': null, 'unknown/': null, 'file.txt': '',
  });
  const found = disk.matchInstallFolders(root, ['rk-halo', 'odd:id.'], { 'Zoo Tycoon - Complete': 'rk-zoo', 'Blur': 'rk-blur', '': 'x' });
  assert.deepEqual(found.map(f => [f.identifier, f.matchedBy]).sort(), [
    ['odd:id.', 'identifier-sanitized'], ['rk-blur', 'title-prefixed'], ['rk-halo', 'identifier'], ['rk-zoo', 'title'],
  ]);
  assert.deepEqual(disk.matchInstallFolders(path.join(root, 'nope'), [], {}), []);
  assert.deepEqual(disk.matchInstallFolders(null), []);
});

test('matchInstallFolders: loose names, identifiers and unique prefixes (real upstream folders)', (t) => {
  const root = tree(tmpDir(t), {
    '(137)Oni - Anniversary Edition/': null,
    '(139)OutRun 2006 Coast 2 Coast/': null,
    '(16)Banjo Kazooie Recompiled/': null,
    '(181)Silent Hill 2/': null,
    '(200)Silent Hill 3/': null,
    '(5)Halo/': null,
    '(7)Oni/': null,
  });
  const found = disk.matchInstallFolders(root, ['oni-ae', 'outrun-2006', 'banjo-kazooie-recompiled.-7z', 'sh2-ee', 'halo-ce', 'halo-2'], {
    'Oni: Anniversary Edition': 'oni-ae',
    'OutRun 2006: Coast 2 Coast': 'outrun-2006',
    'Banjo Kazooie': 'banjo-kazooie-recompiled.-7z',
    'Silent Hill 2: Enhanced Edition': 'sh2-ee',
    'Halo: Combat Evolved': 'halo-ce',
    'Halo 2': 'halo-2',
  });
  assert.deepEqual(found.map(f => [path.basename(f.folderPath), f.identifier, f.matchedBy]).sort(), [
    ['(137)Oni - Anniversary Edition', 'oni-ae', 'loose'],
    ['(139)OutRun 2006 Coast 2 Coast', 'outrun-2006', 'loose'],
    ['(16)Banjo Kazooie Recompiled', 'banjo-kazooie-recompiled.-7z', 'loose'],
    ['(181)Silent Hill 2', 'sh2-ee', 'prefix'],
  ]);
});

test('matchInstallFolders: identifier loose match and prefix on identifiers', (t) => {
  const root = tree(tmpDir(t), { 'Banjo Kazooie Recompiled/': null, 'Perfect/': null });
  const found = disk.matchInstallFolders(root, ['BanjoKazooieRecompiled.7z', 'perfect-dark-pc-port'], {});
  assert.deepEqual(found.map(f => [f.identifier, f.matchedBy]).sort(), [
    ['BanjoKazooieRecompiled.7z', 'loose'], ['perfect-dark-pc-port', 'prefix'],
  ]);
});

test('looseKey: drops case, punctuation, spaces and archive suffixes', () => {
  assert.equal(disk.looseKey('Oni: Anniversary Edition'), disk.looseKey('oni - anniversary edition'));
  assert.equal(disk.looseKey('banjo-kazooie-recompiled.-7z'), 'banjokazooierecompiled');
  assert.equal(disk.looseKey('Pokémon Red'), 'pokemonred');
});

test('matchInstallFolders: looks inside a folder of games, not inside a game', (t) => {
  const root = tree(tmpDir(t), {
    'rohan/(137)Oni - Anniversary Edition/': null, 'rohan/desktop.ini': '',
    'Other/readme.txt': '', 'Other/Halo 2/': null,
    'rohan/deeper/Halo 2/': null,
    'SomeGame/game.exe': '', 'SomeGame/Halo 2/': null,
  });
  const found = disk.matchInstallFolders(root, ['oni-ae', 'halo-2'], { 'Oni: Anniversary Edition': 'oni-ae', 'Halo 2': 'halo-2' });
  assert.deepEqual(found.map(f => [path.relative(root, f.folderPath), f.identifier]), [
    [path.join('rohan', '(137)Oni - Anniversary Edition'), 'oni-ae'],
  ]);
  assert.equal(disk.matchInstallFolders(root, ['halo-2'], { 'Halo 2': 'halo-2' }, { nested: 2 }).length, 1);
});

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

test('findExes on Linux: its own programs first (AppImage, .x86_64, ELF binaries), else the .exe', (t) => {
  const root = tmpDir(t);
  const linux = { platform: 'linux' };
  // Perfect Dark's Linux build next to a stray Windows exe: the Linux program wins
  const pd = tree(path.join(root, 'pd'), { 'pd.x86_64': 'x', 'tool.exe': 'MZ', 'readme.txt': 'r' });
  assert.deepEqual(disk.findExes(pd, 0, linux).map(p => path.basename(p)), ['pd.x86_64']);
  // An ELF binary with no extension is a program; a library or data file isn't
  const bins = tree(path.join(root, 'bins'), { 'libSDL2-2.0.so.0': '', 'game.dat': '' });
  fs.writeFileSync(path.join(bins, 'ironwail'), ELF);
  fs.writeFileSync(path.join(bins, 'libSDL2-2.0.so.0'), ELF);
  fs.writeFileSync(path.join(bins, 'game.dat'), ELF);
  fs.writeFileSync(path.join(bins, 'LICENSE'), 'text, not ELF');
  assert.deepEqual(disk.findExes(bins, 0, linux).map(p => path.basename(p)), ['ironwail']);
  const appimage = tree(path.join(root, 'ai'), { 'dsda-doom.AppImage': '' });
  assert.deepEqual(disk.findExes(appimage, 0, linux).map(p => path.basename(p)), ['dsda-doom.AppImage']);
  // Only a Windows build: its exe, which runs through Proton
  const win = tree(path.join(root, 'win'), { 'game.exe': 'MZ' });
  assert.deepEqual(disk.findExes(win, 0, linux).map(p => path.basename(p)), ['game.exe']);
  // On Windows a Linux program is never offered
  assert.deepEqual(disk.findExes(pd, 0, { platform: 'win32' }).map(p => path.basename(p)), ['tool.exe']);
  assert.equal(disk.isLinuxProgram(path.join(root, 'missing')), false);
});

test('makeRunnable: on Linux, programs that lost their run permission get it back', { skip: process.platform === 'win32' }, (t) => {
  const root = tmpDir(t);
  const dir = tree(path.join(root, 'g'), { 'pd.x86_64': 'x', 'start.sh': '#!/bin/sh', 'data/level.dat': 'd', 'already.AppImage': '' });
  fs.writeFileSync(path.join(dir, 'bin-elf'), ELF);
  fs.chmodSync(path.join(dir, 'already.AppImage'), 0o755);
  for (const f of ['pd.x86_64', 'start.sh', 'bin-elf']) fs.chmodSync(path.join(dir, f), 0o644);
  const logs = [];
  assert.equal(disk.makeRunnable(dir, { platform: 'linux', log: (m) => logs.push(m) }), 3);
  const mode = (f) => fs.statSync(path.join(dir, f)).mode & 0o777;
  assert.deepEqual(['pd.x86_64', 'start.sh', 'bin-elf'].map(mode), [0o755, 0o755, 0o755]);
  assert.equal(mode('data/level.dat'), 0o644, 'data stays data');
  assert.match(logs[0], /Allowed 3 programs to run/);
  // A single downloaded program, and no-ops
  const single = path.join(root, 'Game.AppImage');
  fs.writeFileSync(single, '');
  fs.chmodSync(single, 0o644);
  assert.equal(disk.makeRunnable(single, { platform: 'linux' }), 1);
  assert.equal(disk.makeRunnable(dir, { platform: 'win32' }), 0);
  assert.equal(disk.makeRunnable(null, { platform: 'linux' }), 0);
  assert.equal(disk.makeRunnable(path.join(root, 'missing'), { platform: 'linux' }), 0);
});
