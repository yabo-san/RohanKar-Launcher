'use strict';
/**
 * Preloaded into the Electron main process by the packaged smoke test,
 * before main.js (through the inspector; see packaged.smoke.js).
 *
 * - Points userData at E2E_USER_DATA so each run gets a fresh settings.json.
 * - Starts the backend through backend-entry.js, which loads https-stub.js
 *   into the backend process first, so archive.org and the catalog fetches
 *   are answered from fixtures.js instead of the network.
 */

const { app, utilityProcess } = require('electron');
const path = require('path');

if (process.env.E2E_USER_DATA) app.setPath('userData', process.env.E2E_USER_DATA);

const realFork = utilityProcess.fork;
utilityProcess.fork = function (modulePath, args, options = {}) {
  return realFork.call(this, path.join(__dirname, 'backend-entry.js'), args, {
    ...options,
    env: { ...(options.env || process.env), E2E_BACKEND_MAIN: modulePath },
  });
};
