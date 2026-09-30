'use strict';
/**
 * End-to-end for the Cider-based page (src/frontend/cider/) in a plain
 * browser against the standalone backend: it loads the wall, grouped by
 * title, and a card opens the game's detail page.
 */

const { test, expect } = require('@playwright/test');
const { sourcesFromCatalog, titleKey } = require('../src/backend/sources.js');
const { startStack } = require('./fixture-server');
const fixtures = require('./fixtures/search.json');

const ENABLED = sourcesFromCatalog(require('../catalog/uploaders.json')).filter(s => s.enabled);

let stack, page;

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, { page: 'cider/index.html', catalogs: [{ file: 'Nintendo.json', shelf: 'Nintendo' }] });
  page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log(`[frontend] ${m.text()}`); });
  page.on('pageerror', e => console.log(`[frontend] ${e.message}`));
  await page.goto(stack.pageUrl);
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

test('the Cider page loads the wall and opens a detail', async () => {
  await expect(page.locator('#app-sidebar .brand')).toHaveText('y4bo');
  const docs = ENABLED.flatMap(s => fixtures[s.uploader] || []);
  const groups = new Set(docs.map(d => titleKey(d))).size;

  await page.locator('#app-sidebar [data-page="wall"]').click();
  const cards = page.locator('#app-content .cd-mediaitem-square');
  await expect(cards).toHaveCount(groups, { timeout: 30_000 });

  const name = (await cards.first().locator('.info-rect .title').innerText()).trim();
  await cards.first().locator('.artwork').click();
  await expect(page.locator('#app-content .playlist-page .playlist-name')).toHaveText(name);
  expect(new URL(page.url()).hash).toMatch(/^#game\//);
});
