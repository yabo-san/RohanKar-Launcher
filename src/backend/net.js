'use strict';
/**
 * Outbound HTTP for the backend. Looks up http.get / https.get at call time,
 * so the e2e stub that swaps https.get in the Electron main process still
 * answers every archive.org request.
 */
const http  = require('http');
const https = require('https');

const USER_AGENT = 'y4bo-launcher';

const getter = (url) => (String(url).startsWith('https:') ? https : http);

// GET a URL as text with a hard timeout. Never rejects: network errors and
// timeouts come back as status 0. Every response goes to the net log.
function getText(url, { kind = 'get', timeoutMs = 30000, log = () => {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const fail = (e) => {
      log(kind, url, 0, {}, e.message);
      finish({ status: 0, headers: {}, body: '', error: e.message });
    };
    let req;
    try {
      req = getter(url).get(url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          log(kind, url, res.statusCode, res.headers);
          finish({ status: res.statusCode, headers: res.headers, body });
        });
        res.on('error', fail);
      });
    } catch (e) {
      return fail(e);
    }
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', fail);
  });
}

// GET following up to maxRedirects redirects, sending `headers` on every hop.
// Calls onResponse(res, req) with the final response, or onError(err) once.
// Returns a handle whose req is the live request, so a caller can abort it.
function getFollow(url, { kind = 'get', log = () => {}, timeoutMs = 30000, maxRedirects = 10, headers: extra = {}, onResponse, onError }) {
  const handle = { req: null, aborted: false };
  let failed = false;
  const fail = (e) => { if (!failed && !handle.aborted) { failed = true; onError(e); } };
  const go = (target, redirects) => {
    if (handle.aborted) return;
    if (redirects > maxRedirects) return fail(new Error('Too many redirects'));
    let req;
    try {
      req = getter(target).get(target, { headers: { 'User-Agent': USER_AGENT, ...extra }, timeout: timeoutMs }, (res) => {
        if (handle.aborted) { res.resume(); return; }
        const { statusCode, headers } = res;
        log(kind, target, statusCode, headers);
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          res.resume();
          return go(new URL(headers.location, target).toString(), redirects + 1);
        }
        onResponse(res, req);
      });
    } catch (e) {
      return fail(e);
    }
    handle.req = req;
    req.on('timeout', () => { fail(new Error('Connection timed out')); req.destroy?.(); });
    req.on('error', (e) => {
      if (failed || handle.aborted || handle.req !== req) return;  // superseded by a redirect
      log(kind, target, 0, {}, e.message);
      fail(e);
    });
  };
  go(url, 0);
  return handle;
}

module.exports = { getText, getFollow, USER_AGENT };
