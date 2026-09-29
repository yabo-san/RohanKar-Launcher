'use strict';
/**
 * Smoke test against the unpacked build (electron-builder --dir), the app as
 * the installer ships it. Run with E2E_APP set to its executable.
 *
 * A packaged app ignores `-r`, so archive-stub.js is loaded through the Node
 * inspector instead: start paused (--inspect-brk), require the stub, resume.
 * The renderer is then driven over the Chromium DevTools port.
 */

const { test, expect, chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { sourcesFromCatalog } = require('../src/backend/sources.js');
const { formatSources }      = require('../src/frontend/sources.js');

// What a fresh install defaults to: the bundled catalog (the stub 404s the fetched copy)
const DEFAULT_SOURCES = sourcesFromCatalog(require('../catalog/uploaders.json'));

const STUB = path.join(__dirname, 'archive-stub.js');

// Resolves with the first capture of `re` in the process's stderr
function waitForStderr(proc, re) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d;
      const m = re.exec(buf);
      if (m) { proc.stderr.off('data', onData); resolve(m[1]); }
    };
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => reject(new Error(`app exited (${code}) before ${re}:\n${buf}`)));
  });
}

// Minimal CDP client for the Node inspector websocket
function inspector(ws) {
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)));
      else resolve(msg.result);
    } else if (msg.method) {
      const i = waiters.findIndex(w => w.method === msg.method);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg.params);
    }
  });
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    once: (method) => new Promise(resolve => waiters.push({ method, resolve })),
  };
}

async function launchPackaged(userData) {
  const proc = spawn(process.env.E2E_APP, [
    '--inspect-brk=0', '--remote-debugging-port=0',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ], { env: { ...process.env, E2E_USER_DATA: userData }, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.setEncoding('utf8');

  const nodeWs = await waitForStderr(proc, /Debugger listening on (ws:\/\/\S+)/);
  const devtools = waitForStderr(proc, /DevTools listening on ws:\/\/([^/\s]+)\//);

  // Paused before any app code: run the stub in that first frame, then let the app start
  const ws = new WebSocket(nodeWs);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = inspector(ws);
  const paused = cdp.once('Debugger.paused');
  await cdp.call('Debugger.enable');
  await cdp.call('Runtime.runIfWaitingForDebugger');
  const { callFrames } = await paused;
  await cdp.call('Debugger.evaluateOnCallFrame', {
    callFrameId: callFrames[0].callFrameId,
    expression:  `process.getBuiltinModule('module').createRequire(${JSON.stringify(STUB)})(${JSON.stringify(STUB)})`,
  });
  await cdp.call('Debugger.resume');
  ws.close();

  const browser = await chromium.connectOverCDP(`http://${await devtools}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  // Quit through Chromium and wait for the exit, so Windows releases the temp dir's files
  const exited = new Promise(resolve => proc.once('exit', resolve));
  return {
    page,
    close: async () => {
      // Closing the only window quits the app (window-all-closed)
      await page.evaluate(() => globalThis.close()).catch(() => {});
      const timer = setTimeout(() => proc.kill(), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

test.skip(!process.env.E2E_APP, 'E2E_APP is not set');

test('packaged app: launches, shows default sources, downloads a stub item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-smoke-'));
  const userData    = path.join(root, 'userData');
  const downloadDir = path.join(root, 'downloads');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    downloadPath: downloadDir,
    installPath:  path.join(root, 'games'),
  }));

  const app = await launchPackaged(userData);
  try {
    const { page } = app;

    // The window renders the library from the stub
    await expect(page.locator('#library-grid .game-card').first()).toBeVisible({ timeout: 30_000 });

    await page.locator('#btn-settings').click();
    await expect(page.locator('#setting-sources')).toHaveValue(formatSources(DEFAULT_SOURCES));
    await page.locator('#btn-close-settings').click();

    await page.locator('#library-grid .game-card', { hasText: 'Halo: Combat Evolved' }).click();
    await page.locator('#btn-download').click();
    const zip = path.join(downloadDir, 'rk-e2e-halo-ce', 'rk-e2e-halo-ce.zip');
    await expect.poll(() => fs.existsSync(zip) && fs.statSync(zip).size, { timeout: 30_000 })
      .toBe(fs.statSync(path.join(__dirname, 'fixtures', 'tiny.zip')).size);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
