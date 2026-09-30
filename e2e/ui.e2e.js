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
 * - The announcement from announcement.json shows until dismissed.
 * - Your own app: a folder the library makes, fills and launches.
 * - Additional sources: the Settings toggle asks in a modal every time it goes
 *   on; user.json's entries show with the Your source badge, curated ones
 *   never; a file that changed since its first install asks before installing.
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

test('An installed upload with a newer one on archive.org gets the Newer release badge', async () => {
  await page.locator('#q').fill('Zoo Tycoon');
  const card = page.locator('.game-card', { hasText: 'Zoo Tycoon' }).first();
  await card.click();
  await page.locator('#detail [data-version="rk-e2e-zoo-tycoon"]').click();
  await page.locator('#btn-download').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const note = page.locator('#detail .newer-note');
  await expect(note).toContainText('A newer upload of this game is on archive.org');
  await expect(page.locator('#detail [data-version="rk-e2e-zoo-tycoon-pstriple"] .tag.update')).toHaveText('NEWER');
  await note.locator('button').click();
  await expect(page.locator('#detail #btn-download')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.locator('.tag.update')).toHaveText('NEWER RELEASE');
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
  // Cider 2's context menu: an icon per item, sections split by dividers, a chevron for a submenu
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi')).toHaveText(['Launch', 'Open Folder', 'Launch Options',
    'Remove from Library', 'Game Data…', 'Properties', 'Go to Shelf', 'Go to Source Repo', 'Game Data on archive.org', 'Copy Link', 'Delete']);
  await expect(menu.locator(':scope > .sep')).toHaveCount(3);
  await expect(menu.locator(':scope > .mi .mi-ico.ico').first()).toBeVisible();
  await expect(menu.locator('.has-sub > .mi .chev')).toBeVisible();
  await menu.locator('.has-sub', { hasText: 'Launch Options' }).hover();
  await expect(menu.locator('[data-menu="choose-exe"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Not installed: Download and Locate Existing Install
  await page.locator('#nav-shelves .navitem', { hasText: 'Nintendo' }).click();
  await page.locator('.port-card', { hasText: 'Mario Kart 64' }).click({ button: 'right' });
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi').first()).toHaveText('Download');
  await expect(menu.locator('[data-menu="locate"]')).toBeVisible();
  await menu.locator('[data-menu="details"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#detail')).toContainText('Mario Kart 64');
  await page.keyboard.press('Escape');
});

test("The wall's library header sorts, searches, lists and pages, after Cider's", async () => {
  await page.locator('[data-view="wall"]').click();
  const titles = () => page.locator('#body .game-card .title').allInnerTexts();
  const header = page.locator('.album-header');
  // Cider 2's dropdowns: a pill that opens a listbox, the choice marked
  const choose = async (pref, value) => {
    await header.locator(`[data-pref="${pref}"]`).click();
    await page.locator(`#ddmenu [role="option"][data-value="${value}"]`).click();
    await expect(page.locator('#ddmenu')).toBeHidden();
  };

  await choose('sort', 'name');
  await choose('order', 'asc');
  await expect(header.locator('[data-pref="sort"]')).toHaveAccessibleName('Sort by: Title');
  const asc = await titles();
  expect(asc).toEqual([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  // From the keyboard: Down opens it on the chosen item, arrows move, Enter picks, Escape closes
  await header.locator('[data-pref="order"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#ddmenu [aria-selected="true"]')).toBeFocused();
  await expect(page.locator('#ddmenu [aria-selected="true"]')).toHaveText('Ascending');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ddmenu')).toBeHidden();
  await expect(header.locator('[data-pref="order"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ddmenu')).toBeHidden();
  await expect(header.locator('[data-pref="order"]')).toHaveAccessibleName('Sort order: Descending');
  expect(await titles()).toEqual([...asc].reverse());

  // Punctuation is ignored, as in Cider's library search; focus stays in the box
  await page.locator('#lib-search').fill('zoo-tycoon');
  await expect(page.locator('#body .game-card')).toHaveCount(1);
  await expect(page.locator('#lib-search')).toBeFocused();
  await page.locator('#lib-search').fill('');

  // View as: a two-button switch at the end of the controls row
  const toggle = header.getByRole('group', { name: 'View as' });
  await expect(toggle.getByRole('button', { name: 'Cover art' })).toHaveAttribute('aria-pressed', 'true');
  await toggle.getByRole('button', { name: 'List' }).click();
  await expect(page.locator('#body .list-row').first()).toBeVisible();
  await expect(page.locator('#body .game-card')).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
  await expect(header.getByRole('button', { name: 'Cover art' })).toHaveAttribute('aria-pressed', 'false');
  await header.getByRole('button', { name: 'Cover art' }).click();
  await expect(page.locator('#body .game-card').first()).toBeVisible();

  await choose('scroll', 'paged');
  await expect(header.locator('.pagination-container')).toBeVisible();
  await expect(header.locator('.md-input-number')).toContainText('/ 1');
  await choose('scroll', 'infinite');
  await choose('sort', 'dateAdded');
});

test("The wall's list view: Cider 2's song list, with sorting headers, a column picker and a ⋯ menu", async () => {
  await page.locator('[data-view="wall"]').click();
  await page.locator('.album-header').getByRole('button', { name: 'List' }).click();
  const table = page.locator('#body .lv');
  const rows = table.locator('.lv-row');
  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  await expect(rows).toHaveCount(new Set(docs.map(d => titleKey(d))).size);
  await expect(table.locator('.lv-row img, .lv-row [data-thumb]')).toHaveCount(0);

  // Column headers: the fixtures have no release dates or sizes, so those stay out
  const headers = table.locator('.lv-head [role="columnheader"] button[data-sort-col]');
  await expect(headers).toHaveText(['Name', 'Uploader', 'Platform', 'Added', 'Downloads', 'Status']);
  await expect(rows.first().locator('[role="cell"]').nth(4)).toHaveText('PC');

  // A header click sorts by it; a second click flips the order
  const names = () => rows.locator('.lv-title').allInnerTexts();
  await headers.filter({ hasText: 'Name' }).click();
  await expect(table.locator('.lv-th', { hasText: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  const asc = await names();
  expect(asc).toEqual([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  await expect(page.locator('.album-header [data-pref="sort"]')).toHaveAccessibleName('Sort by: Title');
  await table.locator('.lv-head button[data-sort-col="name"]').click();
  await expect(table.locator('.lv-th', { hasText: 'Name' })).toHaveAttribute('aria-sort', 'descending');
  expect(await names()).toEqual([...asc].reverse());
  await table.locator('.lv-head button[data-sort-col="downloads"]').click();
  const downloads = (await rows.locator('.lv-td.num').allInnerTexts()).map(t => Number(t.replace(/,/g, '')));
  expect(downloads).toEqual([...downloads].sort((a, b) => b - a));

  // The column picker hides a column, and the choice is kept
  await table.locator('[data-col-picker]').click();
  const picker = page.locator('#ddmenu');
  await expect(picker.locator('[role="option"][data-value="size"]')).toContainText('no data');
  await picker.locator('[role="option"][data-value="uploader"]').click();
  await expect(picker).toBeVisible();
  await expect(picker.locator('[role="option"][data-value="uploader"]')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#body .lv-head button[data-sort-col="uploader"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await page.reload();
  await page.locator('[data-view="wall"]').click();
  await expect(page.locator('#body .lv-head button[data-sort-col]')).toHaveText(['Name', 'Platform', 'Added', 'Downloads', 'Status']);
  await page.locator('#body [data-col-picker]').click();
  await page.locator('#ddmenu [role="option"][data-value="uploader"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#body .lv-head button[data-sort-col="uploader"]')).toHaveCount(1);

  // The ⋯ button opens the row menu, the same one a right-click opens
  const row = page.locator('#body .lv-row', { hasText: 'The Sims' });
  await row.hover();
  await expect(row.locator('.lv-go')).toBeVisible();
  await row.locator('.lr-more').click();
  const menu = page.locator('#ctxmenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator(':scope > .mi')).toHaveText(['Install', 'Favorite', 'Properties', 'Go to Uploader', 'View on archive.org', 'Copy Link']);
  await menu.locator('[data-menu="favorite"]').click();
  await expect(menu).toBeHidden();
  await expect(row.locator('.lv-star [data-ico="star-fill"]')).toBeVisible();
  await row.click({ button: 'right' });
  await expect(menu.locator('[data-menu="favorite"]')).toHaveText('Unfavorite');
  await menu.locator('[data-menu="favorite"]').click();
  await expect(row.locator('.lv-star [data-ico="star-fill"]')).toHaveCount(0);
  await row.locator('.lr-more').click();
  await menu.locator('[data-menu="details"]').click();
  await expect(page.locator('#detail')).toContainText('The Sims');
  await page.keyboard.press('Escape');

  await page.locator('.album-header').getByRole('button', { name: 'Cover art' }).click();
  await page.locator('.album-header [data-pref="sort"]').click();
  await page.locator('#ddmenu [data-value="dateAdded"]').click();
  await page.locator('.album-header [data-pref="order"]').click();
  await page.locator('#ddmenu [data-value="desc"]').click();
});

test('Sidebar groups fold and stay folded', async () => {
  await page.locator('[data-collapse="uploaders"]').click();
  await expect(page.locator('#nav-uploaders')).toBeHidden();
  await page.reload();
  await expect(page.locator('#nav-uploaders')).toBeHidden();
  await page.locator('[data-collapse="uploaders"]').click();
  await expect(page.locator('#nav-uploaders')).toBeVisible();
});

test('Additional sources: the toggle asks every time, user.json cards carry the badge, a changed file asks first', async () => {
  const modal = page.locator('#modal');
  const toggle = page.locator('#setting-additional');
  await page.locator('#btn-settings').click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#nav-add-repo')).toBeHidden();

  // Cancel leaves it off
  await toggle.click();
  await expect(modal.locator('.modal-title')).toHaveText('Additional sources');
  await expect(modal.locator('.modal-content')).toHaveText('Warning: we do not monitor additional sources. Make sure you trust the repo or uploader before you add it.');
  await expect(modal.locator('.md-btn-primary')).toHaveText('I understand');
  await expect(modal.locator('.md-btn:not(.md-btn-primary)')).toHaveText('Cancel');
  await modal.locator('.md-btn', { hasText: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  const saved = () => JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'settings.json'), 'utf8'));
  expect(saved().allowAdditionalSources).toBeUndefined();

  // Escape is Cancel too; I understand turns it on
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await modal.locator('.md-btn-primary').click();
  await expect(toggle).toBeChecked();
  expect(saved().allowAdditionalSources).toBe(true);
  await expect(page.locator('#nav-add-repo')).toBeVisible();

  // user.json: loaded, its invalid entry and its conflict with the curated list listed
  const file = path.join(stack.dataDir, 'user.json');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'user.json'), file);
  await page.locator('#setting-user-file').fill('https://example.com/user.json');
  await page.locator('[data-action="user-file-save"]').click();
  await expect(page.locator('#toast')).toContainText('not a URL');
  await page.locator('#setting-user-file').fill(file);
  await page.locator('[data-action="user-file-save"]').click();
  await expect(page.locator('#user-file-counts')).toHaveText('Loaded: 0 collisions, 2 archive.org downloads, 1 GitHub release.');
  await expect(page.locator('#user-invalid')).toContainText('github[1] not a repo: repository must be owner/repo');
  await expect(page.locator('#user-conflicts')).toContainText('rk-e2e-halo-ce (user.json archive): a curated uploader has it');

  // The badge: on your cards, never on curated ones
  await page.locator('[data-view="wall"]').click();
  const demo = page.locator('.game-card', { hasText: 'User Demo' });
  await expect(demo.locator('.user-badge')).toHaveText('Your source · not reviewed');
  await expect(page.locator('.game-card', { hasText: 'Halo' }).locator('.user-badge')).toHaveCount(0);
  await page.locator('#nav-shelves .navitem', { hasText: 'Your ports' }).click();
  await expect(page.locator('.port-card', { hasText: 'User Tool' }).locator('.user-badge')).toHaveText('Your source · not reviewed');
  await expect(page.locator('.port-card .user-badge')).toHaveCount(await page.locator('.port-card').count());
  await page.locator('[data-view="shelf"][data-arg]', { hasText: 'Test ports' }).click();
  await expect(page.locator('.port-card', { hasText: 'Perfect Dark' }).locator('.user-badge')).toHaveCount(0);

  // First install pins the file; a different file later asks before installing
  await page.locator('[data-view="wall"]').click();
  await demo.click();
  await expect(page.locator('#detail .user-note')).toContainText('from a source you added');
  await page.locator('#btn-download').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const pinsFile = path.join(stack.dataDir, 'pins.json');
  const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  expect(Object.keys(pins)).toEqual(['archive:rk-e2e-user-demo\nrk-e2e-user-demo.zip']);
  fs.writeFileSync(pinsFile, JSON.stringify({ 'archive:rk-e2e-user-demo\nrk-e2e-user-demo.zip': 'f'.repeat(40) }));
  // Reinstall over it, as an update would (deleting needs the desktop app)
  const reinstall = page.evaluate(() => installGame(state.detail.version)); // eslint-disable-line no-undef
  await expect(modal.locator('.modal-title')).toHaveText('File changed');
  await expect(modal.locator('.modal-content')).toContainText('rk-e2e-user-demo.zip from User Demo is not the file you installed before');
  await modal.locator('.md-btn-primary', { hasText: 'Install anyway' }).click();
  await reinstall;
  await expect(page.locator('#toast')).toContainText('User Demo is installed.');
  expect(JSON.parse(fs.readFileSync(pinsFile, 'utf8'))).toEqual(pins);
  await page.keyboard.press('Escape');

  // Off hides them and keeps the install; on again asks again
  await page.locator('#btn-settings').click();
  await toggle.click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('#nav-add-repo')).toBeHidden();
  await page.locator('[data-view="wall"]').click();
  await expect(page.locator('.game-card', { hasText: 'Halo' })).toBeVisible();
  await expect(page.locator('.game-card', { hasText: 'User Demo' })).toHaveCount(0);
  expect((await page.evaluate(() => api.getLibrary()))['rk-e2e-user-demo'].install_dir).toBeTruthy();
  await page.locator('#btn-settings').click();
  await toggle.click();
  await expect(modal.locator('.modal-title')).toHaveText('Additional sources');
  await modal.locator('.md-btn-primary').click();
  await expect(toggle).toBeChecked();
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

test('the announcement shows once and stays dismissed', async () => {
  const banner = page.locator('#announce');
  await expect(banner).toContainText('Welcome to the e2e launcher.');
  await banner.locator('[data-action="announce-dismiss"]').click();
  await expect(banner).toBeHidden();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'settings.json'), 'utf8')).dismissedAnnouncements).toEqual(['e2e-hello']);
});

test('Library: add your own app, drop files in its folder, play; rename; remove', async () => {
  await page.locator('[data-view="library"]').click();
  await page.locator('[data-action="manual-open"]').click();
  await page.locator('#manual-name').fill('My Homebrew');
  await page.locator('#btn-manual-create').click();
  const detail = page.locator('#detail');
  await expect(detail.locator('h2')).toHaveText('My Homebrew');
  await expect(detail.locator('.manual-note')).toContainText("Put the app's files in its folder");
  const folder = await page.evaluate(async () => (await api.getLibrary())['manual:My Homebrew'].install_dir);
  expect(fs.readdirSync(folder)).toEqual(['Place app files here.txt']);

  fs.writeFileSync(path.join(folder, 'homebrew.exe'), 'MZ');
  // Play finds the one exe now in the folder and asks the backend to launch it
  const launched = page.waitForRequest(r => r.url().includes('/launch') && r.method() === 'POST');
  await detail.locator('#btn-play').click();
  expect((await launched).postDataJSON().exePath).toBe(path.join(folder, 'homebrew.exe'));

  await page.evaluate(() => { globalThis.prompt = () => 'Homebrew Deluxe'; });
  await detail.locator('[data-action="manual-rename"]').click();
  await expect(detail.locator('h2')).toHaveText('Homebrew Deluxe');
  await expect(page.locator('.game-card', { hasText: 'Homebrew Deluxe' })).toContainText('Your folder');

  await detail.locator('[data-action="manual-remove"]').click();
  await expect(detail).toBeHidden();
  await expect(page.locator('.game-card', { hasText: 'Homebrew Deluxe' })).toHaveCount(0);
  expect(fs.existsSync(path.join(folder, 'homebrew.exe'))).toBe(true);
});

test('Settings feeds: subscribe, trust its uploader, copy your feed, import a feed file', async () => {
  const before = await page.evaluate(() => api.getSources());
  await page.locator('#btn-settings').click();
  await page.locator('#feed-url').fill(`${stack.base}/feed.json`);
  await page.locator('[data-action="feed-add"]').click();
  const row = page.locator('#feed-list .feed-row', { hasText: 'feed' });
  await expect(row.locator('.feed-uploader')).toContainText('gomes.samuel@gmail.com');
  await row.locator('[data-action="feed-trust"]').click();
  await expect(row.locator('.feed-uploader .trusted')).toHaveText('Trusted');
  await expect(page.locator('#setting-sources')).toHaveValue(/^gomes\.samuel@gmail\.com, /m);

  await page.evaluate(() => {
    globalThis.copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { globalThis.copied = t; } } });
  });
  await page.locator('[data-action="ed-export"]').first().click();
  await expect.poll(() => page.evaluate(() => globalThis.copied)).not.toBeNull();
  const copied = JSON.parse(await page.evaluate(() => globalThis.copied));
  expect(copied.uploaders.map(u => u.uploader)).toContain('gomes.samuel@gmail.com');

  await page.locator('#feed-file').setInputFiles({ name: 'mine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    collisions: [{ repository: 'me/imported-port', name: 'Imported Port', sources: [{ ia: 'rk-e2e-feed-data', path: 'x.bin' }] }],
    uploaders: [{ uploader: 'lawlessb991@gmail.com', label: 'lawless' }],
  })) });
  await expect(page.locator('#setting-sources')).toHaveValue(/^lawlessb991@gmail\.com, /m);
  const col = await page.evaluate(() => api.getCollision('me/imported-port'));
  expect(col.origin).toBe('local');

  // put the uploaders back, so the rest of the run sees the shipped wall
  await page.evaluate((s) => api.saveSettings({ sources: s.sources }), before);
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
