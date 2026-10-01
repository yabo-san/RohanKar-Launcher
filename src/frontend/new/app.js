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
  userSources: null,    // GET /user-sources: user.json's state, invalid entries, conflicts
  admin: false,         // the owner's console (mise run admin): curated collisions edited in place
  curated: null,        // GET /admin/collisions, for the Collisions database page
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

// A Cider-style modal: centered window over a dimmed backdrop, a clear title,
// one primary and one secondary button. Resolves true for the primary button;
// Escape, the backdrop and the secondary button resolve false.
function modal({ title, body, primary, secondary = 'Cancel' }) {
  document.getElementById('modal')?.remove();
  const el = document.createElement('div');
  el.id = 'modal';
  el.className = 'modal-fullscreen';
  el.innerHTML = `<div class="modal-window" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-body">
    <div class="modal-header"><div class="modal-title" id="modal-title">${esc(title)}</div></div>
    <div class="modal-content" id="modal-body">${esc(body)}</div>
    <div class="modal-footer"><button class="md-btn" data-modal="0">${esc(secondary)}</button><button class="md-btn md-btn-primary" data-modal="1">${esc(primary)}</button></div>
  </div>`;
  const back = document.activeElement;
  document.body.appendChild(el);
  // The safe answer has focus, so Enter never accepts a warning by accident
  el.querySelector('[data-modal="0"]').focus();
  return new Promise(resolve => {
    const done = (ok) => { el.remove(); document.removeEventListener('keydown', key, true); back?.focus?.(); resolve(ok); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === 'Tab') {
        const b = [...el.querySelectorAll('button')];
        const i = b.indexOf(document.activeElement);
        e.preventDefault();
        b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length].focus();
      }
    };
    document.addEventListener('keydown', key, true);
    el.addEventListener('click', (e) => {
      if (e.target === el) return done(false);
      const b = e.target.closest('[data-modal]');
      if (b) done(b.dataset.modal === '1');
    });
  });
}

// The badge on anything from an additional source
const USER_BADGE = '<span class="user-badge" title="From a source you added. We don\'t monitor it.">Your source · not reviewed</span>';

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
    platform:     v.platform || null,
    size:         v.size ?? null,
    _uploader:    v.source?.uploader,
    _sourceLabel: v.source?.label || v.source?.uploader,
    _override:    v.override || undefined,
    _newer:       v.newer || null,
    _user:        !!v.user,
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
      for (const v of versions) Object.assign(v, { _versions: versions, _userItem: !!item.userSource });
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
    userSource:         !!it.userSource,
    hidden:             !!it.hidden,
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

const isInstalled = (g) => ListView.isInstalled(g, { library: state.library });
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
  renderBadges();
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

// Back and forward in the title row walk the views visited
const navHistory = { back: [], fwd: [] };
function syncHistory() {
  $('#nav-back').disabled = !navHistory.back.length;
  $('#nav-fwd').disabled = !navHistory.fwd.length;
}
function go(name, arg = null) {
  const v = state.view;
  if (v.name !== name || (v.arg || null) !== (arg || null)) {
    navHistory.back.push(v);
    navHistory.fwd.length = 0;
  }
  show(name, arg);
}
function goHistory(dir) {
  const from = dir < 0 ? navHistory.back : navHistory.fwd;
  const v = from.pop();
  if (!v) return;
  (dir < 0 ? navHistory.fwd : navHistory.back).push(state.view);
  show(v.name, v.arg || null);
}
function show(name, arg) {
  if (name === 'collision') startEditor(arg);
  if (name === 'admin') loadCurated();
  state.view = { name, arg };
  state.query = '';
  $('#q').value = '';
  libPrefs.shelf.tag = '';   // tags differ from shelf to shelf
  state.libSearch = '';
  state.libPage = 1;
  $('#body').scrollTop = 0;
  syncHistory();
  render();
  // A quick fade between views; renders within a view (the wall streaming in) don't fade
  $('#body').animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'cubic-bezier(.25, .1, .25, 1)' });
}

// ─── cards ───────────────────────────────────────────────────────────────────

// The installed version of a title that has a newer upload (the backend's `newer`)
const outdated = (g) => ListView.outdated(g, { library: state.library });

function gameCard(g) {
  const title = getTitle(g);
  const n = g._versions?.length || 1;
  const installed = isInstalled(g);
  const dl = state.downloads.get(g.identifier);
  const update = installed && outdated(g);
  return `<button class="card game-card" data-open="game" data-id="${esc(g.identifier)}" title="${esc(title)}">
    <div class="art" data-thumb="${esc(g.identifier)}" style="background:${tint(title)}">
      <div class="noart"><small>${esc(g._sourceLabel)}</small>${esc(title)}</div>
      ${update ? '<span class="tag installed update">NEWER RELEASE</span>' : installed ? '<span class="tag installed">INSTALLED</span>' : dl ? `<span class="tag installed">${dl.percent || 0}%</span>` : ''}
      ${n > 1 ? `<span class="tag versions">${n} VERSIONS</span>` : ''}
      <span class="play-btn${installed ? '' : ' get'}" aria-hidden="true"></span>
    </div>
    <div class="title">${esc(title)}</div>
    <div class="sub">${esc([g._sourceLabel, g.addeddate ? new Date(g.addeddate).getFullYear() : ''].filter(Boolean).join(' · '))}</div>
    ${g._userItem ? USER_BADGE : ''}
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
    ${p.userSource ? USER_BADGE : ''}${p.hidden ? '<span class="pill">Hidden</span>' : ''}
  </button>`;
}

const skeletons = (n) => Array.from({ length: n }, () =>
  '<div class="card skel"><div class="art"></div><div class="title">.</div><div class="sub">.</div></div>').join('');

// A section head is a bold title, with a chevron when it leads to a page of
// its own, and the round arrows at the right of a row (as in Cider)
function section(title, body, { count, sub, seeAll, cls = 'grid' } = {}) {
  const isRow = cls.split(' ')[0] === 'row';
  const h2 = seeAll
    ? `<h2><button class="h2link" data-go="${esc(seeAll[0])}" data-arg="${esc(seeAll[1] || '')}">${esc(title)}<i class="ico" data-ico="chev"></i></button></h2>`
    : `<h2>${esc(title)}</h2>`;
  return `<section class="section${isRow ? ' has-row' : ''}"><div class="section-head">${title ? h2 : ''}
    ${count != null && !isRow ? `<span class="count">${esc(count)}</span>` : ''}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
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
  // The carousel keeps its pager, as in Cider; other rows show arrows only when they overflow
  nav.hidden = max <= 1 && !(row.classList.contains('feature') && row.children.length > 1);
  nav.querySelector('.prev').disabled = row.scrollLeft <= 1;
  nav.querySelector('.next').disabled = row.scrollLeft >= max - 1;
}
const syncRows = () => {
  document.querySelectorAll('#body .row.list').forEach(layoutList);
  document.querySelectorAll('#body .row').forEach(syncRowNav);
};

// A list row runs in columns four items deep, then pages sideways like the
// other rows; the columns keep their width and the last one peeks (Cider's
// song lists on New)
const LIST_DEPTH = 4;
function layoutList(row) {
  row.style.gridTemplateRows = `repeat(${Math.max(1, Math.min(LIST_DEPTH, row.children.length))}, auto)`;
}

// One press moves a row by most of its width, in whole cards (whole columns
// in a list, one card in the feature carousel)
function scrollRow(btn) {
  const row = btn.closest('.section').querySelector('.row');
  const first = row.children[0];
  const pitch = first ? first.offsetWidth + (parseFloat(getComputedStyle(row).columnGap) || 0) : 0;
  const by = !pitch ? row.clientWidth * 0.85
    : row.classList.contains('feature') ? pitch
    : Math.max(1, Math.floor(row.clientWidth / pitch)) * pitch;
row.scrollBy({ left: Number(btn.dataset.rowNav) * by, behavior: 'smooth' });
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
  html += section('Newest on the Wall', newest.length ? newest.map(gameCard).join('') : skeletons(8),
    { cls: 'row', seeAll: ['wall'] });

  for (const s of enabled) {
    const list = state.games.filter(g => (g._versions || [g]).some(v => v._uploader === s.uploader)).sort(byDownloads);
    const failed = state.wall.failed.some(f => f.src.uploader === s.uploader);
    if (failed) continue;
    const body = list.length ? list.slice(0, 20).map(gameCard).join('') : state.wall.loading ? skeletons(8) : '';
    if (!body) continue;
    html += section(`Most Played from ${sourceName(s)}`, body, { count: list.length || null, cls: 'row', seeAll: ['uploader', s.uploader] });
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

// ─── library pages (after Cider's library-albums and songs pages) ──────────
// The page title at the top left and, on the same row at the right, the
// page's controls: filter and sort dropdowns, a cover art / list switch,
// reload and a search box. The choices are kept per page. Sorting, search,
// columns and row actions are ListView's (../list-view.js); this only draws.

const PAGE_SIZE = 60;
const PREFS_KEY = 'y4bo.libraryPrefs';
const PREF_DEFAULTS = {
  wall:    { sort: 'dateAdded', order: 'desc', viewAs: 'covers', scroll: 'infinite', uploader: '', hiddenCols: [] },
  shelf:   { sort: 'data', order: 'desc', viewAs: 'covers', scroll: 'infinite', tag: '', data: '', hiddenCols: [] },
  library: { sort: 'name', order: 'asc', viewAs: 'covers', scroll: 'infinite', hiddenCols: [] },
};
const libPrefs = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { /* storage off */ }
  return Object.fromEntries(Object.entries(PREF_DEFAULTS).map(([k, d]) => [k, { ...d, ...saved[k] }]));
})();
function setPref(page, key, value) {
  libPrefs[page][key] = value;
  if (key !== 'viewAs' && key !== 'hiddenCols') state.libPage = 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(libPrefs)); } catch { /* storage off */ }
}

const { GAME_SORTS, PORT_SORTS, ciderSearch } = ListView;
const listCtx = (kind) => ({ kind, library: state.library, downloads: state.downloads });

// ─── dropdowns (Cider 2's) ──────────────────────────────────────────────────
// A pill: a leading icon, the chosen option and a chevron. Its menu is one
// shared panel (#ddmenu), dark and translucent, bold items, the chosen one in
// accent red with a check. Arrow keys, Home and End move; Enter or Space
// picks; Escape or Tab closes. A multi dropdown (the column picker) toggles
// its items and stays open.
const dropdowns = {};   // id → { label, icon, options: [[value, text, note]], value | isOn, multi, onPick }
function dropdown(id, def) {
  dropdowns[id] = def;
  const cur = def.options.find(([v]) => String(v) === String(def.value));
  const text = cur ? cur[1] : def.label;
  return `<button type="button" class="dd-trigger${def.iconOnly ? ' icon-only' : ''}" data-dd="${esc(id)}" ${def.attrs || ''}
    aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(def.iconOnly ? def.label : `${def.label}: ${text}`)}" title="${esc(def.label)}">
    ${def.icon ? `<i class="ico dd-ico" data-ico="${def.icon}"></i>` : ''}${def.iconOnly ? '' : `<span class="dd-label">${esc(text)}</span>`}<i class="ico dd-chev" data-ico="chevdown"></i></button>`;
}

// A dropdown bound to a page preference
function prefDropdown(page, pref, label, icon, options) {
  return dropdown(`${page}-${pref}`, {
    label, icon, options, value: libPrefs[page][pref], attrs: `data-page="${page}" data-pref="${pref}"`,
    onPick: (v) => { setPref(page, pref, v); render(); },
  });
}

let ddOpen = null;
function openDropdown(id, focus = null) {
  const def = dropdowns[id];
  const trigger = document.querySelector(`[data-dd="${CSS.escape(id)}"]`);
  if (!def || !trigger) return;
  closeMenu();
  let el = $('#ddmenu');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ddmenu';
    el.className = 'ddmenu';
    el.setAttribute('role', 'listbox');
    document.body.append(el);
  }
  const on = (v) => (def.multi ? def.isOn(v) : String(v) === String(def.value));
  el.setAttribute('aria-label', def.label);
  el.setAttribute('aria-multiselectable', String(!!def.multi));
  el.innerHTML = (def.heading ? `<div class="dd-h">${esc(def.heading)}</div>` : '') + def.options.map(([v, text, note]) =>
    `<div class="dd-opt${on(v) ? ' on' : ''}" role="option" tabindex="-1" data-value="${esc(v)}" aria-selected="${on(v)}">
      <i class="ico dd-check" data-ico="check"></i><span class="dd-text">${esc(text)}</span>${note ? `<small>${esc(note)}</small>` : ''}</div>`).join('');
  el.classList.remove('hidden');
  el.style.minWidth = `${Math.max(180, trigger.offsetWidth)}px`;
  const r = trigger.getBoundingClientRect(), m = el.getBoundingClientRect();
  const left = def.alignRight ? r.right - m.width : r.left;
  el.style.left = `${Math.max(8, Math.min(left, innerWidth - m.width - 8))}px`;
  el.style.top = `${r.bottom + m.height + 6 > innerHeight ? Math.max(8, r.top - m.height - 6) : r.bottom + 6}px`;
  document.querySelectorAll('.dd-trigger[aria-expanded="true"]').forEach(t => t.setAttribute('aria-expanded', 'false'));
  trigger.setAttribute('aria-expanded', 'true');
  ddOpen = id;
  const opts = [...el.querySelectorAll('.dd-opt')];
  (opts[focus ?? opts.findIndex(o => o.classList.contains('on'))] || opts[0])?.focus();
}
function closeDropdown(refocus = false) {
  if (!ddOpen) return;
  const id = ddOpen;
  ddOpen = null;
  $('#ddmenu')?.classList.add('hidden');
  const t = document.querySelector(`[data-dd="${CSS.escape(id)}"]`);
  t?.setAttribute('aria-expanded', 'false');
  if (refocus) t?.focus();
}
function pickDropdown(opt) {
  const id = ddOpen, def = dropdowns[id];
  if (!def) return;
  const at = [...opt.parentNode.querySelectorAll('.dd-opt')].indexOf(opt);
  if (!def.multi) closeDropdown();
  def.onPick(opt.dataset.value);
  if (def.multi) openDropdown(id, at);
  else document.querySelector(`[data-dd="${CSS.escape(id)}"]`)?.focus();
}
function dropdownKey(e) {
  const opts = [...document.querySelectorAll('#ddmenu .dd-opt')];
  const at = opts.indexOf(document.activeElement);
  const move = (i) => { e.preventDefault(); opts[(i + opts.length) % opts.length]?.focus(); };
  if (e.key === 'ArrowDown') return move(at + 1);
  if (e.key === 'ArrowUp') return move(at < 0 ? opts.length - 1 : at - 1);
  if (e.key === 'Home') return move(0);
  if (e.key === 'End') return move(opts.length - 1);
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts[at]) pickDropdown(opts[at]); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeDropdown(true); }
  if (e.key === 'Tab') closeDropdown();
}

// View as cover art or a list: a two-button segmented switch, like the one
// under the sidebar's search box
function viewToggle(page) {
  const cur = libPrefs[page].viewAs;
  const b = (v, ico, label) => `<button type="button" class="${cur === v ? 'on' : ''}" data-page="${page}" data-view-as="${v}"
    aria-label="${label}" title="${label}" aria-pressed="${cur === v}"><i class="ico" data-ico="${ico}"></i></button>`;
  return `<div class="seg view-toggle" role="group" aria-label="View as">${b('covers', 'grid', 'Cover art')}${b('list', 'list', 'List')}</div>`;
}

// libraryHeader hands the controls to render(), which puts them in the page
// title row with the search box and reload
let pageHasSearch = false;
let pageControls = null;
function libraryHeader(page, sorts, { extra = '', total = 0 } = {}) {
  pageHasSearch = true;
  pageControls = {
    controls: `${extra}
      ${prefDropdown(page, 'sort', 'Sort by', 'sort', Object.entries(sorts).map(([k, [text]]) => [k, text]))}
      ${prefDropdown(page, 'order', 'Sort order', 'order', [['asc', 'Ascending'], ['desc', 'Descending']])}
      ${prefDropdown(page, 'scroll', 'Scroll', 'scroll', [['infinite', 'Infinite'], ['paged', `Paged (${PAGE_SIZE} per page)`]])}
      ${viewToggle(page)}`,
    pagination: libPrefs[page].scroll === 'paged' ? pagination(total) : '',
  };
  return '';
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

// ─── list view (after Cider 2's song list) ─────────────────────────────────
// A dense borderless table: a star for favourites and a play button on hover
// in the left gutter, the columns (headers sort; a picker at the right end
// hides them), and a ⋯ button that opens the row's menu. No covers.

const LIST_COLUMNS = { game: ListView.GAME_COLUMNS, port: ListView.PORT_COLUMNS };

function listHead(page, kind, cols, list, ctx) {
  const p = libPrefs[page];
  const choices = ListView.columnChoices(LIST_COLUMNS[kind], p.hiddenCols, list, ctx);
  const picker = dropdown(`cols-${page}-${kind}`, {
    label: 'Columns', heading: 'Columns', icon: 'columns', iconOnly: true, multi: true, alignRight: true,
    attrs: `data-col-picker="${kind}"`,
    options: choices.map(c => [c.id, c.label, c.empty ? 'no data' : '']),
    isOn: (id) => !libPrefs[page].hiddenCols.includes(id),
    onPick: (id) => { setPref(page, 'hiddenCols', ListView.toggleColumn(libPrefs[page].hiddenCols, id)); render(); },
  });
  const th = (c) => {
    const sort = ListView.ariaSort(p, c);
    return `<span class="lv-th${c.num ? ' num' : ''}${sort !== 'none' ? ' sorted' : ''}" role="columnheader" aria-sort="${sort}">
      <button type="button" data-sort-col="${c.id}" data-page="${page}" data-kind="${kind}">${esc(c.label)}<i class="ico lv-arrow${sort === 'ascending' ? ' up' : ''}" data-ico="chevdown"></i></button></span>`;
  };
  return `<div class="lv-head" role="row"><span role="columnheader" aria-label="Favourite"></span><span role="columnheader" aria-label="Play"></span>
    ${cols.map(th).join('')}<span class="lv-picker" role="columnheader" aria-label="Columns">${picker}</span></div>`;
}

function listRow(kind, x, cols, ctx) {
  const port = kind === 'port';
  const id = port ? x.id : x.identifier;
  const title = port ? x.name : getTitle(x);
  const installed = port ? !!state.library[x.id]?.install_dir : ListView.isInstalled(x, ctx);
  const status = port ? ListView.portStatus(x, ctx) : ListView.gameStatus(x, ctx);
  const n = x._versions?.length || 1;
  const cell = (c) => {
    if (c.id === 'name') {
      const badges = (!port && n > 1 ? `<span class="lv-badge">${n}</span>` : '') + ((port ? x.userSource : x._userItem) ? '<span class="lv-badge user" title="From a source you added. We don\'t monitor it.">Your source</span>' : '');
      return `<span class="lv-td lv-name" role="cell"><span class="lv-title">${esc(title)}</span>${badges}</span>`;
    }
    const text = c.text(x, ctx);
    const cls = c.id === 'status' && status.kind ? ` st-${status.kind}` : '';
    return `<span class="lv-td${c.num ? ' num' : ''}${cls}" role="cell"${text ? ` title="${esc(text)}"` : ''}>${esc(text)}</span>`;
  };
  return `<div class="list-row lv-row" role="row" tabindex="0" data-open="${kind}" data-id="${esc(id)}" aria-label="${esc(title)}">
    <span class="lv-star" role="cell">${ListView.isFavorite(x, ctx) ? '<i class="ico" data-ico="star-fill" role="img" aria-label="Favourite"></i>' : ''}</span>
    <span class="lv-play" role="cell"><button type="button" class="lv-go" data-row-go="${kind}" data-id="${esc(id)}" tabindex="-1"
      aria-label="${installed ? 'Play' : 'Details for'} ${esc(title)}" title="${installed ? 'Play' : 'Details'}"><i class="ico" data-ico="play"></i></button></span>
    ${cols.map(cell).join('')}
    <span class="lv-end" role="cell"><button type="button" class="lr-more" data-row-menu="${kind}" data-id="${esc(id)}" tabindex="-1"
      aria-label="More for ${esc(title)}" aria-haspopup="menu" title="More"><i class="ico" data-ico="more"></i></button></span>
  </div>`;
}

// The sorted, searched list as covers or a list, infinite or paged
function libraryBody(page, list, { card, kind, cls = 'grid' }) {
  const p = libPrefs[page];
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const cur = Math.min(state.libPage, pages);
  const slice = p.scroll === 'paged' ? list.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE) : null;
  const more = p.scroll === 'paged' && pages > 1 ? pagination(list.length) : '';
  if (p.viewAs !== 'list') {
    return slice ? `<div class="${cls}">${slice.map(card).join('')}</div>${more}` : pagedGrid(list, card, cls);
  }
  const ctx = listCtx(kind);
  const cols = ListView.visibleColumns(LIST_COLUMNS[kind], p.hiddenCols, list, ctx);
  const row = (x) => listRow(kind, x, cols, ctx);
  const rows = slice ? `<div class="lv-rows" role="rowgroup">${slice.map(row).join('')}</div>` : pagedGrid(list, row, 'lv-rows');
  return `<div class="lv" role="table" aria-label="${kind === 'port' ? 'Ports' : 'Games'}" style="--lv-cols: ${ListView.gridTemplate(cols)}">
    ${listHead(page, kind, cols, list, ctx)}${rows}</div>${more}`;
}

function viewWall(uploader) {
  const enabled = state.sources.filter(s => s.enabled !== false);
  const p = libPrefs.wall;
  const who = uploader || p.uploader || null;
  let list = state.games.filter(g => !who || (g._versions || [g]).some(v => v._uploader === who));
  list = ciderSearch(list, state.libSearch, g => [getTitle(g), g._sourceLabel, g.identifier, ...(g._versions || []).map(v => getTitle(v))]);
  list = ListView.sortRows(list, p, [GAME_SORTS], 'dateAdded', listCtx('game'));
  const extra = uploader ? '' : prefDropdown('wall', 'uploader', 'Uploader', 'person',
    [['', 'All uploaders'], ...enabled.map(s => [s.uploader, sourceName(s)])]);
  let html = libraryHeader('wall', GAME_SORTS, { extra, total: list.length }) + wallNotice(uploader);
  if (!list.length && state.wall.loading) return html + section('', skeletons(18));
  if (!list.length) return html + `<p class="empty">${state.libSearch ? 'Nothing matches that search.' : 'Nothing here yet.'}</p>`;
  const note = `${fmtNum(list.length)} titles${state.wall.loading ? ' · still loading uploaders…' : ''}`;
  return html + `<div class="lib-count">${note}</div>` + libraryBody('wall', list, { card: gameCard, kind: 'game' });
}

function viewShelf(id) {
  const shelf = state.ports?.shelves.find(s => s.id === id);
  if (!shelf) return state.portsError ? `<p class="empty">Couldn't load the catalogs: ${esc(state.portsError)}</p>` : section('', skeletons(12), { cls: 'grid ports' });
  const p = libPrefs.shelf;
  const all = state.ports.items.filter(i => i.shelf === id);
  const tags = shelf.preferredTags.length ? shelf.preferredTags : [...new Set(all.flatMap(i => i.tags))].slice(0, 12);
  let list = all.filter(i => (!p.tag || i.tags.includes(p.tag)) && (!p.data || i.data.status === 'available'));
  list = ciderSearch(list, state.libSearch, i => [i.name, i.project, i.repository, ...i.tags]);
  list = ListView.sortRows(list, p, [PORT_SORTS], 'data', listCtx('port'), i => i.name);
  const extra = prefDropdown('shelf', 'data', 'Show', 'filter', [['', 'All ports'], ['1', 'With game data']])
    + prefDropdown('shelf', 'tag', 'Tag', 'tag', [['', 'Any tag'], ...tags.map(t => [t, t])]);
  let html = libraryHeader('shelf', PORT_SORTS, { extra, total: list.length });
  if (shelf.error) {
    html += `<div class="notice warn"><div class="grow">Couldn't fetch the ${esc(shelf.name)} catalog (${esc(shelf.error)}).</div><button class="md-btn" data-action="refresh-ports">Retry</button></div>`;
  } else if (shelf.fromCache) {
    html += `<div class="notice"><div class="grow">Showing the cached ${esc(shelf.name)} catalog from ${esc(fmtDate(shelf.fetchedAt))}; GitHub wasn't reachable.</div><button class="md-btn" data-action="refresh-ports">Retry</button></div>`;
  }
  html += `<div class="lib-count">${list.length} ports · Source: Quiver / ${esc(shelf.name)}${shelf.withData ? ` · ${shelf.withData} with data from archive.org` : ''}</div>`;
  return html + (list.length ? libraryBody('shelf', list, { card: portCard, kind: 'port', cls: 'grid ports' }) : '<p class="empty">No ports match.</p>');
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
  const nameOf = sorts.name[1];
  uniq = ListView.sortRows(ciderSearch(uniq, state.libSearch, g => [getTitle(g), g._sourceLabel]), p, [sorts, GAME_SORTS], 'name', listCtx('game'), nameOf);
  ports = ListView.sortRows(ciderSearch(ports, state.libSearch, i => [i.name, i.repository]), p, [sorts, PORT_SORTS], 'name', listCtx('port'), nameOf);
  let html = libraryHeader('library', sorts, { total: uniq.length + ports.length }) + manual;
  if (uniq.length) html += section('Installed games', libraryBody('library', uniq, { card: gameCard, kind: 'game' }), { count: uniq.length, cls: 'plain' });
  if (ports.length) html += section('Ports', libraryBody('library', ports, { card: portCard, kind: 'port', cls: 'grid ports' }), { count: ports.length, cls: 'plain', sub: 'From a catalog, or yours.' });
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
    <span class="dots" aria-hidden="true"></span>
  </button>`;
}

function viewNew() {
  let html = wallNotice();
  const newest = state.games.slice().sort((a, b) => byNewest(newestVersion(a), newestVersion(b)));
  if (!newest.length) return html + (state.wall.loading ? section('', skeletons(6), { cls: 'row' }) : '<p class="empty">Nothing on the wall yet.</p>');

  const picks = resolvePicks();
  if (picks.length) html += `<section class="section has-row feature-sec"><div class="row feature">${picks.map(featureCard).join('')}</div>${rowNav}</section>`;

  const rest = newest.slice(0, 40);
  if (rest.length) html += section('Recently Added', rest.map(listItem).join(''), { cls: 'row list', seeAll: ['wall'] });

  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const week = newest.filter(g => String(newestVersion(g).addeddate || '') >= weekAgo);
  if (week.length) html += section('New This Week', week.slice(0, 24).map(gameCard).join(''), { cls: 'row squares' });

  const added = new Set(state.review.flatMap(r => r.added.map(a => `${r.id}|${String(a.repository).toLowerCase()}`)));
  const newPorts = (state.ports?.items || []).filter(p => added.has(`${p.shelf}|${String(p.repository).toLowerCase()}`));
  // With nothing new in the catalogs, the ports row shows what they hold
  const ports = newPorts.length ? newPorts : (state.ports?.items || []).slice(0, 24);
  if (ports.length) html += section(newPorts.length ? 'New Ports' : 'Ports', ports.map(portCard).join(''), { cls: 'row squares ports', seeAll: newPorts.length ? ['updates'] : null });
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
      <div class="hint">One archive.org uploader per line, optional ", label". A leading # turns a line off. The wall queries them one at a time.
        Uploaders that aren't on our curated list load only while additional sources are allowed.</div>
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
    <div class="field" id="additional"><label class="switch-row" for="setting-additional">
        <span><b>Allow additional sources</b><span class="hint">Off: only our curated uploaders and catalog. On: your user.json, ports and game data you add,
          feeds you subscribe to and uploaders we don't list. Everything from them is marked Your source · not reviewed.</span></span>
        <input type="checkbox" class="switch" id="setting-additional" role="switch" ${s.allowAdditionalSources ? 'checked' : ''}></label>
      <div id="additional-body">${additionalHtml()}</div></div>
    <div class="field additional-only${s.allowAdditionalSources ? '' : ' hidden'}"><label>Feeds</label>
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
    const hidden = result.needAdditionalSources
      ? ` ${result.needAdditionalSources} of your ports come from repos no catalog lists: they show on Your ports once additional sources are allowed.` : '';
    return `<div class="hint import-done">Imported from ${esc(plan.root)}: ${esc(said || 'nothing to change')}.${esc(hidden)}</div>
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
const RELOADS = { home: 'reload-all', new: 'reload-all', wall: 'reload-wall', uploader: 'reload-wall', shelf: 'refresh-ports', updates: 'refresh-ports' };
const HEADINGS = { home: 'Home', new: 'New', wall: 'Game wall', library: 'Library', updates: 'Keep current', settings: 'Settings', collision: 'Game data', admin: 'Collisions database' };

function render() {
  const v = state.view;
  pagedGrid.pending = {};
  pageHasSearch = false;
  pageControls = null;
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
  else if (v.name === 'admin') html = viewAdmin();
  else html = viewHome();

  const heading = state.query ? 'Search'
    : v.name === 'shelf' ? `${state.ports?.shelves.find(s => s.id === v.arg)?.name || ''} ports`
    : v.name === 'uploader' ? sourceName(state.sources.find(s => s.uploader === v.arg) || { uploader: v.arg })
    : v.name === 'collision' && !v.arg ? (state.admin ? 'New game tile' : 'Add a GitHub repo')
    : HEADINGS[v.name] || 'Home';

  // Keep the settings form as typed while the wall is still streaming in
  if (v.name === 'settings' && !state.query && $('#setting-sources')) { renderNav(); return; }
  const body = $('#body');
  const typing = document.activeElement?.id === 'lib-search' ? document.activeElement.selectionStart : null;
  const reload = !state.query && RELOADS[v.name];
  const search = pageHasSearch ? `<input type="search" class="search-input" id="lib-search" spellcheck="false"
    placeholder="Search ${esc(heading)}" value="${esc(state.libSearch)}" aria-label="Search this page">` : '';
  // A library page's controls share the title row, as on Cider's songs page
  const lib = pageControls;
  body.innerHTML = `<div class="page-head${lib ? ' album-header slim' : ''}"><h1 class="page-title" id="heading">${esc(heading)}</h1><span class="grow"></span>
    ${lib ? `<div class="lib-controls">${lib.controls}</div>` : ''}
    ${reload ? `<button class="reload-btn" data-action="${reload}" aria-label="Reload" title="Reload"></button>` : ''}${search}${lib?.pagination || ''}</div>` + html;
  // A background redraw (the wall streaming in) keeps an open dropdown's trigger marked
  if (ddOpen) document.querySelector(`[data-dd="${CSS.escape(ddOpen)}"]`)?.setAttribute('aria-expanded', 'true');
  if (typing != null) { const el = $('#lib-search'); el?.focus(); el?.setSelectionRange(typing, typing); }
  observeCovers(body);
  syncRows();
  body.querySelectorAll('.sentinel').forEach(el => pageObserver.observe(el));
  if (v.name === 'settings') api.getAppVersion().then(ver => { const el = $('#app-version'); if (el) el.textContent = `y4bo ${ver}`; }).catch(() => {});
  renderNav();
  renderNowbar();
  if (state.detail) renderDetail();
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
  const newerOf = lib?.install_dir && v._newer ? versions.find(x => x.identifier === v._newer) || null : null;
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
  if (state.admin && !v._manual) actions += `<button class="btn" data-action="admin-from-item" data-ia="${esc(v.identifier)}">Make a game tile…</button>`;
  const exes = exePicker(d);
  const desc = stripHtml(Array.isArray(v.description) ? v.description.join('\n') : v.description);
  return `<div class="d-hero"><div class="bg" style="background:${tint(title)}"></div>
      <div class="cover" data-cover="${esc(v.identifier)}" style="background:${tint(title)}"></div>
      <button class="x" data-close aria-label="Close">&#10005;</button>
      <div class="titles"><h2>${esc(title)}</h2><div class="by">${v._manual ? 'Your folder' : `archive.org · ${esc(v._sourceLabel || '')}`}${v.addeddate ? ` · ${fmtDate(v.addeddate)}` : ''}</div></div></div>
    <div class="d-body">
      ${v._user ? `<div class="user-note">${USER_BADGE}<span>This upload is from a source you added. We don't monitor it.</span></div>` : ''}
      <div class="actions">${actions}</div>
      ${dl ? `<div class="progress"><i style="width:${dl.percent || 0}%"></i></div><div class="progress-label">${dl.percent || 0}%</div>` : ''}
      ${exes}
      ${newerOf ? `<div class="newer-note">A newer upload of this game is on archive.org (${esc(fmtDate(newerOf.addeddate))}).
        <button class="btn" data-version="${esc(newerOf.identifier)}">See it</button></div>` : ''}
      ${versions.length > 1 ? `<div class="h3">${versions.length} versions</div><div class="versions">${versions.map(x => `
        <button class="version ${x === v ? 'on' : ''}" data-version="${esc(x.identifier)}"><span class="who">${esc(x._sourceLabel)}</span>${x._user ? USER_BADGE : ''}
        ${state.library[x.identifier]?.install_dir ? '<span class="tag installed" style="position:static">INSTALLED</span>' : ''}
        ${newerOf === x ? '<span class="tag installed update" style="position:static">NEWER</span>' : ''}
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
  // An archive.org-only entry has no repository: its sources carry the binaries
  const bin = p.repository ? `<b>Binary:</b> GitHub release from ${esc(p.repository)}<br>` : '<b>Binary:</b> archive.org, with the data<br>';
  const data = p.data.status === 'available'
    ? `${bin}<b>Data:</b> <span class="ok">archive.org (${esc(p.data.uploader || p.data.iaIdentifier)})</span>, ${esc(p.data.files.join(', ') || 'item contents')}, sha1-checked after staging`
    : p.data.status === 'missing'
      ? `${bin}<b>Data:</b> <span class="warn">needs ${esc(p.data.files.join(', '))}, not in the catalog</span>`
      : `${bin}<b>Data:</b> none needed, as far as the catalog knows`;
  const icon = p.iconUrl ? `<img src="${esc(p.iconUrl)}" alt="">` : '';
  return `<div class="d-hero"><div class="bg" style="background:${tint(p.repository)}${p.iconUrl ? `;background-image:url('${esc(p.iconUrl)}')` : ''}"></div>
      <div class="cover icon" style="background:${tint(p.repository)}">${icon}</div>
      <button class="x" data-close aria-label="Close">&#10005;</button>
      <div class="titles"><h2>${esc(p.name)}</h2><div class="by">${p.project ? `${esc(p.project)} · ` : ''}${p.shelf.startsWith('curated-') ? `y4bo's curated list / ${esc(p.shelfName)}` : `Source: Quiver / ${esc(p.shelfName)}`}</div></div></div>
    <div class="d-body">
      ${p.userSource ? `<div class="user-note">${USER_BADGE}<span>${p.shelf === 'local' ? 'A port you added' : 'Game data you added'}. We don't monitor it.</span></div>` : ''}
      <div class="actions">
        <button class="btn ${added ? '' : 'primary'}" data-toggle-port="${esc(p.id)}">${added ? 'Remove from library' : 'Add to library'}</button>
        ${portActions(p)}
        ${p.repository ? `<button class="btn" data-href="https://github.com/${esc(p.repository)}">Repository</button>
        <button class="btn" data-action="edit-collision" data-repo="${esc(p.repository)}">Game data…</button>` : ''}
      </div>
      ${portProgress(p)}
      ${exePicker(d)}
      <div class="srcline">${data}</div>
      ${p.tags.length ? `<div class="h3">Tags</div><div class="tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <dl class="kv">
        ${p.repository ? `<dt>Repository</dt><dd><a data-href="https://github.com/${esc(p.repository)}">${esc(p.repository)}</a></dd>` : ''}
        <dt>Folder</dt><dd>${esc(p.folderName || p.repository.replace('/', '.') || p.name)}</dd>
        ${p.releaseAssetFilter ? `<dt>Asset filter</dt><dd><code>${esc(p.releaseAssetFilter)}</code></dd>` : ''}
        ${p.filesToAdd.length ? `<dt>Files to add</dt><dd>${esc(p.filesToAdd.join(', '))}</dd>` : ''}
        <dt>Catalog</dt><dd>${esc(p.catalogUrl || 'catalog/collisions.json')}</dd>
      </dl>
    </div>`;
}

// ─── actions ─────────────────────────────────────────────────────────────────

// A file from the user's own source changed since its first install: ask,
// and install again accepting it only on the primary button
function confirmHashChange(job, name) {
  const c = job.hashChange;
  return modal({
    title: 'File changed',
    body: `${c.file} from ${name} is not the file you installed before (sha1 ${c.before.slice(0, 12)}… is now ${c.after.slice(0, 12)}…). `
      + 'It may be an update, or someone may have replaced it. We do not monitor additional sources. Only continue if you trust the source.',
    primary: 'Install anyway',
  });
}

async function installGame(v, { acceptHashChange = false } = {}) {
  const identifier = v.identifier;
  if (state.downloads.has(identifier)) return;
  const list = await api.fetchFileList({ identifier });
  if (!list.ok || !list.files?.length) return toast(`Couldn't read the file list: ${list.error || 'no files'}`);
  const files = list.files;
  const archives = files.filter(f => /\.(zip|7z|rar)$/i.test(f.name) || (/\.exe$/i.test(f.name) && !files.some(x => /\.(zip|7z|rar)$/i.test(x.name))));
  if (!archives.length) return toast('No downloadable file found for this game.');
  // Largest archive is the game; multi-part picks stay in the classic UI for now
  const file = archives.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];

  const dl = { percent: 0, status: 'downloading', jobId: null, name: getTitle(v), open: ['game', v.identifier] };
  state.downloads.set(identifier, dl);
  render();
  const job = await api.install({
    identifier,
    fileName:     file.name,
    acceptHashChange,
    onStart:      (j) => { dl.jobId = j.id; },
    onProgress:   (percent) => showProgress(identifier, percent),
    onExtracting: () => { dl.status = 'extracting'; dl.percent = 100; render(); },
  });
  state.downloads.delete(identifier);
  await reloadLibrary();
  render();
  if (job.hashChange) return (await confirmHashChange(job, getTitle(v))) && installGame(v, { acceptHashChange: true });
  if (job.status === 'done') toast(`${getTitle(v)} is installed.`);
  else if (job.status !== 'cancelled') toast(`Install failed: ${job.error || 'unknown error'}`);
}

async function installPort(p, { acceptHashChange = false } = {}) {
  if (state.downloads.has(p.id)) return;
  const dl = { percent: 0, status: 'downloading', step: 'binary', jobId: null, name: p.name, open: ['port', p.id] };
  state.downloads.set(p.id, dl);
  renderDetail();
  renderNowbar();
  const job = await api.install({
    identifier:   p.id,
    acceptHashChange,
    onStart:      (j) => { dl.jobId = j.id; },
    onProgress:   (percent, j) => { Object.assign(dl, { percent, status: 'downloading', step: j.step }); renderDetail(); renderNowbar(); },
    onExtracting: (j) => { Object.assign(dl, { percent: 100, status: j.status, step: j.step }); renderDetail(); renderNowbar(); },
  });
  state.downloads.delete(p.id);
  await reloadLibrary();
  render();
  if (job.hashChange) return (await confirmHashChange(job, p.name)) && installPort(p, { acceptHashChange: true });
  if (job.status === 'done') toast(`${p.name} is installed.`);
  else if (job.status !== 'cancelled') toast(`Install failed: ${job.error || 'unknown error'}`, 8000);
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
const blankSource = () => ({ ia: '', path: '', target: '', as: '', extract: false, sha1: '', optional: false });

// Loads the collision in effect for repo (or a blank one for a new repo) into the editor
async function startEditor(repo) {
  const port = repo && state.ports?.items.find(i => i.repository?.toLowerCase() === repo.toLowerCase());
  const ed = state.editor = { repo: repo || '', isNew: !repo, loading: !!repo, origin: null, feed: null, extra: {},
    name: port?.name || '', folderName: port?.folderName || '', assetPattern: '', base: 'binary', binaryTarget: '',
    // admin mode: the tile's shelf, the exe to launch, and whether users see it
    shelf: repo ? '' : 'y4bo ports', exe: '', hidden: false, releases: null, search: null, queries: {},
    sources: repo ? [] : [blankSource()], browse: null, preview: null, errors: null };
  if (!repo) return;
  const c = await api.getCollision(repo);
  if (state.editor !== ed) return;
  ed.loading = false;
  if (c) {
    const { repository, name, folderName, assetPattern, base, binaryTarget, sources, shelf, exe, hidden, ...extra } = c.entry;
    Object.assign(ed, {
      origin: c.origin, feed: c.feed || null, extra, shelf: shelf || '', exe: exe || '', hidden: !!hidden,
      name: name || ed.name, folderName: folderName || ed.folderName, assetPattern: assetPattern || '',
      base: base === 'data' ? 'data' : 'binary', binaryTarget: binaryTarget || '',
      sources: (sources || []).map(x => ({ ...blankSource(), ...x, sha1: x.sha1 || '', target: x.target || '', as: x.as || '' })),
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
    : ed.origin === 'user.json' ? 'From your user.json. Saving makes a copy of your own that wins over it.'
    : ed.origin === 'bundled' ? 'Curated: bundled with the launcher. The curated list wins, so it can\'t be changed here.' : 'Nothing yet.';
  const admin = state.admin;
  const off = !admin && !state.settings.allowAdditionalSources;
  const locked = off || (!admin && ed.origin === 'bundled');
  const legacy = ed.extra.dataFiles?.length
    ? `<div class="hint">Also picks ${esc(ed.extra.dataFiles.map(d => d.name).join(', '))} out of ${esc(decodeURIComponent(String(ed.extra.contentUrl || '').split('/').pop()))} (the first version of the schema). That part is kept as it is.</div>` : '';
  return `<div class="form editor">
    <p class="lede">Binds a GitHub release to the game data it needs on archive.org, and says how the two go together in the install folder. ${admin
      ? `<b>Admin mode:</b> saving writes the curated list, catalog/collisions.json, for a PR. ${ed.isNew ? 'A repo no shelf lists becomes a game tile on its shelf.' : ed.origin === 'bundled' ? 'Curated.' : from}`
      : ed.isNew ? 'A repo no catalog lists shows up on the Your ports shelf.' : from}</p>
    ${ed.isNew ? `<div class="field"><label for="ed-repo">GitHub repository</label>
      <input type="text" id="ed-repo" data-ed="repo" value="${esc(ed.repo)}" placeholder="owner/repo" spellcheck="false"></div>`
    : `<div class="field"><label>GitHub repository</label><div class="hint"><a data-href="https://github.com/${esc(ed.repo)}">${esc(ed.repo)}</a></div></div>`}
    <div class="field two"><div><label for="ed-name">Name</label><input type="text" id="ed-name" data-ed="name" value="${esc(ed.name)}" placeholder="${ed.isNew ? 'Required for a repo of your own' : 'From the catalog'}"></div>
      <div><label for="ed-folder">Install folder name</label><input type="text" id="ed-folder" data-ed="folderName" value="${esc(ed.folderName)}" placeholder="owner.repo"></div></div>
    <div class="field"><label for="ed-asset">Release asset</label>
      <div class="hint">A pattern for the release file to take, e.g. <code>(?i)x86_64-windows</code>. Empty picks the Windows build.</div>
      ${admin ? `<div class="inline"><input type="text" id="ed-asset" data-ed="assetPattern" value="${esc(ed.assetPattern)}" spellcheck="false">
        <button class="btn" id="btn-pick-release" data-action="ed-releases">Pick a release…</button></div>${releasesHtml()}`
      : `<input type="text" id="ed-asset" data-ed="assetPattern" value="${esc(ed.assetPattern)}" spellcheck="false">`}</div>
    ${admin ? `<div class="field two"><div><label for="ed-exe">Executable</label><input type="text" id="ed-exe" data-ed="exe" value="${esc(ed.exe)}" placeholder="When the release ships several, e.g. pd.x86_64.exe" spellcheck="false"></div>
      <div><label for="ed-shelf">Shelf</label><input type="text" id="ed-shelf" data-ed="shelf" value="${esc(ed.shelf)}" placeholder="A tile of its own, e.g. y4bo ports" spellcheck="false"></div></div>
      <div class="field"><label class="radio"><input type="checkbox" id="ed-hidden" ${ed.hidden ? 'checked' : ''}> Hidden: only admin mode shows it (gate it until it's ready)</label></div>` : ''}
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
    ${off ? `<div class="notice" id="ed-off"><div class="grow">Game data you add is an additional source. Turn on Allow additional sources in Settings to save it.</div>
      <button class="btn" data-view="settings">Settings</button></div>` : ''}
    <div class="field actions">
      <button class="btn" data-action="ed-preview">Preview</button>
      <button class="btn primary" id="btn-save-collision" data-action="ed-save" ${locked ? 'disabled' : ''}>${admin ? 'Save to the curated list' : 'Save'}</button>
      ${!admin && ed.origin === 'local' ? '<button class="btn" data-action="ed-delete">Remove mine</button>' : ''}
      ${admin && ed.origin === 'bundled' ? '<button class="btn" data-action="ed-delete">Remove from the curated list</button>' : ''}
      ${admin ? '' : '<button class="btn" data-action="ed-export">Copy my collisions as a feed</button>'}</div>
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
    ${state.admin ? `<div class="inline"><input type="text" id="ed-search-${i}" data-search="${i}" value="${esc(ed.queries[i] || '')}" placeholder="Search archive.org, e.g. N64 TOSEC" spellcheck="false" aria-label="Search archive.org">
      <button class="btn" data-action="ed-search" data-i="${i}">Search</button></div>${ed.search?.i === i ? searchHtml() : ''}` : ''}
    <div class="two"><div><label>Take</label><input type="text" data-src="${i}" data-key="path" value="${esc(x.path)}" placeholder="file, folder/* or *" spellcheck="false"></div>
      <div><label>Into folder</label><input type="text" data-src="${i}" data-key="target" value="${esc(x.target)}" placeholder="the install folder" spellcheck="false"></div></div>
    ${state.admin ? `<div><label>Save as</label><input type="text" data-src="${i}" data-key="as" value="${esc(x.as)}" placeholder="The file name the port expects, e.g. pd.ntsc-final.z64 (a ROM zip: the ROM inside it)" spellcheck="false"></div>` : ''}
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
  if (state.admin) {
    if (ed.exe.trim()) entry.exe = ed.exe.trim();
    if (ed.shelf.trim()) entry.shelf = ed.shelf.trim();
    if (ed.hidden) entry.hidden = true;
  }
  const sources = ed.sources.filter(x => x.ia.trim() || x.path.trim()).map(x => ({
    ia: x.ia.trim(), path: x.path.trim(),
    ...(x.target.trim() ? { target: x.target.trim() } : {}),
    ...(x.as?.trim() ? { as: x.as.trim() } : {}),
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
  const r = await (state.admin ? api.saveCuratedCollision(repo, editorEntry()) : api.saveCollision(repo, editorEntry()));
  if (!r.ok) { ed.errors = r.error.split('; '); return render(); }
  toast(state.admin ? `Wrote ${ed.name || repo} to catalog/collisions.json. Commit it in a PR to ship it.`
    : `Saved the game data for ${ed.name || repo}. It's yours now, and wins over any feed's.`, state.admin ? 6000 : undefined);
  await loadPorts();
  const port = state.ports?.items.find(i => i.repository?.toLowerCase() === repo.toLowerCase());
  go('collision', repo);
  if (port) openDetail('port', port.id);
}

async function editorDelete() {
  const ed = state.editor;
  if (state.admin) {
    if (!confirm(`Remove ${ed.repo} from the curated list, catalog/collisions.json?`)) return;
    const r = await api.deleteCuratedCollision(ed.repo);
    if (!r.ok) return toast(`Couldn't remove it: ${r.error}`);
    toast('Removed from the curated list.');
    await loadPorts();
    return go('admin');
  }
  if (!confirm(`Remove your game data for ${ed.repo}? A feed's or the bundled one takes over again, if there is one.`)) return;
  await api.deleteCollision(ed.repo);
  toast('Removed yours.');
  await loadPorts();
  go('collision', ed.repo);
}

// ─── Admin mode: releases, archive.org search, the curated list ─────────────

function releasesHtml() {
  const r = state.editor?.releases;
  if (!r) return '';
  if (r.loading) return '<p class="empty">Reading the releases…</p>';
  if (r.error) return `<p class="empty">${esc(r.error)}</p>`;
  return `<div class="browser" id="release-list">
    <div class="hint">${r.picked ? `The pattern picks <b>${esc(r.picked)}</b> from ${esc(r.latest)}.` : `Nothing in ${esc(r.latest || 'the latest release')} matches yet.`} Pick an asset to take it in every later release.</div>
    ${r.releases.slice(0, 3).map(rel => `<div class="h3">${esc(rel.name)}${rel.prerelease ? ' · prerelease' : ''}${rel.tag === r.latest ? ' · latest' : ''}</div>
      ${rel.assets.map(a => `<button class="pick" data-action="ed-take-asset" data-pattern="${esc(a.pattern)}"><span class="kind">${ARCHIVE_RE.test(a.name) ? 'ZIP' : 'FILE'}</span>${esc(a.name)}<span class="meta">${fmtBytes(a.size)}</span></button>`).join('') || '<p class="empty">No assets.</p>'}`).join('')}
    <button class="btn" data-action="ed-close-releases">Done</button></div>`;
}

async function editorReleases() {
  const ed = state.editor;
  const repo = ed.repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('Type the repository first, as owner/repo.');
  const r = ed.releases = { loading: true };
  render();
  const got = await api.getReleases(repo, ed.assetPattern.trim());
  if (ed.releases !== r) return;
  ed.releases = got.ok ? got : { error: `Couldn't read the releases: ${got.error}` };
  render();
}

function editorTakeAsset(pattern) {
  const ed = state.editor;
  ed.assetPattern = pattern;
  ed.releases = null;
  editorReleases();
}

function searchHtml() {
  const s = state.editor?.search;
  if (!s) return '';
  if (s.loading) return '<p class="empty">Searching archive.org…</p>';
  if (s.error) return `<p class="empty">${esc(s.error)}</p>`;
  return `<div class="browser" id="search-list">${s.items.map(it =>
    `<button class="pick" data-action="ed-pick-item" data-ia="${esc(it.identifier)}"><span class="kind">ITEM</span>${esc(it.title)}<span class="meta">${esc(it.identifier)}${it.uploader ? ` · ${esc(it.uploader)}` : ''}${it.size ? ` · ${fmtBytes(it.size)}` : ''}</span></button>`).join('') || '<p class="empty">Nothing found.</p>'}</div>`;
}

async function editorSearch(i) {
  const ed = state.editor;
  const q = String(ed.queries[i] || '').trim();
  if (!q) return toast('Type something to search for.');
  const s = ed.search = { i, q, loading: true, items: [] };
  render();
  const r = await api.searchArchive(q);
  if (ed.search !== s) return;
  Object.assign(s, { loading: false, items: r.items, error: r.ok ? null : `Couldn't search archive.org: ${r.error}` });
  render();
}

// A search hit becomes the source's item, and its files open to pick from
function editorPickItem(ia) {
  const ed = state.editor;
  const i = ed.search?.i ?? 0;
  ed.sources[i].ia = ia;
  ed.search = null;
  return editorBrowse(i);
}

// "Make a game tile" from an archive.org item on the wall: a new tile with it as the data
function adminFromItem(identifier) {
  closeDetail();
  go('collision');
  state.editor.sources[0].ia = identifier;
  return editorBrowse(0);
}

async function loadCurated() {
  state.curated = null;
  const r = await api.getCuratedCollisions();
  state.curated = r || { error: "Admin mode is off. Start it with mise run admin." };
  if (state.view.name === 'admin') render();
}

function viewAdmin() {
  const c = state.curated;
  if (!c) return '<p class="empty">Loading the curated list…</p>';
  if (c.error) return `<p class="empty">${esc(c.error)}</p>`;
  const summary = (e) => [...(e.sources || []).map(x => `${x.ia}/${x.path}${x.as ? ` → ${x.as}` : ''}`), ...(e.dataFiles || []).map(d => d.name)].join(', ');
  return `<p class="lede">Every curated collision, from <code>${esc(c.file)}</code>. Edits write that file; commit it in a PR to ship them.</p>
    <div class="field actions"><button class="btn primary" data-view="collision">New game tile…</button></div>
    <div class="list-head admin-head"><span>Name</span><span>Repository</span><span>Shelf</span><span>Game data</span><span></span></div>
    <div class="admin-list">${c.collisions.map(e => `<div class="admin-row${e.hidden ? ' is-hidden' : ''}">
      <span><b>${esc(e.name || e.repository)}</b>${e.hidden ? ' <span class="pill">Hidden</span>' : ''}</span>
      <span>${esc(e.repository)}</span><span>${esc(e.shelf || '')}</span><span class="meta">${esc(summary(e))}</span>
      <span class="row-actions"><button class="btn" data-action="edit-collision" data-repo="${esc(e.repository)}">Edit</button>
        <button class="btn" data-action="admin-hide" data-repo="${esc(e.repository)}">${e.hidden ? 'Show' : 'Hide'}</button></span></div>`).join('')}</div>`;
}

async function adminToggleHidden(repo) {
  const e = state.curated?.collisions.find(x => x.repository === repo);
  if (!e) return;
  const { hidden, ...rest } = e;
  const r = await api.saveCuratedCollision(repo, hidden ? rest : { ...rest, hidden: true });
  if (!r.ok) return toast(`Couldn't save: ${r.error}`);
  toast(hidden ? `${e.name || repo} shows for everyone again.` : `${e.name || repo} is hidden: only admin mode shows it.`);
  await loadCurated();
  loadPorts();
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
  // Kept in state, so a re-render (the release list arriving) doesn't wipe what was typed
  if (t.dataset.search !== undefined) { ed.queries[t.dataset.search] = t.value; return; }
  if (t.id === 'ed-filter' && ed.browse) { ed.browse.filter = t.value; $('#browse-list').innerHTML = browseList(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset?.search !== undefined && state.editor) editorSearch(Number(e.target.dataset.search));
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'setting-additional') return setAdditional(e.target.checked);
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
  if (t.id === 'ed-hidden') ed.hidden = t.checked;
  if (t.dataset.src !== undefined && t.type === 'checkbox') ed.sources[Number(t.dataset.src)][t.dataset.key] = t.checked;
});

// ─── Additional sources (Settings) ───────────────────────────────────────────

const SECTION_NAME = { collisions: 'collisions', archive: 'archive', github: 'github' };
function additionalHtml() {
  if (!state.settings.allowAdditionalSources) return '';
  const u = state.userSources;
  if (!u) { loadUserSources(); return '<div class="hint">Loading…</div>'; }
  const n = (k) => u.entries[k];
  const status = !u.file ? '<div class="hint">No user.json yet. Pick a file on this computer: <code>{ "schemaVersion": 1, "collisions": [], "archive": [], "github": [] }</code>.</div>'
    : u.error ? `<div class="notice warn" id="user-file-error"><div class="grow">${esc(u.error)}</div></div>`
    : `<div class="hint" id="user-file-counts">Loaded: ${n('collisions')} collision${n('collisions') === 1 ? '' : 's'}, ${n('archive')} archive.org download${n('archive') === 1 ? '' : 's'}, ${n('github')} GitHub release${n('github') === 1 ? '' : 's'}.</div>`;
  const invalid = u.invalid.length ? `<div class="notice warn user-list" id="user-invalid"><div class="grow"><b>${u.invalid.length} invalid entr${u.invalid.length === 1 ? 'y' : 'ies'}, not loaded:</b>
      ${u.invalid.map(i => `<div>${esc(SECTION_NAME[i.section])}[${i.index}]${i.key ? ` ${esc(i.key)}` : ''}: ${esc(i.errors.join('; '))}</div>`).join('')}</div></div>` : '';
  const conflicts = u.conflicts.length ? `<div class="notice user-list" id="user-conflicts"><div class="grow"><b>Ignored, the curated list already has ${u.conflicts.length === 1 ? 'it' : 'them'}:</b>
      ${u.conflicts.map(c => `<div>${esc(c.key)} (${esc(c.from)}): ${esc(c.reason)}</div>`).join('')}</div></div>` : '';
  return `<label for="setting-user-file" class="sublabel">user.json</label>
    <div class="inline"><input type="text" id="setting-user-file" value="${esc(u.file || '')}" placeholder="Full path to user.json on this computer" spellcheck="false">
      <button class="btn" data-action="user-file-save">Load</button></div>
    ${status}${invalid}${conflicts}`;
}

async function loadUserSources() {
  state.userSources = await api.getUserSources().catch(() => null) || { enabled: false, file: null, error: null, invalid: [], entries: {}, conflicts: [] };
  const el = $('#additional-body');
  if (el) el.innerHTML = additionalHtml();
}

// The toggle: turning it on asks first, every time; off hides what's from
// additional sources (installed files stay on disk)
async function setAdditional(on) {
  const box = $('#setting-additional');
  if (on && !(await modal({
    title: 'Additional sources',
    body: 'Warning: we do not monitor additional sources. Make sure you trust the repo or uploader before you add it.',
    primary: 'I understand',
  }))) {
    if (box) box.checked = false;
    return;
  }
  const r = await api.saveSettings({ allowAdditionalSources: on });
  if (r && r.ok === false) { if (box) box.checked = !on; return toast(`Couldn't save: ${r.body?.detail || r.status}`); }
  state.settings = { ...state.settings, allowAdditionalSources: on };
  document.querySelectorAll('.additional-only').forEach(el => el.classList.toggle('hidden', !on));
  state.userSources = null;
  const el = $('#additional-body');
  if (el) el.innerHTML = additionalHtml();
  toast(on ? 'Additional sources are on. What comes from them is marked Your source · not reviewed.' : 'Additional sources are off. Only the curated list shows; installed games stay on disk.');
  loadWall({ refresh: true });
  loadPorts();
}

async function saveUserFile() {
  const file = $('#setting-user-file').value.trim();
  const r = await api.saveSettings({ userSourcesFile: file || null });
  if (r && r.ok === false) return toast(r.body?.detail || `Couldn't save: HTTP ${r.status}`, 6000);
  state.settings = { ...state.settings, userSourcesFile: file || null };
  await loadUserSources();
  loadWall({ refresh: true });
  loadPorts();
}

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

// ─── row actions: the ⋯ button and the right-click menu ─────────────────────
// Every row menu reads this one list (ListView.createActions). An action is
// { id, label, icon, group, kinds, when(item, ctx), run(item, ctx) }; the
// menu draws one section per group, in ListView.MENU_GROUPS order (pin,
// collection, play, manage, goto, admin, remove). More actions (the admin
// group's Make collision) are added with rowActions.register(...) and need
// no change to the rows or the menu.

const rowActions = ListView.createActions();
const itemDl = (x, ctx) => state.downloads.get(ctx.kind === 'port' ? x.id : x.identifier);
const itemInstalled = (x, ctx) => (ctx.kind === 'port' ? !!state.library[x.id]?.install_dir : isInstalled(x));
const gameTarget = (g) => installedVersion(g) || g;
const targetOf = (x, ctx) => (ctx.kind === 'port' ? portTarget(x) : gameTarget(x));
const idle = (x, ctx) => !itemDl(x, ctx);
const linkOf = (x, ctx) => (ctx.kind === 'port' ? `https://github.com/${x.repository}` : x._manual ? null : `https://archive.org/details/${gameTarget(x).identifier}`);

const ROW_ACTIONS = [
  // play: get it, run it, find it on disk
  { id: 'play', label: 'Play', icon: 'play', group: 'play', kinds: ['game'],
    when: (g, ctx) => itemInstalled(g, ctx) && idle(g, ctx), run: (g) => playGame(gameTarget(g)) },
  { id: 'launch', label: 'Launch', icon: 'play', group: 'play', kinds: ['port'],
    when: (p, ctx) => itemInstalled(p, ctx) && idle(p, ctx), run: (p) => launchPort(p) },
  { id: 'install', label: (x, ctx) => (ctx.kind === 'port' ? 'Download' : 'Install'), icon: 'download', group: 'play',
    when: (x, ctx) => !itemInstalled(x, ctx) && idle(x, ctx) && !x._manual,
    run: (x, ctx) => (ctx.kind === 'port' ? installPort(x) : installGame(x)) },
  { id: 'cancel', label: 'Cancel Download', icon: 'close', group: 'play', when: (x, ctx) => !!itemDl(x, ctx),
    run: async (x, ctx) => { const dl = itemDl(x, ctx); if (dl?.jobId) await api.cancelInstall({ jobId: dl.jobId }); } },
  { id: 'locate', label: 'Locate Existing Install…', icon: 'folder', group: 'play', kinds: ['port'],
    when: (p, ctx) => !itemInstalled(p, ctx) && idle(p, ctx), run: (p) => locateInstall(p) },
  { id: 'open-folder', label: 'Open Folder', icon: 'folder', group: 'play',
    when: (x, ctx) => itemInstalled(x, ctx) && idle(x, ctx), run: (x, ctx) => api.openGameLocation({ identifier: targetOf(x, ctx).identifier }) },
  { id: 'launch-options', label: 'Launch Options', icon: 'settings', group: 'play', kinds: ['port'],
    when: (p, ctx) => itemInstalled(p, ctx) && idle(p, ctx), children: [
      { id: 'choose-exe', label: 'Choose Executable…', icon: 'play', run: (p) => pickExe(p, 'default') },
      { id: 'steam', label: 'Add to Steam…', icon: 'plus', run: (p) => pickExe(p, 'steam') },
    ] },
  { id: 'game-steam', label: 'Add to Steam…', icon: 'plus', group: 'play', kinds: ['game'],
    when: (g, ctx) => itemInstalled(g, ctx) && idle(g, ctx), run: (g) => { openDetail('game', g.identifier); return onAction('steam'); } },

  // manage: favourite, library, properties
  { id: 'favorite', label: (g, ctx) => (ListView.isFavorite(g, ctx) ? 'Unfavorite' : 'Favorite'), icon: 'star', group: 'manage', kinds: ['game'],
    run: async (g, ctx) => {
      const on = ListView.isFavorite(g, ctx);
      const ids = on ? (g._versions || [g]).filter(v => state.library[v.identifier]?.is_favorite).map(v => v.identifier) : [gameTarget(g).identifier];
      for (const identifier of ids) await api.setFavorite({ identifier, isFavorite: !on });
      await reloadLibrary();
      render();
    } },
  { id: 'toggle-library', label: (p) => (inPortLibrary(p) ? 'Remove from Library' : 'Add to Library'), icon: 'library', group: 'manage', kinds: ['port'],
    run: (p) => togglePort(p.id) },
  // An archive.org-only entry (no repository) has neither
  { id: 'collision', label: 'Game Data…', icon: 'box', group: 'manage', kinds: ['port'], when: (p) => p.repository, run: (p) => go('collision', p.repository) },
  { id: 'details', label: 'Properties', icon: 'info', group: 'manage',
    run: (x, ctx) => openDetail(ctx.kind, ctx.kind === 'port' ? x.id : x.identifier) },

  // goto: where it comes from, and a link to it
  { id: 'uploader', label: 'Go to Uploader', icon: 'person', group: 'goto', kinds: ['game'],
    when: (g) => state.sources.some(s => s.uploader === g._uploader && s.enabled !== false), run: (g) => go('uploader', g._uploader) },
  { id: 'shelf', label: 'Go to Shelf', icon: 'wall', group: 'goto', kinds: ['port'],
    when: (p) => state.ports?.shelves.some(s => s.id === p.shelf), run: (p) => go('shelf', p.shelf) },
  { id: 'repo', label: 'Go to Source Repo', icon: 'code', group: 'goto', kinds: ['port'], when: (p) => p.repository,
    run: (p) => api.openExternal(`https://github.com/${p.repository}`) },
  { id: 'data', label: 'Game Data on archive.org', icon: 'globe', group: 'goto', kinds: ['port'],
    when: (p) => p.data.iaIdentifier, run: (p) => api.openExternal(`https://archive.org/details/${p.data.iaIdentifier}`) },
  { id: 'archive', label: 'View on archive.org', icon: 'globe', group: 'goto', kinds: ['game'],
    when: (g) => !g._manual, run: (g) => api.openExternal(`https://archive.org/details/${gameTarget(g).identifier}`) },
  { id: 'share', label: 'Copy Link', icon: 'share', group: 'goto', when: (x, ctx) => linkOf(x, ctx),
    run: async (x, ctx) => {
      try { await navigator.clipboard.writeText(linkOf(x, ctx)); toast('Link copied.'); } catch { toast(linkOf(x, ctx), 8000); }
    } },

  // remove: files off the disk, or the entry out of the library
  { id: 'delete', label: 'Delete', icon: 'trash', group: 'remove', danger: true,
    when: (x, ctx) => itemInstalled(x, ctx) && idle(x, ctx) && !x._manual,
    run: async (x, ctx) => {
      const name = ctx.kind === 'port' ? x.name : getTitle(x);
      if (!confirm(`Delete ${name}? Its install folder goes to the Recycle Bin.`)) return;
      const r = await api.deleteGame({ identifier: targetOf(x, ctx).identifier, trash: true });
      if (!r.ok) return toast(`Couldn't delete: ${r.error}`);
      toast(`Deleted ${name}.`);
      await reloadLibrary();
      render();
    } },
  { id: 'manual-remove', label: 'Remove from Library', icon: 'trash', group: 'remove', danger: true, kinds: ['game'],
    when: (g) => g._manual, run: (g) => { openDetail('game', g.identifier); return onAction('manual-remove'); } },
  // Admin mode (docs/ADMIN.md): a game tile with this archive.org item as its data
  { id: 'make-tile', label: 'Make a Tile…', icon: 'plus', group: 'admin', kinds: ['game'],
    when: (g) => state.admin && !g._manual, run: (g) => adminFromItem(g.identifier) },
];
ROW_ACTIONS.forEach(rowActions.register);

// The item a row, card or ⋯ button stands for
function menuItem(kind, id) {
  if (kind === 'port') return state.ports?.items.find(i => i.id === id) || null;
  return state.games.find(g => g.identifier === id) || state.versions.find(v => v.identifier === id)
    || (state.library[id] ? rowGame(state.library[id]) : null);
}

function menuHtml(sections) {
  const item = (e) => {
    const body = `${e.icon ? `<i class="ico mi-ico" data-ico="${esc(e.icon)}"></i>` : '<i class="mi-ico"></i>'}<span class="mi-label">${esc(e.label)}</span>`;
    return e.children
      ? `<div class="has-sub"><button class="mi" role="menuitem" aria-haspopup="menu" data-sub>${body}<i class="ico chev" data-ico="chev"></i></button>
          <div class="ctxmenu sub" role="menu">${menuHtml([e.children])}</div></div>`
      : `<button class="mi${e.danger ? ' danger' : ''}" role="menuitem" data-menu="${esc(e.id)}">${body}</button>`;
  };
  return sections.map(s => s.map(item).join('')).join('<div class="sep" role="separator"></div>');
}

let menuTarget = null;   // { kind, item }
function openMenu(kind, item, x, y, { alignRight = false } = {}) {
  closeDropdown();
  menuTarget = { kind, item };
  let el = $('#ctxmenu');
  if (!el) { el = document.createElement('div'); el.id = 'ctxmenu'; el.className = 'ctxmenu'; el.setAttribute('role', 'menu'); document.body.append(el); }
  el.innerHTML = menuHtml(rowActions.sections(item, listCtx(kind)));
  el.classList.remove('hidden', 'flip');
  // Keep it on screen; submenus open to the left near the right edge
  const r = el.getBoundingClientRect();
  const left = alignRight ? x - r.width : x;
  el.style.left = `${Math.max(8, Math.min(left, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  if (Math.min(left, innerWidth - r.width - 8) + r.width * 2 > innerWidth) el.classList.add('flip');
  el.querySelector('.mi')?.focus();
}
function closeMenu() { $('#ctxmenu')?.classList.add('hidden'); menuTarget = null; }

// Up and Down walk the menu's items, Right opens a submenu, Left leaves it
function menuKey(e) {
  const el = $('#ctxmenu');
  const inSub = document.activeElement?.closest('.sub');
  const scope = inSub || el;
  const items = [...scope.querySelectorAll(':scope > .mi, :scope > .has-sub > .mi')];
  const at = items.indexOf(document.activeElement);
  const move = (i) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
  if (e.key === 'ArrowDown') return move(at + 1);
  if (e.key === 'ArrowUp') return move(at < 0 ? items.length - 1 : at - 1);
  if (e.key === 'ArrowRight' && document.activeElement?.dataset.sub !== undefined) {
    e.preventDefault();
    return document.activeElement.parentNode.querySelector('.sub .mi')?.focus();
  }
  if (e.key === 'ArrowLeft' && inSub) { e.preventDefault(); return inSub.parentNode.querySelector(':scope > .mi')?.focus(); }
}

async function runMenu(btn) {
  const target = menuTarget;
  const action = rowActions.get(btn.dataset.menu);
  closeMenu();
  if (!target || !action?.run) return;
  return action.run(target.item, listCtx(target.kind));
}

// The left gutter's play button: an installed item launches, others open their details
function rowGo(kind, id) {
  const x = menuItem(kind, id);
  if (!x) return;
  const ctx = listCtx(kind);
  if (itemInstalled(x, ctx) && idle(x, ctx)) return kind === 'port' ? launchPort(x) : playGame(gameTarget(x));
  return openDetail(kind, id);
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

// Right-click on any game or port (card, list row, New's list) opens its row menu
document.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('#body [data-open]');
  const item = card && menuItem(card.dataset.open, card.dataset.id);
  if (!item) return closeMenu();
  e.preventDefault();
  // The keyboard menu key reports 0,0; anchor to the card instead
  const r = card.getBoundingClientRect();
  openMenu(card.dataset.open, item, e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctxmenu')) closeMenu();
  if (!e.target.closest('#ddmenu, [data-dd]')) closeDropdown();
});
const closeMenus = () => { closeMenu(); closeDropdown(); };
window.addEventListener('blur', closeMenus);
window.addEventListener('resize', closeMenus);
document.addEventListener('scroll', (e) => { if (!e.target.closest?.('#ddmenu, #ctxmenu')) closeMenus(); }, true);

async function saveSettingsForm() {
  const sources = parseSources($('#setting-sources').value);
  if (!sources.length) return toast('Add at least one uploader.');
  const patch = { sources, installPath: $('#setting-install').value.trim(), downloadPath: $('#setting-download').value.trim() };
  await api.saveSettings(patch);
  const changed = formatSources(sources) !== formatSources(state.sources);
  state.settings = { ...state.settings, ...patch };
  state.sources = sources;
  toast('Settings saved.');
  if (changed) loadWall({ refresh: true });
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
    case 'reload-wall': return loadWall({ refresh: true });
    case 'reload-all': loadPorts(true); return loadWall({ refresh: true });
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
    case 'ed-releases': return editorReleases();
    case 'ed-close-releases': state.editor.releases = null; return render();
    case 'ed-take-asset': return editorTakeAsset(el.dataset.pattern);
    case 'ed-search': return editorSearch(Number(el.dataset.i));
    case 'ed-pick-item': return editorPickItem(el.dataset.ia);
    case 'admin-from-item': return adminFromItem(el.dataset.ia);
    case 'admin-hide': return adminToggleHidden(el.dataset.repo);
    case 'feed-add': return addCollisionFeed();
    case 'user-file-save': return saveUserFile();
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
    if (p) { e.stopPropagation(); return openMenu('port', p, r.left, r.bottom + 4); }
  }
  // A list row's ⋯ button: the row menu, its right edge under the button
  const rowMenu = e.target.closest('[data-row-menu]');
  if (rowMenu) {
    const item = menuItem(rowMenu.dataset.rowMenu, rowMenu.dataset.id);
    const r = rowMenu.getBoundingClientRect();
    if (item) { e.stopPropagation(); return openMenu(rowMenu.dataset.rowMenu, item, r.right, r.bottom + 4, { alignRight: true }); }
  }
  const opt = e.target.closest('#ddmenu .dd-opt');
  if (opt) return pickDropdown(opt);
  const t = e.target.closest('button, a, [data-close], .lv-row');
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
  if (t.dataset.dd) return ddOpen === t.dataset.dd ? closeDropdown() : openDropdown(t.dataset.dd);
  if (t.dataset.rowGo) return rowGo(t.dataset.rowGo, t.dataset.id);
  if (t.dataset.sortCol) {
    const col = LIST_COLUMNS[t.dataset.kind]?.find(c => c.id === t.dataset.sortCol);
    const next = ListView.headerSort(libPrefs[t.dataset.page], col);
    if (!next) return;
    setPref(t.dataset.page, 'sort', next.sort);
    setPref(t.dataset.page, 'order', next.order);
    return render();
  }
  if (t.dataset.viewAs) { setPref(t.dataset.page, 'viewAs', t.dataset.viewAs); return render(); }
  if (t.dataset.pageGo) { state.libPage = Number(t.dataset.pageGo); render(); $('#body').scrollTop = 0; return; }
  if (t.dataset.collapse) return toggleFold(t.dataset.collapse);
  if (t.dataset.action) return onAction(t.dataset.action, t);
});

document.addEventListener('change', (e) => {
  const t = e.target;
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
  if (e.key === 'Escape' && popKind) return closePop();
  if (ddOpen && e.target.closest?.('#ddmenu')) return dropdownKey(e);
  if (ddOpen && e.key === 'Escape') { e.preventDefault(); return closeDropdown(true); }
  if (menuTarget && e.target.closest?.('#ctxmenu')) menuKey(e);
  if (e.key === 'Escape' && menuTarget) return closeMenu();
  // A trigger opens its dropdown from the keyboard too
  if (e.target.dataset?.dd && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); return openDropdown(e.target.dataset.dd); }
  // Enter on a focused list row opens it, as a click does
  if (e.key === 'Enter' && e.target.classList?.contains('lv-row')) { e.preventDefault(); return openDetail(e.target.dataset.open, e.target.dataset.id); }
  if (e.key === 'Escape') { if (state.detail) closeDetail(); else if (state.query) { $('#q').value = ''; state.query = ''; render(); } }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && stepRow(e)) e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
});

$('#win-min').addEventListener('click', () => api.windowMinimize());
$('#win-max').addEventListener('click', () => api.windowMaximize());
$('#win-close').addEventListener('click', () => api.windowClose());
$('#nav-back').addEventListener('click', () => goHistory(-1));
$('#nav-fwd').addEventListener('click', () => goHistory(1));
$('#btn-sidebar').addEventListener('click', () => $('#app').classList.toggle('no-sidebar'));

// The window buttons dim while the window is in the background, as on macOS
const syncFocus = () => document.body.classList.toggle('unfocused', !document.hasFocus());
window.addEventListener('focus', syncFocus);
window.addEventListener('blur', syncFocus);
syncFocus();

// The two-way switch under the search box: everything, or only what's yours
document.querySelectorAll('.seg [data-seg]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.seg [data-seg]').forEach(x => x.classList.toggle('on', x === b));
  $('#sidebar').classList.toggle('only-yours', b.dataset.seg === 'yours');
}));

// ─── title-row popovers: Downloads and ⋯ (Cider's lyrics and ⋯ slots) ──────

let popKind = null;
function downloadsPopHtml() {
  const active = [...state.downloads.values()].filter(d => d.name);
  const kindOf = (id) => (state.ports?.items.some(i => i.id === id) ? 'port' : 'game');
  const recent = Object.values(state.library).filter(l => l.install_dir)
    .sort((a, b) => String(b.added_at || '').localeCompare(String(a.added_at || ''))).slice(0, 5);
  const nameOf = (l) => state.ports?.items.find(i => i.id === l.identifier)?.name
    || getTitle(state.games.find(g => (g._versions || [g]).some(v => v.identifier === l.identifier)) || { title: l.title || l.identifier });
  let html = '<div class="pop-h">Downloads</div>';
  html += active.length ? active.map(d => `<button class="mi pop-dl" data-open="${esc(d.open[0])}" data-id="${esc(d.open[1])}">
      <span class="pop-name">${esc(d.name)}</span><span class="pop-pct">${d.status === 'downloading' ? `${d.percent || 0}%` : 'Installing…'}</span>
      <span class="nb-bar"><i style="width:${d.percent || 0}%"></i></span></button>`).join('')
    : '<div class="pop-empty">Nothing downloading.</div>';
  if (recent.length) {
    html += '<div class="sep"></div><div class="pop-h">Recently installed</div>';
    html += recent.map(l => `<button class="mi" data-open="${kindOf(l.identifier)}" data-id="${esc(l.identifier)}">
      <span class="pop-name">${esc(nameOf(l))}</span><span class="pop-pct">${esc(fmtDate(l.added_at))}</span></button>`).join('');
  }
  return html;
}
const morePopHtml = () => `<button class="mi" data-view="settings"><i class="ico" data-ico="settings"></i>Settings</button>
  <button class="mi" data-action="reload-all"><i class="ico" data-ico="reload"></i>Reload</button>
  <div class="sep"></div>
  <button class="mi" data-action="legacy-ui"><i class="ico" data-ico="swap"></i>Switch to the classic interface</button>`;

function renderPop() {
  const el = $('#pop');
  if (!popKind) return el.classList.add('hidden');
  el.innerHTML = popKind === 'downloads' ? downloadsPopHtml() : morePopHtml();
  el.dataset.kind = popKind;
  const btn = $(popKind === 'downloads' ? '#btn-downloads' : '#btn-more');
  const r = btn.getBoundingClientRect(), main = $('.main').getBoundingClientRect();
  el.classList.remove('hidden');
  el.style.top = `${r.bottom - main.top + 6}px`;
  el.style.right = `${Math.max(12, main.right - r.right - 8)}px`;
}
function togglePop(kind) {
  popKind = popKind === kind ? null : kind;
  renderPop();
}
function closePop() { if (popKind) { popKind = null; renderPop(); } }
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-pop]');
  if (opener) { e.stopPropagation(); return togglePop(opener.dataset.pop); }
  // Any other click closes it; a click on one of its items still does its job
  closePop();
}, true);
window.addEventListener('blur', closePop);
window.addEventListener('resize', closePop);

// The badges in the title row: a dot while something downloads, the count of
// catalog changes to review on Notifications
function renderBadges() {
  const busy = [...state.downloads.values()].some(d => d.name);
  $('#dl-dot').hidden = !busy;
  const n = reviewCount();
  const b = $('#n-notices');
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n || '';
}

// The pill at the bottom of the window follows the running download, if any
function renderNowbar() {
  renderBadges();
  if (popKind === 'downloads') renderPop();
  const el = $('#nowbar');
  const dl = [...state.downloads.values()].find(d => d.name);
  el.classList.toggle('hidden', !dl);
  if (!dl) return;
  const pct = dl.percent || 0;
  el.innerHTML = `<button class="nowbar-in" data-open="${esc(dl.open[0])}" data-id="${esc(dl.open[1])}">
    <i class="ico" data-ico="download"></i><span class="nb-name">${esc(dl.name)}</span>
    <span class="nb-pct">${dl.status === 'downloading' ? `${pct}%` : 'Installing…'}</span>
    <span class="nb-bar"><i style="width:${pct}%"></i></span></button>`;
}

function showProgress(identifier, percent) {
  const d = state.downloads.get(identifier);
  if (!d || d.status !== 'downloading') return;
  d.percent = percent;
  renderNowbar();
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
  state.admin = !!(await api.getHealth().catch(() => ({}))).admin;
  document.querySelectorAll('.additional-only').forEach(el => el.classList.toggle('hidden', !state.settings.allowAdditionalSources));
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !state.admin));
  state.sources = (await api.getSources()).sources;
  state.featured = await api.getFeatured().catch(() => []);
  await reloadLibrary();
  render();
  showAnnouncement();
  // The two halves load side by side: GitHub for the shelves, archive.org for the wall
  loadPorts();
  loadWall();
})();
