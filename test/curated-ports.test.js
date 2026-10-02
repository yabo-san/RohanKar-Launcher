'use strict';
// scripts/curated-ports.js: building the catalog from the list's repositories, the extras and our metadata
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../scripts/curated-ports');

const doc = (repository, docName, section) => ({ source: 'github', repository, docName, section });

test('full metadata is used as it is, the list adds the section and "curated"', () => {
  const { apps, withMeta } = build([doc('a/banjo', 'Banjo Recomp', 'recomp port')], [], {
    'a/banjo': { name: 'Banjo-Kazooie', folderName: 'Banjo', tags: ['n64'] },
  });
  assert.deepEqual(apps, [{ name: 'Banjo-Kazooie', folderName: 'Banjo', tags: ['n64', 'recomp port', 'curated'], repository: 'a/banjo' }]);
  assert.equal(withMeta, 1);
});

test('metadata with only some fields goes on top of the minimal entry from the list', () => {
  const { apps } = build([doc('snesrev/zelda3', 'Zelda3', 'decomp port')], [], { 'snesrev/zelda3': { releaseAssetFilter: 'zelda3_' } });
  assert.deepEqual(apps, [{ name: 'Zelda3', repository: 'snesrev/zelda3', folderName: 'Zelda3', tags: ['decomp port', 'curated'], releaseAssetFilter: 'zelda3_' }]);
});

test("a metadata section replaces the list's section and stays out of the entry", () => {
  const { apps } = build([doc('x/hero', 'Bomberman Hero', 'recomp port'), doc('x/sa2', 'SA2', 'decomp port')], [], {
    'x/hero': { name: 'Bomberman Hero', folderName: 'BMHero', tags: ['n64'], section: 'source only' },
    'x/sa2': { section: 'source only' },
  });
  assert.deepEqual(apps.map(a => [a.name, a.tags]), [['Bomberman Hero', ['n64', 'source only', 'curated']], ['SA2', ['source only', 'curated']]]);
  assert.equal(apps.some(a => 'section' in a), false);
});

test('extras are owner picks, and one can replace a list entry', () => {
  const { apps } = build([doc('n64decomp/sm64', 'SM64 Decomp', 'source only')], [
    { name: 'SM64 Builds', repository: 'someone/sm64-builds', section: 'decomp port', replaces: 'n64decomp/sm64', releaseAssetFilter: 'win' },
  ], {});
  assert.deepEqual(apps, [{ name: 'SM64 Builds', repository: 'someone/sm64-builds', folderName: 'SM64Builds', releaseAssetFilter: 'win', tags: ['decomp port', 'owner pick'] }]);
});
