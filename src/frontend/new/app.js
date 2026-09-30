'use strict';
/**
 * y4bo launcher, new UI (docs/PRODUCT.md, docs/USER-LOOP.md).
 * Draws what the backend's /v1 API serves (through ../api.js): the
 * archive.org game wall from the curated uploaders, Quiver's port shelves
 * joined to the collision catalog, the library, and the review of what
 * changed. ../sources.js supplies getTitle and the Settings text helpers.
 * The classic UI (../index.html) is one click away in Settings.
 */
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  view: { name: 'home' },
  query: '',
  settings: {},
  sources: [],
  library: {},          // archive.org installs from library.db, keyed by identifier
  versions: [],         // every archive.org item from every enabled uploader
  games: [],            // one entry per title, with _versions
  wall: { loading: true, loaded: [], failed: [] },
  ports: null,          // { shelves, items } built from the subscribed catalogs
  portsError: null,
  portLibrary: [],
  quiverImport: null,
  manualForm: null,     // { name, folder } while adding a manual app from the Library   // { plan, busy, result } while importing a Quiver library
  review: [],
  featured: [],         // hand-picked { identifier } | { repository } from catalog/featured.json
  libSearch: '',        // the search box in a library header (Cider's library pages)
  libPage: 1,           // the page, when a library header is set to paged
  detail: null,
  downloads: new Map(), // identifier -> { percent, status }
  editor: null,         // the collision being edited (viewCollision)
  collisionFeeds: null, // subscribed collision feeds, for Settings
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtBytes = (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`; };
const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
const sourceName = (s) => s.label || s.uploader.split('@')[0];

// Stable gradient per title for cards without art, so the wall still reads as covers
function tint(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 40 + (h >> 9) % 60) % 360;
  return `linear-gradient(160deg, hsl(${a} 55% 34%), hsl(${b} 60% 16%))`;
}

function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
  return d.textContent.trim();
}

// ─── covers (archive.org thumbs via the main-process disk cache) ─────────────

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

// Covers load once their card is near the viewport
const coverObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    coverObserver.unobserve(e.target);
    const id = e.target.dataset.thumb;
    thumb(id).then(url => {
      if (!url) return;
      const img = new Image();
      img.onload = () => { e.target.querySelector('.noart')?.remove(); e.target.prepend(img); };
      img.src = url;
    });
  }
}, { rootMargin: '400px' });

function observeCovers(root) {
  root.querySelectorAll('[data-thumb]').forEach(el => coverObserver.observe(el));
}

// ─── the game wall: archive.org, grouped by title in the backend ────────────

// A backend version as the shape the cards and detail panel draw
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

async function loadWall({ refresh = false } = {}) {
  state.versions = [];
  state.games = [];
  state.wall = { loading: true, loaded: [], failed: [] };
  const enabled = state.sources.filter(s => s.enabled !== false);
  render();
  try {
    const { items, errors } = await api.getItems(refresh ? { shelf: 'wall', refresh: 'true' } : { shelf: 'wall' });
    state.games = items.map(item => {
      const versions = item.versions.map(versionFromItem);
      for (const v of versions) v._versions = versions;
      state.versions.push(...versions);
      return versions[0];
    });
    state.wall.failed = errors.map(e => ({ src: enabled.find(s => s.uploader === e.source) || { uploader: e.source, label: e.label }, error: e.error }));
  } catch (e) {
    state.wall.failed = enabled.map(src => ({ src, error: e.message }));
  }
  state.wall.loaded = enabled.filter(s => !state.wall.failed.some(f => f.src.uploader === s.uploader));
  state.wall.loading = false;
  if (state.wall.failed.length) {
    toast(`Couldn't load ${state.wall.failed.map(f => sourceName(f.src)).join(', ')}: ${state.wall.failed[0].error}`, 8000);
  }
  render();
}

// ─── ports and library ───────────────────────────────────────────────────────

// Quiver's four community lists, subscribed on the first run (when settings
// have no catalogs yet); after that the subscriptions are the user's
const QUIVER_BASE = 'https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/community-app-catalog/';
const QUIVER_CATALOGS = [
  { shelf: 'Nintendo',    file: 'Nintendo.json' },
  { shelf: 'PlayStation', file: 'PlayStation.json' },
  { shelf: 'Xbox',        file: 'Xbox.json' },
  { shelf: 'Other',       file: 'OtherPlatforms.json' },
];

async function subscribeDefaultCatalogs() {
  if (state.settings.catalogs !== undefined) return;
  // One at a time: each subscription is a settings write
  for (const c of QUIVER_CATALOGS) await api.subscribeCatalog({ url: QUIVER_BASE + c.file, name: c.shelf, shelf: c.shelf });
}

// A catalog item from the backend as a port card
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
    releaseAssetFilter: e.releaseAssetFilter || null,
    filesToAdd:         Array.isArray(e.filesToAdd) ? e.filesToAdd : [],
    shelf:              cat.id,
    shelfName:          cat.shelf,
    catalogUrl:         cat.url,
    // A collision with no data (a repo added on its own) has nothing to fetch
    data: it.data && (it.data.iaIdentifier || it.data.contentUrl || it.data.dataFiles?.length || it.data.sources?.length)
      ? { status: 'available', iaIdentifier: it.data.iaIdentifier, contentUrl: it.data.contentUrl, uploader: null,
        files: [...(it.data.dataFiles || []).map(f => f?.name ?? f), ...(it.data.sources || []).map(x => x.path)] }
      : { status: 'none', files: [] },
  };
}

async function loadPorts(refresh = false) {
  try {
    await subscribeDefaultCatalogs();
    let catalogs = await api.getCatalogs();
    if (refresh) catalogs = await Promise.all(catalogs.map(c => api.refreshCatalog(c.id)));
    const lists = await Promise.all(catalogs.map(c => api.getCatalogItems(c.id)));
    const items = catalogs.flatMap((c, i) => lists[i].map(it => portFromItem(it, c)));
    const shelves = catalogs.map(c => {
      const mine = items.filter(i => i.shelf === c.id);
      return {
        id: c.id, name: c.shelf, url: c.url, preferredTags: [],
        count: mine.length,
        withData: mine.filter(i => i.data.status === 'available').length,
        error: c.entries ? null : c.error,
        fromCache: !!(c.error && c.entries), fetchedAt: c.fetchedAt,
      };
    });
    state.ports = { shelves, items };
    state.portsError = null;
    state.review = await Promise.all(catalogs.map(async c => {
      const r = await api.reviewCatalog(c.id);
      return { id: c.id, name: c.shelf, added: r.new, changed: r.changed, removed: r.removed };
    }));
  } catch (e) {
    state.portsError = e.message;
  }
  await reloadLibrary();
  render();
}

// Ports in the library are rows without an install, keyed by the catalog item id
async function reloadLibrary() {
  state.library = await api.getLibrary().catch(() => ({}));
  state.portLibrary = Object.keys(state.library).filter(id => id.startsWith('quiver:')).map(id => ({ id }));
  renderNav();
}

const isInstalled = (g) => (g._versions || [g]).some(v => state.library[v.identifier]?.install_dir);
const installedVersion = (g) => (g._versions || [g]).find(v => state.library[v.identifier]?.install_dir);
const inPortLibrary = (p) => state.portLibrary.some(r => r.id === p.id);
const reviewCount = () => state.review.reduce((n, r) => n + r.added.length + r.changed.length + r.removed.length, 0);

// ─── sidebar ─────────────────────────────────────────────────────────────────

function renderNav() {
  const enabled = state.sources.filter(s => s.enabled !== false);
  $('#nav-uploaders').innerHTML = enabled.map(s => {
    const n = state.versions.filter(v => v._uploader === s.uploader).length;
    const failed = state.wall.failed.some(f => f.src.uploader === s.uploader);
    const loading = state.wall.loading && !state.wall.loaded.includes(s) && !failed;
    return `<button class="navitem" data-view="uploader" data-arg="${esc(s.uploader)}">${avatar(sourceName(s), true)}${esc(sourceName(s))}
      <span class="n">${failed ? '!' : loading ? '…' : n}</span></button>`;
  }).join('');
  $('#nav-shelves').innerHTML = (state.ports?.shelves || []).map(s =>
    `<button class="navitem" data-view="shelf" data-arg="${esc(s.id)}">${avatar(s.name)}${esc(s.name)}<span class="n">${s.count || (s.error ? '!' : '')}</span></button>`
  ).join('') || '<div class="navitem" style="cursor:default;color:var(--text3)"><i class="ico" data-ico="wall"></i>Loading…</div>';
  $('#n-wall').textContent = state.games.length || '';
  const libCount = Object.values(state.library).filter(l => l.install_dir || l.identifier.startsWith('quiver:')).length;
  $('#n-library').textContent = libCount || '';
  $('#n-updates').textContent = reviewCount() || '';
  markActive();
}

// Uploaders and shelves have no artwork of their own: a tinted initial stands in,
// round for people, square for shelves (Cider's artist and playlist chips)
function avatar(name, round = false) {
  return `<i class="avatar${round ? ' round' : ''}" style="background:${tint(name)}">${esc(String(name).trim().charAt(0).toUpperCase())}</i>`;
}

// Sidebar groups fold like Cider's, and stay as left
const FOLDED_KEY = 'y4bo.sidebarFolded';
function loadFolded() {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY)) || []); } catch { return new Set(); }
}
const folded = loadFolded();
function applyFolded() {
  document.querySelectorAll('.sidebar .navgroup').forEach(el => {
    const on = folded.has(el.dataset.collapse);
    el.classList.toggle('collapsed', on);
    document.querySelector(`.navlist[data-group="${el.dataset.collapse}"]`)?.classList.toggle('hidden', on);
  });
}
function toggleFold(name) {
  folded.has(name) ? folded.delete(name) : folded.add(name);
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])); } catch { /* storage off */ }
  applyFolded();
}

function markActive() {
  document.querySelectorAll('.sidebar .navitem').forEach(el => {
    const v = state.view;
    el.classList.toggle('active', !state.query && el.dataset.view === v.name && (el.dataset.arg || null) === (v.arg || null));
  });
}

function go(name, arg = null) {
  if (name === 'collision') startEditor(arg);
  state.view = { name, arg };
  state.query = '';
  $('#q').value = '';
  libPrefs.shelf.tag = '';   // tags differ from shelf to shelf
  state.libSearch = '';
  state.libPage = 1;
  $('#body').scrollTop = 0;
  render();
}

// ─── cards ───────────────────────────────────────────────────────────────────

function gameCard(g) {
  const title = getTitle(g);
  const n = g._versions?.length || 1;
  const installed = isInstalled(g);
  const dl = state.downloads.get(g.identifier);
  return `<button class="card game-card" data-open="game" data-id="${esc(g.identifier)}" title="${esc(title)}">
    <div class="art" data-thumb="${esc(g.identifier)}" style="background:${tint(title)}">
      <div class="noart"><small>${esc(g._sourceLabel)}</small>${esc(title)}</div>
      ${installed ? '<span class="tag installed">INSTALLED</span>' : dl ? `<span class="tag installed">${dl.percent || 0}%</span>` : ''}
      ${n > 1 ? `<span class="tag versions">${n} VERSIONS</span>` : ''}
      <span class="play-btn${installed ? '' : ' get'}" aria-hidden="true"></span>
    </div>
    <div class="title">${esc(title)}</div>
    <div class="sub">${esc([g._sourceLabel, g.addeddate ? new Date(g.addeddate).getFullYear() : ''].filter(Boolean).join(' · '))}</div>
  </button>`;
}

function portCard(p) {
  const added = inPortLibrary(p);
  const tag = p.data.status === 'available' ? '<span class="tag data">DATA</span>'
    : p.data.status === 'missing' ? '<span class="tag needs">NEEDS DATA</span>' : '';
  const art = p.iconUrl
    ? `<img loading="lazy" src="${esc(p.iconUrl)}" alt=""><div class="noart fallback">${esc(p.name)}</div>`
    : `<div class="noart">${esc(p.name)}</div>`;
  return `<button class="card port-card" data-open="port" data-id="${esc(p.id)}" title="${esc(p.name)}">
    <div class="art icon" style="background:${tint(p.repository)}">${art}${tag}
      <span class="play-btn ${added ? 'check' : 'get'}" aria-hidden="true"></span><span class="menu-btn" data-card-menu aria-label="More"></span></div>
    <div class="title">${esc(p.name)}</div>
    <div class="sub">${esc(p.project || p.repository)}</div>
  </button>`;
}

const skeletons = (n) => Array.from({ length: n }, () =>
  '<div class="card skel"><div class="art"></div><div class="title">.</div><div class="sub">.</div></div>').join('');

function section(title, body, { count, sub, seeAll, cls = 'grid' } = {}) {
  const isRow = cls.split(' ')[0] === 'row';
  return `<section class="section${isRow ? ' has-row' : ''}"><div class="section-head"><h2>${esc(title)}</h2>
    ${count != null ? `<span class="count">${esc(count)}</span>` : ''}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    ${seeAll ? `<button class="seeall" data-go="${esc(seeAll[0])}" data-arg="${esc(seeAll[1] || '')}">See all</button>` : ''}
    ${isRow ? rowNav : ''}</div>
    <div class="${cls}">${body}</div></section>`;
}

// ─── horizontal rows ─────────────────────────────────────────────────────────
// No scrollbar: rows scroll with the round arrows in their header (as in
// Cider), a mouse drag, a sideways wheel or trackpad swipe, and Left/Right
// between focused cards.

const rowNav = `<span class="row-nav">
  <button class="prev" data-row-nav="-1" aria-label="Scroll left" tabindex="-1"></button>
  <button class="next" data-row-nav="1" aria-label="Scroll right" tabindex="-1"></button></span>`;

// Arrows only on rows that overflow, each disabled at its end
function syncRowNav(row) {
  const nav = row.closest('.section')?.querySelector('.row-nav');
  if (!nav) return;
  const max = row.scrollWidth - row.clientWidth;
  nav.hidden = max <= 1;
  nav.querySelector('.prev').disabled = row.scrollLeft <= 1;
  nav.querySelector('.next').disabled = row.scrollLeft >= max - 1;
}
const syncRows = () => {
  document.querySelectorAll('#body .row.list').forEach(layoutList);
  document.querySelectorAll('#body .row').forEach(syncRowNav);
};

// A list row fills the width in columns (as many ~280px columns as fit), up to
// four items deep, then pages sideways like the other rows
const LIST_COL = 280, LIST_GAP = 28, LIST_DEPTH = 4;
function layoutList(row) {
  const n = row.children.length;
  const cols = Math.max(1, Math.floor((row.clientWidth + LIST_GAP) / (LIST_COL + LIST_GAP)));
  row.style.gridTemplateRows = `repeat(${Math.min(LIST_DEPTH, Math.ceil(n / cols))}, auto)`;
  row.style.gridAutoColumns = `calc((100% - ${(cols - 1) * LIST_GAP}px) / ${cols})`;
}

function scrollRow(btn) {
  const row = btn.closest('.section').querySelector('.row');
  row.scrollBy({ left: Number(btn.dataset.rowNav) * row.clientWidth * 0.85, behavior: 'smooth' });
}

// Drag to scroll with the mouse; a drag doesn't open the card it started on
let rowDrag = null;
document.addEventListener('pointerdown', (e) => {
  const row = e.pointerType === 'mouse' && e.button === 0 && e.target.closest('#body .row');
  if (row) rowDrag = { row, x: e.clientX, left: row.scrollLeft, moved: false };
});
document.addEventListener('pointermove', (e) => {
  if (!rowDrag) return;
  const dx = e.clientX - rowDrag.x;
  if (!rowDrag.moved && Math.abs(dx) < 6) return;
  if (!rowDrag.moved) { rowDrag.moved = true; rowDrag.row.classList.add('dragging'); }
  rowDrag.row.scrollLeft = rowDrag.left - dx;
});
document.addEventListener('pointerup', () => {
  if (!rowDrag) return;
  const { row, moved } = rowDrag;
  rowDrag = null;
  row.classList.remove('dragging');
  if (moved) document.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
});
document.addEventListener('dragstart', (e) => { if (e.target.closest?.('#body .row')) e.preventDefault(); });
document.addEventListener('scroll', (e) => { if (e.target.classList?.contains('row')) syncRowNav(e.target); }, true);
window.addEventListener('resize', syncRows);

// Left/Right moves focus along a row; the row follows
function stepRow(e) {
  const card = document.activeElement?.closest?.('.row > .card');
  if (!card) return false;
  const next = e.key === 'ArrowRight' ? card.nextElementSibling : card.previousElementSibling;
  if (next?.matches('.card')) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  return true;
}

// Big grids render in pages; a sentinel near the bottom pulls in the next one
const PAGE = 90;
function pagedGrid(list, cardFn, cls = 'grid') {
  const id = `pg${Math.random().toString(36).slice(2, 8)}`;
  pagedGrid.pending[id] = { list, cardFn, shown: PAGE };
  return `<div class="${cls}" id="${id}">${list.slice(0, PAGE).map(cardFn).join('')}</div>
    ${list.length > PAGE ? `<div class="sentinel" data-grid="${id}" style="height:1px"></div>` : ''}`;
}
pagedGrid.pending = {};
const pageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const g = pagedGrid.pending[e.target.dataset.grid];
    const el = document.getElementById(e.target.dataset.grid);
    if (!g || !el) continue;
    el.insertAdjacentHTML('beforeend', g.list.slice(g.shown, g.shown + PAGE).map(g.cardFn).join(''));
    g.shown += PAGE;
    observeCovers(el);
    if (g.shown >= g.list.length) { pageObserver.unobserve(e.target); e.target.remove(); }
  }
}, { rootMargin: '800px' });

// ─── views ───────────────────────────────────────────────────────────────────

const byNewest = (a, b) => String(b.addeddate || '').localeCompare(String(a.addeddate || ''));
const byDownloads = (a, b) => (b.downloads || 0) - (a.downloads || 0);
const byTitle = (a, b) => getTitle(a).localeCompare(getTitle(b));

function wallNotice(uploader = null) {
  const f = state.wall.failed.filter(x => !uploader || x.src.uploader === uploader);
  if (!f.length) return '';
  return `<div class="notice warn"><div class="grow">Couldn't reach archive.org for <b>${esc(f.map(x => sourceName(x.src)).join(', '))}</b>: ${esc(f[0].error)}.</div>
    <button class="btn" data-action="reload-wall">Try again</button></div>`;
}

function viewHome() {
  const enabled = state.sources.filter(s => s.enabled !== false);
  const ports = state.ports;
  let html = wallNotice();

  const newest = state.games.slice().sort(byNewest).slice(0, 24);
  html += section('Newest on the wall', newest.length ? newest.map(gameCard).join('') : skeletons(8),
    { cls: 'row', seeAll: ['wall'] });

  for (const s of enabled) {
    const list = state.games.filter(g => (g._versions || [g]).some(v => v._uploader === s.uploader)).sort(byDownloads);
    const failed = state.wall.failed.some(f => f.src.uploader === s.uploader);
    if (failed) continue;
    const body = list.length ? list.slice(0, 20).map(gameCard).join('') : state.wall.loading ? skeletons(8) : '';
    if (!body) continue;
    html += section(`Most played from ${sourceName(s)}`, body, { count: list.length || null, cls: 'row', seeAll: ['uploader', s.uploader] });
  }

  for (const shelf of ports?.shelves || []) {
    const items = ports.items.filter(i => i.shelf === shelf.id)
      .sort((a, b) => (b.data.status === 'available') - (a.data.status === 'available'));
    if (!items.length) continue;
    html += section(`${shelf.name} ports`, items.slice(0, 20).map(portCard).join(''),
      { count: items.length, sub: shelf.withData ? `${shelf.withData} with data` : '', cls: 'row ports', seeAll: ['shelf', shelf.id] });
  }
  if (!ports && !state.portsError) html += section('Ports', skeletons(8), { cls: 'row ports' });
  return html;
}

// ─── library pages (after Cider's library-albums page) ──────────────────────
// A sticky header over the grid: a search box, then Sort by, Sort order, View
// as (cover art or list) and Scroll (infinite or paged). The choices are kept
// per page. Sorting and search follow Cider's searchLibraryAlbums: numbers
// compare as numbers, everything else case-insensitively, and the search
// ignores punctuation.

const PAGE_SIZE = 60;
const PREFS_KEY = 'y4bo.libraryPrefs';
const PREF_DEFAULTS = {
  wall:    { sort: 'dateAdded', order: 'desc', viewAs: 'covers', scroll: 'infinite', uploader: '' },
  shelf:   { sort: 'data', order: 'desc', viewAs: 'covers', scroll: 'infinite', tag: '', data: '' },
  library: { sort: 'name', order: 'asc', viewAs: 'covers', scroll: 'infinite' },
};
const libPrefs = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { /* storage off */ }
  return Object.fromEntries(Object.entries(PREF_DEFAULTS).map(([k, d]) => [k, { ...d, ...saved[k] }]));
})();
function setPref(page, key, value) {
  libPrefs[page][key] = value;
  if (key !== 'viewAs') state.libPage = 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(libPrefs)); } catch { /* storage off */ }
}

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

function mdSelect(page, pref, label, options) {
  const cur = libPrefs[page][pref];
  return `<select class="md-select" data-page="${page}" data-pref="${pref}" aria-label="${esc(label)}"><optgroup label="${esc(label)}">
    ${options.map(([v, text]) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</optgroup></select>`;
}

// The search box goes in the page title row (render adds it); the rest sit
// in a plain row under the title, on the page itself
let pageHasSearch = false;
function libraryHeader(page, sorts, { extra = '', total = 0 } = {}) {
  pageHasSearch = true;
  return `<div class="album-header">
    <div class="lib-controls">${extra}
      ${mdSelect(page, 'sort', 'Sort by', Object.entries(sorts).map(([k, [text]]) => [k, text]))}
      ${mdSelect(page, 'order', 'Sort order', [['asc', 'Ascending'], ['desc', 'Descending']])}
      ${mdSelect(page, 'viewAs', 'View as', [['covers', 'Cover art'], ['list', 'List']])}
      ${mdSelect(page, 'scroll', 'Scroll', [['infinite', 'Infinite'], ['paged', `Paged (${PAGE_SIZE} per page)`]])}
    </div>${libPrefs[page].scroll === 'paged' ? pagination(total) : ''}</div>`;
}

// Cider's pagination: first, previous, five page numbers around the current
// one, next, last, and a page box
function pagination(total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(state.libPage, pages);
  let start = cur - 2, end = cur + 2;
  if (start < 1) { end += 1 - start; start = 1; }
  if (end > pages) { start = Math.max(1, start - (end - pages)); end = pages; }
  const btn = (n, body, cls = '', off = false) =>
    `<button class="md-btn page-btn ${cls}" data-page-go="${n}"${off ? ' disabled' : ''}>${body}</button>`;
  const nums = [];
  for (let n = start; n <= end; n++) nums.push(btn(n, n, n === cur ? 'md-btn-primary' : ''));
  return `<div class="pagination-container">
    ${btn(1, '<i class="pg first"></i>', '', cur === 1)}${btn(cur - 1, '<i class="pg prev"></i>', '', cur === 1)}
    ${nums.join('')}
    ${btn(cur + 1, '<i class="pg next"></i>', '', cur === pages)}${btn(pages, '<i class="pg last"></i>', '', cur === pages)}
    <label class="page-btn md-input-number"><input type="number" id="page-input" min="1" max="${pages}" value="${cur}"><span>/ ${pages}</span></label>
  </div>`;
}

// The sorted, searched list as covers or a list, infinite or paged
function libraryBody(page, list, { card, row, head, cls = 'grid' }) {
  const p = libPrefs[page];
  const asList = p.viewAs === 'list';
  const fn = asList ? row : card;
  const wrap = asList ? 'songs-list' : cls;
  const top = asList ? `<div class="list-head">${head}</div>` : '';
  if (p.scroll !== 'paged') return top + pagedGrid(list, fn, wrap);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const cur = Math.min(state.libPage, pages);
  return `${top}<div class="${wrap}">${list.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE).map(fn).join('')}</div>
    ${pages > 1 ? pagination(list.length) : ''}`;
}

// A row in list view, after Cider's library song list
function gameRow(g) {
  const title = getTitle(g);
  const n = g._versions?.length || 1;
  const badge = isInstalled(g) ? '<span class="pill">Installed</span>' : n > 1 ? `<span class="pill">${n} versions</span>` : '';
  return `<button class="list-row" data-open="game" data-id="${esc(g.identifier)}">
    <span class="lr-art" data-thumb="${esc(g.identifier)}" style="background:${tint(title)}"><span class="noart"></span></span>
    <span class="lr-title"><b>${esc(title)}</b>${badge}</span>
    <span class="lr-col">${esc(g._sourceLabel || '')}</span>
    <span class="lr-col">${esc(fmtDate(g.addeddate))}</span>
    <span class="lr-col num">${g.downloads ? fmtNum(g.downloads) : ''}</span>
  </button>`;
}
const GAME_HEAD = '<span></span><span>Title</span><span>Uploader</span><span>Date added</span><span class="num">Downloads</span>';

function portRow(p) {
  const art = p.iconUrl ? `<img loading="lazy" src="${esc(p.iconUrl)}" alt="">` : '';
  const badge = p.data.status === 'available' ? '<span class="pill ok">Data</span>' : '';
  return `<button class="list-row port-card" data-open="port" data-id="${esc(p.id)}">
    <span class="lr-art icon" style="background:${tint(p.repository)}">${art}</span>
    <span class="lr-title"><b>${esc(p.name)}</b>${badge}${inPortLibrary(p) ? '<span class="pill">In library</span>' : ''}</span>
    <span class="lr-col">${esc(p.project || '')}</span>
    <span class="lr-col">${esc(p.repository)}</span>
    <span class="lr-col">${esc(p.shelfName || '')}</span>
  </button>`;
}
const PORT_HEAD = '<span></span><span>Name</span><span>Project</span><span>Repository</span><span>Shelf</span>';

function viewWall(uploader) {
  const enabled = state.sources.filter(s => s.enabled !== false);
  const p = libPrefs.wall;
  const who = uploader || p.uploader || null;
  let list = state.games.filter(g => !who || (g._versions || [g]).some(v => v._uploader === who));
  list = ciderSearch(list, state.libSearch, g => [getTitle(g), g._sourceLabel, g.identifier, ...(g._versions || []).map(v => getTitle(v))]);
  list = ciderSort(list, (GAME_SORTS[p.sort] || GAME_SORTS.dateAdded)[1], p.order);
  const extra = uploader ? '' : mdSelect('wall', 'uploader', 'Uploader',
    [['', 'All uploaders'], ...enabled.map(s => [s.uploader, sourceName(s)])]);
  let html = libraryHeader('wall', GAME_SORTS, { extra, total: list.length }) + wallNotice(uploader);
  if (!list.length && state.wall.loading) return html + section('', skeletons(18));
  if (!list.length) return html + `<p class="empty">${state.libSearch ? 'Nothing matches that search.' : 'Nothing here yet.'}</p>`;
  const note = `${fmtNum(list.length)} titles${state.wall.loading ? ' · still loading uploaders…' : ''}`;
  return html + `<div class="lib-count">${note}</div>` + libraryBody('wall', list, { card: gameCard, row: gameRow, head: GAME_HEAD });
}

function viewShelf(id) {
  const shelf = state.ports?.shelves.find(s => s.id === id);
  if (!shelf) return state.portsError ? `<p class="empty">Couldn't load the catalogs: ${esc(state.portsError)}</p>` : section('', skeletons(12), { cls: 'grid ports' });
  const p = libPrefs.shelf;
  const all = state.ports.items.filter(i => i.shelf === id);
  const tags = shelf.preferredTags.length ? shelf.preferredTags : [...new Set(all.flatMap(i => i.tags))].slice(0, 12);
  let list = all.filter(i => (!p.tag || i.tags.includes(p.tag)) && (!p.data || i.data.status === 'available'));
  list = ciderSearch(list, state.libSearch, i => [i.name, i.project, i.repository, ...i.tags]);
  const [, value] = PORT_SORTS[p.sort] || PORT_SORTS.data;
  list = ciderSort(ciderSort(list, i => i.name, 'asc'), value, p.order);
  const extra = mdSelect('shelf', 'data', 'Show', [['', 'All ports'], ['1', 'With game data']])
    + mdSelect('shelf', 'tag', 'Tag', [['', 'Any tag'], ...tags.map(t => [t, t])]);
  let html = libraryHeader('shelf', PORT_SORTS, { extra, total: list.length });
  if (shelf.error) {
    html += `<div class="notice warn"><div class="grow">Couldn't fetch the ${esc(shelf.name)} catalog (${esc(shelf.error)}).</div><button class="md-btn" data-action="refresh-ports">Retry</button></div>`;
  } else if (shelf.fromCache) {
    html += `<div class="notice"><div class="grow">Showing the cached ${esc(shelf.name)} catalog from ${esc(fmtDate(shelf.fetchedAt))}; GitHub wasn't reachable.</div><button class="md-btn" data-action="refresh-ports">Retry</button></div>`;
  }
  html += `<div class="lib-count">${list.length} ports · Source: Quiver / ${esc(shelf.name)}${shelf.withData ? ` · ${shelf.withData} with data from archive.org` : ''}</div>`;
  return html + (list.length ? libraryBody('shelf', list, { card: portCard, row: portRow, head: PORT_HEAD, cls: 'grid ports' }) : '<p class="empty">No ports match.</p>');
}

// A library row no loaded item describes (a manual app, an upload no longer
// on the wall), as a game the cards and detail can show
const rowGame = (l) => ({
  identifier: l.identifier, title: l.title || l.identifier,
  _sourceLabel: l.source === 'manual' ? 'Your folder' : 'archive.org', _manual: l.source === 'manual',
});

// Add your own app: a name, then a new folder in the install folder or one
// that already holds it. Quiver's "manually managed" apps.
function manualFormHtml() {
  const f = state.manualForm;
  if (!f) return `<div class="lib-tools"><button class="btn" data-action="manual-open">Add your own app…</button></div>`;
  return `<div class="manual-form" id="manual-form">
    <div class="field"><label for="manual-name">Name</label>
      <input type="text" id="manual-name" value="${esc(f.name)}" placeholder="What it's called in your library"></div>
    <div class="field"><label>Folder</label>
      <div class="hint">${f.folder ? esc(f.folder) : "A new folder in your install folder. Put the app's files in it and the library launches it."}</div>
      <div class="inline"><button class="btn" data-action="manual-folder">Use a folder I already have…</button>
      ${f.folder ? '<button class="btn" data-action="manual-folder-clear">Make a new one instead</button>' : ''}</div></div>
    <div class="field inline"><button class="btn primary" id="btn-manual-create" data-action="manual-create">Add to library</button>
      <button class="btn" data-action="manual-cancel">Cancel</button></div>
  </div>`;
}

async function createManual() {
  const name = $('#manual-name')?.value.trim();
  if (!name) return toast('Give it a name first.');
  const r = await api.createManualApp({ name, folder: state.manualForm.folder });
  if (!r.ok) return toast(`Couldn't add it: ${r.error}`);
  state.manualForm = null;
  await reloadLibrary();
  render();
  openDetail('game', r.row.identifier);
  if (!r.row.exe_path) api.openGameLocation({ identifier: r.row.identifier });
}

function viewLibrary() {
  // Installed ports are on the Ports shelf below
  const installed = Object.values(state.library).filter(l => (l.install_dir || l.source === 'manual') && !l.identifier.startsWith('quiver:'));
  const games = installed.map(l => state.games.find(g => (g._versions || [g]).some(v => v.identifier === l.identifier)) || rowGame(l));
  let uniq = [...new Map(games.map(g => [g.identifier, g])).values()];
  let ports = state.portLibrary.map(r => state.ports?.items.find(i => i.id === r.id)).filter(Boolean);
  const manual = manualFormHtml();
  if (!uniq.length && !ports.length) {
    return manual + `<p class="empty"><b>Your library is empty.</b><br>Install something from the game wall, open a Ports shelf and add a port,
      or add an app of your own. The library is what's yours, not everything that exists.</p>`;
  }
  const p = libPrefs.library;
  const sorts = { name: ['Title', x => x.name || getTitle(x)], dateAdded: ['Date added', x => state.library[x.identifier || x.id]?.added_at] };
  const [, value] = sorts[p.sort] || sorts.name;
  uniq = ciderSort(ciderSearch(uniq, state.libSearch, g => [getTitle(g), g._sourceLabel]), value, p.order);
  ports = ciderSort(ciderSearch(ports, state.libSearch, i => [i.name, i.repository]), value, p.order);
  let html = libraryHeader('library', sorts, { total: uniq.length + ports.length }) + manual;
  if (uniq.length) html += section('Installed games', libraryBody('library', uniq, { card: gameCard, row: gameRow, head: GAME_HEAD }), { count: uniq.length, cls: 'plain' });
  if (ports.length) html += section('Ports', libraryBody('library', ports, { card: portCard, row: portRow, head: PORT_HEAD, cls: 'grid ports' }), { count: ports.length, cls: 'plain', sub: 'From a catalog, or yours.' });
  return html;
}

// New, laid out like Cider's New page: a wide carousel of the hand-picked
// games and ports (catalog/featured.json), then a compact list of what landed
// most recently, this week's uploads and the ports new in the catalogs.
const newestVersion = (g) => (g._versions || [g]).slice().sort(byNewest)[0];
const blurbOf = (text) => {
  const b = stripHtml(Array.isArray(text) ? text.join('\n') : text).replace(/\s+/g, ' ').trim();
  return b.length > 110 ? `${b.slice(0, 107)}…` : b;
};

// Picks in order, each resolved to a wall game or a catalog port; picks not
// on the wall (a disabled uploader, a catalog not subscribed) are skipped
function resolvePicks() {
  return state.featured.flatMap((pick) => {
    if (pick.identifier) {
      const g = state.games.find(x => (x._versions || [x]).some(v => v.identifier === pick.identifier));
      return g ? [{ kind: 'game', g, v: (g._versions || [g]).find(v => v.identifier === pick.identifier), pick }] : [];
    }
    const p = state.ports?.items.find(x => String(x.repository).toLowerCase() === pick.repository);
    return p ? [{ kind: 'port', p, pick }] : [];
  });
}

function featureCard({ kind, g, v, p, pick }) {
  const port = kind === 'port';
  const title = port ? p.name : getTitle(g);
  const sub = port ? (p.project || p.repository) : [v._sourceLabel, v.addeddate ? new Date(v.addeddate).getFullYear() : ''].filter(Boolean).join(' · ');
  const blurb = pick.blurb || blurbOf(port ? p.description : v.description);
  const art = port
    ? `<div class="art icon" style="background:${tint(p.repository)}">${p.iconUrl ? `<img loading="lazy" src="${esc(p.iconUrl)}" alt="">` : ''}`
    : `<div class="art" data-thumb="${esc(v.identifier)}" style="background:${tint(title)}">`;
  return `<button class="card feature-card" data-open="${port ? 'port' : 'game'}" data-id="${esc(port ? p.id : g.identifier)}">
    <div class="eyebrow">${port ? 'y4bo pick · port' : 'y4bo pick'}</div>
    <div class="title">${esc(title)}</div>
    <div class="sub">${esc(sub)}</div>
    ${art}${blurb ? `<p>${esc(blurb)}</p>` : ''}</div>
  </button>`;
}

function listItem(g) {
  const v = newestVersion(g);
  return `<button class="card list-item" data-open="game" data-id="${esc(g.identifier)}">
    <div class="art" data-thumb="${esc(v.identifier)}" style="background:${tint(getTitle(g))}"></div>
    <div class="grow"><div class="title">${esc(getTitle(g))}</div>
    <div class="sub">${esc([v._sourceLabel, fmtDate(v.addeddate)].filter(Boolean).join(' · '))}</div></div>
  </button>`;
}

function viewNew() {
  let html = wallNotice();
  const newest = state.games.slice().sort((a, b) => byNewest(newestVersion(a), newestVersion(b)));
  if (!newest.length) return html + (state.wall.loading ? section('', skeletons(6), { cls: 'row' }) : '<p class="empty">Nothing on the wall yet.</p>');

  const picks = resolvePicks();
  if (picks.length) html += `<section class="section has-row feature-sec"><div class="row feature">${picks.map(featureCard).join('')}</div>${rowNav}</section>`;

  const rest = newest.slice(0, 40);
  if (rest.length) html += section('Recently added', rest.map(listItem).join(''), { cls: 'row list', seeAll: ['wall'] });

  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const week = newest.filter(g => String(newestVersion(g).addeddate || '') >= weekAgo);
  if (week.length) html += section('New this week', week.slice(0, 24).map(gameCard).join(''), { count: week.length, cls: 'row' });

  const added = new Set(state.review.flatMap(r => r.added.map(a => `${r.id}|${String(a.repository).toLowerCase()}`)));
  const newPorts = (state.ports?.items || []).filter(p => added.has(`${p.shelf}|${String(p.repository).toLowerCase()}`));
  if (newPorts.length) html += section('New ports', newPorts.map(portCard).join(''), { count: newPorts.length, cls: 'row ports', seeAll: ['updates'] });
  return html;
}

function viewUpdates() {
  let html = `<div class="toolbar"><span style="color:var(--text2)">What changed in the catalogs since you last looked. Nothing updates itself; you decide.</span>
    <span class="grow"></span><button class="btn" data-action="refresh-ports">Check catalogs now</button>
    ${reviewCount() ? '<button class="btn primary" data-action="mark-seen">Mark all seen</button>' : ''}</div>`;
  if (!state.review.length) return html + '<p class="empty">Loading…</p>';
  if (!reviewCount()) {
    html += `<p class="empty"><b>Everything is current.</b><br>No catalog entries were added, changed or removed since you last marked them seen.</p>`;
  }
  for (const r of state.review) {
    const rows = [...r.added.map(a => ['added', a]), ...r.changed.map(a => ['changed', a]), ...r.removed.map(a => ['removed', a])];
    if (!rows.length) continue;
    html += section(r.name, `<div class="review-list">${rows.map(([what, a]) => {
      const item = state.ports?.items.find(i => i.shelf === r.id && i.repository === a.repository && i.folderName === (a.folderName || ''));
      return `<div class="review-item"><span class="what ${what}">${what.toUpperCase()}</span>
        ${a.appIconUrl ? `<img src="${esc(a.appIconUrl)}" alt="">` : ''}
        <div class="grow"><div class="name">${esc(a.name)}</div><div class="repo">${esc(a.repository)}</div></div>
        ${item && what !== 'removed' ? `<button class="btn ${inPortLibrary(item) ? '' : 'primary'}" data-toggle-port="${esc(item.id)}">${inPortLibrary(item) ? 'Remove' : 'Add'}</button>` : ''}
      </div>`;
    }).join('')}</div>`, { count: rows.length, cls: '' });
  }
  return html;
}

function viewSettings() {
  const s = state.settings;
  return `<div class="form">
    <div class="field"><label for="setting-sources">Uploaders</label>
      <div class="hint">One archive.org uploader per line, optional ", label". A leading # turns a line off. The wall queries them one at a time.</div>
      <textarea id="setting-sources" spellcheck="false">${esc(formatSources(state.sources))}</textarea></div>
    <div class="field"><label for="setting-install">Install folder</label>
      <div class="inline"><input type="text" id="setting-install" value="${esc(s.installPath || '')}" placeholder="Default: the app's games folder">
      <button class="btn" data-action="choose-install">Choose…</button></div></div>
    <div class="field"><label for="setting-download">Download folder</label>
      <div class="inline"><input type="text" id="setting-download" value="${esc(s.downloadPath || '')}" placeholder="Default: the install folder">
      <button class="btn" data-action="choose-download">Choose…</button></div></div>
    <div class="field actions"><button class="btn primary" id="btn-save-settings" data-action="save-settings">Save</button></div>
    <div class="field"><label>Catalogs</label>
      <div class="hint">${state.ports ? state.ports.shelves.map(sh => `${esc(sh.name)}: ${sh.count}${sh.error ? ' (unreachable)' : sh.fromCache ? ' (cached)' : ''}`).join(' · ') : 'Loading…'}
</div>
      <button class="btn" data-action="refresh-ports">Refresh catalogs</button></div>
    <div class="field"><label>Feeds</label>
      <div class="hint">A feed is someone's curation: ports from GitHub releases with the archive.org data they need, and the archive.org uploaders they trust.
        Subscribe by URL. A feed's ports show up right away (yours win over a feed's, and a feed's over the bundled ones); its uploaders wait until you trust each one.</div>
      <div id="feed-list">${feedListHtml()}</div>
      <div class="inline"><input type="text" id="feed-url" placeholder="https://…/feed.json"><button class="btn" data-action="feed-add">Subscribe</button></div>
      <div class="inline feed-own"><button class="btn" data-action="ed-export">Copy my feed</button>
        <label class="btn">Import a feed file…<input type="file" id="feed-file" accept=".json,application/json" hidden></label></div>
      <div class="hint">Your feed is your own ports and the uploaders you have on. Importing a file makes its ports yours and adds its uploaders to your list.</div></div>
    <div class="field" id="quiver-import"><label>Quiver library</label>
      <div class="hint">Bring over what Quiver Launcher already has: pick the folder with its apps.json. Installed apps are adopted where they are, nothing is downloaded again.</div>
      <div class="import-body">${quiverImportHtml()}</div></div>
    <div class="field"><label>Interface</label>
      <div class="hint">The classic interface is still there while this one catches up on installs for ports.</div>
      <button class="btn" id="btn-classic-ui" data-action="legacy-ui">Switch to the classic interface</button></div>
    <div class="field"><div class="hint" id="app-version"></div></div>
  </div>`;
}

const IMPORT_KIND = { port: 'catalog port', new: 'new on Your ports', manual: 'your folder' };

function quiverImportHtml() {
  const q = state.quiverImport;
  if (!q?.plan) return `<button class="btn" data-action="quiver-import-choose"${q?.busy ? ' disabled' : ''}>Import from Quiver…</button>`;
  const { plan, result } = q;
  if (result) {
    const said = [[result.adopted, 'adopted'], [result.added, 'added'], [result.ports, 'new on Your ports'], [result.unchanged, 'already here']]
      .filter(([n]) => n).map(([n, what]) => `${n} ${what}`).join(', ');
    return `<div class="hint import-done">Imported from ${esc(plan.root)}: ${esc(said || 'nothing to change')}.</div>
      <button class="btn" data-action="quiver-import-cancel">Done</button>`;
  }
  const todo = plan.apps.filter(a => !a.alreadyInstalled && !(a.inLibrary && !a.installed));
  const rows = plan.apps.map(a => `<li><b>${esc(a.name)}</b>
    <span>${esc(IMPORT_KIND[a.kind])} · ${a.alreadyInstalled || (a.inLibrary && !a.installed) ? 'already here' : a.installed ? `installed${a.version ? ` ${esc(a.version)}` : ''}` : 'not installed'}</span></li>`).join('');
  const skipped = plan.skipped.map(x => `<li><b>${esc(x.name)}</b><span>skipped: ${esc(x.reason)}</span></li>`).join('');
  return `<div class="hint">${plan.apps.length} apps in ${esc(plan.root)}</div>
    <ul class="import-list">${rows}${skipped}</ul>
    <div class="inline">
      <button class="btn primary" data-action="quiver-import-apply"${q.busy || !todo.length ? ' disabled' : ''}>${todo.length ? `Import ${todo.length}` : 'Nothing new'}</button>
      <button class="btn" data-action="quiver-import-cancel">Cancel</button></div>`;
}

// render() keeps the settings form as typed, so this redraws only the field
function renderQuiverImport() {
  const el = $('#quiver-import .import-body');
  if (el) el.innerHTML = quiverImportHtml();
}

async function quiverImport(apply) {
  const q = state.quiverImport || {};
  const dir = apply ? q.plan.root : await api.chooseFolder();
  if (!dir) return;
  state.quiverImport = { ...q, busy: true };
  renderQuiverImport();
  const r = await api.importQuiver({ dir, apply });
  if (!r.ok) {
    state.quiverImport = apply ? { ...q, busy: false } : null;
    renderQuiverImport();
    return toast(`Couldn't import: ${r.error}`);
  }
  state.quiverImport = { plan: r, result: r.result || null, busy: false };
  if (apply) await loadPorts();
  renderQuiverImport();
}

function viewSearch(q) {
  const needle = q.toLowerCase();
  const games = state.games.filter(g => (g._versions || [g]).some(v => getTitle(v).toLowerCase().includes(needle) || v.identifier.includes(needle)));
  const ports = (state.ports?.items || []).filter(p => [p.name, p.project, p.repository, ...p.tags].some(x => String(x).toLowerCase().includes(needle)));
  if (!games.length && !ports.length) return `<p class="empty">Nothing matches “${esc(q)}”.</p>`;
  let html = '';
  if (games.length) html += `<section class="section"><div class="section-head"><h2>Games</h2><span class="count">${games.length}</span></div>${pagedGrid(games, gameCard)}</section>`;
  if (ports.length) html += `<section class="section"><div class="section-head"><h2>Ports</h2><span class="count">${ports.length}</span></div>${pagedGrid(ports, portCard, 'grid ports')}</section>`;
  return html;
}

// The round reload button at the right of the page title (Cider's reload-btn)
const RELOADS = { home: 'reload-all', wall: 'reload-wall', uploader: 'reload-wall', shelf: 'refresh-ports', updates: 'refresh-ports' };
const HEADINGS = { home: 'Home', new: 'New', wall: 'Game wall', library: 'Library', updates: 'Keep current', settings: 'Settings', collision: 'Game data' };

function render() {
  const v = state.view;
  pagedGrid.pending = {};
  pageHasSearch = false;
  let html;
  if (state.query) html = viewSearch(state.query);
  else if (v.name === 'new') html = viewNew();
  else if (v.name === 'wall') html = viewWall(null);
  else if (v.name === 'uploader') html = viewWall(v.arg);
  else if (v.name === 'shelf') html = viewShelf(v.arg);
  else if (v.name === 'library') html = viewLibrary();
  else if (v.name === 'updates') html = viewUpdates();
  else if (v.name === 'settings') html = viewSettings();
  else if (v.name === 'collision') html = viewCollision();
  else html = viewHome();

  const heading = state.query ? 'Search'
    : v.name === 'shelf' ? `${state.ports?.shelves.find(s => s.id === v.arg)?.name || ''} ports`
    : v.name === 'uploader' ? sourceName(state.sources.find(s => s.uploader === v.arg) || { uploader: v.arg })
    : v.name === 'collision' && !v.arg ? 'Add a GitHub repo'
    : HEADINGS[v.name] || 'Home';

  // Keep the settings form as typed while the wall is still streaming in
  if (v.name === 'settings' && !state.query && $('#setting-sources')) { renderNav(); return; }
  const body = $('#body');
  const typing = document.activeElement?.id === 'lib-search' ? document.activeElement.selectionStart : null;
  const reload = !state.query && RELOADS[v.name];
  const search = pageHasSearch ? `<input type="search" class="search-input" id="lib-search" spellcheck="false"
    placeholder="Search ${esc(heading)}" value="${esc(state.libSearch)}" aria-label="Search this page">` : '';
  body.innerHTML = `<div class="page-head"><h1 class="page-title" id="heading">${esc(heading)}</h1><span class="grow"></span>
    ${search}${reload ? `<button class="reload-btn" data-action="${reload}" aria-label="Reload" title="Reload"></button>` : ''}</div>` + html;
  if (typing != null) { const el = $('#lib-search'); el?.focus(); el?.setSelectionRange(typing, typing); }
  observeCovers(body);
  syncRows();
  body.querySelectorAll('.sentinel').forEach(el => pageObserver.observe(el));
  if (v.name === 'settings') api.getAppVersion().then(ver => { const el = $('#app-version'); if (el) el.textContent = `y4bo ${ver}`; }).catch(() => {});
  renderAmbient();
  renderNav();
  if (state.detail) renderDetail();
}

// Ambient background: a few covers from the wall, blurred behind the glass
let ambientDone = false;
function renderAmbient() {
  if (ambientDone || state.games.length < 8) return;
  ambientDone = true;
  const picks = state.games.slice().sort(byDownloads).slice(0, 8);
  $('#ambient').innerHTML = picks.map(g => `<div data-amb="${esc(g.identifier)}"></div>`).join('');
  for (const g of picks) {
    thumb(g.identifier).then(url => {
      const el = document.querySelector(`[data-amb="${CSS.escape(g.identifier)}"]`);
      if (url && el) el.style.backgroundImage = `url("${url}")`;
    });
  }
}

// ─── detail panel ────────────────────────────────────────────────────────────

function openDetail(kind, id) {
  if (kind === 'game') {
    const g = state.games.find(x => x.identifier === id) || state.versions.find(x => x.identifier === id)
      || (state.library[id] ? rowGame(state.library[id]) : null);
    if (!g) return;
    state.detail = { kind, game: g, version: installedVersion(g) || g, exes: null };
  } else {
    const p = state.ports?.items.find(x => x.id === id);
    if (!p) return;
    state.detail = { kind, port: p, exes: null };
  }
  $('#detail').classList.remove('hidden');
  renderDetail();
}

function closeDetail() {
  state.detail = null;
  $('#detail').classList.add('hidden');
}

function renderDetail() {
  const d = state.detail;
  const panel = $('#detail-panel');
  if (!d) return;
  panel.innerHTML = d.kind === 'game' ? gameDetail(d) : portDetail(d);
  const cover = panel.querySelector('[data-cover]');
  if (cover) {
    thumb(cover.dataset.cover).then(url => {
      if (!url || state.detail !== d) return;
      cover.innerHTML = `<img src="${esc(url)}" alt="">`;
      panel.querySelector('.d-hero .bg').style.backgroundImage = `url("${url}")`;
    });
  }
}

const EXE_HEADINGS = { steam: 'Pick the executable for Steam', default: 'Pick the executable to launch by default', play: 'Pick the executable' };
function exePicker(d) {
  if (!d.exes) return '';
  return `<div class="h3">${EXE_HEADINGS[d.exes.purpose]}</div>
    <div class="versions">${d.exes.list.map(p => `<button class="version" data-exe="${esc(p)}"><span class="who">${esc(p.split(/[\\/]/).pop())}</span><span class="meta">${esc(p)}</span></button>`).join('')}</div>`;
}

// A manually managed app: its folder is the whole story
function manualDetail(d) {
  const v = d.version;
  const title = getTitle(v);
  const lib = state.library[v.identifier] || {};
  const actions = lib.install_dir
    ? `<button class="btn primary" id="btn-play" data-action="play">Play</button>
      <button class="btn" data-action="open-folder">Open folder</button>
      <button class="btn" data-action="steam">Add to Steam</button>
      <button class="btn" data-action="manual-rename">Rename</button>
      <button class="btn" data-action="manual-remove">Remove from library</button>`
    : `<button class="btn primary" data-action="manual-locate">Locate folder…</button>
      <button class="btn" data-action="manual-remove">Remove from library</button>`;
  const note = !lib.install_dir ? 'Its folder is gone. Point it at the folder the app is in now.'
    : !lib.exe_path ? "Put the app's files in its folder, then Play finds the executable." : '';
  return `<div class="d-hero"><div class="bg" style="background:${tint(title)}"></div>
      <div class="cover" data-cover="${esc(v.identifier)}" style="background:${tint(title)}"></div>
      <button class="x" data-close aria-label="Close">&#10005;</button>
      <div class="titles"><h2>${esc(title)}</h2><div class="by">Your folder</div></div></div>
    <div class="d-body">
      <div class="actions">${actions}</div>
      ${note ? `<p class="hint manual-note">${esc(note)}</p>` : ''}
      ${exePicker(d)}
      <dl class="kv">
        ${lib.install_dir ? `<dt>Folder</dt><dd>${esc(lib.install_dir)}</dd>` : ''}
        ${lib.exe_path ? `<dt>Launches</dt><dd>${esc(lib.exe_path)}</dd>` : ''}
        ${lib.version ? `<dt>Version</dt><dd>${esc(lib.version)}</dd>` : ''}
        ${lib.tags?.length ? `<dt>Tags</dt><dd>${esc(lib.tags.join(', '))}</dd>` : ''}
      </dl>
    </div>`;
}

function gameDetail(d) {
  if (d.version._manual) return manualDetail(d);
  const g = d.game, v = d.version;
  const title = getTitle(v);
  const lib = state.library[v.identifier];
  const dl = state.downloads.get(v.identifier);
  const versions = g._versions || [g];
  let actions;
  if (dl) {
    actions = `<button class="btn primary" disabled>${dl.status === 'extracting' ? 'Extracting…' : 'Downloading…'}</button>
      ${dl.status === 'downloading' ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}`;
  } else if (lib?.install_dir) {
    actions = `<button class="btn primary" id="btn-play" data-action="play">Play</button>
      <button class="btn" data-action="open-folder">Open folder</button>
      <button class="btn" data-action="steam">Add to Steam</button>
      <button class="btn" data-action="delete">Delete</button>`;
  } else {
    actions = `<button class="btn primary" id="btn-download" data-action="install">Install</button>`;
  }
  const exes = exePicker(d);
  const desc = stripHtml(Array.isArray(v.description) ? v.description.join('\n') : v.description);
  return `<div class="d-hero"><div class="bg" style="background:${tint(title)}"></div>
      <div class="cover" data-cover="${esc(v.identifier)}" style="background:${tint(title)}"></div>
      <button class="x" data-close aria-label="Close">&#10005;</button>
      <div class="titles"><h2>${esc(title)}</h2><div class="by">${v._manual ? 'Your folder' : `archive.org · ${esc(v._sourceLabel || '')}`}${v.addeddate ? ` · ${fmtDate(v.addeddate)}` : ''}</div></div></div>
    <div class="d-body">
      <div class="actions">${actions}</div>
      ${dl ? `<div class="progress"><i style="width:${dl.percent || 0}%"></i></div><div class="progress-label">${dl.percent || 0}%</div>` : ''}
      ${exes}
      ${versions.length > 1 ? `<div class="h3">${versions.length} versions</div><div class="versions">${versions.map(x => `
        <button class="version ${x === v ? 'on' : ''}" data-version="${esc(x.identifier)}"><span class="who">${esc(x._sourceLabel)}</span>
        ${state.library[x.identifier]?.install_dir ? '<span class="tag installed" style="position:static">INSTALLED</span>' : ''}
        <span class="meta">${esc(fmtDate(x.addeddate))} · ${fmtNum(x.downloads)} downloads</span></button>`).join('')}</div>` : ''}
      <dl class="kv">
        <dt>Uploader</dt><dd>${esc(v._uploader || '')}</dd>
        <dt>Item</dt><dd><a data-href="https://archive.org/details/${esc(v.identifier)}">${esc(v.identifier)}</a></dd>
        <dt>Downloads</dt><dd>${fmtNum(v.downloads)}</dd>
        ${lib?.install_dir ? `<dt>Installed to</dt><dd>${esc(lib.install_dir)}</dd>` : ''}
      </dl>
      ${desc ? `<div class="h3">About</div><div class="desc">${esc(desc)}</div>` : ''}
    </div>`;
}

// Install, progress and the installed actions for a port (library row keyed by its catalog id)
const PORT_STEPS = { binary: 'the build from GitHub', data: 'the game data from archive.org' };
function portActions(p) {
  const dl = state.downloads.get(p.id);
  if (dl) {
    const what = dl.status === 'verifying' ? 'Checking game data…' : dl.status === 'extracting' ? 'Unpacking…' : 'Downloading…';
    return `<button class="btn primary" disabled>${what}</button>${dl.status === 'downloading' ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}`;
  }
  if (state.library[p.id]?.install_dir) {
    return `<button class="btn primary" id="btn-play" data-action="play">Play</button>
      <button class="btn" data-action="open-folder">Open folder</button>`;
  }
  return `<button class="btn primary" id="btn-install-port" data-action="install">Install</button>`;
}
function portProgress(p) {
  const dl = state.downloads.get(p.id);
  if (!dl) return state.library[p.id]?.install_dir ? `<div class="srcline"><b>Installed to</b> ${esc(state.library[p.id].install_dir)}</div>` : '';
  return `<div class="progress"><i style="width:${dl.percent || 0}%"></i></div>
    <div class="progress-label">${esc(PORT_STEPS[dl.step] || '')} · ${dl.percent || 0}%</div>`;
}

function portDetail(d) {
  const p = d.port;
  const added = inPortLibrary(p);
  const data = p.data.status === 'available'
    ? `<b>Binary:</b> GitHub release from ${esc(p.repository)}<br><b>Data:</b> <span class="ok">archive.org (${esc(p.data.uploader || p.data.iaIdentifier)})</span>, ${esc(p.data.files.join(', ') || 'item contents')}, sha1-checked after staging`
    : p.data.status === 'missing'
      ? `<b>Binary:</b> GitHub release from ${esc(p.repository)}<br><b>Data:</b> <span class="warn">needs ${esc(p.data.files.join(', '))}, not in the catalog</span>`
      : `<b>Binary:</b> GitHub release from ${esc(p.repository)}<br><b>Data:</b> none needed, as far as the catalog knows`;
  const icon = p.iconUrl ? `<img src="${esc(p.iconUrl)}" alt="">` : '';
  return `<div class="d-hero"><div class="bg" style="background:${tint(p.repository)}${p.iconUrl ? `;background-image:url('${esc(p.iconUrl)}')` : ''}"></div>
      <div class="cover icon" style="background:${tint(p.repository)}">${icon}</div>
      <button class="x" data-close aria-label="Close">&#10005;</button>
      <div class="titles"><h2>${esc(p.name)}</h2><div class="by">${esc(p.project)} · Source: Quiver / ${esc(p.shelfName)}</div></div></div>
    <div class="d-body">
      <div class="actions">
        <button class="btn ${added ? '' : 'primary'}" data-toggle-port="${esc(p.id)}">${added ? 'Remove from library' : 'Add to library'}</button>
        ${portActions(p)}
        <button class="btn" data-href="https://github.com/${esc(p.repository)}">Repository</button>
        <button class="btn" data-action="edit-collision" data-repo="${esc(p.repository)}">Game data…</button>
      </div>
      ${portProgress(p)}
      ${exePicker(d)}
      <div class="srcline">${data}</div>
      ${p.tags.length ? `<div class="h3">Tags</div><div class="tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <dl class="kv">
        <dt>Repository</dt><dd><a data-href="https://github.com/${esc(p.repository)}">${esc(p.repository)}</a></dd>
        <dt>Folder</dt><dd>${esc(p.folderName)}</dd>
        ${p.releaseAssetFilter ? `<dt>Asset filter</dt><dd><code>${esc(p.releaseAssetFilter)}</code></dd>` : ''}
        ${p.filesToAdd.length ? `<dt>Files to add</dt><dd>${esc(p.filesToAdd.join(', '))}</dd>` : ''}
        <dt>Catalog</dt><dd>${esc(p.catalogUrl)}</dd>
      </dl>
    </div>`;
}

// ─── actions ─────────────────────────────────────────────────────────────────

async function installGame(v) {
  const identifier = v.identifier;
  if (state.downloads.has(identifier)) return;
  const list = await api.fetchFileList({ identifier });
  if (!list.ok || !list.files?.length) return toast(`Couldn't read the file list: ${list.error || 'no files'}`);
  const files = list.files;
  const archives = files.filter(f => /\.(zip|7z|rar)$/i.test(f.name) || (/\.exe$/i.test(f.name) && !files.some(x => /\.(zip|7z|rar)$/i.test(x.name))));
  if (!archives.length) return toast('No downloadable file found for this game.');
  // Largest archive is the game; multi-part picks stay in the classic UI for now
  const file = archives.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];

  const dl = { percent: 0, status: 'downloading', jobId: null };
  state.downloads.set(identifier, dl);
  render();
  const job = await api.install({
    identifier,
    fileName:     file.name,
    onStart:      (j) => { dl.jobId = j.id; },
    onProgress:   (percent) => showProgress(identifier, percent),
    onExtracting: () => { dl.status = 'extracting'; dl.percent = 100; render(); },
  });
  state.downloads.delete(identifier);
  await reloadLibrary();
  if (job.status === 'done') toast(`${getTitle(v)} is installed.`);
  else if (job.status !== 'cancelled') toast(`Install failed: ${job.error || 'unknown error'}`);
  render();
}

async function installPort(p) {
  if (state.downloads.has(p.id)) return;
  const dl = { percent: 0, status: 'downloading', step: 'binary', jobId: null };
  state.downloads.set(p.id, dl);
  renderDetail();
  const job = await api.install({
    identifier:   p.id,
    onStart:      (j) => { dl.jobId = j.id; },
    onProgress:   (percent, j) => { Object.assign(dl, { percent, status: 'downloading', step: j.step }); renderDetail(); },
    onExtracting: (j) => { Object.assign(dl, { percent: 100, status: j.status, step: j.step }); renderDetail(); },
  });
  state.downloads.delete(p.id);
  await reloadLibrary();
  if (job.status === 'done') toast(`${p.name} is installed.`);
  else if (job.status !== 'cancelled') toast(`Install failed: ${job.error || 'unknown error'}`, 8000);
  render();
}

async function playGame(v) {
  const lib = state.library[v.identifier];
  if (lib?.exe_path) return launch(v, lib.exe_path);
  const exes = await api.findExes({ identifier: v.identifier });
  if (!exes.length) return toast(v._manual ? "No executable yet: put the app's files in its folder." : 'No executable found. Try reinstalling.');
  if (exes.length === 1) return launch(v, exes[0]);
  state.detail.exes = { purpose: 'play', list: exes };
  renderDetail();
}

async function launch(v, exePath) {
  const r = await api.launchGame({ identifier: v.identifier, exePath });
  if (!r.ok) toast(`Couldn't launch: ${r.error}`);
}

async function addToSteam(v, exePath) {
  const r = await api.addToSteam({ appName: getTitle(v), exePath, startDir: exePath.replace(/[\\/][^\\/]*$/, '') });
  toast(r.ok ? `Added ${getTitle(v)} to Steam. Restart Steam to see it.` : `Couldn't add to Steam: ${r.error}`);
}

async function togglePort(id) {
  const p = state.ports?.items.find(i => i.id === id);
  if (!p) return;
  if (inPortLibrary(p)) {
    await api.removeFromLibrary({ id });
    toast(`Removed ${p.name} from your library. Installed files stay where they are.`);
  } else {
    await api.addToLibrary({ id, source: p.catalogUrl });
    toast(`Added ${p.name} to your library.`);
  }
  await reloadLibrary();
  render();
}


// ─── Game data: the collision editor (docs/COLLISIONS.md) ───────────────────

const ARCHIVE_RE = /\.(zip|7z|rar)$/i;
const blankSource = () => ({ ia: '', path: '', target: '', extract: false, sha1: '', optional: false });

// Loads the collision in effect for repo (or a blank one for a new repo) into the editor
async function startEditor(repo) {
  const port = repo && state.ports?.items.find(i => i.repository?.toLowerCase() === repo.toLowerCase());
  const ed = state.editor = { repo: repo || '', isNew: !repo, loading: !!repo, origin: null, feed: null, extra: {},
    name: port?.name || '', folderName: port?.folderName || '', assetPattern: '', base: 'binary', binaryTarget: '',
    sources: repo ? [] : [blankSource()], browse: null, preview: null, errors: null };
  if (!repo) return;
  const c = await api.getCollision(repo);
  if (state.editor !== ed) return;
  ed.loading = false;
  if (c) {
    const { repository, name, folderName, assetPattern, base, binaryTarget, sources, ...extra } = c.entry;
    Object.assign(ed, {
      origin: c.origin, feed: c.feed || null, extra,
      name: name || ed.name, folderName: folderName || ed.folderName, assetPattern: assetPattern || '',
      base: base === 'data' ? 'data' : 'binary', binaryTarget: binaryTarget || '',
      sources: (sources || []).map(x => ({ ...blankSource(), ...x, sha1: x.sha1 || '', target: x.target || '' })),
    });
  }
  if (!ed.sources.length) ed.sources.push(blankSource());
  if (state.view.name === 'collision') render();
}

function viewCollision() {
  const ed = state.editor;
  if (!ed) return '<p class="empty">Loading…</p>';
  if (ed.loading) return '<p class="empty">Loading the collision…</p>';
  const from = ed.origin === 'local' ? 'Yours.' : ed.origin === 'feed' ? `From the ${esc(ed.feed?.name || '')} feed. Saving makes a copy of your own that wins over it.`
    : ed.origin === 'bundled' ? 'Bundled with the launcher. Saving makes a copy of your own that wins over it.' : 'Nothing yet.';
  const legacy = ed.extra.dataFiles?.length
    ? `<div class="hint">Also picks ${esc(ed.extra.dataFiles.map(d => d.name).join(', '))} out of ${esc(decodeURIComponent(String(ed.extra.contentUrl || '').split('/').pop()))} (the first version of the schema). That part is kept as it is.</div>` : '';
  return `<div class="form editor">
    <p class="lede">Binds a GitHub release to the game data it needs on archive.org, and says how the two go together in the install folder. ${ed.isNew ? 'A repo no catalog lists shows up on the Your ports shelf.' : from}</p>
    ${ed.isNew ? `<div class="field"><label for="ed-repo">GitHub repository</label>
      <input type="text" id="ed-repo" data-ed="repo" value="${esc(ed.repo)}" placeholder="owner/repo" spellcheck="false"></div>`
    : `<div class="field"><label>GitHub repository</label><div class="hint"><a data-href="https://github.com/${esc(ed.repo)}">${esc(ed.repo)}</a></div></div>`}
    <div class="field two"><div><label for="ed-name">Name</label><input type="text" id="ed-name" data-ed="name" value="${esc(ed.name)}" placeholder="${ed.isNew ? 'Required for a repo of your own' : 'From the catalog'}"></div>
      <div><label for="ed-folder">Install folder name</label><input type="text" id="ed-folder" data-ed="folderName" value="${esc(ed.folderName)}" placeholder="owner.repo"></div></div>
    <div class="field"><label for="ed-asset">Release asset</label>
      <div class="hint">A pattern for the release file to take, e.g. <code>(?i)x86_64-windows</code>. Empty picks the Windows build.</div>
      <input type="text" id="ed-asset" data-ed="assetPattern" value="${esc(ed.assetPattern)}" spellcheck="false"></div>
    <div class="field"><label>Order</label>
      <label class="radio"><input type="radio" name="ed-base" value="binary" ${ed.base === 'binary' ? 'checked' : ''}> Release first, then the game data beside or inside it</label>
      <label class="radio"><input type="radio" name="ed-base" value="data" ${ed.base === 'data' ? 'checked' : ''}> Game data first (a full rip), then the release unpacked over it</label></div>
    <div class="field"><label for="ed-bintarget">Release folder</label>
      <div class="hint">Where the release unpacks, inside the install folder. Empty is the install folder itself.</div>
      <input type="text" id="ed-bintarget" data-ed="binaryTarget" value="${esc(ed.binaryTarget)}" placeholder="e.g. bin" spellcheck="false"></div>
    <div class="field"><label>Game data from archive.org</label>${legacy}
      ${ed.sources.map((x, i) => sourceCard(x, i)).join('')}
      <button class="btn" data-action="ed-add-source">Add a source</button></div>
    ${ed.errors ? `<div class="notice warn"><div class="grow">${ed.errors.map(esc).join('<br>')}</div></div>` : ''}
    <div class="field actions">
      <button class="btn" data-action="ed-preview">Preview</button>
      <button class="btn primary" id="btn-save-collision" data-action="ed-save">Save</button>
      ${ed.origin === 'local' ? '<button class="btn" data-action="ed-delete">Remove mine</button>' : ''}
      <button class="btn" data-action="ed-export">Copy my collisions as a feed</button></div>
    <div id="ed-preview">${previewHtml()}</div>
  </div>`;
}

function sourceCard(x, i) {
  const ed = state.editor;
  const b = ed.browse?.i === i ? ed.browse : null;
  return `<div class="source-card">
    <div class="inline"><input type="text" data-src="${i}" data-key="ia" value="${esc(x.ia)}" placeholder="archive.org item, e.g. perfect-dark-pc-port_202510" spellcheck="false" aria-label="archive.org item">
      <button class="btn" data-action="ed-browse" data-i="${i}">Browse</button>
      <button class="btn" data-action="ed-remove-source" data-i="${i}" aria-label="Remove this source">&#10005;</button></div>
    <div class="two"><div><label>Take</label><input type="text" data-src="${i}" data-key="path" value="${esc(x.path)}" placeholder="file, folder/* or *" spellcheck="false"></div>
      <div><label>Into folder</label><input type="text" data-src="${i}" data-key="target" value="${esc(x.target)}" placeholder="the install folder" spellcheck="false"></div></div>
    <div class="checks">
      <label><input type="checkbox" data-src="${i}" data-key="extract" ${x.extract ? 'checked' : ''}> Unpack the archive</label>
      <label><input type="checkbox" data-src="${i}" data-key="optional" ${x.optional ? 'checked' : ''}> Optional</label>
      <input type="text" class="sha" data-src="${i}" data-key="sha1" value="${esc(x.sha1)}" placeholder="sha1 (optional; archive.org's is checked anyway)" spellcheck="false" aria-label="sha1"></div>
    ${b ? `<div class="browser">
      <div class="inline"><input type="text" id="ed-filter" value="${esc(b.filter)}" placeholder="Filter ${esc(b.ia)}" spellcheck="false">
        <button class="btn" data-action="ed-take" data-path="*">Whole item</button><button class="btn" data-action="ed-close-browse">Done</button></div>
      <div id="browse-list">${browseList()}</div></div>` : ''}
  </div>`;
}

const BROWSE_CAP = 200;
function browseList() {
  const b = state.editor?.browse;
  if (!b) return '';
  if (b.loading) return '<p class="empty">Listing the item…</p>';
  if (b.error) return `<p class="empty">Couldn't list ${esc(b.ia)}: ${esc(b.error)}</p>`;
  const f = b.filter.toLowerCase();
  const folders = b.folders.filter(d => d.toLowerCase().includes(f));
  const files = b.files.filter(x => x.name.toLowerCase().includes(f) && x.source !== 'metadata' && x.source !== 'derivative' && !/(_meta\.xml|_files\.xml|_meta\.sqlite|_reviews\.xml|_archive\.torrent|__ia_thumb\.jpg)$/i.test(x.name));
  const more = (n) => (n > BROWSE_CAP ? `<div class="hint">${fmtNum(n - BROWSE_CAP)} more; filter to narrow it down.</div>` : '');
  return `${folders.length ? `<div class="h3">Folders</div>${folders.slice(0, BROWSE_CAP).map(d =>
      `<button class="pick" data-action="ed-take" data-path="${esc(d)}/*"><span class="kind">DIR</span>${esc(d)}/<span class="meta">take everything under it</span></button>`).join('')}${more(folders.length)}` : ''}
    <div class="h3">Files</div>${files.slice(0, BROWSE_CAP).map(x =>
      `<button class="pick" data-action="ed-take" data-path="${esc(x.name)}"><span class="kind">${ARCHIVE_RE.test(x.name) ? 'ZIP' : 'FILE'}</span>${esc(x.name)}<span class="meta">${fmtBytes(x.size)}</span></button>`).join('') || '<p class="empty">No files match.</p>'}${more(files.length)}`;
}

function previewHtml() {
  const p = state.editor?.preview;
  if (!p) return '';
  if (p.loading) return '<p class="empty">Checking against archive.org…</p>';
  return `<div class="h3">What an install places</div>${p.list.map(r => r.error
    ? `<div class="preview-row warn">${esc(r.source.path || '?')}: ${esc(r.error)}</div>`
    : `<div class="preview-row"><b>${esc(r.source.ia)}/${esc(r.source.path)}</b> · ${fmtNum(r.files.length)} file${r.files.length === 1 ? '' : 's'}, ${fmtBytes(r.bytes)}${r.source.extract ? ', unpacked' : ''}
        <div class="meta">${r.files.slice(0, 8).map(f => `${esc(f.name)} → ${esc(r.source.extract && ARCHIVE_RE.test(f.name) ? `${r.source.target || '.'}/ (unpacked)` : f.to)}`).join('<br>')}${r.files.length > 8 ? `<br>and ${fmtNum(r.files.length - 8)} more` : ''}</div></div>`).join('')}`;
}

function editorAddSource() { state.editor.sources.push(blankSource()); render(); }
function editorRemoveSource(i) {
  const ed = state.editor;
  ed.sources.splice(i, 1);
  if (ed.browse?.i === i) ed.browse = null;
  render();
}

async function editorBrowse(i) {
  const ed = state.editor;
  const ia = ed.sources[i].ia.trim();
  if (!ia) return toast('Type an archive.org item first.');
  const b = ed.browse = { i, ia, loading: true, files: [], folders: [], filter: '', error: null };
  render();
  const r = await api.fetchItemFiles(ia);
  if (ed.browse !== b) return;
  Object.assign(b, { loading: false, files: r.files || [], folders: r.folders || [], error: r.ok ? null : r.error });
  const list = $('#browse-list');
  if (list) list.innerHTML = browseList();
}

// A pick from the browser: a file (with archive.org's sha1), a folder/* or *
function editorTake(p) {
  const ed = state.editor;
  const b = ed.browse;
  if (!b) return;
  const x = ed.sources[b.i];
  const file = b.files.find(f => f.name === p);
  // An archive is unpacked by default when it's the base of the install
  const archive = !!file && ARCHIVE_RE.test(p);
  Object.assign(x, { ia: b.ia, path: p, sha1: file?.sha1 || '', extract: archive && (x.extract || ed.base === 'data') });
  ed.browse = null;
  render();
}

function editorEntry() {
  const ed = state.editor;
  const entry = { ...ed.extra };
  if (ed.name.trim()) entry.name = ed.name.trim();
  if (ed.folderName.trim()) entry.folderName = ed.folderName.trim();
  if (ed.assetPattern.trim()) entry.assetPattern = ed.assetPattern.trim();
  if (ed.base === 'data') entry.base = 'data';
  if (ed.binaryTarget.trim()) entry.binaryTarget = ed.binaryTarget.trim();
  const sources = ed.sources.filter(x => x.ia.trim() || x.path.trim()).map(x => ({
    ia: x.ia.trim(), path: x.path.trim(),
    ...(x.target.trim() ? { target: x.target.trim() } : {}),
    ...(x.extract ? { extract: true } : {}),
    ...(x.sha1.trim() ? { sha1: x.sha1.trim().toLowerCase() } : {}),
    ...(x.optional ? { optional: true } : {}),
  }));
  if (sources.length) entry.sources = sources;
  return entry;
}

async function editorPreview() {
  const ed = state.editor;
  const sources = editorEntry().sources || [];
  if (!sources.length) return toast('Add a source to preview.');
  ed.preview = { loading: true };
  $('#ed-preview').innerHTML = previewHtml();
  const list = await api.previewCollision(sources);
  if (state.editor !== ed) return;
  ed.preview = list ? { list } : null;
  if (!list) toast("Couldn't reach the backend for a preview.");
  $('#ed-preview').innerHTML = previewHtml();
}

async function editorSave() {
  const ed = state.editor;
  const repo = ed.repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { ed.errors = ['The repository must look like owner/repo.']; return render(); }
  const r = await api.saveCollision(repo, editorEntry());
  if (!r.ok) { ed.errors = r.error.split('; '); return render(); }
  toast(`Saved the game data for ${ed.name || repo}. It's yours now, and wins over any feed's.`);
  await loadPorts();
  const port = state.ports?.items.find(i => i.repository?.toLowerCase() === repo.toLowerCase());
  go('collision', repo);
  if (port) openDetail('port', port.id);
}

async function editorDelete() {
  const ed = state.editor;
  if (!confirm(`Remove your game data for ${ed.repo}? A feed's or the bundled one takes over again, if there is one.`)) return;
  await api.deleteCollision(ed.repo);
  toast('Removed yours.');
  await loadPorts();
  go('collision', ed.repo);
}

async function editorExport() {
  const feed = await api.exportCollisions();
  const text = JSON.stringify(feed, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied your feed: ${feed.collisions.length} port${feed.collisions.length === 1 ? '' : 's'}, ${feed.uploaders.length} uploader${feed.uploaders.length === 1 ? '' : 's'}. Publish it anywhere and others can subscribe to its URL.`, 6000);
  } catch {
    toast("Couldn't reach the clipboard.");
  }
}

// Editor inputs update state as you type; only structure changes re-render
document.addEventListener('input', (e) => {
  const ed = state.editor;
  const t = e.target;
  if (t.id === 'manual-name' && state.manualForm) { state.manualForm.name = t.value; return; }
  if (!ed || state.view.name !== 'collision') return;
  if (t.dataset.ed) { ed[t.dataset.ed] = t.value; return; }
  if (t.dataset.src !== undefined && t.type !== 'checkbox') { ed.sources[Number(t.dataset.src)][t.dataset.key] = t.value; return; }
  if (t.id === 'ed-filter' && ed.browse) { ed.browse.filter = t.value; $('#browse-list').innerHTML = browseList(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'feed-file' && e.target.files[0]) {
    importFeedFile(e.target.files[0]);
    e.target.value = '';
  }
});
document.addEventListener('change', (e) => {
  const ed = state.editor;
  const t = e.target;
  if (!ed || state.view.name !== 'collision') return;
  if (t.name === 'ed-base') ed.base = t.value;
  if (t.dataset.src !== undefined && t.type === 'checkbox') ed.sources[Number(t.dataset.src)][t.dataset.key] = t.checked;
});

// ─── Collision feeds (Settings) ───────────────────────────────────────────────

function feedListHtml() {
  const feeds = state.collisionFeeds;
  if (!feeds) { loadCollisionFeeds(); return '<div class="hint">Loading…</div>'; }
  if (!feeds.length) return '<div class="hint">None yet.</div>';
  return feeds.map(f => `<div class="feed-row"><div class="grow"><b>${esc(f.name)}</b> · ${fmtNum(f.entries)} collision${f.entries === 1 ? '' : 's'}
      ${f.rejected.length ? `, ${f.rejected.length} skipped as invalid` : ''}${f.error ? ` · <span class="warn">${esc(f.error)}</span>` : ''}
      <div class="meta">${esc(f.url)}</div>
      ${f.uploaders.length ? `<div class="feed-uploaders">${f.uploaders.map(u => `<span class="feed-uploader"><b>${esc(u.label)}</b> <span class="meta">${esc(u.uploader)}</span>
        ${u.trusted ? '<span class="trusted">Trusted</span>' : `<button class="btn" data-action="feed-trust" data-uploader="${esc(u.uploader)}" data-label="${esc(u.label)}">Trust</button>`}</span>`).join('')}</div>` : ''}</div>
    <button class="btn" data-action="feed-refresh" data-id="${esc(f.id)}">Refresh</button>
    <button class="btn" data-action="feed-remove" data-id="${esc(f.id)}">Remove</button></div>`).join('');
}

async function loadCollisionFeeds() {
  state.collisionFeeds = await api.getCollisionFeeds().catch(() => []);
  const el = $('#feed-list');
  if (el) el.innerHTML = feedListHtml();
}

async function addCollisionFeed() {
  const url = $('#feed-url').value.trim();
  if (!url) return toast('Paste the URL of a collisions feed.');
  const r = await api.addCollisionFeed({ url });
  if (!r.ok) return toast(`Couldn't subscribe: ${r.error}`);
  toast(`Subscribed to ${r.feed.name}: ${r.feed.entries} collisions${r.feed.error ? ` (${r.feed.error})` : ''}.`);
  $('#feed-url').value = '';
  await loadCollisionFeeds();
  loadPorts();
}

// The user's uploader list changed from a feed: redraw it and reload the wall
async function sourcesChanged() {
  state.sources = (await api.getSources()).sources;
  const box = $('#setting-sources');
  if (box) box.value = formatSources(state.sources);
  await loadCollisionFeeds();
  ambientDone = false;
  loadWall({ refresh: true });
}

async function trustUploader(el) {
  const r = await api.trustUploader({ uploader: el.dataset.uploader, label: el.dataset.label });
  if (!r.ok) return toast(`Couldn't trust it: ${r.error}`);
  toast(`${el.dataset.label} is one of your uploaders now. Their uploads join the wall.`);
  await sourcesChanged();
}

async function importFeedFile(file) {
  const r = await api.importFeed(await file.text());
  if (!r.ok) return toast(`Couldn't import ${file.name}: ${r.error}`, 6000);
  const n = (k, one) => `${r[k].length} ${one}${r[k].length === 1 ? '' : 's'}`;
  toast(`Imported ${file.name}: ${n('collisions', 'port')}, ${n('uploaders', 'uploader')}${r.rejected.length ? `, ${r.rejected.length} skipped as invalid` : ''}.`, 6000);
  if (r.collisions.length) loadPorts();
  if (r.uploaders.length) await sourcesChanged();
}

// ─── right-click menu (ports), after Quiver's ────────────────────────────────

// Entries are [label, key], [label, [...entries]] for a submenu, or '-'
function portMenu(p) {
  const lib = state.library[p.id];
  const about = [
    ['Details', 'details'],
    ['Repository on GitHub', 'repo'],
    ...(p.data.iaIdentifier ? [['Game data on archive.org', 'data']] : []),
  ];
  const library = [inPortLibrary(p) ? 'Remove from Library' : 'Add to Library', 'toggle-library'];
  if (state.downloads.has(p.id)) return [['Cancel Download', 'cancel'], '-', library, ['About', about]];
  if (lib?.install_dir) {
    return [
      ['Launch', 'launch'],
      ['Open Folder', 'open-folder'],
      ['Launch Options', [['Choose Executable…', 'choose-exe'], ['Add to Steam…', 'steam']]],
      library,
      ['Game Data…', 'collision'],
      ['About', about],
      '-',
      ['Delete', 'delete', 'danger'],
    ];
  }
  return [['Download', 'install'], ['Locate Existing Install…', 'locate'], library, ['Game Data…', 'collision'], ['About', about]];
}

function menuHtml(entries) {
  return entries.map(e => e === '-' ? '<div class="sep"></div>'
    : Array.isArray(e[1])
      ? `<div class="has-sub"><button class="mi" data-sub>${esc(e[0])}<span class="chev">›</span></button><div class="ctxmenu sub">${menuHtml(e[1])}</div></div>`
      : `<button class="mi ${e[2] || ''}" data-menu="${esc(e[1])}">${esc(e[0])}</button>`).join('');
}

let menuPort = null;
function openMenu(p, x, y) {
  menuPort = p;
  let el = $('#ctxmenu');
  if (!el) { el = document.createElement('div'); el.id = 'ctxmenu'; el.className = 'ctxmenu'; el.setAttribute('role', 'menu'); document.body.append(el); }
  el.innerHTML = menuHtml(portMenu(p));
  el.classList.remove('hidden', 'flip');
  // Keep it on screen; submenus open to the left near the right edge
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  if (x + r.width * 2 > innerWidth) el.classList.add('flip');
  el.querySelector('.mi')?.focus();
}
function closeMenu() { $('#ctxmenu')?.classList.add('hidden'); menuPort = null; }

async function runMenu(btn) {
  const p = menuPort;
  const key = btn.dataset.menu;
  closeMenu();
  if (!p) return;
  const v = portTarget(p);
  switch (key) {
    case 'install': return installPort(p);
    case 'cancel': {
      const dl = state.downloads.get(p.id);
      if (dl?.jobId) await api.cancelInstall({ jobId: dl.jobId });
      return;
    }
    case 'locate': return locateInstall(p);
    case 'launch': return launchPort(p);
    case 'open-folder': return api.openGameLocation({ identifier: p.id });
    case 'choose-exe': return pickExe(p, 'default');
    case 'steam': return pickExe(p, 'steam');
    case 'toggle-library': return togglePort(p.id);
    case 'details': return openDetail('port', p.id);
    case 'collision': return go('collision', p.repository);
    case 'repo': return api.openExternal(`https://github.com/${p.repository}`);
    case 'data': return api.openExternal(`https://archive.org/details/${p.data.iaIdentifier}`);
    case 'delete': {
      if (!confirm(`Delete ${p.name}? Its install folder goes to the Recycle Bin.`)) return;
      const r = await api.deleteGame({ identifier: v.identifier, trash: true });
      if (!r.ok) return toast(`Couldn't delete: ${r.error}`);
      toast(`Deleted ${p.name}.`);
      await reloadLibrary();
      return render();
    }
  }
}

// An install already on disk (a manual download, or from another launcher)
async function locateInstall(p) {
  const dir = await api.chooseFolder();
  if (!dir) return;
  const r = await api.setInstallDir({ identifier: p.id, installDir: dir });
  if (!r.ok) return toast(`Couldn't use that folder: ${r.error}`);
  await reloadLibrary();
  toast(r.row?.exe_path ? `${p.name} is set up from ${dir}.` : `${p.name} is set up. Pick its executable under Launch Options.`, 6000);
  render();
}

async function launchPort(p) {
  const lib = state.library[p.id];
  if (lib?.exe_path) return launch(portTarget(p), lib.exe_path);
  const exes = await api.findExes({ identifier: p.id });
  if (!exes.length) return toast('No executable found in the install folder.');
  if (exes.length === 1) return launch(portTarget(p), exes[0]);
  return pickExe(p, 'play', exes);
}

// Shows the executable list in the port's detail panel
async function pickExe(p, purpose, list = null) {
  const exes = list || await api.findExes({ identifier: p.id });
  if (!exes.length) return toast('No executable found in the install folder.');
  openDetail('port', p.id);
  state.detail.exes = { purpose, list: exes };
  renderDetail();
}

async function setDefaultExe(v, exePath) {
  await api.setExePath({ identifier: v.identifier, exePath });
  await reloadLibrary();
  toast(`${getTitle(v)} now launches ${exePath.split(/[\\/]/).pop()}.`);
}

document.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.port-card');
  const p = card && state.ports?.items.find(i => i.id === card.dataset.id);
  if (!p) return closeMenu();
  e.preventDefault();
  // The keyboard menu key reports 0,0; anchor to the card instead
  const r = card.getBoundingClientRect();
  openMenu(p, e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);

async function saveSettingsForm() {
  const sources = parseSources($('#setting-sources').value);
  if (!sources.length) return toast('Add at least one uploader.');
  const patch = { sources, installPath: $('#setting-install').value.trim(), downloadPath: $('#setting-download').value.trim() };
  await api.saveSettings(patch);
  const changed = formatSources(sources) !== formatSources(state.sources);
  state.settings = { ...state.settings, ...patch };
  state.sources = sources;
  toast('Settings saved.');
  if (changed) { ambientDone = false; loadWall({ refresh: true }); }
}

// A port acts through its library row, keyed by the catalog item id
const portTarget = (p) => ({ identifier: p.id, title: p.name });
const detailTarget = () => state.detail?.version || (state.detail?.port && portTarget(state.detail.port));

async function onAction(action, el) {
  const d = state.detail;
  const v = detailTarget();
  switch (action) {
    case 'install': return d?.port ? installPort(d.port) : installGame(v);
    case 'cancel': {
      const dl = state.downloads.get(v.identifier);
      if (dl?.jobId) await api.cancelInstall({ jobId: dl.jobId });
      return;
    }
    case 'play': return playGame(v);
    case 'open-folder': return api.openGameLocation({ identifier: v.identifier });
    case 'steam': {
      const exes = await api.findExes({ identifier: v.identifier });
      if (!exes.length) return toast('No executable found in the install folder.');
      d.exes = { purpose: 'steam', list: exes };
      return renderDetail();
    }
    case 'delete': {
      if (!confirm(`Delete ${getTitle(v)}? This removes its files from disk.`)) return;
      const r = await api.deleteGame({ identifier: v.identifier, trash: !!state.library[v.identifier]?.install_dir });
      if (!r.ok) return toast(`Couldn't delete: ${r.error}`);
      await reloadLibrary();
      return render();
    }
    case 'reload-wall': ambientDone = false; return loadWall({ refresh: true });
    case 'reload-all': ambientDone = false; loadPorts(true); return loadWall({ refresh: true });
    case 'refresh-ports': toast('Checking the catalogs…', 2000); return loadPorts(true);
    case 'mark-seen':
      await Promise.all(state.review.map(r => api.markCatalogSeen(r.id)));
      return loadPorts();
    case 'save-settings': return saveSettingsForm();
    case 'edit-collision': closeDetail(); return go('collision', el.dataset.repo);
    case 'ed-add-source': return editorAddSource();
    case 'ed-remove-source': return editorRemoveSource(Number(el.dataset.i));
    case 'ed-browse': return editorBrowse(Number(el.dataset.i));
    case 'ed-close-browse': state.editor.browse = null; return render();
    case 'ed-take': return editorTake(el.dataset.path);
    case 'ed-preview': return editorPreview();
    case 'ed-save': return editorSave();
    case 'ed-delete': return editorDelete();
    case 'ed-export': return editorExport();
    case 'feed-add': return addCollisionFeed();
    case 'feed-trust': return trustUploader(el);
    case 'feed-refresh': await api.refreshCollisionFeed(el.dataset.id); return loadCollisionFeeds();
    case 'feed-remove': await api.removeCollisionFeed(el.dataset.id); await loadCollisionFeeds(); return loadPorts();
    case 'announce-dismiss':
      $('#announce').classList.add('hidden');
      return api.dismissAnnouncement(el.dataset.id);
    case 'manual-open': state.manualForm = { name: '', folder: null }; render(); return $('#manual-name')?.focus();
    case 'manual-cancel': state.manualForm = null; return render();
    case 'manual-folder': {
      const folder = await api.chooseFolder();
      if (!folder) return;
      state.manualForm = { name: $('#manual-name')?.value || folder.split(/[\\/]/).pop(), folder };
      return render();
    }
    case 'manual-folder-clear': state.manualForm = { name: $('#manual-name')?.value || '', folder: null }; return render();
    case 'manual-create': return createManual();
    case 'manual-rename': {
      const title = prompt('Rename to', getTitle(v));
      if (!title?.trim()) return;
      const r = await api.renameEntry({ identifier: v.identifier, title: title.trim() });
      if (!r.ok) return toast(`Couldn't rename: ${r.error}`);
      await reloadLibrary();
      openDetail('game', v.identifier);
      return render();
    }
    case 'manual-locate': {
      const dir = await api.chooseFolder();
      if (!dir) return;
      const r = await api.setInstallDir({ identifier: v.identifier, installDir: dir });
      if (!r.ok) return toast(`Couldn't use that folder: ${r.error}`);
      await reloadLibrary();
      openDetail('game', v.identifier);
      return render();
    }
    case 'manual-remove': {
      if (!confirm(`Remove ${getTitle(v)} from your library? Its folder stays where it is.`)) return;
      await api.removeFromLibrary({ id: v.identifier });
      closeDetail();
      await reloadLibrary();
      return render();
    }
    case 'quiver-import-choose': return quiverImport(false);
    case 'quiver-import-apply': return quiverImport(true);
    case 'quiver-import-cancel': state.quiverImport = null; return renderQuiverImport();
    case 'choose-install': { const p = await api.chooseFolder(); if (p) $('#setting-install').value = p; return; }
    case 'choose-download': { const p = await api.chooseFolder(); if (p) $('#setting-download').value = p; return; }
    case 'legacy-ui':
      await api.saveSettings({ ui: 'legacy' });
      location.href = `../index.html${location.search}`;
      return;
    default: console.warn('unknown action', action, el);
  }
}

// ─── events ──────────────────────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-card-menu]');
  if (menuBtn) {
    const p = state.ports?.items.find(i => i.id === menuBtn.closest('.port-card')?.dataset.id);
    const r = menuBtn.getBoundingClientRect();
    if (p) { e.stopPropagation(); return openMenu(p, r.left, r.bottom + 4); }
  }
  const t = e.target.closest('button, a, [data-close]');
  if (!t) return;
  if (t.matches('[data-close]')) return closeDetail();
  if (t.dataset.href) { e.preventDefault(); return api.openExternal(t.dataset.href); }
  if (t.dataset.view) return go(t.dataset.view, t.dataset.arg || null);
  if (t.dataset.go) return go(t.dataset.go, t.dataset.arg || null);
  if (t.dataset.rowNav) return scrollRow(t);
  if (t.dataset.open) return openDetail(t.dataset.open, t.dataset.id);
  if (t.dataset.togglePort) return togglePort(t.dataset.togglePort);
  if (t.dataset.version && state.detail) {
    state.detail.version = state.detail.game._versions.find(x => x.identifier === t.dataset.version) || state.detail.version;
    state.detail.exes = null;
    return renderDetail();
  }
  if (t.dataset.exe && state.detail?.exes) {
    const { purpose } = state.detail.exes;
    const v = detailTarget();
    state.detail.exes = null;
    renderDetail();
    if (purpose === 'steam') return addToSteam(v, t.dataset.exe);
    if (purpose === 'default') return setDefaultExe(v, t.dataset.exe);
    return launch(v, t.dataset.exe);
  }
  if (t.dataset.menu !== undefined) return runMenu(t);
  if (t.dataset.sub !== undefined) return;
  if (t.dataset.pageGo) { state.libPage = Number(t.dataset.pageGo); render(); $('#body').scrollTop = 0; return; }
  if (t.dataset.collapse) return toggleFold(t.dataset.collapse);
  if (t.dataset.action) return onAction(t.dataset.action, t);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.pref) { setPref(t.dataset.page, t.dataset.pref, t.value); return render(); }
  if (t.id === 'page-input') { state.libPage = Math.max(1, Number(t.value) || 1); render(); $('#body').scrollTop = 0; }
});
let libSearchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'lib-search') return;
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => { state.libSearch = e.target.value; state.libPage = 1; render(); }, 120);
});

// Remote icons that fail to load drop out and leave the tinted plate (CSP rules out inline onerror)
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && !e.target.src.startsWith('blob:')) e.target.remove();
}, true);

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); render(); }, 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuPort) return closeMenu();
  if (e.key === 'Escape') { if (state.detail) closeDetail(); else if (state.query) { $('#q').value = ''; state.query = ''; render(); } }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && stepRow(e)) e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
});

$('#win-min').addEventListener('click', () => api.windowMinimize());
$('#win-max').addEventListener('click', () => api.windowMaximize());
$('#win-close').addEventListener('click', () => api.windowClose());

function showProgress(identifier, percent) {
  const d = state.downloads.get(identifier);
  if (!d || d.status !== 'downloading') return;
  d.percent = percent;
  const bar = document.querySelector('#detail-panel .progress i');
  if (bar && state.detail?.version?.identifier === identifier) {
    bar.style.width = `${percent}%`;
    document.querySelector('#detail-panel .progress-label').textContent = `${percent}%`;
  }
}

// ─── start ───────────────────────────────────────────────────────────────────

// announcement.json on main: one message, shown until dismissed (by id)
async function showAnnouncement() {
  const a = await api.getAnnouncement().catch(() => null);
  const el = $('#announce');
  if (!a || !el) return;
  el.innerHTML = `<span class="msg">${esc(a.message)}</span>
    ${a.link ? `<a data-href="${esc(a.link)}">More</a>` : ''}
    <button class="x" data-action="announce-dismiss" data-id="${esc(a.id)}" aria-label="Dismiss">&#10005;</button>`;
  el.classList.remove('hidden');
}

applyFolded();
(async function init() {
  state.settings = await api.getSettings().catch(() => ({}));
  state.sources = (await api.getSources()).sources;
  state.featured = await api.getFeatured().catch(() => []);
  await reloadLibrary();
  render();
  showAnnouncement();
  // The two halves load side by side: GitHub for the shelves, archive.org for the wall
  loadPorts();
  loadWall();
})();
