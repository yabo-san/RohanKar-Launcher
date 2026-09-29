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
 * - Home's rows have no scrollbar; they scroll with the header arrows, a drag and
 *   the Left/Right keys, and a drag doesn't open a card.
 * - The Settings toggle switches to the classic UI and back, and is saved.
 *
 * archive.org and the Quiver lists are served by fixture-server.js.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { sourcesFromCatalog, titleKey } = require('../src/backend/sources.js');
const { startStack } = require('./fixture-server');
const fixtures = require('./fixtures/search.json');

const ENABLED = sourcesFromCatalog(require('../catalog/uploaders.json')).filter(s => s.enabled);

test.describe.configure({ mode: 'serial' });

let stack, page;

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, {
    page: 'new/index.html',
    catalogs: [{ file: 'Nintendo.json', shelf: 'Nintendo' }, { file: 'Xbox.json', shelf: 'Xbox' }],
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

test("Home's rows scroll without a scrollbar", async () => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.locator('[data-view="home"]').click();
  const section = page.locator('#body .section.has-row').first();
  const row = section.locator('.row');
  const prev = section.locator('.row-nav .prev');
  const next = section.locator('.row-nav .next');
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  expect(await row.evaluate(r => r.offsetHeight - r.clientHeight)).toBe(0);
  const left = () => row.evaluate(r => r.scrollLeft);

  await next.click();
  await expect.poll(left).toBeGreaterThan(0);
  await expect(prev).toBeEnabled();
  await prev.click();
  await expect.poll(left).toBe(0);

  const box = await row.boundingBox();
  await page.mouse.move(box.x + 300, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100, { steps: 5 });
  await page.mouse.up();
  expect(await left()).toBe(200);
  await expect(page.locator('#detail')).toHaveClass(/hidden/);

  await row.locator('.card').first().focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(row.locator('.card').nth(5)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row.locator('.card').nth(4)).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
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
