'use strict';
/**
 * Preloaded into the Electron main process by the packaged smoke test,
 * before main.js (through the inspector; see packaged.smoke.js).
 *
 * - Points userData at E2E_USER_DATA so each run gets a fresh settings.json.
 * - Answers archive.org and raw.githubusercontent.com from fixtures.js
 *   instead of the network (CI never calls archive.org). The backend runs in
 *   this process and calls https.get at request time, so it sees the stub.
 */

const { app } = require('electron');
const https   = require('https');
const { EventEmitter } = require('events');
const { Readable }     = require('stream');
const { answer }       = require('./fixtures');

if (process.env.E2E_USER_DATA) app.setPath('userData', process.env.E2E_USER_DATA);

const realGet = https.get;
const STUBBED_HOSTS = new Set(['archive.org', 'raw.githubusercontent.com']);

https.get = function (target, ...rest) {
  const url = new URL(String(target));
  if (!STUBBED_HOSTS.has(url.hostname)) return realGet.call(this, target, ...rest);

  const callback = rest.find(a => typeof a === 'function');
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy    = () => req;
  const { status, type, body } = answer(url);
  const res = Readable.from([body]);
  res.statusCode = status;
  res.headers    = { 'content-type': type, 'content-length': String(body.length), date: new Date().toUTCString() };
  process.nextTick(() => callback?.(res));
  return req;
};
