'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createCovers, fileUrl, safeName } = require('../../src/backend/covers');
const { createArchive } = require('../../src/backend/archive');
const { fakeArchive, tmpDir, JPEG } = require('./helpers');

async function setup(t, overrides = {}, routes = {}) {
  const fake = await fakeArchive(t, { routes });
  const dir = tmpDir(t);
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(path.join(appDir, 'assets', 'covers'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'assets', 'covers', 'tlr.jpg'), JPEG);
  const covers = createCovers({
    cacheDir: path.join(dir, 'thumbcache'), appDir, archive: createArchive({ base: fake.base }),
    getOverrides: async () => overrides,
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
  let fakeBase;
  const overrides = {
    tlr:    { artUrl: 'assets/covers/tlr.jpg', hero: 'assets/covers/tlr.jpg' },
    remote: { artUrl: 'PLACEHOLDER' },
    broken: { artUrl: 'http://127.0.0.1:1/x.jpg' },
    ignored: { artUrl: 'C:/somewhere/else.jpg' },
  };
  const { fake, appDir, covers } = await setup(t, overrides);
  fakeBase = fake.base;
  overrides.remote.artUrl = `${fakeBase}/services/img/remote-art`;
  assert.equal(await covers.thumb('tlr'), path.join(appDir, 'assets/covers/tlr.jpg'));
  assert.match(await covers.thumb('remote'), /override-[0-9a-f]{16}\.jpg$/);
  assert.equal(await covers.thumb('broken'), null);
  assert.ok((await covers.thumb('ignored')).endsWith('ignored.jpg'));
  assert.equal(await covers.overrideArt('nothing', 'hero'), undefined);
});

test('hero: override first, then hero.* in the install folder', async (t) => {
  const { dir, appDir, covers } = await setup(t, { tlr: { hero: 'assets/covers/tlr.jpg' } });
  const install = path.join(dir, 'game');
  fs.mkdirSync(install);
  assert.equal(await covers.hero('x', install), null);
  fs.writeFileSync(path.join(install, 'hero.webp'), 'x');
  assert.equal(await covers.hero('x', install), path.join(install, 'hero.webp'));
  assert.equal(await covers.hero('tlr', install), path.join(appDir, 'assets/covers/tlr.jpg'));
  assert.equal(covers.installHero(null), null);
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
