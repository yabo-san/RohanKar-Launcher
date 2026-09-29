'use strict';
/**
 * archive-net.log: one JSON line per archive.org (or catalog) response, so
 * real status codes and rate-limit headers can be read after the fact.
 * Non-2xx responses log every header; 2xx keep only the ones useful for
 * throttling. Rotated to .old once it passes 2 MB, checked at startup.
 */
const fs = require('fs');

const NET_LOG_MAX  = 2 * 1024 * 1024;
const NET_LOG_KEEP = ['date', 'server', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

function createNetLog(file, { maxBytes = NET_LOG_MAX } = {}) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.old');
  } catch { /* rotation is best effort */ }

  function log(kind, url, status, headers = {}, error = null) {
    const ok = status >= 200 && status < 300;
    const logged = ok
      ? Object.fromEntries(NET_LOG_KEEP.filter(k => headers[k] != null).map(k => [k, headers[k]]))
      : headers;
    const line = JSON.stringify({ t: new Date().toISOString(), kind, status, url, headers: logged, ...(error ? { error } : {}) });
    try { fs.appendFileSync(file, line + '\n'); } catch { /* logging never breaks a request */ }
  }

  return { file, log };
}

module.exports = { createNetLog, NET_LOG_KEEP };
