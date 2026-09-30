'use strict';
/**
 * The launcher side of the Cider fork: what new/app.js does to turn the /v1
 * API (through ../api.js) into games, ports and library rows, without the
 * drawing. vueapp.js keeps the results in the Vue root and components.js
 * draws them with Cider's components. ../sources.js supplies getTitle.
 *
 * Items handed to Cider's components are shaped like the Apple Music items
 * they were written for ({ id, type, attributes: { name, artistName,
 * artwork: { url } } }), so their templates stay as close to Cider's as
 * possible; `_game` / `_port` carry the launcher object.
 */
/* exported Launcher */

const Launcher = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = (n) => Number(n || 0).toLocaleString();
  const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
  const sourceName = (s) => s.label || s.uploader.split('@')[0];

  // Stable gradient per title for art that has no cover, so a grid still reads as covers
  function tint(text) {
    let h = 0;
    for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const a = h % 360, b = (a + 40 + (h >> 9) % 60) % 360;
    return `linear-gradient(160deg, hsl(${a} 55% 34%), hsl(${b} 60% 16%))`;
  }

  function stripHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
    return d.textContent.trim();
  }

  // ─── covers: /items/:id/cover as object URLs, four at a time ──────────────

  const THUMB_CONCURRENCY = 4;
  const thumbCache = new Map();
  const thumbQueue = [];
  let thumbActive = 0;
  function thumb(identifier) {
    if (thumbCache.has(identifier)) return thumbCache.get(identifier);
    const p = new Promise((resolve) => {
      const run = () => {
        thumbActive++;
        api.getThumb({ identifier }).catch(() => null).then(resolve).finally(() => {
          thumbActive--;
          thumbQueue.shift()?.();
        });
      };
      thumbActive < THUMB_CONCURRENCY ? run() : thumbQueue.push(run);
    });
    thumbCache.set(identifier, p);
    return p;
  }

  // An artwork url as the components pass it: "cover:<identifier>" for an
  // archive.org cover, anything else is used as is
  const coverUrl = (identifier) => `cover:${identifier}`;
  const resolveArtwork = (url) => {
    if (!url) return Promise.resolve('');
    if (url.startsWith('cover:')) return thumb(url.slice(6)).then(u => u || '');
    return Promise.resolve(url);
  };

  // ─── the wall ──────────────────────────────────────────────────────────────

  function versionFromItem(v) {
    return {
      identifier:   v.id,
      title:        v.originalTitle ?? v.title,
      description:  v.description,
      date:         v.date,
      addeddate:    v.addeddate,
      downloads:    v.downloads,
      subject:      v.subject,
      _uploader:    v.source?.uploader,
      _sourceLabel: v.source?.label || v.source?.uploader,
      _override:    v.override || undefined,
    };
  }

  // { games, versions, failed } from GET /items?shelf=wall
  async function loadWall(sources, { refresh = false } = {}) {
    const enabled = sources.filter(s => s.enabled !== false);
    const versions = [];
    let games = [], failed = [];
    try {
      const { items, errors } = await api.getItems(refresh ? { shelf: 'wall', refresh: 'true' } : { shelf: 'wall' });
      games = items.map(item => {
        const vs = item.versions.map(versionFromItem);
        for (const v of vs) v._versions = vs;
        versions.push(...vs);
        return vs[0];
      });
      failed = errors.map(e => ({ src: enabled.find(s => s.uploader === e.source) || { uploader: e.source, label: e.label }, error: e.error }));
    } catch (e) {
      failed = enabled.map(src => ({ src, error: e.message }));
    }
    const loaded = enabled.filter(s => !failed.some(f => f.src.uploader === s.uploader));
    return { games, versions, failed, loaded };
  }

  // ─── ports ─────────────────────────────────────────────────────────────────

  // The Quiver lists new/app.js subscribes to on a first run (the same four)
  const QUIVER_BASE = 'https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/community-app-catalog/';
  const QUIVER_CATALOGS = [
    { shelf: 'Nintendo',    file: 'Nintendo.json' },
    { shelf: 'PlayStation', file: 'PlayStation.json' },
    { shelf: 'Xbox',        file: 'Xbox.json' },
    { shelf: 'Other',       file: 'OtherPlatforms.json' },
  ];

  function portFromItem(it, cat) {
    const e = it.entry || {};
    return {
      id:                 it.id,
      name:               it.title,
      project:            e.project || '',
      repository:         it.repository || '',
      folderName:         e.folderName || '',
      iconUrl:            it.icon || null,
      tags:               it.tags || [],
      description:        it.description || e.description || '',
      releaseAssetFilter: e.releaseAssetFilter || null,
      filesToAdd:         Array.isArray(e.filesToAdd) ? e.filesToAdd : [],
      shelf:              cat.id,
      shelfName:          cat.shelf,
      catalogUrl:         cat.url,
      data: it.data
        ? { status: 'available', iaIdentifier: it.data.iaIdentifier, contentUrl: it.data.contentUrl, uploader: null,
          files: [...(it.data.dataFiles || []).map(f => f?.name ?? f), ...(it.data.sources || []).map(x => x.path)] }
        : { status: 'none', files: [] },
    };
  }

  // { ports: { shelves, items }, review } from the subscribed catalogs
  async function loadPorts(settings, refresh = false) {
    if (settings.catalogs === undefined) {
      for (const c of QUIVER_CATALOGS) await api.subscribeCatalog({ url: QUIVER_BASE + c.file, name: c.shelf, shelf: c.shelf });
    }
    let catalogs = await api.getCatalogs();
    if (refresh) catalogs = await Promise.all(catalogs.map(c => api.refreshCatalog(c.id)));
    const lists = await Promise.all(catalogs.map(c => api.getCatalogItems(c.id)));
    const items = catalogs.flatMap((c, i) => lists[i].map(it => portFromItem(it, c)));
    const shelves = catalogs.map(c => {
      const mine = items.filter(i => i.shelf === c.id);
      return {
        id: c.id, name: c.shelf, url: c.url,
        count: mine.length,
        withData: mine.filter(i => i.data.status === 'available').length,
        error: c.entries ? null : c.error,
        fromCache: !!(c.error && c.entries), fetchedAt: c.fetchedAt,
      };
    });
    const review = await Promise.all(catalogs.map(async c => {
      const r = await api.reviewCatalog(c.id);
      return { id: c.id, name: c.shelf, added: r.new, changed: r.changed, removed: r.removed };
    }));
    return { ports: { shelves, items }, review };
  }

  // ─── sorting and search, after Cider's searchLibraryAlbums ─────────────────
  // Numbers compare as numbers, everything else case-insensitively; the
  // search ignores punctuation.

  function ciderSort(list, value, order) {
    const key = (x) => { const v = value(x); return v == null ? '' : String(v); };
    const cmp = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? a - b : a.toLowerCase().localeCompare(b.toLowerCase()));
    return list.map(x => [key(x), x]).sort(([a], [b]) => (order === 'asc' ? cmp(a, b) : cmp(b, a))).map(([, x]) => x);
  }
  const searchKey = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
  function ciderSearch(list, q, fields) {
    const t = searchKey(q);
    return t ? list.filter(x => fields(x).some(f => searchKey(f).includes(t))) : list;
  }

  const byNewest = (a, b) => String(b.addeddate || '').localeCompare(String(a.addeddate || ''));
  const byDownloads = (a, b) => (b.downloads || 0) - (a.downloads || 0);
  const newestVersion = (g) => (g._versions || [g]).slice().sort(byNewest)[0];

  const GAME_SORTS = {
    name:      ['Title', g => getTitle(g)],
    dateAdded: ['Date added', g => g.addeddate],
    uploader:  ['Uploader', g => g._sourceLabel],
    downloads: ['Downloads', g => g.downloads || 0],
    year:      ['Year', g => (g.date || g.addeddate || '').slice(0, 4)],
  };
  const PORT_SORTS = {
    data:  ['Game data', p => (p.data.status === 'available' ? 1 : 0)],
    name:  ['Name', p => p.name],
    repo:  ['Repository', p => p.repository],
    shelf: ['Shelf', p => p.shelfName],
  };

  // Library page preferences (Cider's cfg.libraryPrefs), kept per page
  const PREFS_KEY = 'y4bo.ciderLibraryPrefs';
  const PREF_DEFAULTS = {
    wall:    { sort: 'dateAdded', order: 'desc', viewAs: 'covers', scroll: 'infinite', uploader: '' },
    shelf:   { sort: 'data', order: 'desc', viewAs: 'covers', scroll: 'infinite', tag: '', data: '' },
    library: { sort: 'name', order: 'asc', viewAs: 'covers', scroll: 'infinite' },
  };
  function loadPrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { /* storage off */ }
    return Object.fromEntries(Object.entries(PREF_DEFAULTS).map(([k, d]) => [k, { ...d, ...saved[k] }]));
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage off */ }
  }

  // ─── Cider-shaped items ────────────────────────────────────────────────────

  function gameItem(g) {
    const title = getTitle(g);
    const year = g.addeddate ? new Date(g.addeddate).getFullYear() : '';
    return {
      id: g.identifier,
      type: 'game',
      attributes: {
        name: title,
        artistName: [g._sourceLabel, year].filter(Boolean).join(' · '),
        artwork: { url: coverUrl(g.identifier), bgColor: tint(title) },
        releaseDate: g.addeddate,
      },
      _game: g,
    };
  }

  function portItem(p) {
    return {
      id: p.id,
      type: 'port',
      attributes: {
        name: p.name,
        artistName: p.project || p.repository,
        artwork: { url: p.iconUrl || '', bgColor: tint(p.repository) },
      },
      _port: p,
    };
  }

  return {
    esc, fmtNum, fmtDate, sourceName, tint, stripHtml,
    thumb, coverUrl, resolveArtwork,
    loadWall, loadPorts, QUIVER_BASE, QUIVER_CATALOGS,
    ciderSort, ciderSearch, byNewest, byDownloads, newestVersion,
    GAME_SORTS, PORT_SORTS, loadPrefs, savePrefs,
    gameItem, portItem,
  };
})();
