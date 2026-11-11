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

const PICKS = [
  ['GoldenEye 007', 'murkantor/Project-Midas'],
  ['Perfect Dark', 'perfect-dark-pc-port/perfect_dark'],
  ['Star Fox 64', 'sonicdcer/Starfox64Recomp'],
  ['Doom Retro', 'bradharding/doomretro'],
  ['DSDA-Doom', 'kraflab/dsda-doom'],
  ['Doom Launcher', 'nstlaurent/DoomLauncher'],
  ['Quake (ironwail)', 'andrei-drexler/ironwail'],
  ['QuakeInjector', 'hrehfeld/QuakeInjector'],
  ['Diablo (DevilutionX)', 'diasurgical/devilutionx'],
];

test('the shelf is the personal picks, in order', () => {
  assert.deepEqual(catalog.apps.map((a) => [a.name, a.repository]), PICKS);
  assert.ok(catalog.apps.every((a) => !a.more), 'no entry hides behind More ports');
});

// Each pick's filter against its latest release's real file names (checked 2026-11-11)
const RELEASES = {
  'bradharding/doomretro': [['doomretro-6.3-win64.zip'], 'doomretro-6.3-win64.zip'],
  'kraflab/dsda-doom': [['dsda-doom-0.29.4-linux-x86_64.appimage', 'dsda-doom-0.29.4-mac-arm64.zip',
    'dsda-doom-0.29.4-mac-x86_64.zip', 'dsda-doom-0.29.4-win-x64.zip'], 'dsda-doom-0.29.4-win-x64.zip'],
  'nstlaurent/DoomLauncher': [['DoomLauncher_3.8.2.0.zip', 'DoomLauncher_3.8.2.0_install.zip'], 'DoomLauncher_3.8.2.0.zip'],
  'andrei-drexler/ironwail': [['ironwail-0.8.2-linux-x64.tar.gz', 'ironwail-0.8.2-win32.zip', 'ironwail-0.8.2-win64.zip'],
    'ironwail-0.8.2-win64.zip'],
  'hrehfeld/QuakeInjector': [['QuakeInjector-alpha08.zip', 'QuakeInjector.exe-alpha08.zip'], 'QuakeInjector.exe-alpha08.zip'],
  'diasurgical/devilutionx': [['devilutionx-android.apk', 'devilutionx-linux-x86_64.appimage', 'devilutionx-macOS-universal.dmg',
    'devilutionx-ps4.pkg', 'devilutionx-src.tar.xz', 'devilutionx-windows-i386.zip', 'devilutionx-windows-x86_64.zip'],
  'devilutionx-windows-x86_64.zip'],
};

test('each Doom, Quake and Diablo pick takes its Windows build', () => {
  const { pickAsset } = require('../src/backend/ports');
  for (const [repo, [names, want]] of Object.entries(RELEASES)) {
    const entry = catalog.apps.find((a) => a.repository === repo);
    const assets = names.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }));
    assert.equal(pickAsset(assets, { filter: entry.releaseAssetFilter }).asset?.name, want, repo);
  }
});

test('Project Midas picks its Windows .7z over the Linux and Steam Deck builds', () => {
  const { pickAsset } = require('../src/backend/ports');
  const midas = catalog.apps.find((a) => a.repository === 'murkantor/Project-Midas');
  // the v1.0 release's files
  const assets = ['ProjectMidas-v1-linux.7z', 'ProjectMidas-v1-steamdeck.7z', 'ProjectMidas-v1-windows.7z']
    .map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }));
  assert.equal(pickAsset(assets, { filter: midas.releaseAssetFilter }).asset.name, 'ProjectMidas-v1-windows.7z');
});
