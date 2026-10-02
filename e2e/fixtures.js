'use strict';
/**
 * archive.org as the e2e tests see it, from fixtures/search.json:
 *   - advancedsearch.php?q=uploader:<id> ... returns that uploader's docs
 *   - /metadata/<id> lists one <id>.zip, and /download/<id>/<id>.zip is fixtures/tiny.zip
 *   - GitHub, for the Perfect Dark port: /repos/perfect-dark-pc-port/perfect_dark/releases
 *     lists one Windows zip laid out like the real one (pd-x86_64-windows/ with
 *     three exes)
 *   - GitLab, for Star Fox 64: Recompiled: /projects/sonicdcer%2FStarfox64Recomp/releases is
 *     test/fixtures/gitlab's copy of the real response, its links pointing here; the Windows
 *     link is a zip with no extension, as on GitLab
 *   - /featured.json is fixtures/featured.json: a wall game (with a pinned
 *     banner), a port and a pick not on the wall; /banners.json is
 *     fixtures/banners.json, whose entry for the wall game the pin overrides
 *   - /curated-ports.json is fixtures/curated-ports.json: the curated shelf
 *   - /announcement.json is fixtures/announcement.json: one message with a link
 *   - /metadata/rk-e2e-user-demo is the archive.org item fixtures/user.json adds
 *   - anything else (covers, overrides.json, uploaders.json) is a 404, so the
 *     bundled copies are used
 * Shared by archive-stub.js (inside Electron) and fixture-server.js (over HTTP).
 */
const fs   = require('fs');
const path = require('path');

const SEARCH   = require('./fixtures/search.json');
const TINY_ZIP = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.zip'));
const { makeZip } = require('../test/backend/helpers');
// Star Fox 64: Recompiled's Windows link: a zip, served without an extension
const SF64_BUILD = makeZip({ 'Starfox64Recompiled.exe': 'MZ', 'assets/.keep': '' });
// Laid out like the real release: one folder, three exes, a data folder
const PD_BUILD = makeZip({
  'pd-x86_64-windows/pd.x86_64.exe': 'MZ', 'pd-x86_64-windows/pd.pal.x86_64.exe': 'MZ', 'pd-x86_64-windows/pd.jpn.x86_64.exe': 'MZ',
  'pd-x86_64-windows/SDL2.dll': 'DLL', 'pd-x86_64-windows/data/put_your_rom_here.txt': 'fixture',
});

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

  if (url.pathname === '/repos/perfect-dark-pc-port/perfect_dark/releases') {
    return reply(200, JSON.stringify([{ tag_name: 'v1.0', assets: [
      { name: 'pd-x86_64-linux.tar.gz', browser_download_url: `${base}/gh/pd-x86_64-linux.tar.gz` },
      { name: 'pd-x86_64-windows.zip', browser_download_url: `${base}/gh/pd-x86_64-windows.zip` },
    ] }]), 'application/json');
  }
  if (url.pathname === '/gh/pd-x86_64-windows.zip') return reply(200, PD_BUILD, 'application/zip');

  if (url.pathname === '/projects/sonicdcer%2FStarfox64Recomp/releases') {
    const releases = require('../test/fixtures/gitlab/starfox64recomp-releases.json').map(r => ({ ...r, assets: { ...r.assets,
      links: r.assets.links.map(l => ({ ...l, direct_asset_url: l.direct_asset_url.replace('https://gitlab.com', base) })) } }));
    return reply(200, JSON.stringify(releases), 'application/json');
  }
  if (url.pathname.startsWith('/sonicdcer/Starfox64Recomp/-/package_files/')) return reply(200, SF64_BUILD, 'application/zip');

  if (url.pathname === '/announcement.json') {
    return reply(200, fs.readFileSync(path.join(__dirname, 'fixtures', 'announcement.json')), 'application/json');
  }
  if (url.pathname === '/curated-ports.json') {
    return reply(200, fs.readFileSync(path.join(__dirname, 'fixtures', 'curated-ports.json')), 'application/json');
  }
  if (url.pathname === '/featured.json' || url.pathname === '/banners.json') {
    return reply(200, fs.readFileSync(path.join(__dirname, 'fixtures', url.pathname.slice(1))), 'application/json');
  }
  const [, kind, id, file] = url.pathname.split('/');
  if (kind === 'metadata' && id === 'rk-e2e-user-demo') {
    return reply(200, JSON.stringify({ metadata: { title: 'User Demo', uploader: 'someone@example.com', date: '2024' }, files: [{ name: `${id}.zip`, size: String(TINY_ZIP.length) }] }), 'application/json');
  }
  if (kind === 'metadata') return reply(200, JSON.stringify({ files: [{ name: `${id}.zip`, size: String(TINY_ZIP.length) }] }), 'application/json');
  if (kind === 'download' && file === `${id}.zip`) return reply(200, TINY_ZIP, 'application/zip');
  return reply(404, 'not in fixtures', 'text/plain');
}

module.exports = { answer, SEARCH, TINY_ZIP };
