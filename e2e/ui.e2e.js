'use strict';
/**
 * End-to-end for the new UI (src/frontend/new/), the default in the app, in
 * a plain browser against the standalone backend.
 *
 * - The sidebar is Library, Ports and Packs (archive.org uploaders), with
 *   What's new and Settings at its foot. The app opens on the Library: what's
 *   installed, games then ports. There is no separate "add to library" step.
 * - A pack's page holds that uploader's games, grouped by title, sorted by
 *   upload or update date; its title links to the uploader on archive.org.
 * - Ports is the built-in list plus the repos you added.
 * - Install downloads, extracts and registers an archive.org game.
 * - A port installs the Windows build from its GitHub release, and only that
 *   (Perfect Dark); game data is the user's job.
 * - Opening a game or a port shows its details page (after Cider's album
 *   page); Back, or Escape, returns to the page it came from, and a search
 *   comes back with its results.
 * - The search box takes a pasted link: an account becomes a pack, a repo
 *   joins Ports and installs, asking which file when its release has several.
 * - Hide from Pack, and Show hidden brings the uploads back.
 * - What's new lists a newer upload of an installed game.
 * - A game's page: Rohan's feature badges, archive.org reviews, the readme.
 * - A new y4bo release shows a bar with its notes.
 * - Cards lift on hover and pages rise in, and prefers-reduced-motion turns
 *   both off.
 * - Report an issue: Settings and each game's and port's page link to a
 *   prefilled GitHub issue.
 * - Settings: your config pastes in; About has no personal social links.
 *
 * archive.org, GitHub and the curated list are served by fixture-server.js.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { sourcesFromCatalog, titleKey } = require('../src/backend/sources.js');
const { startStack } = require('./fixture-server');
const fixtures = require('./fixtures/search.json');

const ENABLED = sourcesFromCatalog(require('../catalog/uploaders.json')).filter(s => s.enabled);
const ROHAN = 'rohanjackson071';

test.describe.configure({ mode: 'serial' });

let stack, page;

// A page change rises in (motion.css); wait it out before opening a dropdown,
// or Playwright's scroll-into-view retries land mid-animation and scroll the
// page, which closes the dropdown as a real scroll would
const settled = () => expect(page.locator('#body.page-enter')).toHaveCount(0);

// A pack's page: the uploader in the sidebar's Packs
async function openPack(name) {
  await page.locator('#nav-uploaders .navitem', { hasText: name }).click();
  await expect(page.locator('#heading')).toHaveText(name);
}
async function openPorts() {
  await page.locator('.sidebar [data-view="ports"]').click();
  await expect(page.locator('#heading')).toHaveText('Ports');
}
// Paste a link into the sidebar's search box
async function pasteLink(link) {
  await page.locator('#q').fill(link);
  await page.locator('#q').press('Enter');
}
const packGroups = (email) => new Set((fixtures[email] || []).map(d => titleKey(d))).size;
const rohan = { uploader: 'rohanjackson071@gmail.com' };

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, { page: 'new/index.html' });
  page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[frontend] ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.goto(stack.pageUrl);
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

test('The app opens on the Library; the sidebar is Library, Ports and Packs', async () => {
  await expect(page.locator('.sidebar .brand')).toHaveText('y4bo');
  await expect(page.locator('#heading')).toHaveText('Library');
  await expect(page.locator('.sidebar [data-view="library"]')).toHaveClass(/active/);
  await expect(page.locator('#body .empty')).toContainText('Nothing installed yet.');
  // No Home, no game wall, no shelves, no Add button: the search box takes links
  await expect(page.locator('[data-view="home"], .sidebar [data-view="wall"], #nav-shelves, #nav-add, #btn-more')).toHaveCount(0);
  await expect(page.locator('#q')).toHaveAttribute('placeholder', 'Search or paste a link');
  await expect(page.locator('#n-ports')).toHaveText('8', { timeout: 30_000 });
  await expect(page.locator('.sidebar .navgroup', { hasText: 'Packs' })).toBeVisible();
  await expect(page.locator('#nav-uploaders .navitem')).toHaveCount(ENABLED.length);
  for (const s of ENABLED) {
    await expect(page.locator(`#nav-uploaders [data-arg="${s.uploader}"] .n`)).toHaveText(String(fixtures[s.uploader].length), { timeout: 30_000 });
  }
  await expect(page.locator('#btn-news')).toBeVisible();

  // A pack: that uploader's games, grouped by title; its name links to archive.org
  await openPack(ROHAN);
  await expect(page.locator('#body .game-card')).toHaveCount(packGroups(rohan.uploader), { timeout: 30_000 });
  await expect(page.locator('#heading .title-link')).toHaveAttribute('data-href', /archive\.org/);
});

test('A game opens its details page; Back returns to the pack', async () => {
  await openPack(ROHAN);
  await page.locator('#body .game-card', { hasText: 'Zoo Tycoon' }).click();

  const detail = page.locator('#detail');
  await expect(detail.locator('.album-title')).toHaveText('Zoo Tycoon (Complete Collection)');
  await expect(page.locator('#heading')).toHaveCount(0);
  await expect(detail.locator('.album-sub')).toHaveText(ROHAN);
  await expect(detail.locator('.album-meta')).toContainText('PC');
  await expect(detail.locator('.album-meta')).toContainText('1,200 downloads');
  await expect(detail.locator('#btn-download')).toBeVisible();
  // The versions as a track list, newest first, the one shown ticked
  await expect(detail.locator('.track')).toHaveCount(2);
  await expect(detail.locator('.track').first()).toContainText('hailstormttv');
  await expect(detail.locator('.track.on')).toHaveAttribute('data-version', 'rk-e2e-zoo-tycoon');
  await expect(detail.locator('.album-foot')).toContainText('rk-e2e-zoo-tycoon');

  // Back lands on the pack; Forward returns
  await page.locator('#nav-back').click();
  await expect(page.locator('#heading')).toHaveText(ROHAN);
  await expect(detail).toHaveCount(0);
  await page.locator('#nav-fwd').click();
  await expect(detail.locator('.album-title')).toHaveText('Zoo Tycoon (Complete Collection)');
  await settled();

  // ⋯ opens the row menu, without Properties since this is that page, and
  // with no "Add to Library": installing is how a game joins the library
  const items = ['Install', 'Favorite', 'Go to Uploader', 'View on archive.org', 'Copy Link', 'Hide from Pack'];
  await detail.locator('[data-detail-menu]').click();
  const menu = page.locator('#ctxmenu');
  await expect(menu.locator('.mi')).toHaveText(items);
  await expect(menu.locator(':scope > .sep')).toHaveCount(3);
  await expect(menu.locator('.mi .mi-ico.ico')).toHaveCount(items.length);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(detail).toBeVisible();
  // Right-click on the page's head opens the same menu
  await detail.locator('.album-title').click({ button: 'right' });
  await expect(menu.locator('.mi')).toHaveText(items);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // More from the uploader opens that title's page; Back walks back to this one
  const more = detail.locator('.section', { hasText: `More from ${ROHAN}` });
  await more.locator('.game-card', { hasText: 'Halo' }).click();
  await expect(detail.locator('.album-title')).toHaveText('Halo: Combat Evolved');
  await page.locator('#nav-back').click();
  await expect(detail.locator('.album-title')).toHaveText('Zoo Tycoon (Complete Collection)');

  // The uploader under the title leads to their pack
  await detail.locator('.album-sub').click();
  await expect(page.locator('#heading')).toHaveText(ROHAN);
});

test('Ports is the built-in list: no curated badge, no game data', async () => {
  await openPorts();
  await expect(page.locator('#body .port-card')).toHaveCount(8);
  await expect(page.locator('#body .port-card .curated-badge')).toHaveCount(0);
  await expect(page.locator('#body .port-card .tag')).toHaveCount(0);
  await expect(page.locator('#body .lib-count')).toContainText('Paste a GitHub, GitLab or Codeberg link');
});

test('Card states from tags: source only links the repository, work in progress and engines still install', async () => {
  await openPorts();
  const bfbb = page.locator('.port-card', { hasText: 'BFBB' });
  await expect(bfbb.locator('.state-badge')).toHaveText('Source only');
  await expect(bfbb.locator('.play-btn')).toHaveCount(0);
  await bfbb.click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.source-only-note')).toHaveText('Source only, no download');
  await expect(detail.locator('#btn-install-port')).toHaveCount(0);
  await expect(detail.locator('.album-actions [data-href]')).toHaveAttribute('data-href', 'https://github.com/bfbbdecomp/bfbb');
  await page.keyboard.press('Escape');

  await bfbb.click({ button: 'right' });
  await expect(page.locator('#ctxmenu [data-menu="install"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.locator('.port-card', { hasText: 'MediEvilRecomp' }).click();
  await expect(detail.locator('.state-badge.wip')).toHaveText('Work in progress');
  await expect(detail.locator('#btn-install-port')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('.port-card', { hasText: 'ironwail' }).click();
  await expect(detail.locator('.state-badge.role')).toHaveText('Engine');
  await expect(detail.locator('.port-desc')).toHaveText('Quake engine. Needs the Quake data (id1/pak0.pak, pak1.pak) from the user.');
  await expect(detail.locator('#btn-install-port')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Install downloads, extracts and registers an archive.org game, and it shows in the Library', async () => {
  await page.locator('#q').fill('Halo');
  await page.locator('.game-card', { hasText: 'Halo: Combat Evolved' }).first().click();
  await page.locator('#btn-download').click();
  await expect(page.locator('#btn-play')).toBeVisible({ timeout: 30_000 });
  const lib = await page.evaluate(() => api.getLibrary());
  expect(Object.values(lib).some(l => l.install_dir)).toBe(true);
  // Installed: ⋯ (the row menu) has Add to Steam and Delete, the drawer's other buttons
  await page.locator('#detail [data-detail-menu]').click();
  await expect(page.locator('#ctxmenu .mi')).toHaveText(['Play', 'Open Folder', 'Readme', 'Add to Steam…', 'Favorite', 'Go to Uploader', 'View on archive.org', 'Copy Link', 'Delete']);
  await page.keyboard.press('Escape');
  // Back to the search, with its results
  await page.keyboard.press('Escape');
  await expect(page.locator('#q')).toHaveValue('Halo');
  await expect(page.locator('#heading')).toHaveText('Search');
  await page.keyboard.press('Escape');

  await page.locator('.sidebar [data-view="library"]').click();
  await expect(page.locator('#body .game-card', { hasText: 'Halo: Combat Evolved' })).toBeVisible();
  await expect(page.locator('#n-library')).toHaveText('1');
});

test("An installed upload with a newer one on archive.org gets the Newer release badge, and What's new lists it", async () => {
  await page.locator('#q').fill('Zoo Tycoon');
  const card = page.locator('.game-card', { hasText: 'Zoo Tycoon' }).first();
  await card.click();
  await page.locator('#detail [data-version="rk-e2e-zoo-tycoon"]').click();
  await page.locator('#btn-download').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const note = page.locator('#detail .newer-note');
  await expect(note).toContainText('A newer upload of this game is on archive.org');
  await expect(page.locator('#detail [data-version="rk-e2e-zoo-tycoon-pstriple"] .tag.update')).toHaveText('NEWER');
  await note.getByRole('button', { name: 'See it' }).click();
  await expect(page.locator('#detail #btn-download')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.locator('.tag.update')).toHaveText('NEWER RELEASE');
  await page.keyboard.press('Escape');

  // What's new: the newer upload, until it's dismissed
  await expect(page.locator('#n-news')).toHaveText('1');
  await page.locator('#btn-news').click();
  const pop = page.locator('#pop');
  const row = pop.locator('.news-row', { hasText: 'Zoo Tycoon' });
  await expect(row).toContainText('Newer upload on archive.org');
  await row.locator('[data-action="news-dismiss"]').click();
  await expect(row).toHaveCount(0);
  await expect(pop).toBeVisible();
  await expect(pop.locator('.news-empty')).toContainText('Nothing new');
  await page.keyboard.press('Escape');
  await expect(page.locator('#n-news')).toHaveText('');
});

test('Perfect Dark installs its GitHub build only, and joins the Library', async () => {
  await openPorts();
  await page.locator('.port-card', { hasText: 'Perfect Dark' }).click();
  // What installs: the release binary, and only that
  await expect(page.locator('#detail .tracklist .track')).toHaveCount(1);
  await expect(page.locator('#detail .album-cover')).toHaveClass(/square/);
  await page.locator('#btn-install-port').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const dir = path.join(stack.dataDir, 'games', 'PerfectDark-PerfectDarkPCPort');
  expect(fs.existsSync(path.join(dir, 'pd.x86_64.exe'))).toBe(true);
  expect(fs.readdirSync(path.join(dir, 'data'))).toEqual(['put_your_rom_here.txt']);
  await expect(page.locator('#detail')).toContainText(`Installed to ${dir}`);
  await page.keyboard.press('Escape');

  await page.locator('.sidebar [data-view="library"]').click();
  await expect(page.locator('#body .port-card', { hasText: 'Perfect Dark' })).toBeVisible();
});

test('Right-click menu on a port card: installed actions, Launch Options submenu, Escape closes', async () => {
  await openPorts();
  const card = page.locator('.port-card', { hasText: 'Perfect Dark' });
  await card.click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu).toBeVisible();
  // Cider 2's context menu: an icon per item, sections split by dividers, a chevron for a submenu
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi')).toHaveText(['Launch', 'Open Folder', 'Readme', 'Launch Options',
    'Properties', 'Go to Ports', 'Go to Source Repo', 'Copy Link', 'Delete']);
  await expect(menu.locator(':scope > .sep')).toHaveCount(3);
  await expect(menu.locator(':scope > .mi .mi-ico.ico').first()).toBeVisible();
  await expect(menu.locator('.has-sub > .mi .chev')).toBeVisible();
  await menu.locator('.has-sub', { hasText: 'Launch Options' }).hover();
  await expect(menu.locator('[data-menu="choose-exe"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Not installed: Download and Locate Existing Install
  await page.locator('.port-card', { hasText: 'Mario Kart 64' }).click({ button: 'right' });
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi').first()).toHaveText('Download');
  await expect(menu.locator('[data-menu="locate"]')).toBeVisible();
  await menu.locator('[data-menu="details"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#detail')).toContainText('Mario Kart 64');
  await page.keyboard.press('Escape');
});

test('Star Fox 64: Recompiled installs from its GitLab release', async () => {
  await openPorts();
  await page.locator('.port-card', { hasText: 'Star Fox 64' }).click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.tracklist .track')).toContainText('GitLab release from sonicdcer/Starfox64Recomp');
  await detail.locator('#btn-install-port').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const dir = path.join(stack.dataDir, 'games', 'StarFox64-StarFox64Recompiled');
  expect(fs.existsSync(path.join(dir, 'Starfox64Recompiled.exe'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'portable.txt'))).toBe(true);
  await expect(page.locator('#detail')).toContainText(`Installed to ${dir}`);
  // The installed release is recorded, and it is the latest: no Update button
  await expect(detail.locator('[data-action="install"]', { hasText: 'Update' })).toHaveCount(0);
  const lib = await page.evaluate(() => api.getLibrary());
  expect(Object.values(lib).find(l => /Starfox64Recomp/i.test(l.identifier))?.version).toBe('v1.0.3');
  await page.keyboard.press('Escape');
});

test("A pack's header sorts by upload or update date, searches and lists, after Cider's", async () => {
  await openPack(ROHAN);
  await settled();
  const titles = () => page.locator('#body .game-card .title').allInnerTexts();
  const header = page.locator('.album-header');
  // Cider 2's dropdowns: a pill that opens a listbox, the choice marked
  const choose = async (pref, value) => {
    await header.locator(`[data-pref="${pref}"]`).click();
    await page.locator(`#ddmenu [role="option"][data-value="${value}"]`).click();
    await expect(page.locator('#ddmenu')).toBeHidden();
  };

  await header.locator('[data-pref="sort"]').click();
  await expect(page.locator('#ddmenu [role="option"]')).toHaveText(['Newest upload', 'Recently updated', 'Title', 'Most downloaded']);
  await page.keyboard.press('Escape');
  // One sort control: picking a sort picks its order, and there is no paging
  await expect(header.locator('[data-pref="order"], [data-pref="scroll"]')).toHaveCount(0);

  await choose('sort', 'name');
  await expect(header.locator('[data-pref="sort"]')).toHaveAccessibleName('Sort by: Title');
  const asc = await titles();
  expect(asc).toEqual([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  // From the keyboard: Down opens it on the chosen item, Escape closes
  await header.locator('[data-pref="sort"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#ddmenu [aria-selected="true"]')).toBeFocused();
  await expect(page.locator('#ddmenu [aria-selected="true"]')).toHaveText('Title');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ddmenu')).toBeHidden();
  await expect(header.locator('[data-pref="sort"]')).toBeFocused();

  await choose('sort', 'updated');
  await expect(header.locator('[data-pref="sort"]')).toHaveAccessibleName('Sort by: Recently updated');

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
  await header.getByRole('button', { name: 'Cover art' }).click();
  await expect(page.locator('#body .game-card').first()).toBeVisible();
  await choose('sort', 'dateAdded');
});

test("A pack's list view: Cider 2's song list, with sorting headers, a column picker and a ⋯ menu", async () => {
  await openPack('r4zel1ght');
  await settled();
  await page.locator('.album-header').getByRole('button', { name: 'List' }).click();
  const table = page.locator('#body .lv');
  const rows = table.locator('.lv-row');
  await expect(rows).toHaveCount(packGroups('spideymaster661@gmail.com'));
  await expect(table.locator('.lv-row img, .lv-row [data-thumb]')).toHaveCount(0);

  // A header click sorts by it; a second click flips the order
  const names = () => rows.locator('.lv-title').allInnerTexts();
  await table.locator('.lv-head button[data-sort-col="name"]').click();
  await expect(table.locator('.lv-th', { hasText: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  const asc = await names();
  expect(asc).toEqual([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  await expect(page.locator('.album-header [data-pref="sort"]')).toHaveAccessibleName('Sort by: Title');
  await table.locator('.lv-head button[data-sort-col="name"]').click();
  await expect(table.locator('.lv-th', { hasText: 'Name' })).toHaveAttribute('aria-sort', 'descending');
  expect(await names()).toEqual([...asc].reverse());

  // The column picker hides a column, and the choice is kept
  await table.locator('[data-col-picker]').click();
  const picker = page.locator('#ddmenu');
  await picker.locator('[role="option"][data-value="uploader"]').click();
  await expect(picker).toBeVisible();
  await expect(picker.locator('[role="option"][data-value="uploader"]')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#body .lv-head button[data-sort-col="uploader"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await page.reload();
  await openPack('r4zel1ght');
  await settled();
  await expect(page.locator('#body .lv-head button[data-sort-col="uploader"]')).toHaveCount(0);
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
  await expect(menu.locator(':scope > .mi')).toHaveText(['Install', 'Favorite', 'Properties', 'Go to Uploader', 'View on archive.org', 'Copy Link', 'Hide from Pack']);
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
  await expect(page.locator('#detail')).toHaveCount(0);
  await settled();

  await page.locator('.album-header').getByRole('button', { name: 'Cover art' }).click();
  await page.locator('.album-header [data-pref="sort"]').click();
  await page.locator('#ddmenu [data-value="dateAdded"]').click();
});

test('Sidebar groups fold and stay folded', async () => {
  await page.locator('[data-collapse="uploaders"]').click();
  await expect(page.locator('#nav-uploaders')).toBeHidden();
  await page.reload();
  await expect(page.locator('#nav-uploaders')).toBeHidden();
  await page.locator('[data-collapse="uploaders"]').click();
  await expect(page.locator('#nav-uploaders')).toBeVisible();
});

/* global document, getComputedStyle, MutationObserver -- page.evaluate callbacks run in the page */
test('The sidebar is no window drag region, so its search box takes clicks on Windows', async () => {
  const dragging = await page.evaluate(() => [...document.querySelectorAll('#sidebar, #sidebar *')]
    .filter(el => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag')
    .map(el => el.id || el.className));
  expect(dragging).toEqual([]);
});

test('Clicks on the search box reach it in the app: no drag region covers it, and the title row still moves the window', async () => {
  // Electron applies drag/no-drag rectangles in document order, later ones
  // winning, whatever the stacking order. Replay that over a few points.
  const hits = await page.evaluate(() => {
    const regions = [...document.querySelectorAll('*')]
      .map(el => ({ r: el.getBoundingClientRect(), v: getComputedStyle(el).getPropertyValue('-webkit-app-region') }))
      .filter(({ r, v }) => (v === 'drag' || v === 'no-drag') && r.width && r.height);
    const drags = (x, y) => regions.reduce((on, { r, v }) =>
      (x >= r.left && x < r.right && y >= r.top && y < r.bottom ? v === 'drag' : on), false);
    const mid = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    return {
      search: drags(...mid(document.querySelector('#q'))),
      spacer: drags(...mid(document.querySelector('.chrome .drag'))),
      back:   drags(...mid(document.querySelector('#nav-back'))),
    };
  });
  expect(hits).toEqual({ search: false, spacer: true, back: false });
});

test('Cards lift on hover and pages rise in; with reduced motion, neither', async () => {
  await openPack(ROHAN);
  const card = page.locator('#body .game-card').first();
  await card.hover();
  await expect.poll(() => card.evaluate(c => getComputedStyle(c).transform)).not.toBe('none');
  // Whether the next page change runs the page-enter animation
  const entered = async (view) => {
    await page.evaluate(() => {
      globalThis.sawEnter = false;
      new MutationObserver(() => { if (document.querySelector('#body').classList.contains('page-enter')) globalThis.sawEnter = true; })
        .observe(document.querySelector('#body'), { attributes: true, attributeFilter: ['class'] });
    });
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(50);
    return page.evaluate(() => globalThis.sawEnter);
  };
  expect(await entered('library')).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await entered('settings')).toBe(false);
  await openPack(ROHAN);
  await card.hover();
  expect(await card.evaluate(c => getComputedStyle(c).transform)).toBe('none');
  expect(await card.evaluate(c => getComputedStyle(c).transitionDuration)).toBe('0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('Paste an account link: it becomes a pack; right-click the pack to remove it', async () => {
  const saved = () => JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'settings.json'), 'utf8')).sources || [];
  await pasteLink('https://archive.org/details/@stranger');
  // The fake archive.org has no such account, so only the saved list and the sidebar show it
  await expect.poll(() => saved().some(s => s.uploader === '@stranger')).toBe(true);
  const nav = page.locator('#nav-uploaders .navitem', { hasText: 'stranger' });
  await expect(nav).toBeVisible();
  await expect(page.locator('#q')).toHaveValue('');

  await nav.click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu.locator('.mi')).toHaveText(['Open on archive.org', 'Remove Pack']);
  await menu.locator('[data-menu="pack-remove"]').click();
  await expect.poll(() => saved().some(s => s.uploader === '@stranger')).toBe(false);
  await expect(nav).toHaveCount(0);
});

test('Hide from Pack: the upload leaves the pack, and Show hidden brings it back', async () => {
  await openPack('r4zel1ght');
  const card = page.locator('.game-card', { hasText: 'The Sims' }).first();
  await card.click({ button: 'right' });
  await page.locator('#ctxmenu [data-menu="hide"]').click();
  await expect(page.locator('#toast')).toContainText('Hid The Sims');
  await expect(page.locator('.game-card', { hasText: 'The Sims' })).toHaveCount(0);
  await page.locator('#body [data-action="unhide-all"]').click();
  await expect(page.locator('.game-card', { hasText: 'The Sims' }).first()).toBeVisible();
});

test('Report an issue: Settings, a game and a port each open a prefilled GitHub issue', async () => {
  const href = async (loc) => new URL(await loc.getAttribute('data-href'));
  await page.locator('#btn-settings').click();
  let u = await href(page.locator('#btn-report-issue'));
  expect(u.origin + u.pathname).toBe('https://github.com/yabo-san/RohanKar-Launcher/issues/new');
  await expect.poll(async () => (await href(page.locator('#btn-report-issue'))).searchParams.get('body')).toMatch(/App: y4bo \d/);

  await openPack(ROHAN);
  await page.locator('.game-card', { hasText: 'Halo' }).click();
  u = await href(page.locator('#detail a', { hasText: 'Report an issue' }));
  expect(u.searchParams.get('body')).toContain('Game: Halo: Combat Evolved (archive.org item rk-e2e-halo-ce');
  await page.keyboard.press('Escape');

  await openPorts();
  await page.locator('.port-card', { hasText: 'Perfect Dark' }).click();
  u = await href(page.locator('#detail a', { hasText: 'Report an issue' }));
  expect(u.searchParams.get('body')).toMatch(/Port: Perfect Dark \(.+\/perfect_dark\)/);
  await page.keyboard.press('Escape');
});

const reposFile = () => path.join(stack.dataDir, 'catalogs', 'repos.local.json');
const savedRepos = () => (fs.existsSync(reposFile()) ? JSON.parse(fs.readFileSync(reposFile(), 'utf8')) : null);

test('Paste a repo link: it joins Ports and tries to install; Remove Repo takes it out', async () => {
  await pasteLink('https://github.com/someone/banjo-fork/releases');
  await expect.poll(savedRepos).toEqual([{ repository: 'someone/banjo-fork' }]);
  // The fake GitHub has no such repo, so the install it starts fails and says so
  await expect(page.locator('#detail')).toContainText('banjo-fork');
  await expect(page.locator('#toast')).toContainText('banjo-fork', { timeout: 30_000 });
  await page.keyboard.press('Escape');

  await openPorts();
  const card = page.locator('.port-card', { hasText: 'banjo-fork' });
  await expect(card).toBeVisible();
  await card.click({ button: 'right' });
  await page.locator('#ctxmenu [data-menu="remove-repo"]').click();
  await expect(card).toHaveCount(0);
  await expect.poll(savedRepos).toEqual([]);
});

test('Paste a repo whose release has several Windows files: pick one, it installs, and updates take the same file', async () => {
  await pasteLink('https://github.com/someone/two-builds');
  const modal = page.locator('#modal');
  await expect(modal.locator('.modal-title')).toHaveText('Which file from someone/two-builds v2?');
  const opts = modal.locator('.file-opt');
  await expect(opts).toHaveCount(3);
  // The automatic pick is first and chosen; there is no "bookmark only" choice
  await expect(opts.first()).toContainText('two-builds-win64.zip');
  await expect(opts.first().locator('input')).toBeChecked();
  await expect(modal.locator('.md-btn')).toHaveText(['Cancel', 'Install']);
  await opts.filter({ hasText: 'two-builds-win32.zip' }).click();
  await modal.locator('.md-btn-primary').click();
  await expect(modal).toHaveCount(0);
  await expect.poll(savedRepos).toEqual([{ repository: 'someone/two-builds', assetPattern: '^two-builds-win\\d+\\.zip$' }]);
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const lib = await page.evaluate(() => api.getLibrary());
  const row = Object.values(lib).find(l => /two-builds/i.test(l.identifier));
  expect(row?.version).toBe('v2');
  expect(fs.existsSync(path.join(row.install_dir, 'TwoBuilds.exe'))).toBe(true);
  await page.keyboard.press('Escape');
});

test("A game page shows Rohan's feature badges and the archive.org reviews; Readme opens the one in its folder", async () => {
  await page.locator('#q').fill('Halo');
  await page.locator('.game-card', { hasText: 'Halo: Combat Evolved' }).first().click();
  const detail = page.locator('#detail');
  await expect(detail.locator('#reviews')).toContainText('Reviews on archive.org');
  await expect(detail.locator('.review')).toContainText('chief');
  await expect(detail.locator('.review')).toContainText('★★★★☆');
  // archive.org review bodies are HTML; the page shows the text only
  await expect(detail.locator('.review p')).toHaveText('Played start to finish.');
  await expect(detail.locator('[data-badge="controller"]')).toHaveText('Controller');
  // Installed by the Install test above: tiny.zip holds readme.txt
  await detail.locator('[data-action="readme"]').click();
  await expect(page.locator('#modal-title')).toHaveText('readme.txt');
  await expect(page.locator('#modal pre.readme')).not.toBeEmpty();
  await page.locator('#modal [data-modal="1"]').click();
  await expect(page.locator('#modal')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('A new y4bo release shows a bar with its notes and a link to get it', async () => {
  const opened = page.waitForRequest(r => r.url().includes('/os/updater-install') && r.method() === 'POST');
  await page.evaluate(() => globalThis.showUpdate({ status: 'available', version: '9.9.9', releaseNotes: '## Fixes\n- faster' }));
  const bar = page.locator('#announce');
  await expect(bar).toContainText('y4bo 9.9.9 is out.');
  await bar.locator('[data-action="update-notes"]').click();
  await expect(page.locator('#modal pre.readme')).toContainText('faster');
  await page.locator('#modal [data-modal="1"]').click();
  await opened;
  await bar.locator('[data-action="update-dismiss"]').click();
  await expect(bar).toBeHidden();
});

test('Update puts the newer upload over the installed copy: same folder, same entry, no second game', async () => {
  const before = (await page.evaluate(() => api.getLibrary()))['rk-e2e-zoo-tycoon'];
  expect(before.install_dir).toBeTruthy();
  await page.locator('#q').fill('Zoo Tycoon');
  await page.locator('.game-card', { hasText: 'Zoo Tycoon' }).first().click();
  await page.locator('#detail [data-version="rk-e2e-zoo-tycoon"]').click();
  const note = page.locator('#detail .newer-note');
  await note.getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('#toast')).toContainText('is updated', { timeout: 30_000 });
  await expect(page.locator('#detail .newer-note')).toHaveCount(0);
  const lib = await page.evaluate(() => api.getLibrary());
  expect(lib['rk-e2e-zoo-tycoon'].install_dir).toBe(before.install_dir);
  expect(lib['rk-e2e-zoo-tycoon'].upload).toBe('rk-e2e-zoo-tycoon-pstriple');
  expect(lib['rk-e2e-zoo-tycoon-pstriple']?.install_dir ?? null).toBe(null);
  await expect(page.locator('#detail .album-foot')).toContainText('Updated with');
  // The newer upload's own row says it's installed and leads to the copy
  await page.locator('#detail [data-version="rk-e2e-zoo-tycoon-pstriple"]').click();
  await expect(page.locator('#detail [data-version="rk-e2e-zoo-tycoon-pstriple"] .tag.installed')).toHaveText('INSTALLED');
  await page.locator('#detail .album-pill', { hasText: 'Go to installed copy' }).click();
  await expect(page.locator('#detail #btn-play')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('Settings: paste a config to add packs; About has no personal social links', async () => {
  await page.locator('#btn-settings').click();
  await page.locator('[data-action="config-paste"]').click();
  const modal = page.locator('#modal');
  await expect(modal.locator('.modal-title')).toHaveText('Paste a config');
  await modal.locator('#modal-input').fill(JSON.stringify({ y4bo: 1, packs: [{ uploader: '@friend', label: 'Friend' }] }));
  await modal.locator('.md-btn-primary').click();
  await expect(page.locator('#toast')).toContainText('Added 1 pack, 0 repos, 0 hidden uploads.');
  await expect(page.locator('#nav-uploaders .navitem', { hasText: 'Friend' })).toBeVisible();
  const config = await page.evaluate(() => api.getConfig());
  expect(config.packs.map(p => p.uploader)).toContain('@friend');
  expect(config.repos.map(r => r.repository)).toEqual(['someone/two-builds']);

  const about = page.locator('#about');
  await expect(about.locator('button')).toHaveText(['y4bo on GitHub', 'Donate to the Internet Archive']);
  await expect(about).toContainText("Built on Rohan Kar's launcher");
  // No Playnite export button (the extension reads the export file), no classic UI switch
  await expect(page.locator('#btn-classic-ui, [data-action="playnite-export"], #setting-user-file')).toHaveCount(0);
});

test("Settings: Find installs here adopts a game already in the folder, as Rohan's Scan Install Folder did", async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rk-e2e-scan-'));
  fs.mkdirSync(path.join(dir, '(12)Age of Empires II'));
  await page.locator('#btn-settings').click();
  await page.locator('#setting-install').fill(dir);
  await page.locator('[data-action="scan-install"]').click();
  // The library row, not the toast: a pack that failed to load (@friend, above)
  // can replace the toast with its own error
  await expect.poll(() => page.evaluate(() => api.getLibrary().then(l => l['rk-e2e-age-of-empires-2']?.install_dir)))
    .toBe(path.join(dir, '(12)Age of Empires II'));
  fs.rmSync(dir, { recursive: true, force: true });
});
