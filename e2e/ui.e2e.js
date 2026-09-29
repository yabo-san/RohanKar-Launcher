'use strict';
/**
 * End-to-end for the new UI (src/frontend/new/), the default in the app, in
 * a plain browser against the standalone backend.
 *
 * - The wall holds the shipped uploaders' games, grouped by title.
 * - A Ports shelf comes from a Quiver list, joined to the bundled
 *   collisions.json; a list that can't be fetched shows as unreachable.
 * - Add puts a port in the library and Remove takes it out.
 * - Install downloads, extracts and registers an archive.org game.
 * - A port installs: the Windows build from its GitHub release, then its game
 *   data from archive.org, staged and sha1-checked (Perfect Dark).
 * - The Settings toggle switches to the classic UI and back, and is saved.
 *
 * archive.org and the Quiver lists are served by fixture-server.js.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { sourcesFromCatalog, titleKey } = require('../src/backend/sources.js');
const { startStack } = require('./fixture-server');
const { PD_ROM } = require('./fixtures');
const fixtures = require('./fixtures/search.json');

const ENABLED = sourcesFromCatalog(require('../catalog/uploaders.json')).filter(s => s.enabled);

test.describe.configure({ mode: 'serial' });

let stack, page;

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, {
    page: 'new/index.html',
    catalogs: [{ file: 'Nintendo.json', shelf: 'Nintendo' }, { file: 'Xbox.json', shelf: 'Xbox' }, { file: 'TestPorts.json', shelf: 'Test ports' }],
  });
  page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[frontend] ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.goto(stack.pageUrl);
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

test('the wall shows every shipped uploader, grouped by title', async () => {
  await expect(page.locator('.sidebar .brand')).toHaveText('y4bo');
  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  const groups = new Set(docs.map(d => titleKey(d))).size;
  await page.locator('[data-view="wall"]').click();
  await expect(page.locator('#body .game-card')).toHaveCount(groups, { timeout: 30_000 });
  for (const s of ENABLED) {
    await expect(page.locator(`#nav-uploaders [data-arg="${s.uploader}"] .n`)).toHaveText(String(fixtures[s.uploader].length));
  }
});

test('a Ports shelf comes from its Quiver list, joined to the collision catalog', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Nintendo' }).click();
  await expect(page.locator('#body .port-card')).toHaveCount(3);
  await expect(page.locator('.port-card', { hasText: 'Banjo-Kazooie' }).locator('.tag.data')).toBeVisible();
  await expect(page.locator('.port-card', { hasText: 'Mario Kart 64' }).locator('.tag.data')).toHaveCount(0);

  await page.locator('#nav-shelves .navitem', { hasText: 'Xbox' }).click();
  await expect(page.locator('#body .notice')).toContainText("Couldn't fetch the Xbox catalog");
});

test('Add puts a port in the library and Remove takes it out', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Nintendo' }).click();
  await page.locator('.port-card', { hasText: 'Banjo-Kazooie' }).click();
  await expect(page.locator('#detail-panel .srcline')).toContainText('archive.org');
  await page.locator('#detail-panel [data-toggle-port]').click();
  await expect(page.locator('#detail-panel [data-toggle-port]')).toHaveText('Remove from library');
  await page.keyboard.press('Escape');

  await page.locator('[data-view="library"]').click();
  await expect(page.locator('#body .port-card')).toHaveCount(1);
  await page.locator('#body .port-card').click();
  await page.locator('#detail-panel [data-toggle-port]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#body .port-card')).toHaveCount(0);
});

test('Install downloads, extracts and registers an archive.org game', async () => {
  await page.locator('#q').fill('Halo');
  await page.locator('.game-card', { hasText: 'Halo: Combat Evolved' }).first().click();
  await page.locator('#btn-download').click();
  await expect(page.locator('#btn-play')).toBeVisible({ timeout: 30_000 });
  const lib = await page.evaluate(() => api.getLibrary());
  expect(Object.values(lib).some(l => l.install_dir)).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('Perfect Dark installs: GitHub build, archive.org data, sha1-checked', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Test ports' }).click();
  await page.locator('.port-card', { hasText: 'Perfect Dark' }).click();
  await page.locator('#btn-install-port').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const dir = path.join(stack.dataDir, 'games', 'PerfectDark-PerfectDarkPCPort');
  expect(fs.readFileSync(path.join(dir, 'data', 'pd.ntsc-final.z64'), 'utf8')).toBe(PD_ROM);
  expect(fs.existsSync(path.join(dir, 'pd.exe'))).toBe(true);
  await expect(page.locator('#detail')).toContainText(`Installed to ${dir}`);
  await page.keyboard.press('Escape');
});

test('Settings switches to the classic UI and back, and remembers the choice', async () => {
  const saved = () => JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'settings.json'), 'utf8')).ui;

  await page.locator('#btn-settings').click();
  await page.locator('#btn-classic-ui').click();
  await expect(page.locator('#library-grid .game-card').first()).toBeVisible({ timeout: 30_000 });
  expect(saved()).toBe('legacy');

  await page.locator('#btn-settings').click();
  await page.locator('#btn-new-ui').click();
  await expect(page.locator('.sidebar .brand')).toHaveText('y4bo');
  expect(saved()).toBe('new');
});
