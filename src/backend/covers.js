'use strict';
/**
 * Covers cache: archive.org thumbnails and overrides.json art, downloaded once
 * into thumbcache/. Everything here returns a path on disk (or null); the IPC
 * layer turns it into a file:// URL and the API serves the bytes.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { getFollow } = require('./net');
const { artSource } = require('./overrides');

const MIN_IMAGE_BYTES = 1024;  // smaller than this is an error page, not a cover

// An identifier becomes a file name in the cache: no separators, no dot-only names
const safeName = (s) => typeof s === 'string' && s !== '' && !/[\\/]/.test(s) && !/^\.+$/.test(s);

function createCovers({ cacheDir, appDir, heroesDir = path.join(appDir, 'assets', 'heroes'), archive, getOverrides, log = () => {} }) {
  fs.mkdirSync(cacheDir, { recursive: true });

  // Path of a cached copy of liveUrl, downloading it first if needed. Null on
  // any failure: the caller keeps its placeholder rather than retrying live.
  function cacheImage(liveUrl, cachePath) {
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > MIN_IMAGE_BYTES) return Promise.resolve(cachePath);

    return new Promise((resolve) => {
      getFollow(liveUrl, {
        kind: 'thumb', log, maxRedirects: 5,
        onError: () => resolve(null),
        onResponse: (res) => {
          // Only cache real image responses
          const ct = res.headers['content-type'] || '';
          if (res.statusCode !== 200 || !ct.startsWith('image/')) {
            res.resume();
            return resolve(null);
          }
          const file = fs.createWriteStream(cachePath);
          const drop = () => {
            file.destroy();
            try { fs.unlinkSync(cachePath); } catch { /* never written */ }
            resolve(null);
          };
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            try {
              if (fs.statSync(cachePath).size > MIN_IMAGE_BYTES) return resolve(cachePath);
            } catch { /* vanished */ }
            resolve(null);
          });
          file.on('error', drop);
          res.on('error', drop);  // aborted mid-body (e.g. timeout): drop the partial file
        },
      });
    });
  }

  // Path for an override image, null if it couldn't be fetched, or undefined
  // when the title has no override for that field
  async function overrideArt(identifier, field) {
    const src = artSource((await getOverrides())[identifier]?.[field]);
    if (!src) return undefined;
    if (src.bundled) return path.join(appDir, src.bundled);
    const name = crypto.createHash('sha1').update(src.remote).digest('hex').slice(0, 16);
    return cacheImage(src.remote, path.join(cacheDir, `override-${name}.jpg`));
  }

  // Cover for an item. A title with an artUrl override never falls through to archive.org.
  async function thumb(identifier) {
    if (!safeName(identifier)) return null;
    const override = await overrideArt(identifier, 'artUrl');
    if (override !== undefined) return override;
    return cacheImage(archive.thumbUrl(identifier), path.join(cacheDir, `${identifier}.jpg`));
  }

  // hero.png (or .jpg/.jpeg/.webp) shipped inside an install folder
  function installHero(installDir) {
    if (!installDir) return null;
    for (const name of ['hero.png', 'hero.jpg', 'hero.jpeg', 'hero.webp']) {
      const p = path.join(installDir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // <heroes>/<identifier>.png shipped with the app
  function bundledHero(identifier) {
    if (!safeName(identifier)) return null;
    const p = path.join(heroesDir, `${identifier}.png`);
    return fs.existsSync(p) ? p : null;
  }

  // The hero banner from one place (from = override | install | bundled), or
  // the first of them that has one: an overrides.json hero, then one in the
  // install folder, then one shipped with the app
  async function hero(identifier, installDir, from = null) {
    if (from === 'override') return (await overrideArt(identifier, 'hero')) ?? null;
    if (from === 'install') return installHero(installDir);
    if (from === 'bundled') return bundledHero(identifier);
    return (await overrideArt(identifier, 'hero')) ?? installHero(installDir) ?? bundledHero(identifier);
  }

  return { cacheImage, overrideArt, thumb, installHero, bundledHero, hero };
}

const fileUrl = (p) => (p ? 'file:///' + p.replace(/\\/g, '/') : p);

module.exports = { createCovers, fileUrl, safeName };
