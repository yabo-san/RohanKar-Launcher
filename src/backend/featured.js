'use strict';
/**
 * Featured picks: the hand-picked games and ports that lead the Home page.
 * catalog/featured.json holds { picks: [{ identifier } | { repository }, ...] }
 * in display order; identifier is an archive.org item on the wall, repository
 * a port's GitHub owner/repo. An optional blurb replaces the item's own
 * description on the card.
 *
 * Each pick's banner is a SteamGridDB hero on its CDN (cdn2.steamgriddb.com):
 * a `banner` pinned on the pick in featured.json wins, else the `banner` on
 * the pick's entry in catalog/art.json (keyed by identifier or lowercase
 * owner/repo, pinned by hand or picked by scripts/box-art/banners.py in CI).
 * Anything else, a SteamGridDB page link included, is dropped here: the
 * workflow resolves page links to CDN URLs in art.json. No banner is null,
 * and the page shows a plain one.
 *
 * The copies on main are fetched at launch (art.json next to featured.json);
 * the ones bundled with the app are the fallback.
 */

const FEATURED_URL = 'https://raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/catalog/featured.json';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// A SteamGridDB CDN image over https, or null
function heroUrl(v) {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && /^cdn\d*\.steamgriddb\.com$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function parseFeatured(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.picks)) throw new Error('featured.json must be { picks: [...] }');
  return data.picks.flatMap((p) => {
    const identifier = str(p?.identifier);
    const repository = str(p?.repository)?.toLowerCase() || null;
    if (!identifier && !repository) return [];
    return [{ ...(identifier ? { identifier } : { repository }), blurb: str(p.blurb), banner: heroUrl(p.banner) }];
  });
}

// art.json: { "<identifier or owner/repo>": { ..., banner?: { url, source, ... } } }
// to a map of key to banner CDN URL. Keys starting with _ are comments.
function parseArtBanners(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('art.json must be an object');
  const out = new Map();
  for (const [key, entry] of Object.entries(data)) {
    const url = !key.startsWith('_') && heroUrl(entry?.banner?.url);
    if (url) out.set(key.includes('/') ? key.toLowerCase() : key, url);
  }
  return out;
}

// A pinned banner on the pick wins, else art.json's
function withBanners(picks, banners) {
  return picks.map(p => ({ ...p, banner: p.banner || banners.get(p.identifier || p.repository) || null }));
}

// Fetched copy, else bundled, else the fallback value
async function loadOne({ name, url, fetchText, readBundled, parse, log, fallback }) {
  try {
    const v = parse(await fetchText(url));
    log(`[${name}] ${v.length ?? v.size} from ${url}`);
    return v;
  } catch (e) {
    log(`[${name}] fetch failed (${e.message}), using bundled copy`);
  }
  try {
    const v = parse(readBundled());
    log(`[${name}] ${v.length ?? v.size} from bundled copy`);
    return v;
  } catch (e) {
    log(`[${name}] no bundled copy (${e.message}), ${name === 'featured' ? 'no picks' : 'none'}`);
    return fallback;
  }
}

// fetchText(url) resolves to the body or rejects; readBundled() and
// readBundledArt() return the bundled text or throw
async function loadFeatured({
  fetchText, readBundled, readBundledArt = () => '{}', log = () => {},
  url = FEATURED_URL, artUrl = url.replace(/featured\.json$/, 'art.json'),
}) {
  const picks = await loadOne({ name: 'featured', url, fetchText, readBundled, parse: parseFeatured, log, fallback: [] });
  if (!picks.length) return picks;
  const banners = await loadOne({ name: 'banners', url: artUrl, fetchText, readBundled: readBundledArt, parse: parseArtBanners, log, fallback: new Map() });
  return withBanners(picks, banners);
}

module.exports = { FEATURED_URL, heroUrl, parseFeatured, parseArtBanners, withBanners, loadFeatured };
