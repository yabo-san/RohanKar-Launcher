'use strict';
/**
 * archive.org as the e2e tests see it, from fixtures/search.json:
 *   - advancedsearch.php?q=uploader:<id> ... returns that uploader's docs
 *   - /metadata/<id> lists one <id>.zip, and /download/<id>/<id>.zip is fixtures/tiny.zip
 *   - Quiver's lists (…/quiver-community-app-catalog/…/<file>, or /quiver/<file>) come
 *     from fixtures/quiver/; a list with no fixture is a 404
 *   - anything else (covers, overrides.json, uploaders.json) is a 404, so the
 *     bundled copies are used
 * Shared by archive-stub.js (inside Electron) and fixture-server.js (over HTTP).
 */
const fs   = require('fs');
const path = require('path');

const SEARCH   = require('./fixtures/search.json');
const TINY_ZIP = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.zip'));

// URL → { status, type, body }
function answer(url) {
  const reply = (status, body, type) => ({ status, type, body: Buffer.from(body) });

  if (url.pathname === '/advancedsearch.php') {
    const uploader = /uploader:(\S+)/.exec(url.searchParams.get('q') || '')?.[1];
    const docs = SEARCH[uploader];
    if (!docs) return reply(404, `no fixture for ${uploader}`, 'text/plain');
    const rows = Number(url.searchParams.get('rows')) || 50;
    const page = Number(url.searchParams.get('page')) || 1;
    const json = { response: { numFound: docs.length, start: (page - 1) * rows, docs: docs.slice((page - 1) * rows, page * rows) } };
    return reply(200, JSON.stringify(json), 'application/json');
  }

  if (url.pathname.startsWith('/quiver/') || url.pathname.includes('/quiver-community-app-catalog/')) {
    const fixture = path.join(__dirname, 'fixtures', 'quiver', path.basename(url.pathname));
    return fs.existsSync(fixture) ? reply(200, fs.readFileSync(fixture), 'application/json') : reply(404, 'no fixture', 'text/plain');
  }

  const [, kind, id, file] = url.pathname.split('/');
  if (kind === 'metadata') return reply(200, JSON.stringify({ files: [{ name: `${id}.zip`, size: String(TINY_ZIP.length) }] }), 'application/json');
  if (kind === 'download' && file === `${id}.zip`) return reply(200, TINY_ZIP, 'application/zip');
  return reply(404, 'not in fixtures', 'text/plain');
}

module.exports = { answer, SEARCH, TINY_ZIP };
