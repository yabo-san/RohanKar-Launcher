'use strict';
/**
 * End-to-end: the frontend in a plain browser against the standalone backend,
 * and the sources a user gets.
 *
 * - Fresh install (no `sources` in settings.json): the defaults from the bundled
 *   catalog/uploaders.json are the ones queried, and each of them loads its games.
 * - Saved list with a # line: the disabled uploader is never queried.
 *
 * archive.org is served from fixtures/search.json by fixture-server.js.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { sourcesFromCatalog } = require('../src/backend/sources.js');
const { formatSources }      = require('../src/frontend/sources.js');
const { startStack }         = require('./fixture-server');

// What a fresh install defaults to: the bundled catalog (the fixture server 404s the fetched copy)
const DEFAULT_SOURCES = sourcesFromCatalog(require('../catalog/uploaders.json'));
const ENABLED         = DEFAULT_SOURCES.filter(s => s.enabled);

test.describe.configure({ mode: 'serial' });

// Starts the backend on a fresh data dir holding `settings` and opens the frontend on it
async function launch(browser, settings) {
  const stack = await startStack(settings);
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[frontend] ${m.text()}`); });
  await page.goto(stack.pageUrl);

  // fetchGames goes one source at a time; done once the grid holds cards or a
  // message. (An empty grid isn't enough: that's also the state before init runs.)
  await page.locator('#library-grid .game-card, #library-grid .loading-msg').first()
    .waitFor({ timeout: 30_000 });

  const close = async () => {
    await page.close();
    await stack.close();
  };
  return { page, userData: stack.dataDir, close };
}

// Uploaders searched so far, from the backend's one-JSON-line-per-response net log
function searchedUploaders(userData) {
  const log = path.join(userData, 'archive-net.log');
  if (!fs.existsSync(log)) return [];
  return [...new Set(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.kind === 'search')
    .map(e => /uploader:(\S+)/.exec(new URL(e.url).searchParams.get('q'))?.[1]))];
}

test.describe('fresh install uses the shipped sources', () => {
  let ctx;
  test.beforeAll(async ({ browser }) => { ctx = await launch(browser, {}); });
  test.afterAll(async () => { await ctx?.close(); });

  test('settings lists the shipped sources', async () => {
    await ctx.page.locator('#btn-settings').click();
    await expect(ctx.page.locator('#setting-sources')).toHaveValue(formatSources(DEFAULT_SOURCES));
    await ctx.page.keyboard.press('Escape');
  });

  test('each shipped source is queried and loads its games', async () => {
    const expected = ENABLED;
    await expect.poll(() => searchedUploaders(ctx.userData).length).toBe(expected.length);
    expect(searchedUploaders(ctx.userData).sort()).toEqual(expected.map(s => s.uploader).sort());

    await expect(ctx.page.locator('#library-grid .loading-msg.error')).toHaveCount(0);
    const perSource = await ctx.page.evaluate(() =>
      allVersions.reduce((acc, g) => ({ ...acc, [g._sourceLabel]: (acc[g._sourceLabel] || 0) + 1 }), {}));
    for (const s of expected) expect(perSource[s.label], `games from ${s.label}`).toBeGreaterThan(0);

    // One card per title group, not per upload
    const groups = await ctx.page.evaluate(() => allGames.length);
    await expect(ctx.page.locator('#library-grid .game-card')).toHaveCount(groups);
  });

  test('the same game from two uploaders is one card with both versions', async () => {
    const zoo = await ctx.page.evaluate(() =>
      allGames.find(g => g.identifier === 'rk-e2e-zoo-tycoon')?._versions.map(v => v._sourceLabel));
    expect(zoo).toEqual(['rohanjackson071', 'hailstormttv']);
    await expect(ctx.page.locator('#library-grid .game-card')).toHaveCount(6);
  });
});

test.describe('a # line in the saved list is skipped', () => {
  const disabled = { uploader: 'disabled-uploader@example.invalid', label: 'disabled', enabled: false };
  let ctx;
  test.beforeAll(async ({ browser }) => { ctx = await launch(browser, { sources: [ENABLED[0], disabled] }); });
  test.afterAll(async () => { await ctx?.close(); });

  test('only the enabled source is queried', async () => {
    await ctx.page.locator('#btn-settings').click();
    await expect(ctx.page.locator('#setting-sources')).toHaveValue(formatSources([ENABLED[0], disabled]));
    await ctx.page.keyboard.press('Escape');

    await expect.poll(() => searchedUploaders(ctx.userData).length).toBe(1);
    expect(searchedUploaders(ctx.userData)).toEqual([ENABLED[0].uploader]);
    const labels = await ctx.page.evaluate(() => [...new Set(allVersions.map(g => g._sourceLabel))]);
    expect(labels).toEqual([ENABLED[0].label]);
  });
});
