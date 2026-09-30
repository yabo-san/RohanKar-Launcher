'use strict';
/**
 * Additional sources: what the user adds beyond the curated list (our
 * uploaders, catalog/ and the port shelves). Off unless Settings > "Allow
 * additional sources" is on; the curated list is the default.
 *
 * user.json, a local file named in Settings (docs/USER-SOURCES.md):
 *
 *   { "schemaVersion": 1,
 *     "collisions": [...],  // a GitHub repo + the archive.org data it needs (catalog/collisions.json's shape)
 *     "archive":    [...],  // { identifier, title?, files?: [{ name, sha1? }] }, a standalone archive.org download
 *     "github":     [...] } // { repository, name?, folderName?, assetPattern?, sha1? }, a standalone release binary
 *
 * Rules: every entry is validated on load and a bad one is reported with its
 * reason, never skipped silently; a user entry with the same repository or
 * identifier as a curated one is ignored and reported as a conflict (curated
 * wins); a file with no sha1 is pinned on first install and a later change
 * stops the install until the user accepts it (checkPin).
 */
const fs   = require('fs');
const path = require('path');
const { validateCollision, toRegExp } = require('./ports');

const SCHEMA_VERSION = 1;
const SECTIONS = ['collisions', 'archive', 'github'];
const IA_ID = /^[\w.-]+$/;
const REPO  = /^[\w.-]+\/[\w.-]+$/;
const SHA1  = /^[0-9a-f]{40}$/i;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const optString = (e, k, errs) => { if (e[k] != null && typeof e[k] !== 'string') errs.push(`${k} must be a string`); };
const optSha1 = (v, at, errs) => { if (v != null && !(typeof v === 'string' && SHA1.test(v))) errs.push(`${at} must be 40 hex characters`); };

function validateArchive(e) {
  if (!isObj(e)) return ['entry must be an object'];
  const errs = [];
  if (typeof e.identifier !== 'string' || !IA_ID.test(e.identifier.trim())) errs.push('identifier must be an archive.org identifier');
  optString(e, 'title', errs);
  if (e.files != null && !Array.isArray(e.files)) errs.push('files must be an array');
  (Array.isArray(e.files) ? e.files : []).forEach((f, i) => {
    if (!isObj(f)) return errs.push(`files[${i}] must be an object`);
    if (typeof f.name !== 'string' || !f.name.trim()) errs.push(`files[${i}].name must be a file name in the item`);
    optSha1(f.sha1, `files[${i}].sha1`, errs);
  });
  return errs;
}

function validateGithub(e) {
  if (!isObj(e)) return ['entry must be an object'];
  const errs = [];
  if (typeof e.repository !== 'string' || !REPO.test(e.repository.trim())) errs.push('repository must be owner/repo');
  for (const k of ['name', 'folderName']) optString(e, k, errs);
  if (e.assetPattern != null) {
    if (typeof e.assetPattern !== 'string') errs.push('assetPattern must be a string');
    else { try { toRegExp(e.assetPattern); } catch (err) { errs.push(`assetPattern: ${err.message}`); } }
  }
  optSha1(e.sha1, 'sha1', errs);
  return errs;
}

const VALIDATE = { collisions: validateCollision, archive: validateArchive, github: validateGithub };
const keyOf = (section, e) => (section === 'archive' ? e?.identifier : e?.repository);

// { error } for a file that isn't user.json at all; else { entries, invalid },
// where invalid lists every bad entry as { section, index, key, errors }
function validateUserFile(doc) {
  if (!isObj(doc)) return { error: 'user.json must be an object: { "schemaVersion": 1, "collisions": [], "archive": [], "github": [] }' };
  if (doc.schemaVersion !== SCHEMA_VERSION) return { error: `schemaVersion must be ${SCHEMA_VERSION} (found ${JSON.stringify(doc.schemaVersion ?? null)})` };
  const bad = SECTIONS.filter(s => doc[s] != null && !Array.isArray(doc[s]));
  if (bad.length) return { error: `${bad.join(', ')} must be ${bad.length > 1 ? 'arrays' : 'an array'}` };
  const entries = { collisions: [], archive: [], github: [] };
  const invalid = [];
  for (const section of SECTIONS) {
    const seen = new Set();
    (doc[section] || []).forEach((e, index) => {
      const errors = VALIDATE[section](e);
      const key = typeof keyOf(section, e) === 'string' ? keyOf(section, e).trim() : null;
      if (!errors.length && seen.has(key.toLowerCase())) errors.push(`repeats ${key}, listed earlier in ${section}`);
      if (errors.length) return invalid.push({ section, index, key, errors });
      seen.add(key.toLowerCase());
      entries[section].push({ ...e, [section === 'archive' ? 'identifier' : 'repository']: key });
    });
  }
  return { entries, invalid };
}

// Reads the file named in Settings. { file, entries, invalid, error }
function readUserFile(file) {
  const empty = { collisions: [], archive: [], github: [] };
  if (!file) return { file: null, entries: empty, invalid: [], error: null };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) return { file, entries: empty, invalid: [], error: 'user.json must be a file on this computer, not a URL' };
  if (!path.isAbsolute(file)) return { file, entries: empty, invalid: [], error: 'user.json must be a full path' };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, entries: empty, invalid: [], error: e.code === 'ENOENT' ? `No file at ${file}` : e.message }; }
  let doc;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { return { file, entries: empty, invalid: [], error: `Not valid JSON: ${e.message}` }; }
  const v = validateUserFile(doc);
  if (v.error) return { file, entries: empty, invalid: [], error: v.error };
  return { file, entries: v.entries, invalid: v.invalid, error: null };
}

// A repository-keyed user entry the curated list already has is ignored:
// { kept, conflicts: [{ section, key }] }. curated: a Set of lowercase keys
function dropCurated(section, list, curated) {
  const kept = [];
  const conflicts = [];
  for (const e of list) {
    const key = keyOf(section, e);
    if (curated.has(String(key).toLowerCase())) conflicts.push({ section, key });
    else kept.push(e);
  }
  return { kept, conflicts };
}

// A github entry as a collision with no data: it defines a port of its own
const githubAsCollision = (g) => ({
  repository: g.repository,
  name: g.name || g.repository.split('/')[1],
  ...(g.folderName ? { folderName: g.folderName } : {}),
  ...(g.assetPattern ? { assetPattern: g.assetPattern } : {}),
  ...(g.sha1 ? { sha1: g.sha1.toLowerCase() } : {}),
});

// The setting, read the one way everywhere
const additionalAllowed = (settings) => settings.load().allowAdditionalSources === true;

// user.json as the backend sees it, re-read when the file or its path changes
function createUserSources({ settings, log = () => {} }) {
  let cache = null;
  function read() {
    const file = settings.load().userSourcesFile || null;
    let mtime;
    try { mtime = file ? fs.statSync(file).mtimeMs : null; } catch { mtime = null; }
    if (!cache || cache.file !== file || cache.mtime !== mtime) {
      cache = { ...readUserFile(file), mtime };
      if (cache.error) log(`[user.json] ${cache.error}`);
    }
    return cache;
  }
  // Entries in use: none while additional sources are off
  const entries = () => (additionalAllowed(settings) ? read().entries : { collisions: [], archive: [], github: [] });
  return { read, entries, enabled: () => additionalAllowed(settings) };
}

// ─── First-install pins, for files the user's entry gives no sha1 for ────────

// What to do with a downloaded file's sha1 (actual):
//   expected set:  it must match (like curated entries)
//   none pinned:   pin it
//   pin matches:   fine
//   pin differs:   stop, unless the user accepted the change (then re-pin)
// { ok, pin? } or { ok: false, error, changed? }
function checkPin({ file, expected, pinned, actual, accept = false }) {
  if (expected) {
    return expected.toLowerCase() === actual
      ? { ok: true }
      : { ok: false, error: `${file} doesn't match your source's sha1 (sha1 ${actual}, expected ${expected.toLowerCase()})` };
  }
  if (!pinned || pinned === actual) return { ok: true, pin: actual };
  if (accept) return { ok: true, pin: actual };
  return { ok: false, error: `${file} changed since you first installed it`, changed: { file, before: pinned, after: actual } };
}

// pins.json in the data directory: "<item id>\n<file name>" → sha1
function createPins(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const key = (itemId, name) => `${itemId}\n${name}`;
  return {
    get: (itemId, name) => load()[key(itemId, name)] || null,
    set(itemId, name, sha1) {
      const all = load();
      all[key(itemId, name)] = sha1;
      fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2));
      fs.renameSync(file + '.tmp', file);
    },
  };
}

module.exports = {
  SCHEMA_VERSION, validateUserFile, readUserFile, dropCurated, githubAsCollision, additionalAllowed,
  createUserSources, checkPin, createPins,
};
