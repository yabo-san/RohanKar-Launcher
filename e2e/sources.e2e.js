'use strict';
/**
 * End-to-end: launch the app with a seeded settings.json holding the sources
 * list, then check that disabled (#) lines are never queried and every active
 * uploader's games make it into the library.
 *
 * Fixture mode (default) serves archive.org from fixtures/search.json.
 * Live mode (E2E_LIVE=1) hits the real archive.org; E2E_SOURCES can override
 * the list (the nightly job feeds it from a repo secret).
 */

const { test, expect, _electron: electron } = require('@playwright/test');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { parseSources, formatSources } = require('../src/renderer/sources.js');

const LIVE      = process.env.E2E_LIVE === '1';
const LIST_TEXT = process.env.E2E_SOURCES || fs.readFileSync(path.join(__dirname, 'sources.txt'), 'utf8');
const SOURCES   = parseSources(LIST_TEXT);
const ACTIVE    = SOURCES.filter(s => s.enabled);
const DISABLED  = SOURCES.filter(s => !s.enabled);

let app, page, userData;

// One JSON line per archive.org response, written by main.js
function searchedUploaders() {
  const log = path.join(userData, 'archive-net.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.kind === 'search')
    .map(e => /uploader:(\S+)/.exec(new URL(e.url).searchParams.get('q'))?.[1]);
}

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-e2e-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ sources: SOURCES }, null, 2));

  app = await electron.launch({
    args: ['-r', path.join(__dirname, 'archive-stub.js'), path.join(__dirname, '..'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env:  { ...process.env, E2E_USER_DATA: userData },
  });
  page = await app.firstWindow();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer] ${m.text()}`); });

  // fetchGames goes one source at a time; done when the skeletons are replaced
  await expect(page.locator('#library-grid .skeleton-card')).toHaveCount(0, { timeout: LIVE ? 180_000 : 30_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (userData) fs.rmSync(userData, { recursive: true, force: true });
});

test('settings shows the seeded list, # lines kept as disabled', async () => {
  expect(ACTIVE.length).toBeGreaterThan(0);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#setting-sources')).toHaveValue(formatSources(SOURCES));
  await page.keyboard.press('Escape');
});

test('only active sources are queried, disabled lines never are', async () => {
  await expect.poll(() => new Set(searchedUploaders()).size).toBe(ACTIVE.length);
  const queried = new Set(searchedUploaders());
  expect([...queried].sort()).toEqual(ACTIVE.map(s => s.uploader).sort());
  for (const s of DISABLED) expect(queried.has(s.uploader)).toBe(false);
});

test('every active source loads its game list', async () => {
  await expect(page.locator('#library-grid .loading-msg.error')).toHaveCount(0);
  const perSource = await page.evaluate(() =>
    allVersions.reduce((acc, g) => ({ ...acc, [g._sourceLabel]: (acc[g._sourceLabel] || 0) + 1 }), {}));
  for (const s of ACTIVE) expect(perSource[s.label], `games from ${s.label}`).toBeGreaterThan(0);
  for (const s of DISABLED) expect(perSource[s.label]).toBeUndefined();

  // One card per title group, not per upload
  const groups = await page.evaluate(() => allGames.length);
  await expect(page.locator('#library-grid .game-card')).toHaveCount(groups);
});

test('fixtures: the same game from two uploaders is one card with both versions', async () => {
  test.skip(LIVE || !!process.env.E2E_SOURCES, 'needs e2e/sources.txt and the fixtures');
  const zoo = await page.evaluate(() =>
    allGames.find(g => g.identifier === 'rk-e2e-zoo-tycoon')?._versions.map(v => v._sourceLabel));
  expect(zoo).toEqual(['rohanjackson071', 'pstriple']);
  await expect(page.locator('#library-grid .game-card')).toHaveCount(6);
});
