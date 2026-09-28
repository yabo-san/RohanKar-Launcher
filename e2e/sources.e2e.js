'use strict';
/**
 * End-to-end: launch the app the way a user gets it and check the sources.
 *
 * - Fresh install (no `sources` in settings.json): the shipped DEFAULT_SOURCES
 *   are the ones queried, and each of them loads its games.
 * - Saved list with a # line: the disabled uploader is never queried.
 *
 * Fixture mode (default) serves archive.org from fixtures/search.json.
 * Live mode (E2E_LIVE=1) hits the real archive.org.
 */

const { test, expect, _electron: electron } = require('@playwright/test');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { DEFAULT_SOURCES, formatSources } = require('../src/renderer/sources.js');

const LIVE = process.env.E2E_LIVE === '1';

test.describe.configure({ mode: 'serial' });

// Starts the app on a fresh userData dir holding `settings`
async function launch(settings) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-e2e-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings, null, 2));

  const app = await electron.launch({
    args: ['-r', path.join(__dirname, 'archive-stub.js'), path.join(__dirname, '..'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env:  { ...process.env, E2E_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer] ${m.text()}`); });

  // fetchGames goes one source at a time; done once the grid holds cards or a
  // message. (An empty grid isn't enough: that's also the state before init runs.)
  await page.locator('#library-grid .game-card, #library-grid .loading-msg').first()
    .waitFor({ timeout: LIVE ? 180_000 : 30_000 });

  const close = async () => {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  };
  return { app, page, userData, close };
}

// Uploaders searched so far, from main.js's one-JSON-line-per-response log
function searchedUploaders(userData) {
  const log = path.join(userData, 'archive-net.log');
  if (!fs.existsSync(log)) return [];
  return [...new Set(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.kind === 'search')
    .map(e => /uploader:(\S+)/.exec(new URL(e.url).searchParams.get('q'))?.[1]))];
}

test.describe('fresh install uses the shipped sources', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launch({}); });
  test.afterAll(async () => { await ctx?.close(); });

  test('settings lists the shipped sources', async () => {
    await ctx.page.locator('#btn-settings').click();
    await expect(ctx.page.locator('#setting-sources')).toHaveValue(formatSources(DEFAULT_SOURCES));
    await ctx.page.keyboard.press('Escape');
  });

  test('each shipped source is queried and loads its games', async () => {
    const expected = DEFAULT_SOURCES.filter(s => s.enabled !== false);
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

  test('fixtures: the same game from two uploaders is one card with both versions', async () => {
    test.skip(LIVE, 'fixture data only');
    const zoo = await ctx.page.evaluate(() =>
      allGames.find(g => g.identifier === 'rk-e2e-zoo-tycoon')?._versions.map(v => v._sourceLabel));
    expect(zoo).toEqual(['rohanjackson071', 'pstriple']);
    await expect(ctx.page.locator('#library-grid .game-card')).toHaveCount(6);
  });
});

test.describe('a # line in the saved list is skipped', () => {
  const disabled = { uploader: 'disabled-uploader@example.invalid', label: 'disabled', enabled: false };
  let ctx;
  test.beforeAll(async () => { ctx = await launch({ sources: [DEFAULT_SOURCES[0], disabled] }); });
  test.afterAll(async () => { await ctx?.close(); });

  test('only the enabled source is queried', async () => {
    await ctx.page.locator('#btn-settings').click();
    await expect(ctx.page.locator('#setting-sources')).toHaveValue(formatSources([DEFAULT_SOURCES[0], disabled]));
    await ctx.page.keyboard.press('Escape');

    await expect.poll(() => searchedUploaders(ctx.userData).length).toBe(1);
    expect(searchedUploaders(ctx.userData)).toEqual([DEFAULT_SOURCES[0].uploader]);
    const labels = await ctx.page.evaluate(() => [...new Set(allVersions.map(g => g._sourceLabel))]);
    expect(labels).toEqual([DEFAULT_SOURCES[0].label]);
  });
});
