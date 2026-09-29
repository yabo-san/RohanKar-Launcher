'use strict';
/**
 * Answers https.get for archive.org and raw.githubusercontent.com from
 * fixtures.js instead of the network (CI never calls archive.org). Loaded
 * into the backend process by backend-entry.js; the backend calls https.get
 * at request time, so it sees the stub.
 */
const https = require('https');
const { EventEmitter } = require('events');
const { Readable }     = require('stream');
const { answer }       = require('./fixtures');

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
