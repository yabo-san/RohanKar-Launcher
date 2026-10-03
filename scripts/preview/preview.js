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
 *   - while Allow additional sources is on, a response saved with it on
 *     ("ON " keys, fixtures builds) answers instead of the default one
 *   - the JSON feeds the app fetches from main at launch (featured.json with
 *     art.json, overrides.json, announcement.json) are fetched live from manifest
 *     info.feed when the page is viewed; the saved copy answers if that fails
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
  state.dismissed ??= [];       // announcement ids
  const persist = () => { try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private window */ } };

  function keyOf(u) {
    const q = new URLSearchParams([...u.searchParams].filter(([k]) => k !== 'token' && k !== 'refresh').sort());
    return `GET ${u.pathname.slice(new URL(BASE).pathname.length)}${q.size ? `?${q}` : ''}`;
  }

  async function saved(k) {
    const { responses } = await loadManifest();
    const entry = (state.settings.allowAdditionalSources && responses[`ON ${k}`]) || responses[k];
    if (!entry) return null;
    const res = await realFetch(DATA + entry.file);
    return new Response(await res.blob(), { status: entry.status, headers: { 'Content-Type': entry.type } });
  }
  const savedJson = async (k, fallback) => { const r = await saved(k); return r?.ok ? r.json() : fallback; };

  // The live feeds: fetched once per page view, null when there's no feed
  // (fixtures) or it fails, and then the saved response stands
  const feeds = {};
  const feed = (file) => (feeds[file] ??= loadManifest().then(({ info }) => {
    if (!info.feed) return null;
    return realFetch(info.feed + file, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null));
  }).catch(() => null));

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // As src/backend/featured.js parses it: a banner is a SteamGridDB CDN image,
  // pinned on the pick or else the banner on its catalog/art.json entry
  function heroUrl(v) {
    try { const u = new URL(str(v)); return u.protocol === 'https:' && /^cdn\d*\.steamgriddb\.com$/.test(u.hostname) ? u.href : null; } catch { return null; }
  }
  function featuredPicks(data, art) {
    if (!Array.isArray(data?.picks)) return null;
    const bannerFor = (key) => {
      const e = art && typeof art === 'object' && !Array.isArray(art) && art[Object.keys(art).find(k => !k.startsWith('_') && k.toLowerCase() === key.toLowerCase())];
      return heroUrl(e?.banner?.url);
    };
    return data.picks.flatMap((p) => {
      const identifier = str(p?.identifier);
      const repository = str(p?.repository)?.toLowerCase() || null;
      if (!identifier && !repository) return [];
      return [{ ...(identifier ? { identifier } : { repository }), blurb: str(p.blurb), banner: heroUrl(p.banner) || bannerFor(identifier || repository) || null }];
    });
  }
  // As src/backend/announcement.js parses it
  function announcement(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const get = (key) => data[Object.keys(data).find(k => k.toLowerCase() === key)];
    const id = str(get('id')), message = str(get('message')), link = str(get('link'));
    if (get('enabled') === false || !id || !message) return null;
    return { id, message, ...(link && /^https:\/\//.test(link) ? { link } : {}) };
  }
  const overridesFeed = () => feed('overrides.json').then(o => (o && typeof o === 'object' && !Array.isArray(o) ? o : null));

  // A wall list with today's overrides in place of the ones saved at build.
  // Hidden uploads drop out unless installed, and series come from the
  // overrides, as src/backend/items.js does.
  function withOverrides(body, ov, lib = {}) {
    const patch = (v) => ({ ...v, override: ov[v.id] || null });
    const shown = (v) => !ov[v.id]?.hidden || lib[v.id]?.install_dir;
    const items = [];
    for (const it of body.items) {
      if (it.shelf !== 'wall') { items.push(it); continue; }
      const versions = (it.versions || []).filter(shown).map(patch);
      if (!versions.length) continue;
      const series = versions.map(v => v.override?.series).find(x => typeof x === 'string' && x.trim())?.trim() || null;
      if (versions[0].id === it.id) items.push({ ...patch(it), versions, series });
      else items.push({ ...it, ...versions[0], shelf: it.shelf, versions, installed: it.installed, library: it.library, series });
    }
    return { ...body, items };
  }
  // The override a cover was saved with, from the saved wall
  async function savedOverride(id) {
    const wall = await savedJson('GET /items?shelf=wall', { items: [] });
    for (const it of wall.items || []) for (const v of [it, ...(it.versions || [])]) if (v.id === id) return v.override || null;
    return null;
  }
  // A cover whose override art changed on main since the build: the new image
  // if the browser may fetch it, else the saved one
  async function liveCover(id) {
    const ov = await overridesFeed();
    const url = ov?.[id]?.artUrl;
    if (!url || !/^https:\/\//.test(url) || url === (await savedOverride(id))?.artUrl) return null;
    try {
      const r = await realFetch(url, { mode: 'cors' });
      return r.ok ? new Response(await r.blob(), { status: 200, headers: { 'Content-Type': r.headers.get('content-type') || 'image/png' } }) : null;
    } catch { return null; }
  }

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
      if (p === '/featured') {
        const [data, art] = await Promise.all([feed('catalog/featured.json'), feed('catalog/art.json')]);
        const picks = featuredPicks(data, art);
        if (picks) return json(200, { picks });
      }
      if (p === '/announcement') {
        const data = await feed('announcement.json');
        if (data) {
          const a = announcement(data);
          return json(200, { announcement: a && !state.dismissed.includes(a.id.toLowerCase()) ? a : null });
        }
      }
      if (p === '/items') {
        const [res, ov, lib] = await Promise.all([saved(keyOf(u)), overridesFeed(), library()]);
        if (res?.ok && ov) return json(200, withOverrides(await res.json(), ov, lib));
        if (res) return res;
      }
      const cover = /^\/items\/([^/]+)\/cover$/.exec(p);
      if (cover) {
        const res = await liveCover(decodeURIComponent(cover[1]));
        if (res) return res;
      }
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
      return new Response(null, { status: 204 });
    }
    if (/^\/catalogs\/[^/]+\/refresh$/.test(p)) {
      const id = decodeURIComponent(p.split('/')[2]);
      const { catalogs = [] } = await savedJson('GET /catalogs', {});
      return json(200, catalogs.find(c => c.id === id) || null);
    }
    if (p === '/announcement/dismiss' && body?.id) {
      state.dismissed.push(String(body.id).toLowerCase());
      persist();
      return json(200, { ok: true });
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
      el.textContent = `Web preview${info.ref ? ` · ${info.ref}` : ''} · ${info.data} data, ${when}${info.feed ? ' · feeds live' : ''} · installs off`;
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
