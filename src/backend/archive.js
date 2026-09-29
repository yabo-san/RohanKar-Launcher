'use strict';
/**
 * archive.org client: advanced search with retry and paging, item metadata,
 * reviews. Every response is logged to archive-net.log by kind.
 */
const { getText } = require('./net');

const SEARCH_PAGE_SIZE = 500;
const SEARCH_MAX_ITEMS = 10000;  // advancedsearch won't page past this
const SEARCH_RETRIES   = 3;
const SEARCH_FIELDS    = 'identifier,title,description,date,addeddate,downloads,subject';

function createArchive({ base = 'https://archive.org', log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const get = (url, kind, timeoutMs) => getText(url, { kind, log, timeoutMs });

  // One advancedsearch request. { status, json, retryAfter, error }
  async function search(params) {
    const r = await get(`${base}/advancedsearch.php?${new URLSearchParams(params)}`, 'search');
    let json = null;
    if (r.status === 200) { try { json = JSON.parse(r.body); } catch { /* retried as a bad 200 */ } }
    const retryAfter = Number(r.headers['retry-after']);
    return { status: r.status, json, retryAfter: retryAfter > 0 ? retryAfter : null, error: r.error || null };
  }

  // Retries 429/5xx/network errors (and a 200 that isn't JSON), waiting
  // Retry-After when archive.org sends it and backing off 2s/4s/8s when it doesn't.
  async function searchWithRetry(params) {
    let lastErr;
    for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt++) {
      const r = await search(params);
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

  // All items for one uploader, paging past the per-request row limit
  async function fetchSource(src) {
    const docs = [];
    for (let page = 1; docs.length < SEARCH_MAX_ITEMS; page++) {
      const json = await searchWithRetry({
        q:      `uploader:${src.uploader} mediatype:software`,
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

  // Item file list. { ok, files, error? }
  async function fileList(identifier) {
    const r = await get(`${base}/metadata/${encodeURIComponent(identifier)}`, 'metadata');
    if (r.status === 0) return { ok: false, error: r.error, files: [] };
    try {
      return { ok: true, files: JSON.parse(r.body).files || [] };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  }

  async function reviews(identifier) {
    const r = await get(`${base}/metadata/${encodeURIComponent(identifier)}/reviews`, 'reviews');
    try { return JSON.parse(r.body)?.result || []; } catch { return []; }
  }

  const downloadUrl = (identifier, fileName) =>
    `${base}/download/${identifier}/${fileName.split('/').map(encodeURIComponent).join('/')}`;
  const thumbUrl = (identifier) => `${base}/services/img/${identifier}`;

  return { base, search, searchWithRetry, fetchSource, fileList, reviews, downloadUrl, thumbUrl };
}

// Archives a user can install from an item's file list: zip/7z/rar, or a
// bare .exe when the item has no archive at all
function installableFiles(files) {
  const hasArchive = files.some(f => /\.(zip|7z|rar)$/i.test(f.name));
  return files.filter(f => /\.(zip|7z|rar)$/i.test(f.name) || (!hasArchive && /\.exe$/i.test(f.name)));
}

module.exports = { createArchive, installableFiles, SEARCH_PAGE_SIZE, SEARCH_MAX_ITEMS, SEARCH_RETRIES };
