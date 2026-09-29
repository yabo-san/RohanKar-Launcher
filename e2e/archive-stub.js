'use strict';
/**
 * Preloaded into the Electron main process by the e2e tests (`-r`), before main.js.
 *
 * - Points userData at E2E_USER_DATA so each run gets a fresh settings.json.
 * - Answers archive.org requests from fixtures/search.json instead of the
 *   network (CI never calls archive.org): advanced search returns that
 *   uploader's docs, every item's metadata lists one <identifier>.zip, and
 *   downloading it returns fixtures/tiny.zip. Anything else (covers) gets a 404.
 * - Answers the overrides.json fetch with a 404, so the bundled copy is used.
 */

const { app } = require('electron');
const https   = require('https');
const { EventEmitter } = require('events');
const { Readable }     = require('stream');

if (process.env.E2E_USER_DATA) app.setPath('userData', process.env.E2E_USER_DATA);

const path     = require('path');
const fixtures = require('./fixtures/search.json');
const tinyZip  = require('fs').readFileSync(path.join(__dirname, 'fixtures', 'tiny.zip'));
const realGet  = https.get;

const respond = (status, body, contentType) => {
  const buf = Buffer.from(body);
  const res = Readable.from([buf]);
  res.statusCode = status;
  res.headers    = { 'content-type': contentType, 'content-length': String(buf.length), date: new Date().toUTCString() };
  return res;
};

// /metadata/<id> and /download/<id>/<id>.zip
const item = (url) => {
  const [, kind, id, file] = url.pathname.split('/');
  if (kind === 'metadata') return respond(200, JSON.stringify({ files: [{ name: `${id}.zip`, size: String(tinyZip.length) }] }), 'application/json');
  if (kind === 'download' && file === `${id}.zip`) return respond(200, tinyZip, 'application/zip');
  return respond(404, 'not in fixtures', 'text/plain');
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

const STUBBED_HOSTS = new Set(['archive.org', 'raw.githubusercontent.com']);

https.get = function (target, ...rest) {
  const url = new URL(String(target));
  if (!STUBBED_HOSTS.has(url.hostname)) return realGet.call(this, target, ...rest);

  const callback = rest.find(a => typeof a === 'function');
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy    = () => req;
  const res = url.pathname === '/advancedsearch.php' ? search(url) : item(url);
  process.nextTick(() => callback?.(res));
  return req;
};
