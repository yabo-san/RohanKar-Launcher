'use strict';
/**
 * Covers and hero banners, downloaded once into thumbcache/. Both come from
 * one order: the overrides.json pin (artUrl for the cover, hero for the
 * banner), else the archive.org item's own image, else catalog/art.json's
 * SteamGridDB art. Everything here returns a path on disk (or null); the IPC
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

// catalog/art.json's pick for an item. For the hero, the banner picked for it
// (the one the Home page shows) wins. Otherwise its first curated grid (or
// hero), else its first.
function catalogArtUrl(art, identifier, kind) {
  const entry = art?.[identifier];
  if (kind === 'heroes' && typeof entry?.banner?.url === 'string') return entry.banner.url;
  const list = Array.isArray(entry?.[kind]) ? entry[kind].filter(a => typeof a?.url === 'string') : [];
  return (list.find(a => a.curated) || list[0])?.url || null;
}

const FIELD = { cover: 'artUrl', hero: 'hero' };
const KIND  = { cover: 'grids', hero: 'heroes' };

// art: catalog/art.json, keyed by identifier
function createCovers({ cacheDir, appDir, archive, getOverrides, art = {}, log = () => {} }) {
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

  const remoteFile = (prefix, url) => path.join(cacheDir, `${prefix}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}.jpg`);

  // Where an override image lives on disk (bundled, or its cache file), or
  // undefined when the title has no override for that field
  function overridePath(overrides, identifier, field) {
    const src = artSource(overrides?.[identifier]?.[field]);
    if (!src) return undefined;
    if (src.bundled) return { file: path.join(appDir, src.bundled) };
    return { file: remoteFile('override', src.remote), remote: src.remote };
  }

  // Path for an override image, null if it couldn't be fetched, or undefined
  // when the title has no override for that field
  async function overrideArt(identifier, field) {
    const p = overridePath(await getOverrides(), identifier, field);
    if (!p) return undefined;
    return p.remote ? cacheImage(p.remote, p.file) : p.file;
  }

  // The three steps, as places on disk and where to fetch them from
  function steps(identifier, which, overrides) {
    const sgdb = catalogArtUrl(art, identifier, KIND[which]);
    return [
      overridePath(overrides, identifier, FIELD[which]),
      { file: path.join(cacheDir, `${identifier}.jpg`), remote: archive.thumbUrl(identifier) },
      sgdb ? { file: remoteFile('art', sgdb), remote: sgdb } : null,
    ];
  }

  // The cover (which = 'cover') or hero banner (which = 'hero') of an item.
  // A pinned override never falls through: a broken pin shows no art.
  async function resolve(identifier, which) {
    if (!safeName(identifier)) return null;
    const [pin, ia, sgdb] = steps(identifier, which, await getOverrides());
    if (pin) return pin.remote ? cacheImage(pin.remote, pin.file) : pin.file;
    return (await cacheImage(ia.remote, ia.file)) || (sgdb ? cacheImage(sgdb.remote, sgdb.file) : null);
  }

  // Cover and hero already on disk, in the same order, fetching nothing: what
  // the Playnite export points at
  function localArt(identifier, overrides) {
    if (!safeName(identifier)) return { cover: null, hero: null };
    const onDisk = (which) => {
      const [pin, ...rest] = steps(identifier, which, overrides);
      const found = (pin ? [pin] : rest).find(s => s && fs.existsSync(s.file));
      return found ? found.file : null;
    };
    return { cover: onDisk('cover'), hero: onDisk('hero') };
  }

  const thumb = (identifier) => resolve(identifier, 'cover');
  const hero  = (identifier) => resolve(identifier, 'hero');

  return { cacheImage, overrideArt, localArt, thumb, hero };
}

const fileUrl = (p) => (p ? 'file:///' + p.replace(/\\/g, '/') : p);

module.exports = { createCovers, catalogArtUrl, fileUrl, safeName };
