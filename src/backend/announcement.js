'use strict';
/**
 * Announcements: announcement.json on main holds one message,
 * { id, enabled, message, link? }, shown once per id until the user
 * dismisses it. After Quiver's AnnouncementService: edit the file and push to
 * publish without a release; change the id to show it again to people who
 * dismissed the last one. Keys are read case-insensitively, as Quiver does.
 * Dismissed ids live in settings.json (dismissedAnnouncements).
 */

const ANNOUNCEMENT_URL = 'https://raw.githubusercontent.com/yabo-san/RohanKar-Launcher/main/announcement.json';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The announcement to show, or null (disabled, incomplete, not JSON)
function parseAnnouncement(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const get = (key) => data[Object.keys(data).find(k => k.toLowerCase() === key)];
  if (get('enabled') === false) return null;
  const id = str(get('id'));
  const message = str(get('message'));
  if (!id || !message) return null;
  const link = str(get('link'));
  return { id, message, ...(link && /^https:\/\//.test(link) ? { link } : {}) };
}

const isDismissed = (id, dismissed) =>
  Array.isArray(dismissed) && dismissed.some(d => typeof d === 'string' && d.toLowerCase() === id.toLowerCase());

// fetchText(url) resolves to the body or rejects. Never throws: no network
// means no announcement.
async function currentAnnouncement({ fetchText, url = ANNOUNCEMENT_URL, dismissed = [] }) {
  let a;
  try { a = parseAnnouncement(await fetchText(url)); } catch { return null; }
  return a && !isDismissed(a.id, dismissed) ? a : null;
}

module.exports = { ANNOUNCEMENT_URL, parseAnnouncement, currentAnnouncement, isDismissed };
