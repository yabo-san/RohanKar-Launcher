'use strict';
/**
 * Gamepad navigation (src/frontend/gamepad.js, new/pad.js) with a stand-in
 * for navigator.getGamepads: a standard-mapping pad the test presses.
 *
 * - The d-pad moves focus to the nearest thing that way; A presses it.
 * - LB and RB jump to the sidebar and the page; B goes back.
 * - Y opens a card's menu, B closes it; Start opens Downloads.
 * - A hint bar shows while the pad is in use, and a mouse hides it.
 */

const { test, expect } = require('@playwright/test');
const { startStack } = require('./fixture-server');

test.describe.configure({ mode: 'serial' });

let stack, page;

// Standard mapping: buttons by index, as Steam Input reports them
const BUTTON = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
const frames = () => page.evaluate(() => new Promise(r => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(r)))));
async function press(name) {
  await page.evaluate((i) => { globalThis.__pad.buttons[i] = { pressed: true, value: 1 }; }, BUTTON[name]);
  await frames();
  await page.evaluate((i) => { globalThis.__pad.buttons[i] = { pressed: false, value: 0 }; }, BUTTON[name]);
  await frames();
}
const focused = () => page.evaluate(() => {
  const el = globalThis.document.activeElement;
  return el?.dataset?.view || el?.dataset?.id || el?.id || el?.className || '';
});

test.beforeAll(async ({ browser }) => {
  stack = await startStack({}, { page: 'new/index.html' });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', m => { if (m.type() === 'error') console.log(`[frontend] ${m.text()}`); });
  await page.addInitScript(() => {
    const pad = { id: 'Steam Deck (standard)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    globalThis.__pad = pad;
    navigator.getGamepads = () => [globalThis.__padOn ? pad : null];
    globalThis.__connectPad = () => { globalThis.__padOn = true; globalThis.dispatchEvent(new Event('gamepadconnected')); };
  });
  await page.goto(stack.pageUrl);
  await expect(page.locator('#n-ports')).toHaveText('8', { timeout: 30_000 });
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

test('The d-pad walks the sidebar and A opens what it lands on; a hint bar shows', async () => {
  await expect(page.locator('#padhints')).toHaveCount(0);
  await page.evaluate(() => globalThis.__connectPad());
  await press('lb');
  expect(await focused()).toBe('library');
  await expect(page.locator('#padhints')).toBeVisible();
  await expect(page.locator('#padhints')).toContainText('Back');
  await press('down');
  expect(await focused()).toBe('ports');
  await press('a');
  await expect(page.locator('#heading')).toHaveText('Ports');
});

test('RB goes to the page, the d-pad moves between cards, A opens one and B comes back', async () => {
  await press('rb');
  expect(await page.evaluate(() => globalThis.document.activeElement.closest('#body') !== null)).toBe(true);
  // Into the cards, then along the row
  let guard = 0;
  while (!(await page.evaluate(() => globalThis.document.activeElement.matches('.port-card'))) && guard++ < 10) await press('down');
  const card = await focused();
  await press('right');
  const next = await focused();
  expect(next).not.toBe(card);
  expect(await page.evaluate(() => globalThis.document.activeElement.matches('.port-card'))).toBe(true);
  await press('left');
  expect(await focused()).toBe(card);

  await press('a');
  await expect(page.locator('#detail .album-title')).toBeVisible();
  await press('b');
  await expect(page.locator('#heading')).toHaveText('Ports');
  await expect(page.locator('#detail')).toHaveCount(0);
});

test("Y opens a card's menu and B closes it; Start opens Downloads", async () => {
  await press('rb');
  let guard = 0;
  while (!(await page.evaluate(() => globalThis.document.activeElement.matches('.port-card'))) && guard++ < 10) await press('down');
  await press('y');
  const menu = page.locator('#ctxmenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mi:focus')).toHaveCount(1);
  await press('down');
  await expect(menu.locator('.mi:focus')).toHaveCount(1);
  await press('b');
  await expect(menu).toBeHidden();

  await press('start');
  await expect(page.locator('#pop')).toBeVisible();
  await expect(page.locator('#pop')).toHaveAttribute('data-kind', 'downloads');
  await press('b');
  await expect(page.locator('#pop')).toBeHidden();
});

test('A mouse takes over again: the hint bar goes', async () => {
  await expect(page.locator('#padhints')).toBeVisible();
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await expect(page.locator('#padhints')).toBeHidden();
  await expect(page.locator('html')).not.toHaveClass(/\bpad\b/);
});
