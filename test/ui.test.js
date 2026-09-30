'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { parseArgs, serve, start } = require('../scripts/ui');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('mise run ui: arguments and defaults', () => {
  assert.deepEqual(parseArgs([], {}).port, 5180);
  assert.equal(parseArgs([], {}).host, '0.0.0.0', 'reachable through a forwarded port');
  assert.equal(parseArgs([], {}).live, false, 'fixtures unless asked');
  const o = parseArgs(['--live', '--port', '6000', '--host', '127.0.0.1', '--out', 'x'], { UI_PORT: '7000' });
  assert.deepEqual([o.live, o.port, o.host, o.out], [true, 6000, '127.0.0.1', path.resolve('x')]);
  assert.equal(parseArgs([], { UI_PORT: '7000', UI_HOST: '::1' }).port, 7000);
});

test('serve: static files, / goes to the new UI, nothing outside the folder', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'new'));
  fs.writeFileSync(path.join(dir, 'new', 'index.html'), '<p>new</p>');
  fs.writeFileSync(path.join(path.dirname(dir), 'rk-ui-secret.txt'), 'no');
  t.after(() => fs.rmSync(path.join(path.dirname(dir), 'rk-ui-secret.txt'), { force: true }));
  const s = await serve(dir, { port: 0, host: '127.0.0.1' });
  t.after(s.close);
  const root = await fetch(`${s.url}/`, { redirect: 'manual' });
  assert.deepEqual([root.status, root.headers.get('location')], [302, '/new/']);
  const page = await fetch(`${s.url}/new/`);
  assert.deepEqual([page.status, page.headers.get('content-type'), await page.text()], [200, 'text/html', '<p>new</p>']);
  assert.equal((await fetch(`${s.url}/new/missing.js`)).status, 404);
  assert.equal((await fetch(`${s.url}/..%2Frk-ui-secret.txt`)).status, 404);
  assert.equal((await fetch(`${s.url}/%E0%A4%A`)).status, 404);
});

test('start: builds from the fixtures (no network) and serves a working preview', async (t) => {
  const out = path.join(tmp(t), 'site');
  const lines = [];
  const s = await start({ live: false, port: 0, host: '127.0.0.1', out }, (l) => lines.push(l));
  t.after(s.close);
  assert.match(lines.join(''), /fixtures data: \d+ wall items/);
  const html = await (await fetch(`${s.url}/new/`)).text();
  assert.match(html, /preview\.js/, 'the API stand-in loads before api.js');
  const manifest = await (await fetch(`${s.url}/preview-data/manifest.json`)).json();
  assert.equal(manifest.info.data, 'fixtures');
  const lib = manifest.responses['GET /library'];
  const rows = Object.values((await (await fetch(`${s.url}/preview-data/${lib.file}`)).json()).library);
  assert.ok(rows.filter(r => r.install_dir).length >= 2, 'installed games in the made-up library');
  assert.ok(rows.some(r => r.identifier.startsWith('quiver:')), 'a port added');
  assert.ok(rows.some(r => r.is_favorite === 1), 'a favourite');
});
