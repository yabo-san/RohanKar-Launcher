'use strict';
/**
 * y4bo — overrides.js
 * Per-title overrides keyed by archive.org identifier: { title?, artUrl?, hero? }.
 * The copy on main is fetched at launch; the one bundled with the app is the fallback.
 */
const path = require('path');

const OVERRIDES_URL = 'https://raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/overrides.json';

function parseOverrides(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('overrides.json must be an object keyed by identifier');
  }
  return data;
}

// fetchText(url) resolves to the body or rejects; readBundled() returns the bundled text or throws
async function loadOverrides({ fetchText, readBundled, log = () => {}, url = OVERRIDES_URL }) {
  try {
    const fetched = parseOverrides(await fetchText(url));
    log(`[overrides] ${Object.keys(fetched).length} from ${url}`);
    return fetched;
  } catch (e) {
    log(`[overrides] fetch failed (${e.message}), using bundled copy`);
  }
  try {
    const bundled = parseOverrides(readBundled());
    log(`[overrides] ${Object.keys(bundled).length} from bundled copy`);
    return bundled;
  } catch (e) {
    log(`[overrides] no bundled copy (${e.message}), none applied`);
    return {};
  }
}

// An absolute URL is fetched and cached; a path under assets/covers/ ships with the app.
// Anything else is ignored.
function artSource(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^https?:\/\//i.test(value)) return { remote: value };
  const rel = path.posix.normalize(value.replace(/\\/g, '/'));
  return rel.startsWith('assets/covers/') ? { bundled: rel } : null;
}

module.exports = { OVERRIDES_URL, parseOverrides, loadOverrides, artSource };
