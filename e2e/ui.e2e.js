'use strict';
/**
 * End-to-end for the new UI (src/frontend/new/), the default in the app, in
 * a plain browser against the standalone backend.
 *
 * - The wall holds the shipped uploaders' games, grouped by title.
 * - The port shelf is the curated list, with no game data on its cards.
 * - Add puts a port in the library and Remove takes it out.
 * - Install downloads, extracts and registers an archive.org game.
 * - A port installs the Windows build from its GitHub release, and only that
 *   (Perfect Dark); game data is the user's job.
 * - Home's rows have no scrollbar; they scroll with the header arrows, the
 *   arrows over their ends, a drag (snapping to a column) and the Left/Right
 *   keys, and a drag doesn't open a card.
 * - Opening a game or a port shows its details page (after Cider's album
 *   page); Back, or Escape, returns to the page it came from, scrolled where
 *   it was, and a search comes back with its results.
 * - Home (the app opens on it) leads with the featured picks (a wall game and
 *   a port), then a compact list of the latest uploads, newest first, then
 *   each uploader's most played games and each shelf's ports.
 * - The announcement from announcement.json shows until dismissed.
 * - Your own app: a folder the library makes, fills and launches.
 * - Cards lift on hover and pages rise in, and prefers-reduced-motion turns
 *   both off.
 * - Additional sources: the Settings toggle asks in a modal every time it goes
 *   on; user.json's entries show with the Your source badge, curated ones
 *   never; a file that changed since its first install asks before installing.
 * - The Settings toggle switches to the classic UI and back, and is saved.
 *
 * archive.org, GitHub and the curated list are served by fixture-server.js.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { sourcesFromCatalog, titleKey } = require('../src/backend/sources.js');
const { startStack } = require('./fixture-server');
const fixtures = require('./fixtures/search.json');
const overrides = require('./fixtures/overrides.json');

const ENABLED = sourcesFromCatalog(require('../catalog/uploaders.json')).filter(s => s.enabled);

test.describe.configure({ mode: 'serial' });

let stack, page;

// A page change rises in (motion.css); wait it out before opening a dropdown,
// or Playwright's scroll-into-view retries land mid-animation and scroll the
// page, which closes the dropdown as a real scroll would
const settled = () => expect(page.locator('#body.page-enter')).toHaveCount(0);

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, { page: 'new/index.html' });
  page = await browser.newPage();
  // SteamGridDB's CDN, for the featured banners: a small local hero
  await page.route('https://cdn2.steamgriddb.com/**', r => r.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'hero.png')) }));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[frontend] ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.goto(stack.pageUrl);
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

test('the wall shows every shipped uploader, grouped by title and series', async () => {
  await expect(page.locator('.sidebar .brand')).toHaveText('y4bo');
  // The app opens on Home, which leads with the picks
  await expect(page.locator('#heading')).toHaveText('Home');
  await expect(page.locator('#body .feature-card').first()).toBeVisible({ timeout: 30_000 });
  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  // A series (overrides.json "series") is one card
  const groups = new Set(docs.map(d => overrides[d.identifier]?.series || titleKey(d))).size;
  await page.locator('[data-view="wall"]').click();
  await expect(page.locator('#body .game-card')).toHaveCount(groups, { timeout: 30_000 });
  for (const s of ENABLED) {
    await expect(page.locator(`#nav-uploaders [data-arg="${s.uploader}"] .n`)).toHaveText(String(fixtures[s.uploader].length));
  }
});

test("Home's rows scroll without a scrollbar", async () => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.locator('[data-view="home"]').click();
  const section = page.locator('#body .section.has-row', { has: page.locator('h2', { hasText: 'Recently Added' }) });
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

  // The arrows over the row's ends show on hover, the left one only once it has scrolled
  const edgeNext = section.locator('.row-edge.next');
  await row.hover();
  await expect(edgeNext).toHaveCSS('opacity', '1');
  await expect(section.locator('.row-edge.prev')).toBeDisabled();
  await edgeNext.click();
  await expect.poll(left).toBeGreaterThan(0);
  await expect(section.locator('.row-wrap')).toHaveClass(/more-left/);
  await section.locator('.row-edge.prev').click();
  await expect.poll(left).toBe(0);

  // A drag scrolls, then settles on a card's edge
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 300, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100, { steps: 5 });
  expect(await left()).toBeGreaterThan(0);
  await page.mouse.up();
  // Once the drag lets go the row comes to rest on a snap stop: a column's edge, or either end
  const resting = () => row.evaluate(r => {
    const pad = parseFloat(getComputedStyle(r).paddingLeft) || 0;
    const base = r.getBoundingClientRect().left + pad;
    const stops = [0, r.scrollWidth - r.clientWidth,
      ...[...r.children].map(c => c.getBoundingClientRect().left - base + r.scrollLeft)];
    return stops.some(x => Math.abs(x - r.scrollLeft) <= 2) ? 'ok' : `scrollLeft ${r.scrollLeft}, stops ${stops.map(Math.round)}`;
  });
  await expect.poll(resting).toBe('ok');
  await expect(page.locator('#detail')).toHaveCount(0);

  await row.locator('.card').first().focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(row.locator('.card').nth(5)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row.locator('.card').nth(4)).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('Home leads with the picks, then the latest uploads newest first', async () => {
  await expect(page.locator('[data-view="new"]')).toHaveCount(0);
  await page.locator('[data-view="home"]').click();
  await expect(page.locator('#heading')).toHaveText('Home');
  await expect(page.locator('.sidebar [data-view="home"]')).toHaveClass(/active/);
  // featured.json: Halo, an item not on the wall (skipped), Banjo from the curated list
  const features = page.locator('#body .feature-card');
  await expect(features).toHaveCount(2);
  await expect(features.nth(0).locator('.title')).toHaveText('Halo: Combat Evolved');
  await expect(features.nth(0).locator('.eyebrow')).toHaveText('y4bo pick');
  await expect(features.nth(0).locator('p')).toHaveText('The one that started it all.');
  await expect(features.nth(1).locator('.title')).toHaveText('Banjo-Kazooie');
  await expect(features.nth(1).locator('.eyebrow')).toHaveText('y4bo pick · port');
  // Banners are SteamGridDB heroes: Halo's pin in featured.json beats its art.json banner;
  // Banjo has none, so a plain banner with its title, never the port's square icon
  const hero = features.nth(0).locator('.art.banner img');
  await expect(hero).toHaveAttribute('src', 'https://cdn2.steamgriddb.com/hero/e2e0000000000000000000000000halo.png');
  await expect.poll(() => hero.evaluate(i => i.complete && i.naturalWidth)).toBe(384);
  const ratio = await features.nth(0).locator('.art').evaluate(a => a.offsetWidth / a.offsetHeight);
  expect(Math.abs(ratio - 1920 / 620)).toBeLessThan(0.05);
  expect(await hero.evaluate(i => i.ownerDocument.defaultView.getComputedStyle(i).objectFit)).toBe('cover');
  await expect(features.nth(1).locator('.art.plain .banner-title')).toHaveText('Banjo-Kazooie');
  await expect(features.nth(1).locator('.art img')).toHaveCount(0);

  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  const items = page.locator('#body .list-item');
  await expect(items).toHaveCount(new Set(docs.map(d => titleKey(d))).size);
  const dates = await items.locator('.sub').evaluateAll(els => els.map(e => e.textContent.match(/\d{4}-\d{2}-\d{2}/)?.[0] || ''));
  expect(dates).toEqual([...dates].sort().reverse());
  // Then the rows the old Home had: each uploader's most played, each shelf's ports
  await expect(page.locator('#body h2', { hasText: /^Most Played from/ }).first()).toBeVisible();
  await expect(page.locator('#body h2', { hasText: / ports$/ }).first()).toBeVisible();

  await items.first().click();
  await expect(page.locator('#detail')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#heading')).toHaveText('Home');
  await features.nth(1).click();
  await expect(page.locator('#detail')).toContainText('Banjo');
  await page.keyboard.press('Escape');
});

test('A game opens its details page; Back returns to the page and the scroll it came from', async () => {
  await page.locator('[data-view="wall"]').click();
  const body = page.locator('#body');
  const zoo = page.locator('#body .game-card', { hasText: 'Zoo Tycoon' });
  await page.setViewportSize({ width: 1280, height: 500 });
  await body.evaluate(b => { b.style.scrollBehavior = 'auto'; });
  await zoo.scrollIntoViewIfNeeded();
  const scrolled = await body.evaluate(b => b.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  await zoo.click();

  const detail = page.locator('#detail');
  await expect(detail.locator('.album-title')).toHaveText('Zoo Tycoon (Complete Collection)');
  await expect(page.locator('#heading')).toHaveCount(0);
  await expect(detail.locator('.album-sub')).toHaveText('rohanjackson071');
  await expect(detail.locator('.album-meta')).toContainText('PC');
  await expect(detail.locator('.album-meta')).toContainText('1,200 downloads');
  await expect(detail.locator('#btn-download')).toBeVisible();
  // The versions as a track list, newest first, the one shown ticked
  await expect(detail.locator('.track')).toHaveCount(2);
  await expect(detail.locator('.track').first()).toContainText('hailstormttv');
  await expect(detail.locator('.track.on')).toHaveAttribute('data-version', 'rk-e2e-zoo-tycoon');
  await expect(detail.locator('.album-foot')).toContainText('rk-e2e-zoo-tycoon');

  // Back lands on the wall where it was left; Forward returns
  await page.locator('#nav-back').click();
  await expect(page.locator('#heading')).toHaveText('Game wall');
  await expect(detail).toHaveCount(0);
  await expect.poll(() => body.evaluate(b => b.scrollTop)).toBe(scrolled);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#nav-fwd').click();
  await expect(detail.locator('.album-title')).toHaveText('Zoo Tycoon (Complete Collection)');
  await settled();

  // ⋯ opens the row menu (the same grouped, iconed list as a list row's ⋯),
  // without Properties since this is that page; Escape closes it and stays
  await detail.locator('[data-detail-menu]').click();
  const menu = page.locator('#ctxmenu');
  await expect(menu.locator('.mi')).toHaveText(['Install', 'Favorite', 'Go to Uploader', 'View on archive.org', 'Copy Link']);
  await expect(menu.locator(':scope > .sep')).toHaveCount(2);
  await expect(menu.locator('.mi .mi-ico.ico')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(detail).toBeVisible();
  // Right-click on the page's head opens the same menu
  await detail.locator('.album-title').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mi')).toHaveText(['Install', 'Favorite', 'Go to Uploader', 'View on archive.org', 'Copy Link']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // More from the uploader opens that title's page; Back walks back to this one
  const more = detail.locator('.section', { hasText: 'More from rohanjackson071' });
  await more.locator('.game-card', { hasText: 'Halo' }).click();
  await expect(detail.locator('.album-title')).toHaveText('Halo: Combat Evolved');
  await page.locator('#nav-back').click();
  await expect(detail.locator('.album-title')).toHaveText('Zoo Tycoon (Complete Collection)');

  // The uploader under the title leads to their wall
  await detail.locator('.album-sub').click();
  await expect(page.locator('#heading')).toHaveText('rohanjackson071');
});

test('The port shelf is the curated list: every card Curated, no game data, no other shelf', async () => {
  await expect(page.locator('#nav-shelves .navitem')).toHaveCount(1);
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  await expect(page.locator('#body .port-card')).toHaveCount(8);
  await expect(page.locator('#body .port-card .curated-badge')).toHaveCount(8);
  await expect(page.locator('#body .port-card .tag')).toHaveCount(0);
  await expect(page.locator('#body .lib-count')).toContainText('Source: y4bo curated list');
  await page.locator('#btn-settings').click();
  await expect(page.locator('#setting-full-quiver')).toHaveCount(0);
  await expect(page.locator('#quiver-import')).toHaveCount(0);
  await page.locator('#btn-settings').click();
});

test('Card states from tags: source only links the repository, work in progress and engines still install', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  const bfbb = page.locator('.port-card', { hasText: 'BFBB' });
  await expect(bfbb.locator('.state-badge')).toHaveText('Source only');
  await expect(bfbb.locator('.play-btn')).toHaveCount(0);
  await bfbb.click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.source-only-note')).toHaveText('Source only, no download');
  await expect(detail.locator('#btn-install-port')).toHaveCount(0);
  await expect(detail.locator('[data-toggle-port]')).toHaveCount(0);
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

test('A title with one upload has no track list: one track is no album', async () => {
  await page.locator('[data-view="wall"]').click();
  await page.locator('#body .game-card', { hasText: 'The Sims' }).click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.album-title')).toHaveText('The Sims');
  await expect(detail.locator('.album-kind')).toHaveText('Game');
  await expect(detail.locator('.tracklist')).toHaveCount(0);
  await expect(detail.locator('.album-foot')).toContainText('rk-e2e-the-sims');
  await page.keyboard.press('Escape');
});

test('A series is one card on the wall; it opens an album of its games, each opening its own page', async () => {
  await page.locator('[data-view="wall"]').click();
  const card = page.locator('#body .series-card', { hasText: 'Fixture Classics' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.tag.versions')).toHaveText('2 GAMES');
  await expect(page.locator('#body .game-card', { hasText: 'Age of Empires II' })).toHaveCount(0);
  await card.click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.album-kind')).toHaveText('Series');
  await expect(detail.locator('.album-title')).toHaveText('Fixture Classics');
  await expect(detail.locator('.album-meta')).toContainText('2 games');
  // Its games as tracks, oldest first
  const tracks = detail.locator('.series-tracks .track');
  await expect(tracks).toHaveCount(2);
  await tracks.filter({ hasText: 'Age of Empires II' }).click();
  await expect(detail.locator('.album-title')).toHaveText('Age of Empires II');
  await expect(detail.locator('#btn-download')).toBeVisible();
  // The game's page leads back to its series
  await detail.locator('.album-series').click();
  await expect(detail.locator('.album-title')).toHaveText('Fixture Classics');
  // A search shows the series' games one by one
  await page.locator('#nav-back').click();
  await page.locator('#nav-back').click();
  await page.locator('#nav-back').click();
  await page.locator('#lib-search').fill('age of empires');
  await expect(page.locator('#body .game-card', { hasText: 'Age of Empires II' })).toHaveCount(1);
  await expect(page.locator('#body .series-card')).toHaveCount(0);
  await page.locator('#lib-search').fill('');
});

test('An upload linked to a shelf port: one album with both, and the port leads back', async () => {
  await page.locator('[data-view="wall"]').click();
  const card = page.locator('#body .game-card', { hasText: 'RollerCoaster Tycoon' });
  await expect(card.locator('.tag.versions')).toHaveText('UPLOAD + PORT');
  await card.click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.album-kind')).toHaveText('Game · and a port');
  await expect(detail.locator('.tracklist .track')).toHaveCount(2);
  const port = detail.locator('.port-track');
  await expect(port).toContainText('BanjoRecomp/BanjoRecomp');
  await expect(port.locator('.tag.port')).toHaveText('PORT');
  await expect(detail.locator('.track-sum')).toContainText('1 upload · 1 port');
  await port.click();
  await expect(detail.locator('.album-title')).toHaveText('Banjo-Kazooie');
  await detail.locator('.album-series', { hasText: 'Also on archive.org: RollerCoaster Tycoon' }).click();
  await expect(detail.locator('.album-title')).toHaveText('RollerCoaster Tycoon');
  await page.keyboard.press('Escape');
});

test('Add puts a port in the library and Remove takes it out', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  await page.locator('.port-card', { hasText: 'Banjo-Kazooie' }).click();
  // One thing installs, so no track list: the release binary in the info at the foot
  await expect(page.locator('#detail .tracklist')).toHaveCount(0);
  await expect(page.locator('#detail .album-foot')).toContainText('The Windows build from the latest GitHub release');
  await expect(page.locator('#detail .album-foot')).toContainText('BanjoRecomp/BanjoRecomp');
  await expect(page.locator('#detail .album-cover')).toHaveClass(/square/);
  await page.locator('#detail [data-toggle-port]').click();
  await expect(page.locator('#detail [data-toggle-port]')).toHaveText('Remove from library');
  await page.locator('#nav-back').click();
  await expect(page.locator('#heading')).toHaveText('Curated ports');

  await page.locator('[data-view="library"]').click();
  await expect(page.locator('#body .port-card')).toHaveCount(1);
  await page.locator('#body .port-card').click();
  await page.locator('#detail [data-toggle-port]').click();
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
  // Installed: ⋯ (the row menu) has Add to Steam and Delete, the drawer's other buttons
  await page.locator('#detail [data-detail-menu]').click();
  await expect(page.locator('#ctxmenu .mi')).toHaveText(['Play', 'Open Folder', 'Add to Steam…', 'Favorite', 'Go to Uploader', 'View on archive.org', 'Copy Link', 'Delete']);
  await page.keyboard.press('Escape');
  // Back to the search, with its results
  await page.keyboard.press('Escape');
  await expect(page.locator('#q')).toHaveValue('Halo');
  await expect(page.locator('#heading')).toHaveText('Search');
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

test('Perfect Dark installs its GitHub build only', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  await page.locator('.port-card', { hasText: 'Perfect Dark' }).click();
  await page.locator('#btn-install-port').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const dir = path.join(stack.dataDir, 'games', 'PerfectDark-PerfectDarkPCPort');
  expect(fs.existsSync(path.join(dir, 'pd.x86_64.exe'))).toBe(true);
  expect(fs.readdirSync(path.join(dir, 'data'))).toEqual(['put_your_rom_here.txt']);
  await expect(page.locator('#detail')).toContainText(`Installed to ${dir}`);
  await page.keyboard.press('Escape');
});

test('Right-click menu on a port card: installed actions, Launch Options submenu, Escape closes', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  const card = page.locator('.port-card', { hasText: 'Perfect Dark' });
  await card.click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu).toBeVisible();
  // Cider 2's context menu: an icon per item, sections split by dividers, a chevron for a submenu
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi')).toHaveText(['Launch', 'Open Folder', 'Launch Options',
    'Remove from Library', 'Properties', 'Go to Shelf', 'Go to Source Repo', 'Copy Link', 'Delete']);
  await expect(menu.locator(':scope > .sep')).toHaveCount(3);
  await expect(menu.locator(':scope > .mi .mi-ico.ico').first()).toBeVisible();
  await expect(menu.locator('.has-sub > .mi .chev')).toBeVisible();
  await menu.locator('.has-sub', { hasText: 'Launch Options' }).hover();
  await expect(menu.locator('[data-menu="choose-exe"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Not installed: Download and Locate Existing Install
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  await page.locator('.port-card', { hasText: 'Mario Kart 64' }).click({ button: 'right' });
  await expect(menu.locator(':scope > .mi, :scope > .has-sub > .mi').first()).toHaveText('Download');
  await expect(menu.locator('[data-menu="locate"]')).toBeVisible();
  await menu.locator('[data-menu="details"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#detail')).toContainText('Mario Kart 64');
  await page.keyboard.press('Escape');
});

test('Star Fox 64: Recompiled installs from the curated shelf, from its GitLab release', async () => {
  await page.locator('#nav-shelves .navitem', { hasText: 'Curated' }).click();
  await page.locator('.port-card', { hasText: 'Star Fox 64' }).click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.album-foot')).toContainText('The Windows build from the latest GitLab release');
  await expect(detail.locator('.album-foot')).toContainText('sonicdcer/Starfox64Recomp');
  await detail.locator('#btn-install-port').click();
  await expect(page.locator('#detail #btn-play')).toBeVisible({ timeout: 30_000 });
  const dir = path.join(stack.dataDir, 'games', 'StarFox64-StarFox64Recompiled');
  expect(fs.existsSync(path.join(dir, 'Starfox64Recompiled.exe'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'portable.txt'))).toBe(true);
  await expect(page.locator('#detail')).toContainText(`Installed to ${dir}`);
  await page.keyboard.press('Escape');
});

test("The wall's library header sorts, searches, lists and pages, after Cider's", async () => {
  await page.locator('[data-view="wall"]').click();
  await settled();
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
  await settled();
  await page.locator('.album-header').getByRole('button', { name: 'List' }).click();
  const table = page.locator('#body .lv');
  const rows = table.locator('.lv-row');
  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  await expect(rows).toHaveCount(new Set(docs.map(d => overrides[d.identifier]?.series || titleKey(d))).size);
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
  await settled();
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
  await expect(page.locator('#detail')).toHaveCount(0);
  await settled();

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

/* global document, getComputedStyle, MutationObserver -- page.evaluate callbacks run in the page */
test('Cards lift on hover and pages rise in; with reduced motion, neither', async () => {
  await page.locator('[data-view="home"]').click();
  const card = page.locator('#body .row .game-card').first();
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
  expect(await entered('wall')).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await entered('home')).toBe(false);
  await card.hover();
  expect(await card.evaluate(c => getComputedStyle(c).transform)).toBe('none');
  expect(await card.evaluate(c => getComputedStyle(c).transitionDuration)).toBe('0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
  await expect.poll(() => saved().allowAdditionalSources).toBe(true); // the save lands after the toggle redraws
  await expect(page.locator('#nav-add-repo')).toBeVisible();

  // user.json: loaded, its invalid entry and its conflict with the curated list listed
  const file = path.join(stack.dataDir, 'user.json');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'user.json'), file);
  await page.locator('#setting-user-file').fill('https://example.com/user.json');
  await page.locator('[data-action="user-file-save"]').click();
  await expect(page.locator('#toast')).toContainText('not a URL');
  await page.locator('#setting-user-file').fill(file);
  await page.locator('[data-action="user-file-save"]').click();
  await expect(page.locator('#user-file-counts')).toHaveText('Loaded: 2 archive.org downloads, 1 GitHub release.');
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
  await page.locator('[data-view="shelf"][data-arg]', { hasText: 'Curated' }).click();
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

test('Settings > Uploaders: saving one we don\'t list asks first, every time it is new', async () => {
  const modal = page.locator('#modal');
  const box = page.locator('#setting-sources');
  const saved = () => JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'settings.json'), 'utf8')).sources;
  await page.locator('#btn-settings').click();
  const before = await box.inputValue();
  await box.fill(before + '\n# stranger@example.invalid, Stranger');

  // Cancel saves nothing
  await page.locator('#btn-save-settings').click();
  await expect(modal.locator('.modal-title')).toHaveText('An uploader we don\'t list');
  await expect(modal.locator('.modal-content')).toHaveText('Warning: we do not monitor stranger@example.invalid. It is not on our curated list. Make sure you trust this uploader before you add it.');
  await modal.locator('.md-btn', { hasText: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);
  expect((saved() || []).some(s => s.uploader === 'stranger@example.invalid')).toBe(false);

  // I understand saves it; saving again doesn't ask
  await page.locator('#btn-save-settings').click();
  await modal.locator('.md-btn-primary').click();
  await expect.poll(() => (saved() || []).some(s => s.uploader === 'stranger@example.invalid')).toBe(true);
  await page.locator('#btn-save-settings').click();
  await expect(page.locator('#toast')).toContainText('Settings saved.');
  await expect(modal).toHaveCount(0);

  // Removing it doesn't ask either
  await box.fill(before);
  await page.locator('#btn-save-settings').click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => saved().some(s => s.uploader === 'stranger@example.invalid')).toBe(false);
});

test('Add a GitHub repo: it lands on Your ports, and can be removed', async () => {
  await page.locator('#nav-add-repo').click();
  await expect(page.locator('#heading')).toHaveText('Add a GitHub repo');
  await page.locator('#repo-repository').fill('someone/banjo-fork');
  await page.locator('#repo-name').fill('Banjo Fork');
  await page.locator('#btn-add-repo').click();
  await expect(page.locator('.repo-row', { hasText: 'someone/banjo-fork' })).toBeVisible();
  const saved = JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'catalogs', 'repos.local.json'), 'utf8'));
  expect(saved).toEqual([{ repository: 'someone/banjo-fork', name: 'Banjo Fork' }]);

  await page.locator('#nav-shelves .navitem', { hasText: 'Your ports' }).click();
  await expect(page.locator('.port-card', { hasText: 'Banjo Fork' }).locator('.user-badge')).toBeVisible();

  await page.locator('#nav-add-repo').click();
  await page.locator('.repo-row', { hasText: 'someone/banjo-fork' }).locator('[data-action="repo-remove"]').click();
  await expect(page.locator('.repo-row', { hasText: 'someone/banjo-fork' })).toHaveCount(0);
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
  await expect(detail.locator('.album-title')).toHaveText('My Homebrew');
  await expect(detail.locator('.manual-note')).toContainText("Put the app's files in its folder");
  const folder = await page.evaluate(async () => (await api.getLibrary())['manual:My Homebrew'].install_dir);
  expect(fs.readdirSync(folder)).toEqual(['Place app files here.txt']);

  fs.writeFileSync(path.join(folder, 'homebrew.exe'), 'MZ');
  // Play finds the one exe now in the folder and asks the backend to launch it
  const launched = page.waitForRequest(r => r.url().includes('/launch') && r.method() === 'POST');
  await detail.locator('#btn-play').click();
  expect((await launched).postDataJSON().exePath).toBe(path.join(folder, 'homebrew.exe'));

  await page.evaluate(() => { globalThis.prompt = () => 'Homebrew Deluxe'; });
  await detail.locator('[data-detail-menu]').click();
  await page.locator('#ctxmenu [data-menu="manual-rename"]').click();
  await expect(detail.locator('.album-title')).toHaveText('Homebrew Deluxe');
  await page.locator('#nav-back').click();
  const card = page.locator('.game-card', { hasText: 'Homebrew Deluxe' });
  await expect(card).toContainText('Your folder');

  await card.click();
  await detail.locator('[data-detail-menu]').click();
  await page.locator('#ctxmenu [data-menu="manual-remove"]').click();
  await expect(detail).toHaveCount(0);
  await expect(page.locator('#heading')).toHaveText('Library');
  await expect(page.locator('.game-card', { hasText: 'Homebrew Deluxe' })).toHaveCount(0);
  expect(fs.existsSync(path.join(folder, 'homebrew.exe'))).toBe(true);
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
