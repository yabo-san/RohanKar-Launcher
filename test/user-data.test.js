'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { resolveUserData, LEGACY_NAMES } = require('../src/electron/user-data');

let appData;
beforeEach(() => { appData = fs.mkdtempSync(path.join(os.tmpdir(), 'y4bo-appdata-')); });
afterEach(() => fs.rmSync(appData, { recursive: true, force: true }));

const NAME = 'y4bo-launcher';
const current = () => path.join(appData, NAME);
const seed = (name, file = 'settings.json') => {
  fs.mkdirSync(path.join(appData, name), { recursive: true });
  fs.writeFileSync(path.join(appData, name, file), '{}');
};
const resolve = () => resolveUserData({ current: current(), appData, name: NAME });

test('fresh install: the new folder', () => {
  assert.deepEqual(resolve(), { dir: current(), reason: 'fresh' });
});

test('existing rohankar-launcher data: keeps using that folder, copies and moves nothing', () => {
  seed('rohankar-launcher', 'library.db');
  fs.mkdirSync(path.join(appData, 'rohankar-launcher', 'games', 'halo'), { recursive: true });
  assert.deepEqual(resolve(), { dir: path.join(appData, 'rohankar-launcher'), reason: 'legacy' });
  assert.ok(fs.existsSync(path.join(appData, 'rohankar-launcher', 'games', 'halo')));
  assert.ok(!fs.existsSync(current()));
});

test('the "RohanKar Launcher" folder counts too, after rohankar-launcher', () => {
  seed('RohanKar Launcher');
  assert.equal(resolve().dir, path.join(appData, 'RohanKar Launcher'));
  seed('rohankar-launcher');
  assert.equal(resolve().dir, path.join(appData, 'rohankar-launcher'));
  assert.deepEqual(LEGACY_NAMES, ['rohankar-launcher', 'RohanKar Launcher']);
});

test('data already in the new folder wins over an old one', () => {
  seed('rohankar-launcher');
  seed(NAME, 'library.db');
  assert.deepEqual(resolve(), { dir: current(), reason: 'current' });
});

test('an old folder holding only Chromium files is not launcher data', () => {
  fs.mkdirSync(path.join(appData, 'rohankar-launcher', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'rohankar-launcher', 'Local State'), '{}');
  assert.equal(resolve().reason, 'fresh');
});

test('an explicit userData (app.setPath, --user-data-dir) is left alone', () => {
  seed('rohankar-launcher');
  const other = path.join(appData, 'e2e-user-data');
  assert.deepEqual(resolveUserData({ current: other, appData, name: NAME }), { dir: other, reason: 'override' });
});

test('resolveDataDir: launcher data in y4bo-data beside the executable wins; defaultDir is the usual folder', () => {
  const { resolveDataDir } = require('../src/electron/user-data');
  const exeDir = path.join(appData, 'Apps', 'y4bo');
  const args = { current: current(), appData, name: NAME, exeDir };
  assert.deepEqual(resolveDataDir(args), { dir: current(), reason: 'fresh', defaultDir: current() });
  fs.mkdirSync(path.join(exeDir, 'y4bo-data'), { recursive: true });
  assert.equal(resolveDataDir(args).reason, 'fresh', 'an empty y4bo-data is not portable');
  seed(path.join('Apps', 'y4bo', 'y4bo-data'), 'library.db');
  assert.deepEqual(resolveDataDir(args), { dir: path.join(exeDir, 'y4bo-data'), reason: 'portable', defaultDir: current() });
  assert.equal(resolveDataDir({ ...args, exeDir: null }).reason, 'fresh', 'not packaged: never portable');
});
