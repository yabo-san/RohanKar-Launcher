'use strict';
// catalog/curated-ports.json is edited by hand: every entry must be one the app can show and
// install. The format is described in catalog/README.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'catalog', 'curated-ports.json');
const SECTIONS = ['recomp port', 'decomp port', 'work in progress', 'source only', 'engine', 'launcher'];
const FIELDS = ['name', 'repository', 'repositorySource', 'folderName', 'releaseAssetFilter', 'appIconUrl', 'description', 'tags', 'filesToAdd', 'more'];

const catalog = JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('the shelf is a Quiver-style catalog with apps', () => {
  assert.equal(typeof catalog.name, 'string');
  assert.ok(Array.isArray(catalog.apps) && catalog.apps.length > 0);
});

test('every entry has a name, an owner/repo, a folder and known fields only', () => {
  for (const a of catalog.apps) {
    const at = a.name || JSON.stringify(a);
    assert.ok(typeof a.name === 'string' && a.name.trim(), `${at}: name`);
    assert.match(a.repository, /^[^/\s]+(\/[^/\s]+)+$/, `${at}: repository is owner/repo`);
    if (a.repositorySource !== 'gitlab') assert.match(a.repository, /^[^/\s]+\/[^/\s]+$/, `${at}: a GitHub repository is owner/repo`);
    assert.ok(a.repositorySource === undefined || a.repositorySource === 'gitlab', `${at}: repositorySource is "gitlab" or left out`);
    assert.match(a.folderName, /^[A-Za-z0-9._-]+$/, `${at}: folderName`);
    for (const k of ['releaseAssetFilter', 'appIconUrl', 'description']) {
      if (k in a) assert.ok(typeof a[k] === 'string' && a[k].trim(), `${at}: ${k} is a non-empty string`);
    }
    if ('appIconUrl' in a) assert.match(a.appIconUrl, /^https:\/\//, `${at}: appIconUrl is https`);
    if ('more' in a) assert.equal(a.more, true, `${at}: more is true or left out`);
    if ('filesToAdd' in a) assert.ok(Array.isArray(a.filesToAdd), `${at}: filesToAdd is a list`);
    for (const k of Object.keys(a)) assert.ok(FIELDS.includes(k), `${at}: unknown field "${k}"`);
  }
});

test('every entry has exactly one section tag', () => {
  for (const a of catalog.apps) {
    assert.ok(Array.isArray(a.tags), `${a.name}: tags`);
    const sections = a.tags.filter((t) => SECTIONS.includes(t));
    assert.equal(sections.length, 1, `${a.name}: one of ${SECTIONS.join(', ')} (has ${sections.join(', ') || 'none'})`);
  }
});

test('no repository or folder is listed twice', () => {
  const repos = catalog.apps.map((a) => `${a.repositorySource || 'github'}:${a.repository.toLowerCase()}`);
  const folders = catalog.apps.map((a) => a.folderName.toLowerCase());
  assert.deepEqual(repos.filter((r, i) => repos.indexOf(r) !== i), []);
  assert.deepEqual(folders.filter((f, i) => folders.indexOf(f) !== i), []);
});

test('the shelf is the personal picks: GoldenEye 007 (Project Midas), Perfect Dark, Star Fox 64', () => {
  assert.deepEqual(catalog.apps.map((a) => a.name), ['GoldenEye 007', 'Perfect Dark', 'Star Fox 64']);
  assert.deepEqual(catalog.apps.map((a) => a.repository),
    ['murkantor/Project-Midas', 'perfect-dark-pc-port/perfect_dark', 'sonicdcer/Starfox64Recomp']);
  assert.ok(catalog.apps.every((a) => !a.more), 'no entry hides behind More ports');
});

test('Project Midas picks its Windows .7z over the Linux and Steam Deck builds', () => {
  const { pickAsset } = require('../src/backend/ports');
  const midas = catalog.apps.find((a) => a.repository === 'murkantor/Project-Midas');
  // the v1.0 release's files
  const assets = ['ProjectMidas-v1-linux.7z', 'ProjectMidas-v1-steamdeck.7z', 'ProjectMidas-v1-windows.7z']
    .map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }));
  assert.equal(pickAsset(assets, { filter: midas.releaseAssetFilter }).asset.name, 'ProjectMidas-v1-windows.7z');
});
