'use strict';
/**
 * The web preview reads the JSON feeds live: a fixtures build pointed at a
 * local "main" (PREVIEW_FEED) shows today's overrides, picks and announcement
 * instead of the ones saved at build time, and falls back to the saved ones
 * when a feed can't be fetched.
 */

const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { build } = require('../scripts/preview/build');

let server, base, out;
const feed = {};

test.beforeAll(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-preview-live-'));
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/feed/')) {
      const body = feed[u.pathname.slice('/feed/'.length)];
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(body ? JSON.stringify(body) : '');
    }
    const file = path.join(out, decodeURIComponent(u.pathname));
    if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PREVIEW_FEED = `${base}/feed/`;
  try { await build({ out, fixtures: true }); } finally { delete process.env.PREVIEW_FEED; }
});

test.afterAll(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(out, { recursive: true, force: true });
});

test('the preview shows the feeds on main, not the build-time copies', async ({ page }) => {
  feed['overrides.json'] = { 'rk-e2e-halo-ce': { title: 'Halo, renamed on main' } };
  feed['catalog/featured.json'] = { picks: [{ identifier: 'rk-e2e-the-sims', blurb: 'Picked after the build.' }] };
  feed['announcement.json'] = { id: 'live-1', message: 'Posted after the build' };

  await page.goto(`${base}/new/index.html`);
  await expect(page.locator('#announce')).toContainText('Posted after the build');
  await page.locator('[data-view="wall"]').first().click();
  await expect(page.locator('#body')).toContainText('Halo, renamed on main');
  await page.locator('[data-view="home"]').first().click();
  await expect(page.locator('#body')).toContainText('Picked after the build.');
  await expect(page.locator('#body')).not.toContainText('The one that started it all.');
  await expect(page.locator('body')).toContainText('feeds live');
});

test('a feed that fails falls back to what the build saved', async ({ page }) => {
  for (const k of Object.keys(feed)) delete feed[k];

  await page.goto(`${base}/new/index.html`);
  await page.locator('[data-view="home"]').first().click();
  await expect(page.locator('#body')).toContainText('The one that started it all.');
  await page.locator('[data-view="wall"]').first().click();
  await expect(page.locator('#body')).toContainText('Halo: Combat Evolved');
});
