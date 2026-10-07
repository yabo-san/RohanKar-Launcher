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
