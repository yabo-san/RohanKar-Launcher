'use strict';
/**
 * Preloaded into the Electron main process by the e2e tests (`-r`), before main.js.
 *
 * - Points userData at E2E_USER_DATA so each run gets a fresh settings.json.
 * - Answers archive.org requests from fixtures/search.json instead of the
 *   network (CI never calls archive.org): advanced search returns that
 *   uploader's docs, anything else (covers, metadata) gets a 404.
 */

const { app } = require('electron');
const https   = require('https');
const { EventEmitter } = require('events');
const { Readable }     = require('stream');

if (process.env.E2E_USER_DATA) app.setPath('userData', process.env.E2E_USER_DATA);

const fixtures = require('./fixtures/search.json');
const realGet  = https.get;

const respond = (status, body, contentType) => {
  const res = Readable.from([Buffer.from(body)]);
  res.statusCode = status;
  res.headers    = { 'content-type': contentType, date: new Date().toUTCString() };
  return res;
};

// advancedsearch.php?q=uploader:<id> mediatype:software&rows=..&page=..
const search = (url) => {
  const uploader = /uploader:(\S+)/.exec(url.searchParams.get('q') || '')?.[1];
  const docs = fixtures[uploader];
  if (!docs) return respond(404, `no fixture for ${uploader}`, 'text/plain');
  const rows  = Number(url.searchParams.get('rows')) || 50;
  const page  = Number(url.searchParams.get('page')) || 1;
  const json  = { response: { numFound: docs.length, start: (page - 1) * rows, docs: docs.slice((page - 1) * rows, page * rows) } };
  return respond(200, JSON.stringify(json), 'application/json');
};

https.get = function (target, ...rest) {
  const url = new URL(String(target));
  if (url.hostname !== 'archive.org') return realGet.call(this, target, ...rest);

  const callback = rest.find(a => typeof a === 'function');
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy    = () => req;
  const res = url.pathname === '/advancedsearch.php' ? search(url) : respond(404, 'not in fixtures', 'text/plain');
  process.nextTick(() => callback?.(res));
  return req;
};
