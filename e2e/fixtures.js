'use strict';
/**
 * archive.org as the e2e tests see it, from fixtures/search.json:
 *   - advancedsearch.php?q=uploader:<id> ... returns that uploader's docs
 *   - /metadata/<id> lists one <id>.zip, and /download/<id>/<id>.zip is fixtures/tiny.zip
 *   - Quiver's lists (…/quiver-community-app-catalog/…/<file>, or /quiver/<file>) come
 *     from fixtures/quiver/; a list with no fixture is a 404
 *   - GitHub, for the Perfect Dark port: /repos/perfect-dark-pc-port/perfect_dark/releases
 *     lists one Windows zip holding pd.exe, and its archive.org data item holds
 *     PD_ROM, which fixtures/collisions.json expects by sha1
 *   - /metadata/rk-e2e-romset is a ROM set with folders, for the game data editor
 *   - /featured.json is fixtures/featured.json: a wall game, a port and a pick
 *     that isn't on the wall
 *   - anything else (covers, overrides.json, uploaders.json) is a 404, so the
 *     bundled copies are used
 * Shared by archive-stub.js (inside Electron) and fixture-server.js (over HTTP).
 */
const fs   = require('fs');
const path = require('path');

const SEARCH   = require('./fixtures/search.json');
const TINY_ZIP = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.zip'));
const { makeZip } = require('../test/backend/helpers');
const PD_ROM   = 'PERFECT DARK FIXTURE ROM\n';
const PD_BUILD = makeZip({ 'pd.exe': 'MZ', 'data/.keep': '' });
const PD_DATA  = makeZip({ 'Perfect Dark/pd.ntsc-final.z64': PD_ROM, 'Perfect Dark/readme.txt': 'fixture' });

// URL → { status, type, body }; base is where this server answers, for the
// asset links in a release
function answer(url, base = '') {
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

  if (url.pathname === '/repos/perfect-dark-pc-port/perfect_dark/releases') {
    return reply(200, JSON.stringify([{ tag_name: 'v1.0', assets: [
      { name: 'pd-x86_64-linux.tar.gz', browser_download_url: `${base}/gh/pd-x86_64-linux.tar.gz` },
      { name: 'pd-x86_64-windows.zip', browser_download_url: `${base}/gh/pd-x86_64-windows.zip` },
    ] }]), 'application/json');
  }
  if (url.pathname === '/gh/pd-x86_64-windows.zip') return reply(200, PD_BUILD, 'application/zip');
  if (decodeURIComponent(url.pathname) === '/download/perfect-dark-pc-port_202510/Perfect Dark PC Port.zip') return reply(200, PD_DATA, 'application/zip');

  if (url.pathname === '/featured.json') {
    return reply(200, fs.readFileSync(path.join(__dirname, 'fixtures', 'featured.json')), 'application/json');
  }
  const [, kind, id, file] = url.pathname.split('/');
  if (kind === 'metadata' && id === 'rk-e2e-romset') return reply(200, JSON.stringify({ files: ROMSET }), 'application/json');
  if (kind === 'metadata') return reply(200, JSON.stringify({ files: [{ name: `${id}.zip`, size: String(TINY_ZIP.length) }] }), 'application/json');
  if (kind === 'download' && file === `${id}.zip`) return reply(200, TINY_ZIP, 'application/zip');
  return reply(404, 'not in fixtures', 'text/plain');
}

// Shaped like a real ROM-set item, archive.org's bookkeeping files included
const ROMSET = [
  { name: 'Nintendo 64/Banjo-Kazooie (USA).z64', source: 'original', size: '16777216', sha1: '1fe1632098865f639e22c11b9a81ee8f29c75d7a' },
  { name: 'Nintendo 64/Perfect Dark (USA).z64', source: 'original', size: '33554432', sha1: 'a'.repeat(40) },
  { name: 'Nintendo 64/Textures/bk-hd.png', source: 'original', size: '2048' },
  { name: 'Full Rip.zip', source: 'original', size: '734003200', sha1: 'b'.repeat(40) },
  { name: 'rk-e2e-romset_meta.xml', source: 'metadata', size: '900' },
  { name: '__ia_thumb.jpg', source: 'original', size: '4000' },
];

module.exports = { answer, SEARCH, TINY_ZIP, PD_ROM };
