'use strict';
// scripts/dev.js: the mise backend/frontend/dev tasks without Electron
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settings, startFrontend, pageUrls, start } = require('../scripts/dev');
const { fakeArchive, tmpDir } = require('./backend/helpers');

test('settings default to fixed ports and the dev token', () => {
  const s = settings({});
  assert.equal(s.backendPort, 5170);
  assert.equal(s.frontendPort, 5173);
  assert.equal(s.token, 'dev');
  assert.match(s.dataDir, /\.launcher-data$/);
  const o = settings({ LAUNCHER_PORT: '1', FRONTEND_PORT: '2', LAUNCHER_TOKEN: 't', LAUNCHER_DATA_DIR: '/d' });
  assert.deepEqual(o, { backendPort: 1, frontendPort: 2, token: 't', dataDir: '/d' });
});

test('the frontend server serves src/frontend and nothing outside it', async (t) => {
  const f = await startFrontend({ frontendPort: 0 });
  t.after(f.close);
  const get = (p) => fetch(f.url + p);

  let res = await get('/new/index.html');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.match(await res.text(), /y4/);

  res = await get('/');
  assert.equal(res.status, 200);
  assert.equal((await get('/api.js')).headers.get('content-type'), 'text/javascript');

  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/new')).status, 404);
  assert.equal((await get('/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/%E0%A4%A')).status, 404);
});

test('page URLs point both UIs at the backend', () => {
  const p = pageUrls('http://127.0.0.1:5173', 'http://127.0.0.1:5170/v1', 'dev');
  assert.equal(p.new, 'http://127.0.0.1:5173/new/index.html?api=http%3A%2F%2F127.0.0.1%3A5170%2Fv1&token=dev');
  assert.equal(p.classic, 'http://127.0.0.1:5173/index.html?api=http%3A%2F%2F127.0.0.1%3A5170%2Fv1&token=dev');
});

test('dev starts the backend and the frontend together', async (t) => {
  const fake = await fakeArchive(t);
  const out = [];
  const env = { LAUNCHER_PORT: '0', FRONTEND_PORT: '0', LAUNCHER_TOKEN: 'tok', LAUNCHER_DATA_DIR: tmpDir(t) };
  const { stop } = await start('dev', env, {
    extraArgs: ['--archive-base', fake.base, '--overrides-url', `${fake.base}/o.json`, '--uploaders-url', `${fake.base}/u.json`],
    print: (l) => out.push(l),
  });
  t.after(stop);
  const text = out.join('');
  const api = /backend\s+(\S+)\s+token tok/.exec(text)?.[1];
  assert.ok(api, text);
  const res = await fetch(`${api}/health`, { headers: { authorization: 'Bearer tok' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const page = /new UI\s+(\S+)/.exec(text)[1];
  assert.equal((await fetch(page)).status, 200);
});

test('backend and frontend modes start only their half', async (t) => {
  const fake = await fakeArchive(t);
  const env = { LAUNCHER_PORT: '0', FRONTEND_PORT: '0', LAUNCHER_DATA_DIR: tmpDir(t) };
  const opts = (out) => ({
    extraArgs: ['--archive-base', fake.base, '--overrides-url', `${fake.base}/o.json`, '--uploaders-url', `${fake.base}/u.json`],
    print: (l) => out.push(l),
  });

  const b = [];
  await (await start('backend', env, opts(b))).stop();
  assert.match(b.join(''), /^backend /);
  assert.doesNotMatch(b.join(''), /frontend/);

  const f = [];
  await (await start('frontend', env, opts(f))).stop();
  assert.doesNotMatch(f.join(''), /^backend /m);
  assert.match(f.join(''), /expects the backend at http:\/\/127\.0\.0\.1:0\/v1/);
});

test('a port in use fails the start and stops what already started', async (t) => {
  const taken = await startFrontend({ frontendPort: 0 });
  t.after(taken.close);
  const fake = await fakeArchive(t);
  const env = { LAUNCHER_PORT: '0', FRONTEND_PORT: new URL(taken.url).port, LAUNCHER_DATA_DIR: tmpDir(t) };
  await assert.rejects(start('dev', env, {
    extraArgs: ['--archive-base', fake.base, '--overrides-url', `${fake.base}/o.json`, '--uploaders-url', `${fake.base}/u.json`],
    print: () => {},
  }), /EADDRINUSE/);
});
