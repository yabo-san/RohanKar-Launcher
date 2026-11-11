'use strict';
/**
 * y4bo launcher UI (docs/AGENT-BRIEF.md has the user loop it serves).
 * Draws what the backend's /v1 API serves (through ../api.js): the Library
 * (what's installed), Ports (the repos), the Packs (archive.org uploaders),
 * What's new, and Settings. ../sources.js supplies getTitle and the Settings text helpers.
 */
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  view: { name: 'library' },
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
  portUpdates: [],      // GET /ports/updates: installed ports with a newer release
  appVersion: '',       // GET /health version, for the Report an issue links
  libSearch: '',        // the search box in a library header (Cider's library pages)
  libPage: 1,           // the page, when a library header is set to paged
  detail: null,
  downloads: new Map(), // identifier -> { percent, status }
  myRepos: null,        // GET /repos: the repos the user added, for Settings
};

// ─── helpers ─────────────────────────────────────────────────────────────────

// A link the sidebar box (or a paste anywhere) adds instead of searching for
const LINK_RE = /^(https?:\/\/)?(www\.)?(archive\.org|github\.com|gitlab\.com)\//i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString();
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
function modal({ title, body, html = false, primary, secondary = 'Cancel' }) {
  document.getElementById('modal')?.remove();
  const el = document.createElement('div');
  el.id = 'modal';
  el.className = 'modal-fullscreen';
  el.innerHTML = `<div class="modal-window" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-body">
    <div class="modal-header"><div class="modal-title" id="modal-title">${esc(title)}</div></div>
    <div class="modal-content" id="modal-body">${html ? body : esc(body)}</div>
    <div class="modal-footer">${secondary ? `<button class="md-btn" data-modal="0">${esc(secondary)}</button>` : ''}<button class="md-btn md-btn-primary" data-modal="1">${esc(primary)}</button></div>
  </div>`;
  const back = document.activeElement;
  document.body.appendChild(el);
  // The safe answer has focus, so Enter never accepts a warning by accident
  (el.querySelector('[data-modal="0"]') || el.querySelector('[data-modal="1"]')).focus();
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

// ─── motion (motion.css): page transitions, cover fade-ins ──────────────────

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motionOk = () => !reducedMotion.matches;

// A new page fades in and rises a few pixels; renders within a page (the wall
// streaming in) don't replay it. Transform and opacity only, so nothing shifts.
function pageEnter() {
  const body = $('#body');
  body.classList.remove('page-enter');
  if (!motionOk()) return;
  void body.offsetWidth;
  body.classList.add('page-enter');
  clearTimeout(pageEnter.timer);
  pageEnter.timer = setTimeout(() => body.classList.remove('page-enter'), 260);
}

// Covers fade in the first time they load; one already seen (a re-render)
// shows at once
const seenImages = new Set();
document.addEventListener('load', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.closest('#body, #pop')) return;
  if (!seenImages.has(img.src)) img.classList.add('fade-in');
  seenImages.add(img.src);
}, true);

// The frosted title row gets its hairline once the page scrolls under it
function syncChrome() {
  $('.main').classList.toggle('scrolled', $('#body').scrollTop > 4);
}

// A port's state from its tags (core's portTraits), as small badges on cards and details
const ROLE_LABEL = { engine: 'Engine', launcher: 'Launcher' };
const portBadges = (p) => (p.sourceOnly ? '<span class="state-badge source-only" title="Publishes source code but no download">Source only</span>' : '')
  + (p.workInProgress ? '<span class="state-badge wip" title="Not finished yet; installs if a release exists">Work in progress</span>' : '')
  + (p.role ? `<span class="state-badge role" title="A plain app: bring your own game data">${ROLE_LABEL[p.role]}</span>` : '');

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
      img.onload = () => {
        if (!seenImages.has(url)) img.className = 'fade-in';
        seenImages.add(url);
        e.target.querySelector('.noart')?.remove();
        e.target.prepend(img);
      };
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
    updatedate:   v.updatedate || null,
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
      for (const v of versions) Object.assign(v, { _versions: versions });
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
    sourceOnly:         !!it.sourceOnly,
    workInProgress:     !!it.workInProgress,
    role:               it.role || null,
    description:        it.description || '',
    repositoryUrl:      it.repositoryUrl || null,
    host:               it.repositorySource === 'gitlab' ? 'GitLab' : 'GitHub',
    sourceLabel:        cat.shelf,
    catalogUrl:         cat.url,
  };
}

async function loadPorts(refresh = false) {
  try {
    let catalogs = await api.getCatalogs();
    if (refresh) catalogs = await Promise.all(catalogs.map(c => api.refreshCatalog(c.id)));
    const lists = await Promise.all(catalogs.map(c => api.getCatalogItems(c.id)));
    const items = catalogs.flatMap((c, i) => lists[i].map(it => portFromItem(it, c)));
    const shelves = catalogs.map(c => {
      const mine = items.filter(i => i.shelf === c.id);
      return {
        id: c.id, name: c.shelf, url: c.url, preferredTags: [],
        count: mine.length,
        error: c.entries ? null : c.error,
        fromCache: !!(c.error && c.entries), fetchedAt: c.fetchedAt, bundled: !!c.bundled,
      };
    });
    state.ports = { shelves, items };
    state.portsError = null;
  } catch (e) {
    state.portsError = e.message;
  }
  await reloadLibrary();
  render();
  loadPortUpdates();
}

// Newer releases of installed ports, for What's new and the Update button
async function loadPortUpdates() {
  state.portUpdates = await api.getPortUpdates().catch(() => []);
  renderNav();
  if (onDetailPage()) renderDetail();
}
const portUpdate = (p) => state.portUpdates.find(u => u.id === p.id) || null;

// Ports in the library are rows without an install, keyed by the catalog item id
async function reloadLibrary() {
  state.library = await api.getLibrary().catch(() => ({}));
  state.portLibrary = Object.keys(state.library).filter(id => id.startsWith('quiver:')).map(id => ({ id }));
  renderNav();
}

const isInstalled = (g) => ListView.isInstalled(g, { library: state.library });
const installedVersion = (g) => (g._versions || [g]).find(v => state.library[v.identifier]?.install_dir);

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
  $('#n-ports').textContent = state.ports?.items.length || '';
  const libCount = Object.values(state.library).filter(l => l.install_dir && l.source !== 'manual').length;
  $('#n-library').textContent = libCount || '';
  $('#n-news').textContent = newsItems().length || '';
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

// Back and forward in the title row walk the pages visited (details.js):
// a search is a page too, and each page comes back scrolled where it was left
const navHistory = createHistory();
const here = () => ({ ...state.view, query: state.query, scroll: $('#body').scrollTop });
function syncHistory() {
  $('#nav-back').disabled = !navHistory.canBack;
  $('#nav-fwd').disabled = !navHistory.canForward;
}
function go(name, arg = null) {
  navHistory.push(here(), { name, arg, query: '' });
  show(name, arg);
}
function goHistory(dir) {
  const v = navHistory.step(here(), dir);
  if (v) show(v.name, v.arg || null, v);
}
function show(name, arg, { query = '', scroll = 0 } = {}) {
  if (!DETAIL_VIEWS.has(name)) state.detail = null;
  state.view = { name, arg };
  state.query = query;
  $('#q').value = query;
  libPrefs.shelf.tag = '';   // tags differ from shelf to shelf
  state.libSearch = '';
  state.libPage = 1;
  syncHistory();
  render();
  // Straight to the spot, not a smooth scroll there
  const body = $('#body');
  body.style.scrollBehavior = 'auto';
  body.scrollTop = scroll;
  body.style.scrollBehavior = '';
  syncChrome();
  pageEnter();
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
  </button>`;
}

function portCard(p) {
  const installed = !!state.library[p.id]?.install_dir;
  const update = installed && portUpdate(p);
  const art = p.iconUrl
    ? `<img loading="lazy" src="${esc(p.iconUrl)}" alt=""><div class="noart fallback">${esc(p.name)}</div>`
    : `<div class="noart">${esc(p.name)}</div>`;
  return `<button class="card port-card" data-open="port" data-id="${esc(p.id)}" title="${esc(p.name)}">
    <div class="art icon" style="background:${tint(p.repository)}">${art}
      ${update ? '<span class="tag installed update">NEWER RELEASE</span>' : ''}
      ${p.sourceOnly ? '' : `<span class="play-btn${installed ? '' : ' get'}" aria-hidden="true"></span>`}<span class="menu-btn" data-card-menu aria-label="More"></span></div>
    <div class="title">${esc(p.name)}</div>
    <div class="sub">${esc(p.project || p.repository)}</div>
    ${portBadges(p) ? `<div class="badges">${portBadges(p)}</div>` : ''}
  </button>`;
}

const skeletons = (n) => Array.from({ length: n }, () =>
  '<div class="card skel"><div class="art"></div><div class="title">.</div><div class="sub">.</div></div>').join('');

// A section head is a bold title, with a chevron when it leads to a page of
// its own, and the round arrows at the right of a row (as in Cider)
function section(title, body, { count, sub, seeAll, cls = 'grid' } = {}) {
  const isRow = cls.split(' ')[0] === 'row';
  const rowHtml = isRow ? `<div class="row-wrap"><div class="${cls}">${body}</div>${rowEdges}</div>` : `<div class="${cls}">${body}</div>`;
  const h2 = seeAll
    ? `<h2><button class="h2link" data-go="${esc(seeAll[0])}" data-arg="${esc(seeAll[1] || '')}">${esc(title)}<i class="ico" data-ico="chev"></i></button></h2>`
    : `<h2>${esc(title)}</h2>`;
  return `<section class="section${isRow ? ' has-row' : ''}"><div class="section-head">${title ? h2 : ''}
    ${count != null && !isRow ? `<span class="count">${esc(count)}</span>` : ''}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    ${isRow ? rowNav : ''}</div>
    ${rowHtml}</section>`;
}

// ─── horizontal rows ─────────────────────────────────────────────────────────
// No scrollbar: rows scroll with the round arrows in their header (as in
// Cider), a mouse drag, a sideways wheel or trackpad swipe, and Left/Right
// between focused cards.

const rowNav = `<span class="row-nav">
  <button class="prev" data-row-nav="-1" aria-label="Scroll left" tabindex="-1"></button>
  <button class="next" data-row-nav="1" aria-label="Scroll right" tabindex="-1"></button></span>`;

// The round arrows that fade in over a row's ends while the pointer is on it
const rowEdges = `<button class="row-edge prev" data-row-nav="-1" aria-label="Scroll left" tabindex="-1"></button>
  <button class="row-edge next" data-row-nav="1" aria-label="Scroll right" tabindex="-1"></button>`;

// Arrows only on rows that overflow, each disabled at its end; the row's
// edges fade out on the sides with more to scroll to
function syncRowNav(row) {
  const max = row.scrollWidth - row.clientWidth;
  const wrap = row.closest('.row-wrap');
  if (wrap) {
    const atStart = row.scrollLeft <= 1, atEnd = row.scrollLeft >= max - 1;
    wrap.classList.toggle('more-left', !atStart);
    wrap.classList.toggle('more-right', !atEnd);
    wrap.querySelector('.row-edge.prev').disabled = atStart;
    wrap.querySelector('.row-edge.next').disabled = atEnd;
  }
  const nav = row.closest('.section')?.querySelector('.row-nav');
  if (!nav) return;
  // Arrows only when the row overflows
  nav.hidden = max <= 1;
  nav.querySelector('.prev').disabled = row.scrollLeft <= 1;
  nav.querySelector('.next').disabled = row.scrollLeft >= max - 1;
}
const syncRows = () => document.querySelectorAll('#body .row').forEach(syncRowNav);

// One press moves a row by most of its width, in whole cards
function scrollRow(btn) {
  const row = btn.closest('.section').querySelector('.row');
  const first = row.children[0];
  const pitch = first ? first.offsetWidth + (parseFloat(getComputedStyle(row).columnGap) || 0) : 0;
  const by = !pitch ? row.clientWidth * 0.85
    : Math.max(1, Math.floor(row.clientWidth / pitch)) * pitch;
  row.scrollBy({ left: Number(btn.dataset.rowNav) * by, behavior: motionOk() ? 'smooth' : 'auto' });
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
  if (moved) settleRow(row);
  if (moved) document.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
});
// After a drag, settle on the nearest card or column edge (Chromium doesn't re-snap on its own)
function settleRow(row) {
  const base = row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft);
  const edges = [...new Set([...row.children].map(c => Math.round(c.getBoundingClientRect().left - base + row.scrollLeft)))];
  if (!edges.length) return;
  const max = row.scrollWidth - row.clientWidth;
  const target = Math.min(max, edges.reduce((a, b) => Math.abs(b - row.scrollLeft) < Math.abs(a - row.scrollLeft) ? b : a));
  if (!motionOk()) { row.scrollLeft = target; return; }
  // CSS snapping fights a smooth scroll and can leave it a few pixels short, so it's off until this one ends
  row.classList.add('settling');
  const done = () => { row.classList.remove('settling'); row.removeEventListener('scrollend', done); clearTimeout(timer); };
  const timer = setTimeout(done, 600);
  row.addEventListener('scrollend', done);
  row.scrollTo({ left: target, behavior: 'smooth' });
}
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
    next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: motionOk() ? 'smooth' : 'auto' });
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


function wallNotice(uploader = null) {
  const f = state.wall.failed.filter(x => !uploader || x.src.uploader === uploader);
  if (!f.length) return '';
  return `<div class="notice warn"><div class="grow">Couldn't reach archive.org for <b>${esc(f.map(x => sourceName(x.src)).join(', '))}</b>: ${esc(f[0].error)}.</div>
    <button class="btn" data-action="reload-wall">Try again</button></div>`;
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
  shelf:   { sort: 'name', order: 'asc', viewAs: 'covers', scroll: 'infinite', tag: '', hiddenCols: [] },
  library: { sort: 'name', order: 'asc', viewAs: 'covers', scroll: 'infinite', hiddenCols: [] },
};
const libPrefs = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { /* storage off */ }
  // Every page scrolls: the paged mode is gone
  return Object.fromEntries(Object.entries(PREF_DEFAULTS).map(([k, d]) => [k, { ...d, ...saved[k], scroll: 'infinite' }]));
})();
function setPref(page, key, value) {
  libPrefs[page][key] = value;
  if (key !== 'viewAs' && key !== 'hiddenCols') state.libPage = 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(libPrefs)); } catch { /* storage off */ }
}

const { GAME_SORTS, PORT_SORTS, ciderSearch } = ListView;
// A pack's page sorts by when uploads arrived or last changed on archive.org
const WALL_SORTS = {
  dateAdded: ['Newest upload', g => g.addeddate],
  updated:   ['Recently updated', g => g.updatedate || g.addeddate],
  name:      ['Title', g => getTitle(g)],
  downloads: ['Most downloaded', g => g.downloads || 0],
};
// The Library's sorts, games and ports alike
const libRow = (x) => state.library[x.identifier || x.id] || {};
const LIBRARY_SORTS = {
  name:       ['Title', x => x.name || getTitle(x)],
  lastPlayed: ['Recently played', x => libRow(x).last_played_at || ''],
  dateAdded:  ['Recently installed', x => libRow(x).added_at || ''],
  playtime:   ['Playtime', x => libRow(x).playtime_secs || 0],
};
// Title reads A to Z; every other sort puts the newest or biggest first
const orderFor = (sort) => (sort === 'name' ? 'asc' : 'desc');
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
    onPick: (v) => { setPref(page, pref, v); if (pref === 'sort') setPref(page, 'order', orderFor(v)); render(); },
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
function libraryHeader(page, sorts, { extra = '' } = {}) {
  pageHasSearch = true;
  pageControls = {
    controls: `${extra}
      ${prefDropdown(page, 'sort', 'Sort by', 'sort', Object.entries(sorts).map(([k, [text]]) => [k, text]))}
      ${viewToggle(page)}`,
    pagination: '',
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
      const badges = (!port && n > 1 ? `<span class="lv-badge">${n}</span>` : '') + (port && x.sourceOnly ? '<span class="lv-badge">Source only</span>' : '') + (port && x.workInProgress ? '<span class="lv-badge wip">Work in progress</span>' : '');
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
  list = ListView.sortRows(list, p, [WALL_SORTS, GAME_SORTS], 'dateAdded', listCtx('game'));
  const extra = uploader ? '' : prefDropdown('wall', 'uploader', 'Uploader', 'person',
    [['', 'All uploaders'], ...enabled.map(s => [s.uploader, sourceName(s)])]);
  let html = libraryHeader('wall', WALL_SORTS, { extra }) + wallNotice(uploader);
  if (!list.length && state.wall.loading) return html + section('', skeletons(18));
  const hidden = (state.settings.excludeItems || []).length;
  const showHidden = hidden ? ` · ${hidden} hidden <button class="linkbtn" data-action="unhide-all">Show hidden</button>` : '';
  if (!list.length) return html + `<p class="empty">${state.libSearch ? 'Nothing matches that search.' : 'Nothing here yet.'}${showHidden}</p>`;
  const note = `${fmtNum(list.length)} titles${state.wall.loading ? ' · still loading…' : ''}`;
  return html + `<div class="lib-count">${note}${showHidden}</div>` + libraryBody('wall', list, { card: gameCard, kind: 'game' });
}

// Ports: every port, the built-in picks and the repos you added, in one list
function viewPorts() {
  if (!state.ports) return state.portsError ? `<p class="empty">Couldn't load the ports: ${esc(state.portsError)}</p>` : section('', skeletons(12), { cls: 'grid ports' });
  const p = libPrefs.shelf;
  let list = ciderSearch(state.ports.items, state.libSearch, i => [i.name, i.project, i.repository, ...i.tags]);
  list = ListView.sortRows(list, p, [PORT_SORTS], 'name', listCtx('port'), i => i.name);
  let html = libraryHeader('shelf', { name: PORT_SORTS.name, status: PORT_SORTS.status });
  for (const shelf of state.ports.shelves.filter(s => s.error || s.fromCache)) {
    html += shelf.error
      ? `<div class="notice warn"><div class="grow">Couldn't fetch ${esc(shelf.name)} (${esc(shelf.error)}).</div><button class="md-btn" data-action="refresh-ports">Retry</button></div>`
      : `<div class="notice"><div class="grow">Showing ${shelf.bundled ? `the ${esc(shelf.name)} list that came with the app` : `${esc(shelf.name)} as of ${esc(fmtDate(shelf.fetchedAt))}`}; GitHub wasn't reachable.</div><button class="md-btn" data-action="refresh-ports">Retry</button></div>`;
  }
  html += '<div class="lib-count">Paste a GitHub, GitLab or Codeberg link into the box at the top left to add a repo.</div>';
  return html + (list.length ? libraryBody('shelf', list, { card: portCard, kind: 'port', cls: 'grid ports' }) : '<p class="empty">No ports match.</p>');
}

// A library row no loaded item describes (an upload no longer
// on the wall), as a game the cards and detail can show
const rowGame = (l) => ({
  identifier: l.identifier, title: l.title || l.identifier,
  _sourceLabel: 'archive.org',
});

function viewLibrary() {
  // Manual apps (a removed feature) stay in library.db for the Playnite export but aren't shown
  const installed = Object.values(state.library).filter(l => l.install_dir && l.source !== 'manual' && !l.identifier.startsWith('quiver:'));
  const games = installed.map(l => state.games.find(g => (g._versions || [g]).some(v => v.identifier === l.identifier)) || rowGame(l));
  let uniq = [...new Map(games.map(g => [g.identifier, g])).values()];
  let ports = (state.ports?.items || []).filter(i => state.library[i.id]?.install_dir);
  if (!uniq.length && !ports.length) {
    return `<p class="empty"><b>Nothing installed yet.</b><br>Open a pack or Ports in the sidebar, or paste an archive.org, GitHub or GitLab link into the box at the top left.</p>`;
  }
  const p = libPrefs.library;
  const nameOf = LIBRARY_SORTS.name[1];
  uniq = ListView.sortRows(ciderSearch(uniq, state.libSearch, g => [getTitle(g), g._sourceLabel]), p, [LIBRARY_SORTS, GAME_SORTS], 'name', listCtx('game'), nameOf);
  ports = ListView.sortRows(ciderSearch(ports, state.libSearch, i => [i.name, i.repository]), p, [LIBRARY_SORTS, PORT_SORTS], 'name', listCtx('port'), nameOf);
  // One library: the games, then the ports (square art) right under them, no headings
  return libraryHeader('library', LIBRARY_SORTS)
    + (uniq.length ? libraryBody('library', uniq, { card: gameCard, kind: 'game' }) : '')
    + (ports.length ? `<div class="lib-gap"></div>${libraryBody('library', ports, { card: portCard, kind: 'port', cls: 'grid ports' })}` : '');
}

const ABOUT_LINKS = [
  ['y4bo on GitHub', 'https://github.com/yabo-san/RohanKar-Launcher'],
  ['Donate to the Internet Archive', 'https://archive.org/donate'],
];

function viewSettings() {
  const s = state.settings;
  return `<div class="form">
    <div class="field"><label for="setting-install">Install folder</label>
      <div class="inline"><input type="text" id="setting-install" value="${esc(s.installPath || '')}" placeholder="Default: the app's games folder">
      <button class="btn" data-action="choose-install">Choose…</button>
      <button class="btn" data-action="scan-install" title="Games already in this folder join your library, as Scan Install Folder did in the RohanKar launcher">Find installs here</button></div></div>
    <div class="field"><label for="setting-github-token">GitHub token</label>
      <div class="hint">Optional. GitHub allows 60 release checks an hour without one, which a few installs and updates can use up.
        A token with no scopes is enough: GitHub, Settings, Developer settings, Personal access tokens.</div>
      <input type="password" id="setting-github-token" value="${esc(s.githubToken || '')}" placeholder="Empty: no token" spellcheck="false" autocomplete="off"></div>
    <div class="field actions"><button class="btn primary" id="btn-save-settings" data-action="save-settings">Save</button></div>
    <div class="field" id="your-config"><label>Your config</label>
      <div class="hint">The packs you follow, the repos you added and the uploads you hid, as text. Copy it to move to another computer or share it; paste one to add what it lists. Pasting never removes anything.</div>
      <div class="inline"><button class="btn" data-action="config-copy">Copy</button><button class="btn" data-action="config-paste">Paste…</button></div></div>
    <div class="field"><label>Something wrong?</label>
      <div class="hint">Tell us on GitHub. The report opens with your app version filled in; a game's or port's page has the same link for that one.</div>
      <button class="btn" id="btn-report-issue" data-href="${esc(issueUrl({ version: state.appVersion }))}">Report an issue</button></div>
    <div class="field" id="about"><label>About</label>
      <div class="hint" id="app-version">y4bo ${esc(state.appVersion || '')}. Downloads games from the Internet Archive and installs releases from GitHub and GitLab.
        Built on Rohan Kar's launcher.</div>
      <div class="inline">${ABOUT_LINKS.map(([label, url]) => `<button class="btn" data-href="${esc(url)}">${esc(label)}</button>`).join('')}</div></div>
  </div>`;
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
const RELOADS = { wall: 'reload-wall', uploader: 'reload-wall', ports: 'refresh-ports' };
const HEADINGS = { wall: 'All uploads', library: 'Library', ports: 'Ports', settings: 'Settings' };

function render() {
  const v = state.view;
  pagedGrid.pending = {};
  pageHasSearch = false;
  pageControls = null;
  let html;
  if (state.query) html = viewSearch(state.query);
  else if (v.name === 'wall') html = viewWall(null);
  else if (v.name === 'uploader') html = viewWall(v.arg);
  else if (v.name === 'ports' || v.name === 'shelf') html = viewPorts();
  else if (v.name === 'library') html = viewLibrary();
  else if (v.name === 'settings') html = viewSettings();
  else if (DETAIL_VIEWS.has(v.name)) html = viewDetail(v);
  else html = viewLibrary();

  const heading = state.query ? 'Search'
    : v.name === 'shelf' ? 'Ports'
    : v.name === 'uploader' ? sourceName(state.sources.find(s => s.uploader === v.arg) || { uploader: v.arg })
    : HEADINGS[v.name] || 'Library';

  // Keep the settings form as typed while the wall is still streaming in
  if (v.name === 'settings' && !state.query && $('#setting-install')) {
    renderNav();
    return;
  }
  const body = $('#body');
  const typing = document.activeElement?.id === 'lib-search' ? document.activeElement.selectionStart : null;
  const reload = !state.query && RELOADS[v.name];
  const search = pageHasSearch ? `<input type="search" class="search-input" id="lib-search" spellcheck="false"
    placeholder="Search ${esc(heading)}" value="${esc(state.libSearch)}" aria-label="Search this page">` : '';
  // A library page's controls share the title row, as on Cider's songs page;
  // the details page has its own header (the album head)
  const lib = pageControls;
  const head = onDetailPage() ? '' : `<div class="page-head${lib ? ' album-header slim' : ''}"><h1 class="page-title" id="heading">${v.name === 'uploader' && !state.query
    ? `<a class="title-link" data-href="${esc(packUrl(v.arg))}" title="Open on archive.org">${esc(heading)}</a>` : esc(heading)}</h1><span class="grow"></span>
    ${lib ? `<div class="lib-controls">${lib.controls}</div>` : ''}
    ${reload ? `<button class="reload-btn" data-action="${reload}" aria-label="Reload" title="Reload"></button>` : ''}${search}${lib?.pagination || ''}</div>`;
  body.innerHTML = head + html;
  // A background redraw (the wall streaming in) keeps an open dropdown's trigger marked
  if (ddOpen) document.querySelector(`[data-dd="${CSS.escape(ddOpen)}"]`)?.setAttribute('aria-expanded', 'true');
  if (typing != null) { const el = $('#lib-search'); el?.focus(); el?.setSelectionRange(typing, typing); }
  observeCovers(body);
  syncRows();
  body.querySelectorAll('.sentinel').forEach(el => pageObserver.observe(el));
  if (v.name === 'settings' && !state.appVersion) {
    api.getAppVersion().then(ver => {
      state.appVersion = ver;
      const el = $('#app-version'); if (el) el.textContent = `y4bo ${ver}`;
      const btn = $('#btn-report-issue'); if (btn) btn.dataset.href = issueUrl({ version: ver });
    }).catch(() => {});
  }
  renderNav();
  renderNowbar();
  if (onDetailPage()) paintDetail();
}

// ─── details page (after Cider's album page) ─────────────────────────────────
// A game or a port is a page of its own ('game' / 'port' views): the cover
// at left over a wash of its colours, title, uploader, the meta line
// (details.js), the Play/Install pill, a second pill and ⋯, the description,
// then the versions (or what installs) as a track list and more from the same
// uploader or shelf. Back returns to the page it was opened from.

const DETAIL_VIEWS = new Set(['game', 'port']);
const onDetailPage = () => !state.query && DETAIL_VIEWS.has(state.view.name);
const fileSizes = new Map();   // identifier -> bytes an install downloads (null while asked)

function detailFor(kind, id) {
  if (kind === 'game') {
    const g = state.games.find(x => x.identifier === id) || state.versions.find(x => x.identifier === id)
      || (state.library[id] ? rowGame(state.library[id]) : null);
    return g ? { kind, id, game: g, version: installedVersion(g) || g, exes: null } : null;
  }
  const p = state.ports?.items.find(x => x.id === id);
  return p ? { kind, id, port: p, exes: null } : null;
}

// The page's state (the version picked, an executable list) lives while the
// page is showing; coming back to it through history builds it again
function ensureDetail(kind, id) {
  const d = state.detail;
  if (d && d.kind === kind && d.id === id) return d;
  state.detail = detailFor(kind, id);
  return state.detail;
}

function openDetail(kind, id) {
  const d = detailFor(kind, id);
  if (!d) return;
  if (onDetailPage() && state.view.name === kind && state.view.arg === id) { state.detail = d; return render(); }
  go(kind, id);
}

function closeDetail() {
  if (!DETAIL_VIEWS.has(state.view.name)) return;
  if (navHistory.canBack) goHistory(-1); else go('library');
}

function renderDetail() {
  if (onDetailPage()) render();
}

function viewDetail(v) {
  const d = ensureDetail(v.name, v.arg);
  if (d) return `<div class="album-page" id="detail">${d.kind === 'game' ? gameDetail(d) : portDetail(d)}</div>`;
  const loading = v.name === 'game' ? state.wall.loading : !state.ports;
  return loading ? section('', skeletons(6), { cls: 'row' }) : `<p class="empty">That isn't on the wall or a shelf any more.</p>`;
}

// After render: the cover and its wash, the install size, the description's More
function paintDetail() {
  const d = state.detail;
  const page = $('#detail');
  if (!d || !page) return;
  const cover = page.querySelector('[data-cover]');
  if (cover) {
    thumb(cover.dataset.cover).then(url => {
      if (!url || state.detail !== d || !cover.isConnected) return;
      cover.insertAdjacentHTML('afterbegin', `<img src="${esc(url)}" alt="">`);
      page.querySelector('.album-wash').style.backgroundImage = `url("${url}")`;
    });
  }
  const v = d.version;
  if (d.kind === 'game') paintReviews(d);
  if (d.kind === 'game' && !fileSizes.has(v.identifier)) {
    fileSizes.set(v.identifier, null);
    api.fetchFileList({ identifier: v.identifier }).then(r => {
      fileSizes.set(v.identifier, r.ok ? installBytes(r.installable || r.files) : 0);
      // Only the meta line changes: no re-render under an open menu
      const meta = state.detail === d && onDetailPage() && $('#detail .album-meta');
      if (meta) meta.innerHTML = metaHtml(gameMeta(v, { bytes: fileSizes.get(v.identifier) }));
    }).catch(() => fileSizes.set(v.identifier, 0));
  }
  const desc = page.querySelector('.album-desc');
  if (desc && !desc.classList.contains('open')) {
    const p = desc.querySelector('p');
    desc.classList.toggle('clamped', p.scrollHeight > p.clientHeight + 1);
  }
}

const pill = (label, attrs, { primary = false, icon = '' } = {}) =>
  `<button class="btn album-pill${primary ? ' primary' : ''}" ${attrs}>${icon ? `<i class="ico" data-ico="${icon}"></i>` : ''}${esc(label)}</button>`;
const moreBtn = (attrs) => `<button class="album-more" ${attrs} aria-label="More" title="More"><i class="ico" data-ico="more"></i></button>`;

const metaHtml = (meta) => meta.map(esc).join('<span class="sep">·</span>');

function albumHead({ kind, title, cover, wash, sub, meta = [], actions, extra = '', desc = '' }) {
  return `<div class="album-wash-clip" aria-hidden="true"><div class="album-wash" style="${wash}"></div></div>
    <header class="album-head">
      ${cover}
      <div class="album-info">
        <div class="album-kind">${esc(kind)}</div>
        <h1 class="album-title">${esc(title)}</h1>
        ${sub}
        <div class="album-meta">${metaHtml(meta)}</div>
        <div class="album-actions">${actions}</div>
        ${extra}
        ${desc ? `<div class="album-desc"><p>${esc(desc)}</p><button class="album-desc-more" data-action="desc-more">More</button></div>` : ''}
      </div>
    </header>`;
}

// Everything the drawer listed, in small type at the foot of the page
const albumFoot = (rows) => `<dl class="kv album-foot">${rows.filter(Boolean).join('')}</dl>`;

const EXE_HEADINGS = { steam: 'Pick the executable for Steam', default: 'Pick the executable to launch by default', play: 'Pick the executable' };
function exePicker(d) {
  if (!d.exes) return '';
  return `<div class="h3">${EXE_HEADINGS[d.exes.purpose]}</div>
    <div class="versions">${d.exes.list.map(p => `<button class="version" data-exe="${esc(p)}"><span class="who">${esc(p.split(/[\\/]/).pop())}</span><span class="meta">${esc(p)}</span></button>`).join('')}</div>`;
}

// The versions of a title as a track list
function versionsTable(d) {
  const rows = versionRows(d.game._versions || [d.game], { selected: d.version.identifier, library: state.library });
  return `<section class="section album-tracks"><div class="tracklist" role="list">
    <div class="track-head"><span class="num">#</span><span>Version</span><span>Added</span><span class="num">Downloads</span><span></span></div>
    ${rows.map(r => `<button class="track ${r.on ? 'on' : ''}" data-version="${esc(r.identifier)}" role="listitem">
      <span class="num tn">${r.on ? '<i class="ico" data-ico="check"></i>' : r.n}</span>
      <span class="tt"><b>${esc(r.uploader)}</b><small>${esc(r.identifier)}</small></span>
      <span class="tc">${esc(r.date)}</span>
      <span class="tc num">${fmtNum(r.downloads)}</span>
      <span class="tflags">${r.installed ? '<span class="tag installed">INSTALLED</span>' : ''}${r.newer ? '<span class="tag installed update">NEWER</span>' : ''}</span>
    </button>`).join('')}
  </div><div class="track-sum">${rows.length === 1 ? '1 version' : `${rows.length} versions`}${d.version.addeddate ? ` · Latest ${esc(rows[0].date)}` : ''}</div></section>`;
}

function gameDetail(d) {
  const g = d.game, v = d.version;
  const title = getTitle(v);
  const lib = state.library[v.identifier];
  const dl = state.downloads.get(v.identifier);
  const versions = g._versions || [g];
  const newerOf = lib?.install_dir && v._newer ? versions.find(x => x.identifier === v._newer) || null : null;
  let actions;
  if (dl) {
    actions = pill(dl.status === 'extracting' ? 'Extracting…' : `Downloading… ${dl.percent || 0}%`, 'disabled', { primary: true })
      + (dl.status === 'downloading' ? pill('Cancel', 'data-action="cancel"') : '');
  } else if (lib?.install_dir) {
    actions = pill('Play', 'id="btn-play" data-action="play"', { primary: true, icon: 'play' }) + pill('Open folder', 'data-action="open-folder"')
      + pill('Readme', 'data-action="readme"');
  } else {
    actions = pill('Install', 'id="btn-download" data-action="install"', { primary: true, icon: 'download' })
      + pill('archive.org', `data-href="https://archive.org/details/${esc(v.identifier)}"`);
  }
  actions += moreBtn('data-detail-menu');
  const desc = stripHtml(Array.isArray(v.description) ? v.description.join('\n') : v.description);
  const more = moreFrom(state.games, v._uploader, { except: g });
  const badges = featureBadges(v).map(b => `<span class="state-badge feature" data-badge="${b.id}">${esc(b.label)}</span>`).join('');
  return albumHead({
    kind: versions.length > 1 ? `Game · ${versions.length} versions` : 'Game',
    title,
    cover: `<div class="album-cover" data-cover="${esc(v.identifier)}" style="background:${tint(title)}"></div>`,
    wash: `background:${tint(title)}`,
    sub: v._uploader
      ? `<button class="album-sub by" data-view="uploader" data-arg="${esc(v._uploader)}">${esc(v._sourceLabel || v._uploader)}</button>`
      : `<div class="album-sub by">archive.org</div>`,
    meta: gameMeta(v, { bytes: fileSizes.get(v.identifier) || 0 }),
    actions,
    extra: `${badges ? `<div class="badges">${badges}</div>` : ''}${dl ? `<div class="progress"><i style="width:${dl.percent || 0}%"></i></div><div class="progress-label">${dl.percent || 0}%</div>` : ''}
      ${exePicker(d)}
      ${newerOf ? `<div class="newer-note">A newer upload of this game is on archive.org (${esc(fmtDate(newerOf.addeddate))}).
        <button class="btn" data-version="${esc(newerOf.identifier)}">See it</button></div>` : ''}`,
    desc,
  }) + versionsTable(d) + '<section class="section album-reviews" id="reviews" hidden></section>' + albumFoot([
    `<dt>Uploader</dt><dd>${esc(v._uploader || '')}</dd>`,
    `<dt>Item</dt><dd><a data-href="https://archive.org/details/${esc(v.identifier)}">${esc(v.identifier)}</a></dd>`,
    `<dt>Problem?</dt><dd><a data-href="${esc(issueUrl({ version: state.appVersion, item: { kind: 'game', title: getTitle(v), id: v.identifier, source: v._uploader } }))}">Report an issue</a></dd>`,
    `<dt>Downloads</dt><dd>${fmtNum(v.downloads)}</dd>`,
    v.addeddate ? `<dt>Added</dt><dd>${esc(fmtDate(v.addeddate))}</dd>` : '',
    lib?.install_dir ? `<dt>Installed to</dt><dd>${esc(lib.install_dir)}</dd>` : '',
    ...playRows(lib),
  ]) + (more.length ? section(`More from ${v._sourceLabel || v._uploader}`, more.map(gameCard).join(''), { cls: 'row', seeAll: ['uploader', v._uploader] }) : '');
}

// Playtime and last played, from the library row (the Playnite export sends them too)
const playRows = (lib) => [
  lib?.playtime_secs ? `<dt>Played</dt><dd>${esc(formatPlaytime(lib.playtime_secs))}</dd>` : '',
  lib?.last_played_at ? `<dt>Last played</dt><dd>${esc(fmtDate(lib.last_played_at))}</dd>` : '',
];

// archive.org reviews of the version showing, under its track list
const reviewsCache = new Map();
async function paintReviews(d) {
  const id = d.version.identifier;
  if (!reviewsCache.has(id)) reviewsCache.set(id, api.fetchReviews({ identifier: id }).catch(() => []));
  const reviews = await reviewsCache.get(id);
  const el = state.detail === d && $('#reviews');
  if (!el || !reviews?.length) return;
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  el.innerHTML = `<div class="h3">Reviews on archive.org</div>${reviews.map(r => `<div class="review">
    <div class="review-head"><b>${esc(r.reviewer || 'Anonymous')}</b><span class="stars">${stars(Math.max(0, Math.min(5, Number(r.stars) || 0)))}</span>
    <span class="hint">${esc(fmtDate(r.reviewdate))}</span></div>
    ${r.reviewtitle ? `<div class="review-title">${esc(r.reviewtitle)}</div>` : ''}<p>${esc(stripHtml(r.reviewbody || ''))}</p></div>`).join('')}`;
  el.hidden = false;
}

// The README in the install folder, if the game or port shipped one
async function showReadme(identifier, name) {
  const r = await api.readReadme({ identifier }).catch(() => null);
  if (!r?.text) return toast(`${name} has no readme in its install folder.`);
  return modal({ title: r.fileName || 'Readme', body: `<pre class="readme">${esc(r.text)}</pre>`, html: true, primary: 'Close', secondary: null });
}

// Install, progress and the installed actions for a port (library row keyed by its catalog id)
const PORT_STEPS = { binary: 'the release build' };
function portActions(p) {
  const dl = state.downloads.get(p.id);
  if (dl) {
    const what = dl.status === 'verifying' ? 'Checking game data…' : dl.status === 'extracting' ? 'Unpacking…' : 'Downloading…';
    return pill(what, 'disabled', { primary: true }) + (dl.status === 'downloading' ? pill('Cancel', 'data-action="cancel"') : '');
  }
  if (state.library[p.id]?.install_dir) {
    return pill('Play', 'id="btn-play" data-action="play"', { primary: true, icon: 'play' }) + pill('Open folder', 'data-action="open-folder"');
  }
  if (p.sourceOnly) {
    return `<span class="source-only-note">Source only, no download</span>` + pill('Open repository', `data-href="${esc(p.repositoryUrl)}"`, { primary: true });
  }
  return pill('Install', 'id="btn-install-port" data-action="install"', { primary: true, icon: 'download' });
}
function portProgress(p) {
  const dl = state.downloads.get(p.id);
  if (!dl) return state.library[p.id]?.install_dir ? `<div class="srcline"><b>Installed to</b> ${esc(state.library[p.id].install_dir)}</div>` : '';
  return `<div class="progress"><i style="width:${dl.percent || 0}%"></i></div>
    <div class="progress-label">${esc(PORT_STEPS[dl.step] || '')} · ${dl.percent || 0}%</div>`;
}

// What a port's install brings down, as a track list: the release binary, and only that
function portTracks(p) {
  const rows = p.sourceOnly
    ? [['No download', 'The project publishes its source only', '']]
    : [['Windows build', `${p.host} release from ${p.repository}`, p.releaseAssetFilter ? `matches ${p.releaseAssetFilter}` : 'latest release']];
  return `<section class="section album-tracks"><div class="tracklist ports-tracks" role="list">
    <div class="track-head"><span class="num">#</span><span>What installs</span><span>From</span><span></span></div>
    ${rows.map(([name, from, note, cls = ''], i) => `<div class="track" role="listitem"><span class="num tn">${i + 1}</span>
      <span class="tt"><b>${esc(name)}</b></span><span class="tc ${cls}">${esc(from)}</span><span class="tc">${esc(note)}</span></div>`).join('')}
  </div></section>`;
}

function portDetail(d) {
  const p = d.port;
  const update = state.library[p.id]?.install_dir && portUpdate(p);
  const icon = p.iconUrl ? `<img src="${esc(p.iconUrl)}" alt="">` : `<div class="noart">${esc(p.name)}</div>`;
  const more = morePorts(state.ports?.items, p);
  return albumHead({
    kind: `Port · Source: ${p.sourceLabel}`,
    title: p.name,
    cover: `<div class="album-cover square" style="background:${tint(p.repository)}">${icon}</div>`,
    wash: `background:${tint(p.repository)}${p.iconUrl ? `;background-image:url('${esc(p.iconUrl)}')` : ''}`,
    sub: `<button class="album-sub by" data-href="${esc(p.repositoryUrl)}">${esc(p.project || p.repository)}</button>`,
    meta: portMeta(p),
    actions: portActions(p) + (update && !state.downloads.get(p.id) ? pill(`Update to ${update.latest}`, 'id="btn-update-port" data-action="install"', { icon: 'updates' }) : '') + moreBtn('data-detail-menu'),
    extra: `${portBadges(p) ? `<div class="badges">${portBadges(p)}</div>` : ''}${p.description ? `<p class="port-desc">${esc(p.description)}</p>` : ''}
      ${portProgress(p)}${exePicker(d)}`,
  }) + portTracks(p) + albumFoot([
    `<dt>Repository</dt><dd><a data-href="${esc(p.repositoryUrl)}">${esc(p.repository)}</a></dd>`,
    `<dt>Problem?</dt><dd><a data-href="${esc(issueUrl({ version: state.appVersion, item: { kind: 'port', title: p.name, id: p.id, source: p.repository } }))}">Report an issue</a></dd>`,
    `<dt>Folder</dt><dd>${esc(p.folderName || p.repository.replace('/', '.'))}</dd>`,
    p.releaseAssetFilter ? `<dt>Asset filter</dt><dd><code>${esc(p.releaseAssetFilter)}</code></dd>` : '',
    p.filesToAdd.length ? `<dt>Files to add</dt><dd>${esc(p.filesToAdd.join(', '))}</dd>` : '',
    p.tags.length ? `<dt>Tags</dt><dd>${esc(p.tags.join(', '))}</dd>` : '',
    state.library[p.id]?.version ? `<dt>Release</dt><dd>${esc(state.library[p.id].version)}</dd>` : '',
    `<dt>Catalog</dt><dd>${esc(p.catalogUrl || 'Your repos')}</dd>`,
    ...playRows(state.library[portTarget(p).identifier]),
  ]) + (more.length ? section('More ports', more.map(portCard).join(''), { cls: 'row ports', seeAll: ['ports'] }) : '');
}

// ⋯ and right-click on the details page: the item's row menu (ROW_ACTIONS),
// for the version picked on a game's page. Properties is left out there.
function detailMenuItem(d) {
  if (d.kind === 'port') return d.port;
  // Only the version showing: Play, Install and Delete act on it, as its pills do
  return { ...d.version, _versions: undefined };
}
function openDetailMenu(x, y, opts = {}) {
  const d = state.detail;
  if (!d || !onDetailPage()) return;
  openMenu(d.kind, detailMenuItem(d), x, y, { ...opts, onDetail: true });
}

// ─── actions ─────────────────────────────────────────────────────────────────

// A file from the user's own source changed since its first install: ask,
// and install again accepting it only on the primary button
function confirmHashChange(job, name) {
  const c = job.hashChange;
  return modal({
    title: 'File changed',
    body: `${c.file} from ${name} is not the file you installed before (sha1 ${c.before.slice(0, 12)}… is now ${c.after.slice(0, 12)}…). `
      + 'It may be an update, or someone may have replaced it. Only continue if you trust the source.',
    primary: 'Install anyway',
  });
}

async function installGame(v, { acceptHashChange = false } = {}) {
  const identifier = v.identifier;
  if (state.downloads.has(identifier)) return;
  const list = await api.fetchFileList({ identifier });
  if (!list.ok || !list.files?.length) return toast(`Couldn't read the file list: ${list.error || 'no files'}`);
  // What core says installs: archives (extracted), else an exe, else the
  // uploader's own files, downloaded as they are
  const installable = list.installable || [];
  if (!installable.length) return toast('This upload has no files of its own to download.');
  const plain = !installable.some(f => /\.(zip|7z|rar|exe)$/i.test(f.name));
  // Largest archive is the game; plain files all download
  const picks = plain ? installable : [installable.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0]];

  const dl = { percent: 0, status: 'downloading', jobId: null, name: getTitle(v), open: ['game', v.identifier] };
  state.downloads.set(identifier, dl);
  render();
  let job;
  for (const file of picks) {
    job = await api.install({
      identifier,
      fileName:     file.name,
      acceptHashChange,
      onStart:      (j) => { dl.jobId = j.id; },
      onProgress:   (percent) => showProgress(identifier, percent),
      onExtracting: () => { dl.status = 'extracting'; dl.percent = 100; render(); },
    });
    if (job.status !== 'done') break;
  }
  state.downloads.delete(identifier);
  await reloadLibrary();
  render();
  if (job.hashChange) return (await confirmHashChange(job, getTitle(v))) && installGame(v, { acceptHashChange: true });
  if (job.status === 'done') toast(plain ? `${getTitle(v)} is downloaded. Open its folder to use the files.` : `${getTitle(v)} is installed.`);
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
  else if (/^No Windows build|has no published release/.test(job.error || '')) {
    toast(`${p.name} has no Windows build to install. Its tile stays on Your ports; right-click opens its page.`, 8000);
  } else if (job.status !== 'cancelled') toast(`Install failed: ${job.error || 'unknown error'}`, 8000);
}

async function playGame(v) {
  const lib = state.library[v.identifier];
  if (lib?.exe_path) return launch(v, lib.exe_path);
  const exes = await api.findExes({ identifier: v.identifier });
  if (!exes.length) return toast('No executable found. Try reinstalling.');
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

// ─── Add: paste a link into the sidebar box (docs/AGENT-BRIEF.md, "The user loop")
// An archive.org account becomes a pack; one upload asks whether to get just it
// or follow its uploader; a GitHub or GitLab repo joins Ports and installs.

// A modal with several answers. Resolves the index of the button pressed, or
// -1 for Escape and the backdrop. buttons[0] is the safe one and has focus.
function choose({ title, body, buttons, input = null }) {
  document.getElementById('modal')?.remove();
  const el = document.createElement('div');
  el.id = 'modal';
  el.className = 'modal-fullscreen';
  el.innerHTML = `<div class="modal-window" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-body">
    <div class="modal-header"><div class="modal-title" id="modal-title">${esc(title)}</div></div>
    <div class="modal-content" id="modal-body">${esc(body)}${input ? `<input type="text" id="modal-input" class="modal-input" placeholder="${esc(input.placeholder || '')}" spellcheck="false" autocomplete="off">` : ''}</div>
    <div class="modal-footer">${buttons.map((b, i) => `<button class="md-btn${i === buttons.length - 1 ? ' md-btn-primary' : ''}" data-modal="${i}">${esc(b)}</button>`).join('')}</div>
  </div>`;
  const back = document.activeElement;
  document.body.appendChild(el);
  (el.querySelector('#modal-input') || el.querySelector('[data-modal="0"]')).focus();
  return new Promise(resolve => {
    const done = (i) => {
      const value = el.querySelector('#modal-input')?.value || '';
      el.remove(); document.removeEventListener('keydown', key, true); back?.focus?.();
      resolve(input ? { index: i, value } : i);
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(-1); }
      if (e.key === 'Enter' && e.target.id === 'modal-input') { e.preventDefault(); done(buttons.length - 1); }
      if (e.key === 'Tab') {
        const f = [...el.querySelectorAll('input, button')];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    };
    document.addEventListener('keydown', key, true);
    el.addEventListener('click', (e) => {
      if (e.target === el) return done(-1);
      const b = e.target.closest('[data-modal]');
      if (b) done(Number(b.dataset.modal));
    });
  });
}

async function addLink(link) {
  const r = await api.resolveLink(link);
  if (!r.ok) return toast(r.error, 6000);
  if (r.kind === 'repo') return addRepo(r);
  if (r.kind === 'account') return addSource({ uploader: r.uploader });
  // One upload: just it, or everything its uploader has put up?
  const pick = r.uploader
    ? await choose({ title: r.title, body: 'Get just this game, or follow everything its uploader puts up as a pack?', buttons: ['Cancel', 'Get this game', 'Follow the uploader'] })
    : 1;
  if (pick === 1) return addSource({ uploader: `https://archive.org/details/${r.identifier}`, label: r.title, open: r.identifier });
  if (pick === 2) return addSource({ uploader: r.uploader });
}

const sameUploader = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isUploadSource = (s) => /archive\.org\/(?:details|download)\/(?!@)/i.test(s.uploader);
const sourceLabel = (u) => (/@([^/?#\s]+)/.exec(u)?.[1] || u).split('@')[0];
// A pack's page on archive.org: the account, the upload, or the uploader search
function packUrl(u) {
  const x = String(u || '').trim();
  if (/^https?:\/\//i.test(x)) return x;
  if (x.startsWith('@')) return `https://archive.org/details/${x}`;
  if (x.includes('@')) return `https://archive.org/search?query=${encodeURIComponent(`uploader:"${x}"`)}`;
  return `https://archive.org/details/@${x}`;
}

async function addSource({ uploader, label, open = null }) {
  const have = state.sources.find(s => sameUploader(s.uploader, uploader));
  if (have && have.enabled !== false) {
    if (open) return openDetail('game', open);
    return toast(`${sourceName(have)} is already in your packs.`);
  }
  const sources = have
    ? state.sources.map(s => (s === have ? { ...s, enabled: true } : s))
    : [...state.sources, { uploader, label: label || sourceLabel(uploader), enabled: true }];
  const r = await api.saveSettings({ sources });
  if (r && r.ok === false) return toast(r.body?.detail || "Couldn't add it.", 6000);
  state.sources = sources;
  toast(open ? `Added ${label}.` : `Following ${label || sourceLabel(uploader)}. Its uploads are loading.`);
  render();
  await loadWall({ refresh: true });
  if (open) { openDetail('game', open); const g = detailFor('game', open); if (g && !isInstalled(g.game)) installGame(g.version); }
}

async function removeSource(uploader) {
  const sources = state.sources.filter(s => !sameUploader(s.uploader, uploader));
  const r = await api.saveSettings({ sources });
  if (r && r.ok === false) return toast(r.body?.detail || "Couldn't remove it.", 6000);
  state.sources = sources;
  render();
  loadWall({ refresh: true });
}

// A repo joins Ports and its latest release installs straight away. When the
// release has several Windows files (or none that look like one), the user
// picks which; the pick is kept as the repo's assetPattern, so updates take
// the same file.
async function addRepo({ repository, repositorySource }) {
  const entry = repositorySource === 'gitlab' ? { repositorySource } : {};
  const rel = await api.getRepoRelease(repository, repositorySource);
  if (rel.ok && rel.choose && rel.files.length) {
    const pick = await pickReleaseFile(repository, rel);
    if (!pick) return;
    entry.assetPattern = pick.pattern;
  }
  const r = await api.saveRepo(repository, entry);
  if (!r.ok) return toast(`Couldn't add it: ${r.error}`, 6000);
  state.myRepos = null;
  await loadPorts();
  const p = (state.ports?.items || []).find(i => String(i.repository).toLowerCase() === repository.toLowerCase());
  if (!p) return toast(`Added ${repository}.`);
  openDetail('port', p.id);
  if (state.library[p.id]?.install_dir) return toast(`${p.name} is already installed.`);
  return installPort(p);
}

// The release's files as a list to pick from, the automatic pick first and focused
function pickReleaseFile(repository, rel) {
  const files = rel.files.slice().sort((a, b) => (b.name === rel.auto) - (a.name === rel.auto));
  return new Promise(resolve => {
    document.getElementById('modal')?.remove();
    const el = document.createElement('div');
    el.id = 'modal';
    el.className = 'modal-fullscreen';
    el.innerHTML = `<div class="modal-window" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-header"><div class="modal-title" id="modal-title">Which file from ${esc(repository)}${rel.tag ? ` ${esc(rel.tag)}` : ''}?</div></div>
      <div class="modal-content"><div class="file-pick" role="radiogroup" aria-label="Release file">
        ${files.map((f, i) => `<label class="file-opt"><input type="radio" name="release-file" value="${i}"${i === 0 ? ' checked' : ''}>
          <span class="grow">${esc(f.name)}</span>${f.windows ? '<span class="hint">Windows</span>' : ''}</label>`).join('')}
      </div><div class="hint">Updates download the same file from each new release.</div></div>
      <div class="modal-footer"><button class="md-btn" data-modal="0">Cancel</button><button class="md-btn md-btn-primary" data-modal="1">Install</button></div>
    </div>`;
    document.body.appendChild(el);
    el.querySelector('input:checked')?.focus();
    const done = (ok) => {
      const i = Number(el.querySelector('input:checked')?.value);
      el.remove(); document.removeEventListener('keydown', key, true);
      resolve(ok && files[i] ? files[i] : null);
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    document.addEventListener('keydown', key, true);
    el.addEventListener('click', (e) => {
      if (e.target === el) return done(false);
      const b = e.target.closest('[data-modal]');
      if (b) done(b.dataset.modal === '1');
    });
  });
}

async function removeRepo(repo) {
  await api.removeRepo(repo);
  state.myRepos = null;
  render();
  loadPorts();
}

// Hide from Wall: the uploads leave the wall, Home and search (installed ones stay)
async function hideUploads(ids, name) {
  const excludeItems = [...new Set([...(state.settings.excludeItems || []), ...ids])];
  const r = await api.saveSettings({ excludeItems });
  if (r && r.ok === false) return toast(r.body?.detail || "Couldn't hide it.", 6000);
  state.settings = { ...state.settings, excludeItems };
  toast(`Hid ${name}. "Show hidden" on its pack brings it back.`);
  loadWall();
}

async function unhideAll() {
  const r = await api.saveSettings({ excludeItems: [] });
  if (r && r.ok === false) return toast(r.body?.detail || "Couldn't save.", 6000);
  state.settings = { ...state.settings, excludeItems: [] };
  render();
  loadWall();
}

// A link pasted anywhere but a text field adds it, as the sidebar box does
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]') || $('#modal')) return;
  const text = e.clipboardData?.getData('text')?.trim();
  if (text && LINK_RE.test(text)) { e.preventDefault(); addLink(text); }
});

// ─── Your config (Settings): copy it out, paste one in ───────────────────────

async function copyConfig() {
  const c = await api.getConfig();
  if (!c) return toast("Couldn't read your config.");
  const text = JSON.stringify(c, null, 2);
  try { await navigator.clipboard.writeText(text); toast('Config copied.'); }
  catch { modal({ title: 'Your config', body: `<pre class="readme">${esc(text)}</pre>`, html: true, primary: 'Close', secondary: null }); }
}

async function pasteConfig() {
  const { index, value } = await choose({
    title: 'Paste a config',
    body: 'Paste the text from Copy. What it lists is added; nothing you have is removed.',
    buttons: ['Cancel', 'Add'],
    input: { placeholder: '{ "y4bo": 1, … }' },
  });
  if (index !== 1 || !value.trim()) return;
  const r = await api.pasteConfig(value);
  if (!r.ok) return toast(r.error, 6000);
  const a = r.added;
  toast(`Added ${a.packs} pack${a.packs === 1 ? '' : 's'}, ${a.repos} repo${a.repos === 1 ? '' : 's'}, ${a.hidden} hidden upload${a.hidden === 1 ? '' : 's'}.${r.errors.length ? ` Skipped: ${r.errors.join('; ')}` : ''}`, 8000);
  state.settings = await api.getSettings().catch(() => state.settings);
  ({ sources: state.sources } = await api.getSources());
  state.myRepos = null;
  render();
  loadPorts();
  loadWall({ refresh: true });
}

// ─── row actions: the ⋯ button and the right-click menu ─────────────────────
// Every row menu reads this one list (ListView.createActions). An action is
// { id, label, icon, group, kinds, when(item, ctx), run(item, ctx) }; the
// menu draws one section per group, in ListView.MENU_GROUPS order (pin,
// collection, play, manage, goto, remove). More actions are added with
// rowActions.register(...) and need no change to the rows or the menu.

const rowActions = ListView.createActions();
const itemDl = (x, ctx) => state.downloads.get(ctx.kind === 'port' ? x.id : x.identifier);
const itemInstalled = (x, ctx) => (ctx.kind === 'port' ? !!state.library[x.id]?.install_dir : isInstalled(x));
const gameTarget = (g) => installedVersion(g) || g;
const targetOf = (x, ctx) => (ctx.kind === 'port' ? portTarget(x) : gameTarget(x));
const idle = (x, ctx) => !itemDl(x, ctx);
const linkOf = (x, ctx) => (ctx.kind === 'port' ? x.repositoryUrl : `https://archive.org/details/${gameTarget(x).identifier}`);

const ROW_ACTIONS = [
  // play: get it, run it, find it on disk
  { id: 'play', label: 'Play', icon: 'play', group: 'play', kinds: ['game'],
    when: (g, ctx) => itemInstalled(g, ctx) && idle(g, ctx), run: (g) => playGame(gameTarget(g)) },
  { id: 'launch', label: 'Launch', icon: 'play', group: 'play', kinds: ['port'],
    when: (p, ctx) => itemInstalled(p, ctx) && idle(p, ctx), run: (p) => launchPort(p) },
  { id: 'install', label: (x, ctx) => (ctx.kind === 'port' ? 'Download' : 'Install'), icon: 'download', group: 'play',
    when: (x, ctx) => !itemInstalled(x, ctx) && idle(x, ctx) && !x.sourceOnly,
    run: (x, ctx) => (ctx.kind === 'port' ? installPort(x) : installGame(x)) },
  { id: 'update', label: (p) => `Update to ${portUpdate(p)?.latest}`, icon: 'updates', group: 'play', kinds: ['port'],
    when: (p, ctx) => itemInstalled(p, ctx) && idle(p, ctx) && !!portUpdate(p), run: (p) => installPort(p) },
  { id: 'cancel', label: 'Cancel Download', icon: 'close', group: 'play', when: (x, ctx) => !!itemDl(x, ctx),
    run: async (x, ctx) => { const dl = itemDl(x, ctx); if (dl?.jobId) await api.cancelInstall({ jobId: dl.jobId }); } },
  { id: 'locate', label: 'Locate Existing Install…', icon: 'folder', group: 'play', kinds: ['port'],
    when: (p, ctx) => !itemInstalled(p, ctx) && idle(p, ctx) && !p.sourceOnly, run: (p) => locateInstall(p) },
  { id: 'open-folder', label: 'Open Folder', icon: 'folder', group: 'play',
    when: (x, ctx) => itemInstalled(x, ctx) && idle(x, ctx), run: (x, ctx) => api.openGameLocation({ identifier: targetOf(x, ctx).identifier }) },
  { id: 'readme', label: 'Readme', icon: 'info', group: 'play',
    when: (x, ctx) => itemInstalled(x, ctx) && idle(x, ctx),
    run: (x, ctx) => showReadme(targetOf(x, ctx).identifier, ctx.kind === 'port' ? x.name : getTitle(x)) },
  { id: 'launch-options', label: 'Launch Options', icon: 'settings', group: 'play', kinds: ['port'],
    when: (p, ctx) => itemInstalled(p, ctx) && idle(p, ctx), children: [
      { id: 'choose-exe', label: 'Choose Executable…', icon: 'play', run: (p) => pickExe(p, 'default') },
      { id: 'steam', label: 'Add to Steam…', icon: 'plus', run: (p) => pickExe(p, 'steam') },
    ] },
  { id: 'game-steam', label: 'Add to Steam…', icon: 'plus', group: 'play', kinds: ['game'],
    when: (g, ctx) => itemInstalled(g, ctx) && idle(g, ctx), run: (g, ctx) => { if (!ctx.onDetail) openDetail('game', g.identifier); return onAction('steam'); } },

  // manage: favourite, library, properties
  { id: 'favorite', label: (g, ctx) => (ListView.isFavorite(g, ctx) ? 'Unfavorite' : 'Favorite'), icon: 'star', group: 'manage', kinds: ['game'],
    run: async (g, ctx) => {
      const on = ListView.isFavorite(g, ctx);
      const ids = on ? (g._versions || [g]).filter(v => state.library[v.identifier]?.is_favorite).map(v => v.identifier) : [gameTarget(g).identifier];
      for (const identifier of ids) await api.setFavorite({ identifier, isFavorite: !on });
      await reloadLibrary();
      render();
    } },
  // Opens the details page; not offered on that page
  { id: 'details', label: 'Properties', icon: 'info', group: 'manage', when: (x, ctx) => !ctx.onDetail,
    run: (x, ctx) => openDetail(ctx.kind, ctx.kind === 'port' ? x.id : x.identifier) },

  // goto: where it comes from, and a link to it
  { id: 'uploader', label: 'Go to Uploader', icon: 'person', group: 'goto', kinds: ['game'],
    when: (g) => state.sources.some(s => s.uploader === g._uploader && s.enabled !== false), run: (g) => go('uploader', g._uploader) },
  { id: 'shelf', label: 'Go to Ports', icon: 'wall', group: 'goto', kinds: ['port'], run: () => go('ports') },
  { id: 'repo', label: 'Go to Source Repo', icon: 'code', group: 'goto', kinds: ['port'],
    run: (p) => api.openExternal(p.repositoryUrl) },
  { id: 'archive', label: 'View on archive.org', icon: 'globe', group: 'goto', kinds: ['game'],
    run: (g) => api.openExternal(`https://archive.org/details/${gameTarget(g).identifier}`) },
  { id: 'share', label: 'Copy Link', icon: 'share', group: 'goto', when: (x, ctx) => linkOf(x, ctx),
    run: async (x, ctx) => {
      try { await navigator.clipboard.writeText(linkOf(x, ctx)); toast('Link copied.'); } catch { toast(linkOf(x, ctx), 8000); }
    } },

  // remove: files off the disk, or the entry out of the library
  { id: 'delete', label: 'Delete', icon: 'trash', group: 'remove', danger: true,
    when: (x, ctx) => itemInstalled(x, ctx) && idle(x, ctx),
    run: async (x, ctx) => {
      const name = ctx.kind === 'port' ? x.name : getTitle(x);
      if (!confirm(`Delete ${name}? Its install folder goes to the Recycle Bin.`)) return;
      const r = await api.deleteGame({ identifier: targetOf(x, ctx).identifier, trash: true });
      if (!r.ok) return toast(`Couldn't delete: ${r.error}`);
      toast(`Deleted ${name}.`);
      await reloadLibrary();
      render();
    } },
  { id: 'remove-repo', label: 'Remove Repo', icon: 'close', group: 'remove', kinds: ['port'],
    when: (p) => p.shelf === 'local',
    run: async (p) => { await removeRepo(p.repository); toast(`Removed ${p.name} from Ports. Installed files stay where they are.`); } },
  { id: 'hide', label: 'Hide from Pack', icon: 'close', group: 'remove', kinds: ['game'],
    when: (g, ctx) => !itemInstalled(g, ctx) && idle(g, ctx),
    run: (g) => hideUploads((g._versions || [g]).map(v => v.identifier), getTitle(g)) },
];
ROW_ACTIONS.forEach(rowActions.register);

// A pack's right-click menu in the sidebar
const packActions = ListView.createActions();
[
  { id: 'pack-open', label: 'Open on archive.org', icon: 'globe', group: 'goto', run: (s) => api.openExternal(packUrl(s.uploader)) },
  { id: 'pack-remove', label: 'Remove Pack', icon: 'close', group: 'remove', danger: true,
    run: async (s) => { await removeSource(s.uploader); toast(`Removed ${sourceName(s)}. Installed games stay installed.`); } },
].forEach(packActions.register);

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

let menuTarget = null;   // { kind, item, ctx }
function openMenu(kind, item, x, y, { alignRight = false, onDetail = false } = {}) {
  closeDropdown();
  const ctx = { ...listCtx(kind), onDetail };
  const actions = kind === 'pack' ? packActions : rowActions;
  menuTarget = { kind, item, ctx, actions };
  let el = $('#ctxmenu');
  if (!el) { el = document.createElement('div'); el.id = 'ctxmenu'; el.className = 'ctxmenu'; el.setAttribute('role', 'menu'); document.body.append(el); }
  el.innerHTML = menuHtml(actions.sections(item, ctx));
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
  const action = target?.actions.get(btn.dataset.menu);
  closeMenu();
  if (!target || !action?.run) return;
  return action.run(target.item, target.ctx);
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

// Right-click on any game or port (card, list row, New's list) opens its row
// menu; on the details page's head, the menu its ⋯ opens
document.addEventListener('contextmenu', (e) => {
  const navPack = e.target.closest('#nav-uploaders .navitem');
  const pack = navPack && state.sources.find(s => s.uploader === navPack.dataset.arg);
  if (pack) {
    e.preventDefault();
    const r = navPack.getBoundingClientRect();
    return openMenu('pack', pack, e.clientX || r.left + 24, e.clientY || r.bottom);
  }
  const card = e.target.closest('#body [data-open]');
  const item = card && menuItem(card.dataset.open, card.dataset.id);
  const head = !item && e.target.closest('#detail .album-head');
  if (head && state.detail) {
    e.preventDefault();
    const r = head.getBoundingClientRect();
    return openDetailMenu(e.clientX || r.left + 24, e.clientY || r.top + 24);
  }
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
// A scroll the user starts closes open menus; one the app makes (restoring a
// page's scroll, a row settling) doesn't, or a menu could vanish as it opens
const userScroll = (e) => { if (!e.target.closest?.('#ddmenu, #ctxmenu')) closeMenus(); };
document.addEventListener('wheel', userScroll, { capture: true, passive: true });
document.addEventListener('touchmove', userScroll, { capture: true, passive: true });

async function saveSettingsForm() {
  const patch = {
    installPath: $('#setting-install').value.trim(),
    githubToken: $('#setting-github-token').value.trim() || null,
  };
  const saved = await api.saveSettings(patch);
  if (saved && saved.ok === false) return toast(saved.body?.detail || 'Settings not saved.');
  state.settings = { ...state.settings, ...patch };
  toast('Settings saved.');
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
    case 'save-settings': return saveSettingsForm();
    case 'desc-more': return el.closest('.album-desc')?.classList.add('open');
    case 'unhide-all': return unhideAll();
    case 'config-copy': return copyConfig();
    case 'config-paste': return pasteConfig();
    case 'news-go': return newsGo(el.dataset.key);
    case 'news-dismiss': return newsDismiss([el.dataset.key]);
    case 'news-clear': return newsDismiss(newsItems().map(n => n.key), { seenNow: true });
    case 'choose-install': { const p = await api.chooseFolder(); if (p) $('#setting-install').value = p; return; }
    case 'scan-install': {
      const r = await api.scanInstalls($('#setting-install').value.trim() || undefined);
      toast(r.found ? (r.found.length ? `Found ${r.found.length} install${r.found.length === 1 ? '' : 's'}.` : 'Nothing new here that the catalogs know by name.') : `Couldn't scan: ${r.error}`);
      if (r.found?.length) await reloadLibrary();
      return;
    }
    case 'readme': return showReadme(v.identifier, getTitle(v));
    case 'update-notes': return showUpdateNotes();
    case 'update-get': return api.updaterInstall();
    case 'update-dismiss': return $('#announce').classList.add('hidden');
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
  if (t.matches('[data-detail-menu]')) {
    e.stopPropagation();
    const r = t.getBoundingClientRect();
    return openDetailMenu(r.left, r.bottom + 6);
  }
  if (t.dataset.href) { e.preventDefault(); return api.openExternal(t.dataset.href); }
  if (t.dataset.view) return go(t.dataset.view, t.dataset.arg || null);
  if (t.dataset.go) return go(t.dataset.go, t.dataset.arg || null);
  if (t.dataset.rowNav) return scrollRow(t);
  if (t.dataset.open) return openDetail(t.dataset.open, t.dataset.id);
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

// The sidebar box: words search, a pasted archive.org, GitHub or GitLab link adds it
let searchTimer;
const addFromBox = (text) => { $('#q').value = ''; state.query = ''; render(); return addLink(text); };
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const text = e.target.value.trim();
  if (LINK_RE.test(text)) return;
  searchTimer = setTimeout(() => { state.query = text; render(); }, 120);
});
$('#q').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text')?.trim();
  if (text && LINK_RE.test(text)) { e.preventDefault(); addFromBox(text); }
});
$('#q').addEventListener('keydown', (e) => {
  const text = e.target.value.trim();
  if (e.key === 'Enter' && LINK_RE.test(text)) { e.preventDefault(); addFromBox(text); }
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
  if (e.key === 'Escape' && !e.target.closest?.('input, textarea, select')) {
    if (onDetailPage()) closeDetail(); else if (state.query) { $('#q').value = ''; state.query = ''; render(); }
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && stepRow(e)) e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
});

$('#win-min').addEventListener('click', () => api.windowMinimize());
$('#win-max').addEventListener('click', () => api.windowMaximize());
$('#win-close').addEventListener('click', () => api.windowClose());
$('#nav-back').addEventListener('click', () => goHistory(-1));
$('#body').addEventListener('scroll', syncChrome, { passive: true });
$('#nav-fwd').addEventListener('click', () => goHistory(1));
$('#btn-sidebar').addEventListener('click', () => $('#app').classList.toggle('no-sidebar'));

// The window buttons dim while the window is in the background, as on macOS
const syncFocus = () => document.body.classList.toggle('unfocused', !document.hasFocus());
window.addEventListener('focus', syncFocus);
window.addEventListener('blur', syncFocus);
syncFocus();

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

// ─── What's new: the sidebar button and its pane ────────────────────────────
// Three kinds of row: a newer release of an installed port, a newer upload of
// an installed game, and a new upload from a pack. A pack's uploads count as
// new when added after the pack was last looked at here; the first time a
// pack is seen nothing is new (or a fresh pack would list everything). Seen
// times and dismissed rows are kept per browser profile, in localStorage.
const NEWS_KEY = 'y4bo.news';
const news = (() => {
  try { const n = JSON.parse(localStorage.getItem(NEWS_KEY)) || {}; return { seen: n.seen || {}, dismissed: n.dismissed || [] }; }
  catch { return { seen: {}, dismissed: [] }; }
})();
const saveNews = () => { try { localStorage.setItem(NEWS_KEY, JSON.stringify(news)); } catch { /* storage off */ } };

function newsItems() {
  const out = [];
  for (const u of state.portUpdates) {
    const p = state.ports?.items.find(i => i.id === u.id);
    if (p) out.push({ key: `port:${u.id}:${u.latest}`, kind: 'port', id: p.id, title: p.name, sub: `New release ${u.latest} · ${p.host}`, button: 'Update' });
  }
  for (const l of Object.values(state.library)) {
    if (!l.install_dir) continue;
    const g = state.games.find(x => (x._versions || [x]).some(v => v.identifier === l.identifier));
    const newer = g && outdated(g);
    if (newer) out.push({ key: `newer:${newer.identifier}`, kind: 'game', id: newer.identifier, title: getTitle(g), sub: 'Newer upload on archive.org', button: 'See it' });
  }
  if (!state.wall.loading) {
    let stamped = false;
    for (const src of state.sources.filter(x => x.enabled !== false && !isUploadSource(x))) {
      const since = news.seen[src.uploader];
      if (!since) { news.seen[src.uploader] = new Date().toISOString(); stamped = true; continue; }
      for (const v of state.versions) {
        if (v._uploader === src.uploader && v.addeddate && v.addeddate > since && !isInstalled(v)) {
          out.push({ key: `new:${v.identifier}`, kind: 'game', id: v.identifier, title: getTitle(v), sub: `New from ${sourceName(src)}`, button: 'Get' });
        }
      }
    }
    if (stamped) saveNews();
  }
  const seenKeys = new Set();
  return out.filter(n => !news.dismissed.includes(n.key) && !seenKeys.has(n.key) && seenKeys.add(n.key));
}

function newsPopHtml() {
  const list = newsItems();
  const rows = list.map(n => `<div class="news-row">
      <button class="grow linkrow" data-open="${n.kind}" data-id="${esc(n.id)}"><b>${esc(n.title)}</b><small>${esc(n.sub)}</small></button>
      <button class="btn${n.button === 'See it' ? '' : ' primary'}" data-action="news-go" data-key="${esc(n.key)}">${esc(n.button)}</button>
      <button class="x" data-keep-pop data-action="news-dismiss" data-key="${esc(n.key)}" aria-label="Dismiss ${esc(n.title)}" title="Dismiss">&#10005;</button>
    </div>`).join('');
  return `<div class="news-head"><b>What's new</b><span class="grow"></span>${list.length ? '<button class="btn" data-keep-pop data-action="news-clear">Clear</button>' : ''}</div>
    ${rows || '<div class="news-empty">Nothing new. New releases of your ports and new uploads from your packs show up here.</div>'}`;
}

async function newsGo(key) {
  const n = newsItems().find(x => x.key === key);
  if (!n) return;
  newsDismiss([key]);
  if (n.kind === 'port') {
    const p = state.ports?.items.find(i => i.id === n.id);
    if (p) { openDetail('port', p.id); return installPort(p); }
  }
  openDetail('game', n.id);
  const d = state.detail;
  if (n.button === 'Get' && d?.version && !isInstalled(d.version)) return installGame(d.version);
}

function newsDismiss(keys, { seenNow = false } = {}) {
  news.dismissed = [...new Set([...news.dismissed, ...keys])].slice(-500);
  if (seenNow) for (const src of state.sources) news.seen[src.uploader] = new Date().toISOString();
  saveNews();
  renderNav();
  if (popKind === 'news') renderPop();
}

function renderPop() {
  const el = $('#pop');
  if (!popKind) return el.classList.add('hidden');
  el.innerHTML = popKind === 'news' ? newsPopHtml() : downloadsPopHtml();
  el.dataset.kind = popKind;
  el.classList.toggle('news-pop', popKind === 'news');
  el.classList.remove('hidden');
  const main = $('.main').getBoundingClientRect();
  if (popKind === 'news') {
    // Beside the sidebar, its foot level with the button's
    const r = $('#btn-news').getBoundingClientRect();
    el.style.left = '8px';
    el.style.right = 'auto';
    el.style.top = `${Math.max(12, r.bottom - main.top - el.offsetHeight)}px`;
    return;
  }
  const r = $('#btn-downloads').getBoundingClientRect();
  el.style.left = '';
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
  // Dismiss and Clear in What's new keep the pane open
  if (e.target.closest('#pop [data-keep-pop]')) return;
  // Any other click closes it; a click on one of its items still does its job
  closePop();
}, true);
window.addEventListener('blur', closePop);
window.addEventListener('resize', closePop);

// The badge in the title row: a dot while something downloads
function renderBadges() {
  const busy = [...state.downloads.values()].some(d => d.name);
  $('#dl-dot').hidden = !busy;
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
  const bar = document.querySelector('#detail .progress i');
  if (bar && state.detail?.version?.identifier === identifier) {
    bar.style.width = `${percent}%`;
    document.querySelector('#detail .progress-label').textContent = `${percent}%`;
    const busy = document.querySelector('#detail .album-pill.primary:disabled');
    if (busy) busy.textContent = `Downloading… ${percent}%`;
  }
}

// ─── start ───────────────────────────────────────────────────────────────────

// A new y4bo release (electron-updater, src/electron/main.js): a bar over the
// page with its notes and a link to the release. Nothing installs by itself.
let pendingUpdate = null;
function showUpdate(status) {
  const el = $('#announce');
  if (status?.status !== 'available' || !el) return;
  pendingUpdate = status;
  el.innerHTML = `<span class="msg">y4bo ${esc(status.version)} is out.</span>
    ${status.releaseNotes ? '<button class="btn" data-action="update-notes">What\'s new</button>' : ''}
    <button class="btn primary" data-action="update-get">Get it</button>
    <button class="x" data-action="update-dismiss" aria-label="Dismiss">&#10005;</button>`;
  el.classList.remove('hidden');
}
async function showUpdateNotes() {
  if (!pendingUpdate) return;
  const ok = await modal({ title: `What's new in ${pendingUpdate.version}`, body: `<pre class="readme">${esc(pendingUpdate.releaseNotes)}</pre>`,
    html: true, primary: 'Get it', secondary: 'Later' });
  if (ok) api.updaterInstall();
}

// Playnite's "show in launcher" (y4bo --open <id>): the item's page, once
// the wall or the shelves have it
let pendingOpen = null;
function showPendingItem() {
  const id = pendingOpen;
  if (!id) return;
  const kind = state.ports?.items.some(i => i.id === id) ? 'port' : detailFor('game', id) ? 'game' : null;
  if (!kind) return;
  pendingOpen = null;
  api.clearOpenItem();
  openDetail(kind, id);
}

applyFolded();
(async function init() {
  state.settings = await api.getSettings().catch(() => ({}));
  api.getAppVersion().then(ver => { state.appVersion = ver; }).catch(() => {});
  ({ sources: state.sources } = await api.getSources());
  await reloadLibrary();
  render();
  api.onUpdaterStatus(showUpdate);
  api.onOpenItem(({ identifier }) => { pendingOpen = identifier; showPendingItem(); });
  // The two halves load side by side: GitHub for the shelves, archive.org for the wall
  loadPorts().then(showPendingItem);
  loadWall().then(showPendingItem);
})();
