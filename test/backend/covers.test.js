'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createCovers, catalogArtUrl, fileUrl, safeName, wholeImage } = require('../../src/backend/covers');
const { createArchive } = require('../../src/backend/archive');
const { fakeArchive, tmpDir, JPEG } = require('./helpers');

async function setup(t, overrides = {}, routes = {}, art = {}) {
  const fake = await fakeArchive(t, { routes });
  const dir = tmpDir(t);
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(path.join(appDir, 'assets', 'covers'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'assets', 'covers', 'tlr.jpg'), JPEG);
  const covers = createCovers({
    cacheDir: path.join(dir, 'thumbcache'), appDir, archive: createArchive({ base: fake.base }),
    getOverrides: async () => overrides, art: typeof art === 'function' ? art() : art,
  });
  return { fake, dir, appDir, covers };
}

test('thumb: downloads once into the cache, then serves the file', async (t) => {
  const { fake, dir, covers } = await setup(t);
  const p = await covers.thumb('rk-halo');
  assert.equal(p, path.join(dir, 'thumbcache', 'rk-halo.jpg'));
  assert.equal(fs.statSync(p).size, JPEG.length);
  await covers.thumb('rk-halo');
  assert.equal(fake.requests.filter(r => r.includes('rk-halo')).length, 1);
});

test('thumb: 404, non-image and tiny images are not cached', async (t) => {
  const { covers } = await setup(t, {}, {
    '/services/img/html':  (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); },
    '/services/img/tiny':  (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); },
    '/services/img/moved': (req, res) => { res.writeHead(302, { location: '/services/img/real' }); res.end(); },
  });
  assert.equal(await covers.thumb('missing-one'), null);
  assert.equal(await covers.thumb('html'), null);
  assert.equal(await covers.thumb('tiny'), null);
  assert.ok(await covers.thumb('moved'));
  assert.equal(await covers.thumb('../escape'), null);
  assert.equal(await covers.thumb('..'), null);
});

test('overrides: bundled art, remote art, and no fall-through to archive.org', async (t) => {
  const overrides = {
    tlr:    { artUrl: 'assets/covers/tlr.jpg', hero: 'assets/covers/tlr.jpg' },
    remote: { artUrl: 'PLACEHOLDER' },
    broken: { artUrl: 'http://127.0.0.1:1/x.jpg' },
    ignored: { artUrl: 'C:/somewhere/else.jpg' },
  };
  const { fake, appDir, covers } = await setup(t, overrides);
  overrides.remote.artUrl = `${fake.base}/services/img/remote-art`;
  assert.equal(await covers.thumb('tlr'), path.join(appDir, 'assets/covers/tlr.jpg'));
  assert.match(await covers.thumb('remote'), /override-[0-9a-f]{16}\.jpg$/);
  assert.equal(await covers.thumb('broken'), null);
  assert.ok((await covers.thumb('ignored')).endsWith('ignored.jpg'));
  assert.equal(await covers.overrideArt('nothing', 'hero'), undefined);
});

test('cover and hero: the pin, else the archive.org image, else catalog/art.json', async (t) => {
  const missing = (req, res) => { res.writeHead(404); res.end(); };
  const art = {};
  const { fake, dir, appDir, covers } = await setup(t, { tlr: { hero: 'assets/covers/tlr.jpg' } }, {
    '/services/img/sgdb-only': missing, '/services/img/nothing': missing,
  }, () => art);
  const base = fake.base;
  art['sgdb-only'] = {
    grids:  [{ url: `${base}/services/img/grid-a` }, { url: `${base}/services/img/grid-curated`, curated: true }],
    heroes: [{ url: `${base}/services/img/hero-a` }],
  };
  art['with-ia'] = { grids: [{ url: `${base}/services/img/never` }] };

  // pinned hero
  assert.equal(await covers.hero('tlr'), path.join(appDir, 'assets/covers/tlr.jpg'));
  // no pin: the archive.org item's own image, for the cover and the hero alike
  assert.equal(await covers.thumb('with-ia'), path.join(dir, 'thumbcache', 'with-ia.jpg'));
  assert.equal(await covers.hero('with-ia'), path.join(dir, 'thumbcache', 'with-ia.jpg'));
  assert.ok(!fake.requests.some(r => r.includes('never')), 'art.json is not reached while archive.org has an image');
  // no archive.org image: art.json's curated grid, and its hero
  assert.match(await covers.thumb('sgdb-only'), /art-[0-9a-f]{16}\.jpg$/);
  assert.ok(fake.requests.some(r => r.endsWith('/grid-curated')) && !fake.requests.some(r => r.endsWith('/grid-a')));
  assert.match(await covers.hero('sgdb-only'), /art-[0-9a-f]{16}\.jpg$/);
  // none of the three
  assert.equal(await covers.thumb('nothing'), null);
  assert.equal(await covers.hero('nothing'), null);
  assert.equal(await covers.hero('../x'), null);
});

test('localArt: the same order from what is on disk, fetching nothing', async (t) => {
  const { fake, dir, appDir, covers } = await setup(t, {}, {}, { sg: { grids: [{ url: 'https://x/g.jpg' }], heroes: [{ url: 'https://x/h.jpg' }] } });
  const before = fake.requests.length;
  const cache = path.join(dir, 'thumbcache');
  assert.deepEqual(covers.localArt('sg', {}), { cover: null, hero: null });
  fs.writeFileSync(path.join(cache, 'sg.jpg'), 'x');
  assert.deepEqual(covers.localArt('sg', {}), { cover: path.join(cache, 'sg.jpg'), hero: path.join(cache, 'sg.jpg') });
  fs.rmSync(path.join(cache, 'sg.jpg'));
  // an art.json download on disk counts
  const crypto = require('crypto');
  const artFile = path.join(cache, `art-${crypto.createHash('sha1').update('https://x/h.jpg').digest('hex').slice(0, 16)}.jpg`);
  fs.writeFileSync(artFile, 'x');
  assert.equal(covers.localArt('sg', {}).hero, artFile);
  // a pin never falls through, even when it isn't on disk yet
  assert.deepEqual(covers.localArt('sg', { sg: { hero: 'assets/covers/tlr.jpg', artUrl: 'https://x/pin.jpg' } }),
    { cover: null, hero: path.join(appDir, 'assets/covers/tlr.jpg') });
  assert.equal(fake.requests.length, before, 'nothing fetched');
});

test('catalogArtUrl: first curated, else first; nothing for an unknown item or a bad list', () => {
  const art = { a: { grids: [{ url: 'u1' }, { url: 'u2', curated: true }], heroes: [{ url: 'h1' }] }, b: { grids: 'x' }, c: { grids: [{ id: 1 }] } };
  assert.equal(catalogArtUrl(art, 'a', 'grids'), 'u2');
  assert.equal(catalogArtUrl(art, 'a', 'heroes'), 'h1');
  assert.equal(catalogArtUrl({ a: { banner: { url: 'picked' }, heroes: [{ url: 'h1' }] } }, 'a', 'heroes'), 'picked', 'the picked banner wins');
  assert.equal(catalogArtUrl({ a: { banner: { url: 'picked' } } }, 'a', 'grids'), null);
  assert.equal(catalogArtUrl(art, 'b', 'grids'), null);
  assert.equal(catalogArtUrl(art, 'c', 'grids'), null);
  assert.equal(catalogArtUrl(art, 'zz', 'grids'), null);
  assert.equal(catalogArtUrl(null, 'a', 'grids'), null);
});

test('fileUrl and safeName', () => {
  assert.equal(fileUrl('C:\\a\\b.jpg'), 'file:///C:/a/b.jpg');
  assert.equal(fileUrl(null), null);
  assert.equal(safeName('a-b.c_1'), true);
  for (const bad of ['', 'a/b', 'a\\b', '.', '..', null]) assert.equal(safeName(bad), false);
});

test('cacheImage: a write error drops the partial file', async (t) => {
  const { dir, fake, covers } = await setup(t);
  const target = path.join(dir, 'no-such-dir', 'x.jpg');
  assert.equal(await covers.cacheImage(`${fake.base}/services/img/a`, target), null);
});

test('cacheImage: a body cut short is not cached, and a truncated cache file is fetched again', async (t) => {
  const half = JPEG.subarray(0, 1500);
  const { dir, covers } = await setup(t, {}, {
    // claims the whole length, sends half, then ends the connection without an error status
    '/services/img/cut': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': JPEG.length });
      res.write(half);
      setImmediate(() => res.socket.destroy());
    },
  });
  assert.equal(await covers.thumb('cut'), null);
  const cache = path.join(dir, 'thumbcache');
  assert.ok(!fs.existsSync(path.join(cache, 'cut.jpg')), 'no partial file left as the cover');
  assert.ok(!fs.existsSync(path.join(cache, 'cut.jpg.part')), 'no .part left behind');

  // a truncated file from an older build is replaced by a fresh download
  fs.writeFileSync(path.join(cache, 'rk-old.jpg'), Buffer.concat([JPEG.subarray(0, 1500), Buffer.alloc(10)]));
  const p = await covers.thumb('rk-old');
  assert.equal(fs.readFileSync(p).length, JPEG.length);
});

test('wholeImage: needs the JPEG end marker or the PNG IEND chunk', (t) => {
  const dir = require('./helpers').tmpDir(t);
  const file = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };
  assert.equal(wholeImage(file('ok.jpg', JPEG)), true);
  assert.equal(wholeImage(file('cut.jpg', JPEG.subarray(0, 1500))), false);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048), Buffer.from('IEND'), Buffer.alloc(4)]);
  assert.equal(wholeImage(file('ok.png', png)), true);
  assert.equal(wholeImage(file('cut.png', png.subarray(0, 1500))), false);
  assert.equal(wholeImage(file('tiny.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))), false);
  assert.equal(wholeImage(path.join(dir, 'missing.jpg')), false);
});
