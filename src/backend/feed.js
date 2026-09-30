'use strict';
/**
 * A feed file is what one person curates: ports (GitHub releases, with the
 * archive.org data they need, as collisions) and the archive.org uploaders
 * they trust. docs/COLLISIONS.md has the format.
 *
 *   { "schemaVersion": 1, "collisions": [...], "uploaders": [{ "uploader", "label" }] }
 *
 * Quiver's catalogs are only read; a feed is what users keep, share, import
 * and subscribe to. Uploaders from someone else's feed are listed, never used,
 * until the user trusts each one (it then joins their own uploader list).
 */
const { validateCollision } = require('./ports');

const MAX_UPLOADER = 200;

// A feed's uploaders, as { uploader, label }. Takes our own shape and
// catalog/uploaders.json's ({ uploaderEmail, handle }); drops the rest, and repeats.
function parseUploaders(list) {
  const out = [];
  const seen = new Set();
  for (const u of Array.isArray(list) ? list : []) {
    const raw = typeof u === 'string' ? u : u?.uploader ?? u?.uploaderEmail;
    const uploader = typeof raw === 'string' ? raw.trim() : '';
    if (!uploader || /\s/.test(uploader) || uploader.length > MAX_UPLOADER) continue;
    const key = uploader.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = typeof u === 'object' && typeof (u.label ?? u.handle) === 'string' && (u.label ?? u.handle).trim();
    out.push({ uploader, label: label || uploader.split('@')[0] });
  }
  return out;
}

// A feed document's two halves. collisions keep the shapes parseCollisions reads.
function parseFeed(text) {
  const data = JSON.parse(text);
  const collisions = Array.isArray(data) ? data
    : Array.isArray(data?.collisions) ? data.collisions
    : data && typeof data === 'object'
      ? Object.entries(data).filter(([k, v]) => !k.startsWith('_') && !['schemaVersion', 'uploaders'].includes(k) && v && typeof v === 'object')
        .map(([repository, v]) => ({ repository, ...v }))
      : [];
  return { collisions, uploaders: parseUploaders(data?.uploaders) };
}

// The user's feed: their own collisions and every uploader they have on
const exportFeed = ({ collisions, sources }) => ({
  schemaVersion: 1,
  collisions,
  uploaders: sources.filter(s => s.enabled !== false).map(s => ({ uploader: s.uploader, label: s.label || s.uploader.split('@')[0] })),
});

// sources plus the uploaders not already in it (turned on, or back on).
// { sources, added: [uploader], enabled: [uploader] }
function trustUploaders(sources, incoming) {
  const out = sources.map(s => ({ ...s }));
  const added = [];
  const enabled = [];
  for (const u of incoming) {
    const have = out.find(s => s.uploader.toLowerCase() === u.uploader.toLowerCase());
    if (!have) {
      out.push({ uploader: u.uploader, label: u.label, enabled: true });
      added.push(u.uploader);
    } else if (have.enabled === false) {
      have.enabled = true;
      enabled.push(have.uploader);
    }
  }
  return { sources: out, added, enabled };
}

// Imports a feed file the user picked: its collisions become theirs (saved
// through saveCollision), its uploaders join their list. Returns counts and
// what was rejected.
function importFeed(text, { saveCollision, sources }) {
  let feed;
  try { feed = parseFeed(text); } catch (e) { return { ok: false, error: `Not a feed file: ${e.message}` }; }
  const saved = [];
  const rejected = [];
  for (const c of feed.collisions) {
    const errors = c && typeof c === 'object' ? validateCollision(c) : ['not an object'];
    if (errors.length) { rejected.push({ repository: c?.repository ?? null, errors }); continue; }
    const r = saveCollision(c);
    if (r.ok) saved.push(r.entry.repository);
    else rejected.push({ repository: c.repository, errors: r.errors });
  }
  const trust = trustUploaders(sources, feed.uploaders);
  if (!saved.length && !rejected.length && !feed.uploaders.length) return { ok: false, error: 'The file has no collisions or uploaders' };
  return { ok: true, collisions: saved, rejected, uploaders: [...trust.added, ...trust.enabled], sources: trust.sources };
}

module.exports = { parseUploaders, parseFeed, exportFeed, trustUploaders, importFeed };
