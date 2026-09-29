'use strict';
/**
 * Featured picks: the hand-picked games and ports that lead the New page.
 * catalog/featured.json holds { picks: [{ identifier } | { repository }, ...] }
 * in display order; identifier is an archive.org item on the wall, repository
 * a port's GitHub owner/repo. An optional blurb replaces the item's own
 * description on the card. The copy on main is fetched at launch; the one
 * bundled with the app is the fallback.
 */

const FEATURED_URL = 'https://raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/catalog/featured.json';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parseFeatured(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.picks)) throw new Error('featured.json must be { picks: [...] }');
  return data.picks.flatMap((p) => {
    const identifier = str(p?.identifier);
    const repository = str(p?.repository)?.toLowerCase() || null;
    if (!identifier && !repository) return [];
    return [{ ...(identifier ? { identifier } : { repository }), blurb: str(p.blurb) }];
  });
}

// fetchText(url) resolves to the body or rejects; readBundled() returns the bundled text or throws
async function loadFeatured({ fetchText, readBundled, log = () => {}, url = FEATURED_URL }) {
  try {
    const picks = parseFeatured(await fetchText(url));
    log(`[featured] ${picks.length} from ${url}`);
    return picks;
  } catch (e) {
    log(`[featured] fetch failed (${e.message}), using bundled copy`);
  }
  try {
    const picks = parseFeatured(readBundled());
    log(`[featured] ${picks.length} from bundled copy`);
    return picks;
  } catch (e) {
    log(`[featured] no bundled copy (${e.message}), no picks`);
    return [];
  }
}

module.exports = { FEATURED_URL, parseFeatured, loadFeatured };
