'use strict';
// The backend as the desktop app's utility process: the listening message,
// OS actions answered by the app, updater status and messages it ignores.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { run } = require('../../src/backend/main');
const { connectParent, HOST_METHODS } = require('../../src/backend/parent');
const { fakeArchive, tmpDir } = require('./helpers');

// process.parentPort as the backend sees it, plus the app's side of it
function fakePort() {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = (msg) => { port.sent.push(msg); port.emit('sent', msg); };
  port.deliver = (data) => port.emit('message', { data });
  return port;
}

// Answers every host call with answer(method, args)
function answerHost(port, answer) {
  port.on('sent', async (msg) => {
    if (msg.type !== 'host') return;
    try {
      port.deliver({ type: 'host-result', id: msg.id, ok: true, value: await answer(msg.method, msg.args) });
    } catch (e) {
      port.deliver({ type: 'host-result', id: msg.id, ok: false, error: { message: e.message, code: e.code } });
    }
  });
}

async function startChild(t, port) {
  const fake = await fakeArchive(t);
  const dataDir = tmpDir(t);
  const srv = await run(['--data-dir', dataDir, '--archive-base', fake.base,
    '--overrides-url', `${fake.base}/o.json`, '--uploaders-url', `${fake.base}/u.json`],
  { LAUNCHER_TOKEN: 'tok' }, () => {}, { parent: port });
  t.after(() => srv.stop());
  const call = async (method, p, body) => {
    const res = await fetch(`${srv.url}${p}`, {
      method,
      headers: { authorization: 'Bearer tok', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { srv, call };
}

test('parent: reports where it listens, then OS actions go to the app', async (t) => {
  const port = fakePort();
  const calls = [];
  answerHost(port, (method, args) => {
    calls.push([method, ...args]);
    if (method === 'chooseFolder') return 'D:\\Games';
    if (method === 'addToSteam') return { ok: true, alreadyAdded: true };
    return null;
  });
  const { srv, call } = await startChild(t, port);

  assert.deepEqual(port.sent[0], { type: 'listening', port: srv.port, token: 'tok', url: srv.url });
  assert.deepEqual((await call('POST', '/os/choose-folder')).body, { path: 'D:\\Games' });
  assert.equal((await call('POST', '/os/window', { action: 'minimize' })).status, 200);
  assert.deepEqual((await call('POST', '/os/add-to-steam', { appName: 'a', exePath: 'b', startDir: 'c' })).body, { ok: true, alreadyAdded: true });
  assert.deepEqual(calls, [['chooseFolder'], ['window', 'minimize'], ['addToSteam', { appName: 'a', exePath: 'b', startDir: 'c' }]]);
});

test('parent: the app\'s errors come back with their code', async (t) => {
  const port = fakePort();
  answerHost(port, (method) => {
    const e = new Error(method === 'openExternal' ? 'no browser here' : 'dialog broke');
    if (method === 'openExternal') e.code = 'unsupported';
    throw e;
  });
  const { call } = await startChild(t, port);
  const r = await call('POST', '/os/open-external', { url: 'https://archive.org' });
  assert.deepEqual([r.status, r.body.detail], [501, 'no browser here']);
  assert.equal((await call('POST', '/os/choose-folder')).status, 500);
});

test('parent: updater status from the app is served and ignored noise is harmless', async (t) => {
  const port = fakePort();
  const { call } = await startChild(t, port);
  port.deliver({ type: 'updater', status: { status: 'available', version: '9.0.0' } });
  port.deliver(null);
  port.deliver({ type: 'host-result', id: 999, ok: true });
  port.emit('message', { type: 'nothing-listens-for-this' });
  assert.deepEqual((await call('GET', '/os/updater')).body, { status: { status: 'available', version: '9.0.0' } });
});

test('connectParent: every host method is a call to the app; a failure without detail still rejects', async () => {
  const port = fakePort();
  const { host, on } = connectParent(port);
  assert.deepEqual(Object.keys(host), HOST_METHODS);
  const seen = [];
  on('shutdown', (m) => seen.push(m.type));
  port.deliver({ type: 'shutdown' });
  assert.deepEqual(seen, ['shutdown']);

  const pending = host.trashItem('C:\\x');
  const { id } = port.sent.at(-1);
  assert.deepEqual(port.sent.at(-1), { type: 'host', id, method: 'trashItem', args: ['C:\\x'] });
  port.deliver({ type: 'host-result', id, ok: false });
  await assert.rejects(pending, /could not do that/);
});

test('main: runs until SIGTERM, and exits 1 when it cannot start', async (t) => {
  const { main } = require('../../src/backend/main');
  const dataDir = tmpDir(t);
  const argv = process.argv;
  t.after(() => { process.argv = argv; });
  const urls = ['--archive-base', 'http://127.0.0.1:1', '--overrides-url', 'http://127.0.0.1:1/o.json', '--uploaders-url', 'http://127.0.0.1:1/u.json'];
  const signals = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  t.after(() => {
    for (const [sig, kept] of Object.entries(signals)) {
      for (const fn of process.listeners(sig)) if (!kept.includes(fn)) process.off(sig, fn);
    }
  });

  process.argv = ['node', 'main.js', '--data-dir', dataDir, ...urls];
  const printed = [];
  let exited;
  const done = new Promise(r => { exited = r; });
  const quit = await main({ exit: exited, print: (line) => printed.push(line) });
  assert.ok(JSON.parse(printed[0]).port > 0);
  assert.ok(process.listeners('SIGTERM').includes(quit));
  quit();
  assert.equal(await done, 0);

  process.argv = ['node', 'main.js', '--data-dir', dataDir, '--port', '99999', ...urls];
  assert.equal(await new Promise(exit => main({ exit })), 1);

  // A Playnite command exits with its code instead of serving
  process.argv = ['node', 'main.js', '--data-dir', dataDir, ...urls, '--launch', 'x'];
  assert.equal(await new Promise(exit => main({ exit, print: () => {} })), 3);
});

test('parent: the app asks to show an item by its export id or library id', async (t) => {
  const port = fakePort();
  const { srv } = await startChild(t, port);
  srv.backend.library.add('mine', 'manual');
  const uuid = srv.backend.library.exportId('mine');
  port.deliver({ type: 'open-item', id: uuid });
  assert.equal(srv.backend.openRequest, 'mine');
  port.deliver({ type: 'open-item', id: 'rk-e2e-halo-ce' });
  assert.equal(srv.backend.openRequest, 'rk-e2e-halo-ce');
});
