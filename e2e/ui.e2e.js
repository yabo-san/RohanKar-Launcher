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
 * - Home's rows have no scrollbar; they scroll with the header arrows, a drag and
 *   the Left/Right keys, and a drag doesn't open a card.
 * - New leads with the featured picks (a wall game and a port), then a
 *   compact list of the latest uploads, newest first.
 * - Settings imports a Quiver library (apps.json + Apps/) without downloading.
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

test('New leads with the picks, then the latest uploads newest first', async () => {
  await page.locator('[data-view="new"]').click();
  await expect(page.locator('#heading')).toHaveText('New');
  // featured.json: Halo, an item not on the wall (skipped), Banjo from the Nintendo list
  const features = page.locator('#body .feature-card');
  await expect(features).toHaveCount(2);
  await expect(features.nth(0).locator('.title')).toHaveText('Halo: Combat Evolved');
  await expect(features.nth(0).locator('.eyebrow')).toHaveText('y4bo pick');
  await expect(features.nth(0).locator('p')).toHaveText('The one that started it all.');
  await expect(features.nth(1).locator('.title')).toHaveText('Banjo-Kazooie');
  await expect(features.nth(1).locator('.eyebrow')).toHaveText('y4bo pick · port');

  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  const items = page.locator('#body .list-item');
  await expect(items).toHaveCount(new Set(docs.map(d => titleKey(d))).size);
  const dates = await items.locator('.sub').evaluateAll(els => els.map(e => e.textContent.match(/\d{4}-\d{2}-\d{2}/)?.[0] || ''));
  expect(dates).toEqual([...dates].sort().reverse());

  await items.first().click();
  await expect(page.locator('#detail')).not.toHaveClass(/hidden/);
  await page.keyboard.press('Escape');
  await features.nth(1).click();
  await expect(page.locator('#detail')).toContainText('Banjo');
  await page.keyboard.press('Escape');
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

test('Right-click menu on a port card: installed actions, Launch Options submenu, Escape closes', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Test ports' }).click();
  const card = page.locator('.port-card', { hasText: 'Perfect Dark' });
  await card.click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi')).toHaveText(['Launch', 'Open Folder', 'Launch Options›', 'Remove from Library', 'Game Data…', 'About›', 'Delete']);
  await menu.locator('.has-sub', { hasText: 'Launch Options' }).hover();
  await expect(menu.locator('[data-menu="choose-exe"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Not installed: Download and Locate Existing Install
  await page.locator('#nav-shelves .navitem', { hasText: 'Nintendo' }).click();
  await page.locator('.port-card', { hasText: 'Mario Kart 64' }).click({ button: 'right' });
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi').first()).toHaveText('Download');
  await expect(menu.locator('[data-menu="locate"]')).toBeVisible();
  await menu.locator('.has-sub', { hasText: 'About' }).hover();
  await menu.locator('[data-menu="details"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#detail')).toContainText('Mario Kart 64');
  await page.keyboard.press('Escape');
});

test("The wall's library header sorts, searches, lists and pages, after Cider's", async () => {
  await page.locator('[data-view="wall"]').click();
  const titles = () => page.locator('#body .game-card .title').allInnerTexts();
  const header = page.locator('.album-header');

  await header.locator('[data-pref="sort"]').selectOption('name');
  await header.locator('[data-pref="order"]').selectOption('asc');
  const asc = await titles();
  expect(asc).toEqual([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  await header.locator('[data-pref="order"]').selectOption('desc');
  expect(await titles()).toEqual([...asc].reverse());

  // Punctuation is ignored, as in Cider's library search; focus stays in the box
  await page.locator('#lib-search').fill('zoo-tycoon');
  await expect(page.locator('#body .game-card')).toHaveCount(1);
  await expect(page.locator('#lib-search')).toBeFocused();
  await page.locator('#lib-search').fill('');

  await header.locator('[data-pref="viewAs"]').selectOption('list');
  await expect(page.locator('#body .list-row').first()).toBeVisible();
  await expect(page.locator('#body .game-card')).toHaveCount(0);
  await header.locator('[data-pref="viewAs"]').selectOption('covers');

  await header.locator('[data-pref="scroll"]').selectOption('paged');
  await expect(header.locator('.pagination-container')).toBeVisible();
  await expect(header.locator('.md-input-number')).toContainText('/ 1');
  await header.locator('[data-pref="scroll"]').selectOption('infinite');
  await header.locator('[data-pref="sort"]').selectOption('dateAdded');
});

test('Sidebar groups fold and stay folded', async () => {
  await page.locator('[data-collapse="uploaders"]').click();
  await expect(page.locator('#nav-uploaders')).toBeHidden();
  await page.reload();
  await expect(page.locator('#nav-uploaders')).toBeHidden();
  await page.locator('[data-collapse="uploaders"]').click();
  await expect(page.locator('#nav-uploaders')).toBeVisible();
});

test('Game data: add a GitHub repo, browse an archive.org item, pick a file and a folder, preview, save', async () => {
  await page.locator('#nav-add-repo').click();
  await expect(page.locator('#heading')).toHaveText('Add a GitHub repo');
  await page.locator('#ed-repo').fill('someone/banjo-fork');
  await page.locator('#ed-name').fill('Banjo Fork');

  // Browse the item: bookkeeping files are hidden, folders come first
  await page.locator('[data-src="0"][data-key="ia"]').fill('rk-e2e-romset');
  await page.locator('[data-action="ed-browse"]').click();
  await expect(page.locator('#browse-list .pick')).toHaveCount(6);
  await expect(page.locator('#browse-list')).not.toContainText('_meta.xml');
  await page.locator('#ed-filter').fill('banjo');
  await expect(page.locator('#browse-list .pick')).toHaveCount(1);
  await page.locator('#browse-list .pick').click();
  await expect(page.locator('[data-src="0"][data-key="path"]')).toHaveValue('Nintendo 64/Banjo-Kazooie (USA).z64');
  await expect(page.locator('[data-src="0"][data-key="sha1"]')).toHaveValue('1fe1632098865f639e22c11b9a81ee8f29c75d7a');

  // A second source: a whole folder into textures/
  await page.locator('[data-action="ed-add-source"]').click();
  await page.locator('[data-src="1"][data-key="ia"]').fill('rk-e2e-romset');
  await page.locator('[data-action="ed-browse"][data-i="1"]').click();
  await page.locator('#browse-list .pick[data-path="Nintendo 64/Textures/*"]').click();
  await page.locator('[data-src="1"][data-key="target"]').fill('textures');
  await page.locator('[data-action="ed-preview"]').click();
  await expect(page.locator('#ed-preview')).toContainText('Nintendo 64/Textures/bk-hd.png → textures/bk-hd.png');
  await expect(page.locator('#ed-preview')).toContainText('16 MB');

  await page.locator('#btn-save-collision').click();
  await expect(page.locator('#detail')).toContainText('Banjo Fork');
  await page.keyboard.press('Escape');
  const saved = JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'catalogs', 'collisions.local.json'), 'utf8'));
  expect(saved).toEqual([{
    repository: 'someone/banjo-fork', name: 'Banjo Fork',
    sources: [
      { ia: 'rk-e2e-romset', path: 'Nintendo 64/Banjo-Kazooie (USA).z64', sha1: '1fe1632098865f639e22c11b9a81ee8f29c75d7a' },
      { ia: 'rk-e2e-romset', path: 'Nintendo 64/Textures/*', target: 'textures' },
    ],
  }]);
  await expect(page.locator('#nav-shelves .navitem', { hasText: 'Your ports' })).toBeVisible();

  // A bad entry names its problems instead of saving
  await page.locator('#nav-shelves .navitem', { hasText: 'Your ports' }).click();
  await page.locator('.port-card', { hasText: 'Banjo Fork' }).click({ button: 'right' });
  await page.locator('#ctxmenu [data-menu="collision"]').click();
  await page.locator('[data-src="0"][data-key="target"]').fill('../escape');
  await page.locator('#btn-save-collision').click();
  await expect(page.locator('.editor .notice')).toContainText('sources[0].target must be a relative folder');
});

test('Settings imports a Quiver library: preview, import, then the library and Your ports show it', async () => {
  const root = path.join(stack.dataDir, 'quiver');
  const put = (rel, text = 'MZ') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('apps.json', JSON.stringify({ apps: [
    { name: 'Perfect Dark', folderName: 'PerfectDark', repository: 'perfect-dark-pc-port/perfect_dark' },
    { name: 'Obscure Port', folderName: 'ObscurePort', repository: 'someone/obscure-port' },
    { name: 'Homebrew Thing', folderName: 'Homebrew', tags: ['manual'] },
  ] }));
  put('Apps/Homebrew/thing.exe');
  await page.evaluate((dir) => { api.chooseFolder = async () => dir; }, root);

  await page.locator('#btn-settings').click();
  const field = page.locator('#quiver-import');
  await field.locator('[data-action="quiver-import-choose"]').click();
  await expect(field.locator('.import-list li')).toHaveCount(3);
  await expect(field.locator('.import-list li', { hasText: 'Perfect Dark' })).toContainText('already here');
  await expect(field.locator('.import-list li', { hasText: 'Homebrew Thing' })).toContainText('your folder · installed');
  await field.locator('[data-action="quiver-import-apply"]').click();
  await expect(field.locator('.import-done')).toContainText('1 adopted, 1 added, 1 new on Your ports, 1 already here');
  await field.locator('[data-action="quiver-import-cancel"]').click();

  await expect(page.locator('#nav-shelves .navitem', { hasText: 'Your ports' })).toBeVisible();
  await page.locator('[data-view="library"]').click();
  const card = page.locator('.game-card', { hasText: 'Homebrew Thing' });
  await expect(card).toContainText('Your folder');
  await card.click();
  await expect(page.locator('#detail .by')).toHaveText('Your folder');
  await expect(page.locator('#detail #btn-play')).toBeVisible();
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
