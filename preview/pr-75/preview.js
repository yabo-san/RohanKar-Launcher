'use strict';
/**
 * The web preview's stand-in for the backend (see build.js). Loaded before
 * api.js: it points api.js at a made-up base and answers its fetches from
 * preview-data/, saved from a real backend at build time.
 *   - GETs come from preview-data/manifest.json; anything not saved is a 404
 *   - favorites, notes, Add/Remove and settings change in memory, kept for the
 *     tab (sessionStorage) so switching UIs keeps them
 *   - installs, launching and OS actions answer 501, as a browser tab does
 *     against a real backend
 * A pill in the corner says it's a preview and what data it shows.
 */
(() => {
  const BASE = `${location.origin}/__preview/v1`;
  const DATA = new URL('preview-data/', document.currentScript.src).href;
  window.launcher = { apiBase: BASE, token: 'preview' };

  const realFetch = window.fetch.bind(window);
  let manifest = null;
  const loadManifest = () => (manifest ??= realFetch(DATA + 'manifest.json').then(r => r.json()));

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notHere = () => json(501, { error: 'preview', detail: 'Not in the web preview: installs, launching and folders need the desktop app' });

  // State the preview lets you change, on top of the saved responses
  const STORE = 'rk-preview-state';
  let state;
  try { state = JSON.parse(sessionStorage.getItem(STORE)) || {}; } catch { state = {}; }
  state.settings ??= {};
  state.library ??= {};         // identifier → row, or null when removed
  const persist = () => { try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private window */ } };

  function keyOf(u) {
    const q = new URLSearchParams([...u.searchParams].filter(([k]) => k !== 'token' && k !== 'refresh').sort());
    return `GET ${u.pathname.slice(new URL(BASE).pathname.length)}${q.size ? `?${q}` : ''}`;
  }

  async function saved(k) {
    const entry = (await loadManifest()).responses[k];
    if (!entry) return null;
    const res = await realFetch(DATA + entry.file);
    return new Response(await res.blob(), { status: entry.status, headers: { 'Content-Type': entry.type } });
  }
  const savedJson = async (k, fallback) => { const r = await saved(k); return r?.ok ? r.json() : fallback; };

  async function library() {
    const lib = { ...(await savedJson('GET /library', { library: {} })).library };
    for (const [id, row] of Object.entries(state.library)) {
      if (row === null) delete lib[id];
      else lib[id] = { ...lib[id], ...row };
    }
    return lib;
  }

  async function answer(method, u, body) {
    const p = u.pathname.slice(new URL(BASE).pathname.length);
    const lib = /^\/library\/([^/]+)$/.exec(p);

    if (method === 'GET') {
      if (p === '/settings') return json(200, { ...(await savedJson('GET /settings', {})), ...state.settings });
      if (p === '/library') return json(200, { library: await library() });
      if (/^\/library\/[^/]+\/exes$/.test(p)) return json(200, { exes: [] });
      if (/^\/installs\//.test(p)) return json(404, { error: 'not_found' });
      return (await saved(keyOf(u))) || json(404, { error: 'not_found', detail: 'Not saved in the web preview' });
    }
    if (p === '/settings' && method === 'PUT') {
      Object.assign(state.settings, body);
      persist();
      return json(200, { ...(await savedJson('GET /settings', {})), ...state.settings });
    }
    if (p === '/library' && method === 'POST') {
      state.library[body.id] = { identifier: body.id, source: body.source || null, install_dir: null, exe_path: null, is_favorite: 0, notes: null, added_at: new Date().toISOString() };
      persist();
      return json(201, state.library[body.id]);
    }
    if (lib && method === 'PATCH') {
      const id = decodeURIComponent(lib[1]);
      const row = { ...((await library())[id] || { identifier: id }) };
      if ('favorite' in body) row.is_favorite = body.favorite ? 1 : 0;
      if ('notes' in body) row.notes = body.notes;
      if ('exePath' in body || 'installDir' in body) return notHere();
      state.library[id] = row;
      persist();
      return json(200, row);
    }
    if (lib && method === 'DELETE') {
      const id = decodeURIComponent(lib[1]);
      if ((await library())[id]?.install_dir) return notHere();
      state.library[id] = null;
      persist();
      return json(200, { ok: true });
    }
    if (/^\/catalogs\/[^/]+\/refresh$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[2]);
      const { catalogs = [] } = await savedJson('GET /catalogs', {});
      return json(200, catalogs.find(c => c.id === id) || null);
    }
    if (/^\/catalogs\/[^/]+\/seen$/.test(p) || p === '/os/open-item') return json(200, { ok: true });
    if (p === '/os/open-external' && body?.url) { window.open(body.url, '_blank', 'noopener'); return json(200, { ok: true }); }
    return notHere();
  }

  window.fetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    if (!href.startsWith(BASE)) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body;
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    return answer(method, new URL(href), body);
  };

  // No live events in a static page
  const RealEventSource = window.EventSource;
  window.EventSource = function (url, opts) {
    if (!String(url).startsWith(BASE)) return new RealEventSource(url, opts);
    return { addEventListener() {}, removeEventListener() {}, close() {} };
  };

  // The corner pill
  function pill() {
    loadManifest().then(({ info }) => {
      const el = document.createElement('a');
      const when = new Date(info.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      el.textContent = `Web preview${info.ref ? ` · ${info.ref}` : ''} · ${info.data} data, ${when} · installs off`;
      el.title = `${info.items} wall items, ${info.ports} ports${info.sourceErrors ? `, ${info.sourceErrors} source(s) failed at build` : ''}${info.commit ? `\ncommit ${info.commit.slice(0, 7)}` : ''}`;
      if (info.repo && info.commit) { el.href = `https://github.com/${info.repo}/commit/${info.commit}`; el.target = '_blank'; el.rel = 'noopener'; }
      Object.assign(el.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: 99999, padding: '6px 12px', borderRadius: '999px',
        font: '12px/1.2 system-ui, sans-serif', color: '#fff', background: 'rgba(20,20,24,.82)', textDecoration: 'none',
        backdropFilter: 'blur(8px)', boxShadow: '0 2px 10px rgba(0,0,0,.3)', pointerEvents: 'auto',
      });
      document.body.appendChild(el);
    }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pill);
  else pill();
})();
