'use strict';
/**
 * archive.org client: advanced search with retry and paging, an account's uploads by @handle, item metadata,
 * reviews. Every response is logged to archive-net.log by kind.
 */
const { getText } = require('./net');
const { normalizeUploader } = require('./sources');

const SEARCH_PAGE_SIZE  = 500;
const SEARCH_MAX_ITEMS  = 10000;  // advancedsearch won't page past this
const SEARCH_RETRIES    = 3;
const SEARCH_FIELDS     = 'identifier,title,description,date,addeddate,downloads,subject';
const DOC_FIELDS        = SEARCH_FIELDS.split(',');
const UPLOADS_PAGE_SIZE = 100;

// One page of the account uploads list (services/search/beta/page_production,
// page_type=account_details, page_elements=["uploads"]):
//   { response: { body: { page_elements: { uploads: { hits: { total, hits: [{ fields: {...} }] } } } } } }
// as { total, hits: [{ identifier, mediatype, doc }] }, doc in advancedsearch's
// shape (SEARCH_FIELDS). Tolerant of what the endpoint may vary: total as a
// number or { value }, a hit's fields under _source, one-element arrays for
// single values, publicdate standing in for addeddate. Hits with no
// identifier are dropped.
function accountUploads(json) {
  const body = json?.response?.body ?? json?.body ?? {};
  const uploads = body.page_elements?.uploads ?? {};
  const h = uploads.hits ?? {};
  const rawTotal = typeof h.total === 'object' && h.total ? h.total.value : h.total;
  const total = Number.isFinite(Number(rawTotal)) && rawTotal !== null && rawTotal !== '' ? Number(rawTotal) : null;
  const one = (v) => (Array.isArray(v) && v.length <= 1 ? v[0] ?? null : v ?? null);
  const hits = (Array.isArray(h.hits) ? h.hits : []).map(hit => {
    const f = hit?.fields ?? hit?._source ?? {};
    const identifier = one(f.identifier);
    if (typeof identifier !== 'string' || !identifier) return null;
    const doc = {
      identifier,
      title:       one(f.title),
      description: f.description ?? null,
      date:        one(f.date),
      addeddate:   one(f.addeddate) ?? one(f.publicdate),
      downloads:   one(f.downloads),
      subject:     f.subject ?? null,
    };
    return { identifier, mediatype: one(f.mediatype), doc };
  }).filter(Boolean);
  return { total, hits };
}

function createArchive({ base = 'https://archive.org', log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const get = (url, kind, timeoutMs) => getText(url, { kind, log, timeoutMs });

  // One JSON request. { status, json, retryAfter, error }
  async function getJson(url, kind) {
    const r = await get(url, kind);
    let json = null;
    if (r.status === 200) { try { json = JSON.parse(r.body); } catch { /* retried as a bad 200 */ } }
    const retryAfter = Number(r.headers['retry-after']);
    return { status: r.status, json, retryAfter: retryAfter > 0 ? retryAfter : null, error: r.error || null };
  }

  // One advancedsearch request. { status, json, retryAfter, error }
  const search = (params) => getJson(`${base}/advancedsearch.php?${new URLSearchParams(params)}`, 'search');

  // One page of an account's uploads, as archive.org's own profile page asks
  // for them (the uploads tab of https://archive.org/details/@<handle>)
  const uploadsPage = (handle, page) => getJson(`${base}/services/search/beta/page_production/?${new URLSearchParams({
    page_type:     'account_details',
    page_target:   '@' + handle,
    page_elements: '["uploads"]',
    hits_per_page: String(UPLOADS_PAGE_SIZE),
    page:          String(page),
  })}`, 'uploads');

  // Retries 429/5xx/network errors (and a 200 that isn't JSON), waiting
  // Retry-After when archive.org sends it and backing off 2s/4s/8s when it doesn't.
  const searchWithRetry = (params) => withRetry(() => search(params));

  async function withRetry(request) {
    let lastErr;
    for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt++) {
      const r = await request();
      if (r.status === 200 && r.json) return r.json;
      lastErr = new Error(
        r.status === 429 ? 'rate limited by archive.org (HTTP 429)'
        : r.status        ? `HTTP ${r.status}`
        :                   (r.error || 'network error'));
      const retryable = r.status === 0 || r.status === 429 || r.status >= 500 || r.status === 200;
      if (!retryable) throw lastErr;
      if (attempt < SEARCH_RETRIES) await sleep(r.retryAfter ? r.retryAfter * 1000 : 2000 * 2 ** attempt);
    }
    throw lastErr;
  }

  // All software items for one source, in advancedsearch's doc shape. The
  // source is what the user typed (normalizeUploader): an email is searched
  // with uploader:<email>; an @handle or profile URL goes through the
  // account's uploads list, since uploader: only matches the email; an item
  // URL is that one item.
  async function fetchSource(src) {
    const n = normalizeUploader(src.uploader);
    if (n.error) throw new Error(n.error);
    if (n.kind === 'handle') return fetchAccount(n.value);
    if (n.kind === 'item') return [await fetchItemDoc(n.value)];
    return fetchUploader(n.value);
  }

  async function fetchAccount(handle) {
    const docs = [];
    const seen = new Set();
    for (let page = 1; seen.size < SEARCH_MAX_ITEMS; page++) {
      const { hits, total } = accountUploads(await withRetry(() => uploadsPage(handle, page)));
      let fresh = 0;
      for (const h of hits) {
        if (seen.has(h.identifier)) continue;
        seen.add(h.identifier);
        fresh++;
        if (!h.mediatype || h.mediatype === 'software') docs.push(h.doc);
      }
      if (page === 1 && !hits.length) throw new Error(`no uploads found for @${handle}; check the handle on its archive.org profile`);
      // Stops at the total when there is one (a page may hold fewer than asked
      // for), else at a short page; a page with nothing new ends it either way
      if (!fresh || (total != null ? seen.size >= total : hits.length < UPLOADS_PAGE_SIZE)) break;
    }
    return docs;
  }

  // One item as a search doc, for a single upload named by URL
  async function fetchItemDoc(identifier) {
    const r = await item(identifier);
    if (!r.ok) throw new Error(r.error || 'network error');
    if (!Object.keys(r.metadata).length) throw new Error(`${identifier} isn't an archive.org item`);
    const m = r.metadata;
    return Object.fromEntries(DOC_FIELDS.map(k => [k, k === 'identifier' ? identifier : m[k] ?? null]));
  }

  async function fetchUploader(email) {
    const docs = [];
    for (let page = 1; docs.length < SEARCH_MAX_ITEMS; page++) {
      const json = await searchWithRetry({
        q:      `uploader:${email} mediatype:software`,
        fl:     SEARCH_FIELDS,
        rows:   String(SEARCH_PAGE_SIZE),
        page:   String(page),
        output: 'json',
      });
      const batch = json?.response?.docs || [];
      docs.push(...batch);
      if (batch.length < SEARCH_PAGE_SIZE || docs.length >= (json?.response?.numFound || 0)) break;
    }
    return docs;
  }

  // Item metadata and file list. { ok, metadata, files, error? }
  async function item(identifier) {
    const r = await get(`${base}/metadata/${encodeURIComponent(identifier)}`, 'metadata');
    if (r.status === 0) return { ok: false, error: r.error, metadata: {}, files: [] };
    try {
      const json = JSON.parse(r.body);
      return { ok: true, metadata: json.metadata || {}, files: json.files || [] };
    } catch (e) {
      return { ok: false, error: e.message, metadata: {}, files: [] };
    }
  }

  // Item file list. { ok, files, error? }
  async function fileList(identifier) {
    const { metadata, ...r } = await item(identifier); // eslint-disable-line no-unused-vars
    return r;
  }

  async function reviews(identifier) {
    const r = await get(`${base}/metadata/${encodeURIComponent(identifier)}/reviews`, 'reviews');
    try { return JSON.parse(r.body)?.result || []; } catch { return []; }
  }

  const downloadUrl = (identifier, fileName) =>
    `${base}/download/${identifier}/${fileName.split('/').map(encodeURIComponent).join('/')}`;
  const thumbUrl = (identifier) => `${base}/services/img/${identifier}`;

  return { base, search, searchWithRetry, fetchSource, item, fileList, reviews, downloadUrl, thumbUrl };
}

// archive.org's own files in every item: its metadata, thumbnail and torrent
const IA_OWN_FILE = /(_meta\.xml|_files\.xml|_meta\.sqlite|_reviews\.xml|__ia_thumb\.jpg|_archive\.torrent|\.torrent)$/i;
const ARCHIVE_FILE = /\.(zip|7z|rar)$/i;

// Files a user can install from an item's file list: zip/7z/rar (extracted),
// else a bare .exe, else the uploader's own files as they are (download
// only: an .iso, a .pkg, a folder of anything). Never archive.org's
// derivatives or metadata.
function installableFiles(files) {
  const archives = files.filter(f => ARCHIVE_FILE.test(f.name));
  if (archives.length) return archives;
  const exes = files.filter(f => /\.exe$/i.test(f.name));
  if (exes.length) return exes;
  return files.filter(f => f.source === 'original' && !IA_OWN_FILE.test(f.name));
}

module.exports = { createArchive, installableFiles, ARCHIVE_FILE, accountUploads, SEARCH_PAGE_SIZE, SEARCH_MAX_ITEMS, SEARCH_RETRIES, UPLOADS_PAGE_SIZE };
