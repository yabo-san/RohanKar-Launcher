'use strict';
/**
 * Default sources, what users type for a source, title filters, and grouping
 * by title. The frontend gets sources and items from the API (/v1/sources,
 * /v1/items); its sources.js keeps only display helpers and the Settings text
 * format, and test/backend/sources.test.js checks its getTitle matches this one.
 */

// Default sources from catalog/uploaders.json. An entry is on only when it is
// marked launcher: true, not track: false, and has an uploaderEmail (what
// archive.org's uploader: field matches); everything else ships off.
// handles (every @handle the account goes by) lets a user who types one get
// the curated entry; titleInclude/titleExclude are carried as written.
function sourcesFromCatalog(data) {
  const list = Array.isArray(data?.uploaders) ? data.uploaders : [];
  return list.map(u => {
    const uploader = u?.uploaderEmail || u?.handle;
    if (!uploader) return null;
    const enabled = u.launcher === true && u.track !== false && !!u.uploaderEmail;
    const src = { uploader, label: u.handle || uploader.split('@')[0], enabled };
    const handles = [u.handle, ...(Array.isArray(u.handles) ? u.handles : [])].filter(h => typeof h === 'string' && h);
    if (u.uploaderEmail && handles.length) src.handles = [...new Set(handles)];
    for (const k of ['titleInclude', 'titleExclude']) if (typeof u[k] === 'string' && u[k].trim()) src[k] = u[k].trim();
    return src;
  }).filter(Boolean);
}

// The saved list when settings.json has one, else the catalog defaults
function sourcesFromSettings(settings, defaults = []) {
  return Array.isArray(settings.sources) ? settings.sources.filter(x => x && x.uploader) : defaults;
}

// ─── What users type: uploaders, single uploads, title filters ──────────────

const IA_ID  = /^[\w.-]+$/;
const EMAIL  = /^[^@\s/?#"]+@[^@\s/?#"]+$/;
const HANDLE = /^[\w.-]+$/;
// An archive.org page, with or without scheme and www.: path, query, fragment
const IA_URL = /^(?:https?:\/\/)?(?:www\.)?archive\.org(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const pathParts = (p) => (p || '').split('/').filter(Boolean).map(decode);

// An archive.org identifier from an identifier or an item URL
// (https://archive.org/details/<id>, /download/<id>/<file>, /metadata/<id>,
// /embed/<id>; http, www., trailing slashes, query strings and fragments are
// fine). null for anything else, a profile URL (/details/@name) included.
function itemIdFrom(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return null;
  const url = IA_URL.exec(s);
  if (!url) return IA_ID.test(s) ? s : null;
  const [kind, id] = pathParts(url[1]);
  if (!['details', 'download', 'metadata', 'embed'].includes(kind) || !id) return null;
  return IA_ID.test(id) ? id : null;
}

// What one Settings uploader names, normalized:
//   { kind: 'email',  value: 'me@example.com', key }  queried with uploader:<email>
//   { kind: 'handle', value: 'name', key: '@name' }   an account's uploads, by @handle
//   { kind: 'item',   value: '<identifier>', key }    a single upload (an item URL)
//   { error }                                         anything else
// Accepts an email; @handle; a bare name (archive.org's uploader: field is the
// account's email, so a name without @ can only be a handle); a profile URL
// (archive.org/details/@name or archive.org/@name, with /uploads, a query
// string or a fragment after it); a search URL for uploader:"<email>"; and an
// item URL. key is the lowercase form two sources match on.
function normalizeUploader(input) {
  const s = typeof input === 'string' ? input.trim().replace(/^mailto:/i, '') : '';
  if (!s) return { error: 'no uploader' };
  const out = (kind, value) => ({ kind, value, key: (kind === 'handle' ? '@' : '') + value.toLowerCase() });
  if (EMAIL.test(s)) return out('email', s);
  const url = IA_URL.exec(s);
  if (url) {
    const parts = pathParts(url[1]);
    const profile = parts[0] === 'details' ? parts[1] : parts[0];
    if (profile?.startsWith('@') && HANDLE.test(profile.slice(1))) return out('handle', profile.slice(1));
    const params = new URLSearchParams(url[2] || '');
    const query = params.get('query') || params.get('q') || '';
    const email = /uploader:\s*"?([^"\s)]+)"?/i.exec(query)?.[1];
    if (email && EMAIL.test(email)) return out('email', email);
    const id = itemIdFrom(s);
    if (id) return out('item', id);
    return { error: `${s} isn't an archive.org profile, uploader search or item` };
  }
  const bare = s.replace(/^@/, '');
  if (HANDLE.test(bare)) return out('handle', bare);
  return { error: `${s} isn't an email, @handle or archive.org URL` };
}

// Every key a source answers to: its own, and a curated entry's @handles
function sourceKeys(src) {
  const n = normalizeUploader(src?.uploader);
  const keys = n.error ? [] : [n.key];
  for (const h of Array.isArray(src?.handles) ? src.handles : []) {
    const k = normalizeUploader('@' + String(h).replace(/^@/, ''));
    if (!k.error) keys.push(k.key);
  }
  return keys;
}

// Pipe-separated substrings ("DVD|PS2"), as catalog/uploaders.json and the
// Settings line write them, or arrays of them: one lowercase list
const terms = (...lists) => lists.flatMap(l => (Array.isArray(l) ? l : String(l ?? '').split('|')))
  .map(t => String(t).trim().toLowerCase()).filter(Boolean);

// Filter strings joined, repeats and blanks dropped: ('a|B', 'b', '') -> 'a|b'
const joinTerms = (...lists) => [...new Set(terms(...lists))].join('|');

// Whether an upload's title passes a source's filters, case-insensitive:
// with a titleInclude, one of its substrings must appear; no titleExclude
// substring may. The archive.org title is what's matched, not a rename.
function titleAllowed(title, { titleInclude, titleExclude } = {}) {
  const t = (Array.isArray(title) ? title.join(' ') : String(title ?? '')).toLowerCase();
  const inc = terms(titleInclude);
  if (inc.length && !inc.some(w => t.includes(w))) return false;
  return !terms(titleExclude).some(w => t.includes(w));
}

// An overrides.json title (attached as _override) replaces the archive.org one
function getTitle(game) {
  if (game._override?.title) return game._override.title;
  const t = Array.isArray(game.title) ? game.title[0] : game.title;
  return (t && String(t).trim()) || game.identifier?.replace(/-/g, ' ') || 'Unknown';
}

// Same game from different uploaders → one entry. Key is the title with case,
// punctuation, "the", and trailing bracketed tags like "(v1.2)" removed.
function titleKey(game) {
  return getTitle(game).toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

module.exports = {
  sourcesFromCatalog, sourcesFromSettings, getTitle, titleKey,
  itemIdFrom, normalizeUploader, sourceKeys, titleAllowed, joinTerms,
};
