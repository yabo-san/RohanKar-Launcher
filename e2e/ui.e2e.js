'use strict';
/**
 * End-to-end for the new UI (src/ui/), the default on a fresh install.
 *
 * - The wall holds the shipped uploaders' games, grouped by title.
 * - The Nintendo shelf is built from fixtures/quiver/Nintendo.json, joined to
 *   the bundled collisions.json, and a list with no fixture shows as unreachable.
 * - Add puts a port in the library and Remove takes it out.
 * - Install downloads, extracts and registers an archive.org game.
 *
 * archive.org and raw.githubusercontent.com are served by archive-stub.js.
 */

const { test, expect, _electron: electron } = require('@playwright/test');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { DEFAULT_SOURCES, titleKey } = require('../src/renderer/sources.js');
const fixtures = require('./fixtures/search.json');

test.describe.configure({ mode: 'serial' });

let app, page, userData;

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-ui-e2e-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), '{}');
  app = await electron.launch({
    args: ['-r', path.join(__dirname, 'archive-stub.js'), path.join(__dirname, '..'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, E2E_USER_DATA: userData, RK_UI: '' },
  });
  page = await app.firstWindow();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer] ${m.text()}`); });
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

test('the wall shows every shipped uploader, grouped by title', async () => {
  const docs = DEFAULT_SOURCES.flatMap(s => fixtures[s.uploader] || []);
  const groups = new Set(docs.map(d => titleKey(d))).size;
  await page.locator('[data-view="wall"]').click();
  await expect(page.locator('#body .game-card')).toHaveCount(groups, { timeout: 30_000 });
  for (const s of DEFAULT_SOURCES) {
    await expect(page.locator(`#nav-uploaders [data-arg="${s.uploader}"] .n`)).toHaveText(String(fixtures[s.uploader].length));
  }
});

test('the Nintendo shelf comes from Quiver, joined to the collision catalog', async () => {
  await page.locator('[data-view="shelf"][data-arg="nintendo"]').click();
  await expect(page.locator('#body .port-card')).toHaveCount(3);
  await expect(page.locator('.port-card', { hasText: 'Banjo-Kazooie' }).locator('.tag.data')).toBeVisible();
  await expect(page.locator('.port-card', { hasText: 'Mario Kart 64' }).locator('.tag.needs')).toBeVisible();

  await page.locator('[data-view="shelf"][data-arg="xbox"]').click();
  await expect(page.locator('#body .notice')).toContainText("Couldn't fetch the Xbox catalog");
});

test('Add puts a port in the library and Remove takes it out', async () => {
  await page.locator('[data-view="shelf"][data-arg="nintendo"]').click();
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
  const lib = await page.evaluate(() => globalThis.electronAPI.getLibrary());
  expect(Object.values(lib).some(l => l.install_dir)).toBe(true);
});
