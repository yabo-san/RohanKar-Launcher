'use strict';
/**
 * End-to-end for admin mode (docs/ADMIN.md), the owner's console: pick a ROM
 * from an archive.org set (N64TOSEC's shape: one zip per ROM), pick a GitHub
 * release, save, and a game tile appears that installs in one click.
 *
 * The backend runs with --admin on a copy of the fixture collisions, so saving
 * writes that copy, as it writes catalog/collisions.json in a checkout.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { startStack } = require('./fixture-server');
const { PD_ROM } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

let stack, page;

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, { page: 'new/index.html', admin: true });
  page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log(`[frontend] ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.goto(stack.pageUrl);
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

test('admin: pick a TOSEC ROM and a release, save, and the tile installs in one click', async () => {
  await page.locator('#nav-new-tile').click();
  await expect(page.locator('#heading')).toHaveText('New game tile');
  await expect(page.locator('.editor .lede')).toContainText('Admin mode');

  await page.locator('#ed-repo').fill('rk-e2e/tile-port');
  await page.locator('#ed-name').fill('Tile Port');
  await page.locator('#btn-pick-release').click();
  await page.locator('#release-list .pick', { hasText: 'tile-v1.2.0-x86_64-windows.zip' }).click();
  await expect(page.locator('#ed-asset')).toHaveValue('(?i)^tile-.+-x86_64-windows\\.zip$');
  await expect(page.locator('#release-list')).toContainText('The pattern picks tile-v1.2.0-x86_64-windows.zip from v1.2.0');
  await page.locator('#ed-exe').fill('pd.x86_64.exe');
  await expect(page.locator('#ed-shelf')).toHaveValue('y4bo ports');

  // The ROM: search archive.org, open the set, take the USA Rev A zip, unpack it as the name the port expects
  await page.locator('#ed-search-0').fill('n64 tosec');
  await page.locator('[data-action="ed-search"]').click();
  await page.locator('#search-list .pick', { hasText: 'N64TOSEC' }).click();
  await page.locator('.browser .pick', { hasText: 'Perfect Dark (USA) (Rev A).zip' }).click();
  await page.locator('[data-src="0"][data-key="extract"]').check();
  await page.locator('[data-src="0"][data-key="target"]').fill('data');
  await page.locator('[data-src="0"][data-key="as"]').fill('pd.ntsc-final.z64');
  await page.locator('#btn-save-collision').click();
  await expect(page.locator('.toast').last()).toContainText('Wrote Tile Port to catalog/collisions.json');

  const saved = JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'collisions.json'), 'utf8')).find(c => c.repository === 'rk-e2e/tile-port');
  expect(saved).toMatchObject({
    name: 'Tile Port', shelf: 'y4bo ports', exe: 'pd.x86_64.exe', assetPattern: '(?i)^tile-.+-x86_64-windows\\.zip$',
    sources: [{ ia: 'N64TOSEC', path: 'Perfect Dark (USA) (Rev A).zip', target: 'data', as: 'pd.ntsc-final.z64', extract: true }],
  });

  // Saving opens the new tile; it's curated, so no "Your source" note, and one click installs it
  await expect(page.locator('#detail h2')).toHaveText('Tile Port');
  await expect(page.locator('#detail')).toContainText('y4bo ports');
  await expect(page.locator('#detail .user-note')).toHaveCount(0);
  await page.locator('#btn-install-port').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const dir = path.join(stack.dataDir, 'games', 'rk-e2e.tile-port');
  expect(fs.readFileSync(path.join(dir, 'data', 'pd.ntsc-final.z64'), 'utf8')).toBe(PD_ROM);
  expect(fs.existsSync(path.join(dir, 'pd.x86_64.exe'))).toBe(true);
  const lib = await page.evaluate(() => api.getLibrary());
  const row = Object.values(lib).find(r => r.install_dir === dir);
  expect(row.exe_path).toBe(path.join(dir, 'pd.x86_64.exe'));
  await page.locator('#detail [data-close]').first().click();
  await page.locator('#nav-shelves .navitem', { hasText: 'y4bo ports' }).click();
  await expect(page.locator('.port-card', { hasText: 'Tile Port' })).toBeVisible();
});

test('admin: the collisions database lists the curated list; Hide gates a tile', async () => {
  await page.locator('#nav-admin').click();
  await expect(page.locator('#heading')).toHaveText('Collisions database');
  const row = page.locator('.admin-row', { hasText: 'rk-e2e/tile-port' });
  await expect(row).toContainText('N64TOSEC/Perfect Dark (USA) (Rev A).zip → pd.ntsc-final.z64');
  await expect(page.locator('.admin-row', { hasText: 'perfect-dark-pc-port/perfect_dark' })).toBeVisible();
  await row.locator('[data-action="admin-hide"]').click();
  await expect(row.locator('.pill')).toHaveText('Hidden');
  expect(JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'collisions.json'), 'utf8')).find(c => c.repository === 'rk-e2e/tile-port').hidden).toBe(true);
  await page.locator('#nav-shelves .navitem', { hasText: 'y4bo ports' }).click();
  await expect(page.locator('.port-card', { hasText: 'Tile Port' }).locator('.pill')).toHaveText('Hidden');
});

test('admin: a wall game\'s detail makes a tile from its archive.org item', async () => {
  await page.locator('[data-view="wall"]').first().click();
  await page.locator('.card[data-open="game"]').first().click();
  const id = await page.locator('#detail .kv a').first().textContent();
  await page.locator('#detail [data-action="admin-from-item"]').click();
  await expect(page.locator('#heading')).toHaveText('New game tile');
  await expect(page.locator('[data-src="0"][data-key="ia"]')).toHaveValue(id);
  await expect(page.locator('.browser .pick').first()).toBeVisible();
});

test('admin: in list view, a wall row makes a tile and a port row edits its collision', async () => {
  await page.locator('[data-view="wall"]').first().click();
  await page.evaluate(() => { libPrefs.wall.viewAs = 'list'; render(); }); // eslint-disable-line no-undef
  const row = page.locator('.list-row[data-open="game"]').first();
  const id = await row.getAttribute('data-id');
  await row.locator('[data-make-tile]').click();
  await expect(page.locator('#heading')).toHaveText('New game tile');
  await expect(page.locator('[data-src="0"][data-key="ia"]')).toHaveValue(id);
  await expect(page.locator('#detail.open')).toHaveCount(0);

  await page.locator('#nav-shelves .navitem', { hasText: 'y4bo ports' }).click();
  await page.evaluate(() => { libPrefs.shelf.viewAs = 'list'; render(); }); // eslint-disable-line no-undef
  await page.locator('.list-row', { hasText: 'Tile Port' }).locator('[data-edit-repo]').click();
  await expect(page.locator('#heading')).toHaveText('Game data');
  await expect(page.locator('#ed-exe')).toHaveValue('pd.x86_64.exe');
});
