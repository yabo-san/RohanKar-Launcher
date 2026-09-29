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
  review: [],
  wallFilter: { uploader: null, sort: 'newest' },
  shelfFilter: { tag: null, dataOnly: false },
  detail: null,
  downloads: new Map(), // identifier -> { percent, status }
};

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    data: it.data
      ? { status: 'available', iaIdentifier: it.data.iaIdentifier, contentUrl: it.data.contentUrl, uploader: null,
        files: (it.data.dataFiles || []).map(f => f?.name ?? f) }
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
    return `<button class="navitem" data-view="uploader" data-arg="${esc(s.uploader)}"><span class="dot"></span>${esc(sourceName(s))}
      <span class="n">${failed ? '!' : loading ? '…' : n}</span></button>`;
  }).join('');
  $('#nav-shelves').innerHTML = (state.ports?.shelves || []).map(s =>
    `<button class="navitem" data-view="shelf" data-arg="${esc(s.id)}"><span class="dot"></span>${esc(s.name)}<span class="n">${s.count || (s.error ? '!' : '')}</span></button>`
  ).join('') || '<div class="navitem" style="cursor:default;color:var(--text3)"><span class="dot"></span>Loading…</div>';
  $('#n-wall').textContent = state.games.length || '';
  const libCount = Object.values(state.library).filter(l => l.install_dir).length + state.portLibrary.length;
  $('#n-library').textContent = libCount || '';
  $('#n-updates').textContent = reviewCount() || '';
  markActive();
}

function markActive() {
  document.querySelectorAll('.sidebar .navitem').forEach(el => {
    const v = state.view;
    el.classList.toggle('active', !state.query && el.dataset.view === v.name && (el.dataset.arg || null) === (v.arg || null));
  });
}

function go(name, arg = null) {
  state.view = { name, arg };
  state.query = '';
  $('#q').value = '';
  state.wallFilter.uploader = null;
  state.shelfFilter = { tag: null, dataOnly: false };
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
      <div class="play${installed ? '' : ' plus'}"></div>
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
    <div class="art icon" style="background:${tint(p.repository)}">${art}${tag}<div class="play ${added ? 'check' : 'plus'}"></div></div>
    <div class="title">${esc(p.name)}</div>
    <div class="sub">${esc(p.project || p.repository)}</div>
  </button>`;
}

const skeletons = (n) => Array.from({ length: n }, () =>
  '<div class="card skel"><div class="art"></div><div class="title">.</div><div class="sub">.</div></div>').join('');

function section(title, body, { count, sub, seeAll, cls = 'grid' } = {}) {
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>
    ${count != null ? `<span class="count">${esc(count)}</span>` : ''}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    ${seeAll ? `<button class="seeall" data-go="${esc(seeAll[0])}" data-arg="${esc(seeAll[1] || '')}">See all</button>` : ''}</div>
    <div class="${cls}">${body}</div></section>`;
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
  const covers = state.games.slice().sort(byDownloads).slice(0, 6);
  let html = `<div class="hero">
    <div class="bg">${covers.map(g => `<div data-thumb="${esc(g.identifier)}" style="background:${tint(getTitle(g))}"></div>`).join('')}</div>
    <div class="copy">
      <div class="eyebrow">One launcher, two kinds of shelf</div>
      <h2>Games from archive.org, ports from GitHub.</h2>
      <p>The wall is everything ${esc(enabled.map(sourceName).join(', '))} have posted. The Ports shelves come from Quiver's community catalogs, and when a port needs game data the collision catalog says where to get it.</p>
      <div class="stats">
        <div class="stat"><b>${state.wall.loading && !state.games.length ? '…' : fmtNum(state.games.length)}</b><span>games on the wall</span></div>
        <div class="stat"><b>${enabled.length}</b><span>uploaders</span></div>
        <div class="stat"><b>${ports ? fmtNum(ports.items.length) : '…'}</b><span>ports on ${ports ? ports.shelves.length : 4} shelves</span></div>
        <div class="stat"><b>${ports ? ports.items.filter(i => i.data.status === 'available').length : '…'}</b><span>with data wired</span></div>
      </div>
    </div></div>`;
  html += wallNotice();

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

function viewWall(uploader) {
  const enabled = state.sources.filter(s => s.enabled !== false);
  const f = state.wallFilter;
  const who = uploader || f.uploader;
  let list = state.games.filter(g => !who || (g._versions || [g]).some(v => v._uploader === who));
  list = list.slice().sort(f.sort === 'downloads' ? byDownloads : f.sort === 'title' ? byTitle : byNewest);
  let html = '';
  if (!uploader) {
    html += `<div class="toolbar">
      <button class="chip ${!f.uploader ? 'on' : ''}" data-wall-uploader="">All uploaders</button>
      ${enabled.map(s => `<button class="chip ${f.uploader === s.uploader ? 'on' : ''}" data-wall-uploader="${esc(s.uploader)}">${esc(sourceName(s))}</button>`).join('')}
      <span class="grow"></span>${sortSelect()}</div>`;
  } else {
    const src = state.sources.find(s => s.uploader === uploader);
    html += `<div class="toolbar"><span class="sub" style="color:var(--text2)">archive.org uploader <b style="color:var(--text)">${esc(uploader)}</b>${src ? '' : ' (not in your sources)'}</span><span class="grow"></span>${sortSelect()}</div>`;
  }
  html += wallNotice(uploader);
  const title = uploader ? sourceName(state.sources.find(s => s.uploader === uploader) || { uploader }) : 'Game wall';
  if (!list.length && state.wall.loading) return html + section(title, skeletons(18));
  if (!list.length) return html + `<p class="empty">Nothing here yet.</p>`;
  return html + `<section class="section"><div class="section-head"><h2>${esc(title)}</h2><span class="count">${fmtNum(list.length)} titles</span>
    ${state.wall.loading ? '<span class="sub">still loading uploaders…</span>' : ''}</div>${pagedGrid(list, gameCard)}</section>`;
}

function sortSelect() {
  const s = state.wallFilter.sort;
  return `<select id="wall-sort" aria-label="Sort">
    <option value="newest" ${s === 'newest' ? 'selected' : ''}>Newest</option>
    <option value="downloads" ${s === 'downloads' ? 'selected' : ''}>Most downloaded</option>
    <option value="title" ${s === 'title' ? 'selected' : ''}>A to Z</option></select>`;
}

function viewShelf(id) {
  const shelf = state.ports?.shelves.find(s => s.id === id);
  if (!shelf) return state.portsError ? `<p class="empty">Couldn't load the catalogs: ${esc(state.portsError)}</p>` : section('Ports', skeletons(12), { cls: 'grid ports' });
  const f = state.shelfFilter;
  const all = state.ports.items.filter(i => i.shelf === id);
  const list = all.filter(i => (!f.tag || i.tags.includes(f.tag)) && (!f.dataOnly || i.data.status === 'available'));
  const tags = shelf.preferredTags.length ? shelf.preferredTags : [...new Set(all.flatMap(i => i.tags))].slice(0, 10);
  let html = `<div class="toolbar">
    <button class="chip ${!f.tag && !f.dataOnly ? 'on' : ''}" data-shelf-tag="">All</button>
    <button class="chip ${f.dataOnly ? 'on' : ''}" data-shelf-data="1">Data available</button>
    ${tags.map(t => `<button class="chip ${f.tag === t ? 'on' : ''}" data-shelf-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
  if (shelf.error) {
    html += `<div class="notice warn"><div class="grow">Couldn't fetch the ${esc(shelf.name)} catalog (${esc(shelf.error)}).</div><button class="btn" data-action="refresh-ports">Retry</button></div>`;
  } else if (shelf.fromCache) {
    html += `<div class="notice"><div class="grow">Showing the cached ${esc(shelf.name)} catalog from ${esc(fmtDate(shelf.fetchedAt))}; GitHub wasn't reachable.</div><button class="btn" data-action="refresh-ports">Retry</button></div>`;
  }
  return html + `<section class="section"><div class="section-head"><h2>${esc(shelf.name)}</h2><span class="count">${list.length} ports</span>
    <span class="sub">Source: Quiver / ${esc(shelf.name)}${shelf.withData ? ` · ${shelf.withData} with data from archive.org` : ''}</span></div>
    ${list.length ? pagedGrid(list, portCard, 'grid ports') : '<p class="empty">No ports match.</p>'}</section>`;
}

function viewLibrary() {
  const installed = Object.values(state.library).filter(l => l.install_dir);
  const games = installed.map(l => state.games.find(g => (g._versions || [g]).some(v => v.identifier === l.identifier))
    || { identifier: l.identifier, title: l.identifier, _sourceLabel: 'archive.org' });
  const uniq = [...new Map(games.map(g => [g.identifier, g])).values()];
  const ports = state.portLibrary.map(r => state.ports?.items.find(i => i.id === r.id)).filter(Boolean);
  if (!uniq.length && !ports.length) {
    return `<p class="empty"><b>Your library is empty.</b><br>Install something from the game wall, or open a Ports shelf and add a port.
      The library is what's yours, not everything that exists.</p>`;
  }
  let html = '';
  if (uniq.length) html += section('Installed games', uniq.map(gameCard).join(''), { count: uniq.length });
  if (ports.length) html += section('Ports', ports.map(portCard).join(''), { count: ports.length, cls: 'grid ports', sub: 'Added from a catalog. Installing ports is the next step in the brief.' });
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
    <div class="field"><label>Interface</label>
      <div class="hint">The classic interface is still there while this one catches up on installs for ports.</div>
      <button class="btn" id="btn-classic-ui" data-action="legacy-ui">Switch to the classic interface</button></div>
    <div class="field"><div class="hint" id="app-version"></div></div>
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

const HEADINGS = { home: 'Home', wall: 'Game wall', library: 'Library', updates: 'Keep current', settings: 'Settings' };

function render() {
  const v = state.view;
  pagedGrid.pending = {};
  let html;
  if (state.query) html = viewSearch(state.query);
  else if (v.name === 'wall') html = viewWall(null);
  else if (v.name === 'uploader') html = viewWall(v.arg);
  else if (v.name === 'shelf') html = viewShelf(v.arg);
  else if (v.name === 'library') html = viewLibrary();
  else if (v.name === 'updates') html = viewUpdates();
  else if (v.name === 'settings') html = viewSettings();
  else html = viewHome();

  $('#heading').textContent = state.query ? 'Search'
    : v.name === 'shelf' ? `${state.ports?.shelves.find(s => s.id === v.arg)?.name || ''} ports`
    : v.name === 'uploader' ? sourceName(state.sources.find(s => s.uploader === v.arg) || { uploader: v.arg })
    : HEADINGS[v.name] || 'Home';

  // Keep the settings form as typed while the wall is still streaming in
  if (v.name === 'settings' && !state.query && $('#setting-sources')) { renderNav(); return; }
  const body = $('#body');
  body.innerHTML = html;
  observeCovers(body);
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
    const g = state.games.find(x => x.identifier === id) || state.versions.find(x => x.identifier === id);
    if (!g) return;
    state.detail = { kind, game: g, version: installedVersion(g) || g, exes: null };
  } else {
    const p = state.ports?.items.find(x => x.id === id);
    if (!p) return;
    state.detail = { kind, port: p };
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

function gameDetail(d) {
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
  const exes = d.exes ? `<div class="h3">${d.exes.purpose === 'steam' ? 'Pick the executable for Steam' : 'Pick the executable'}</div>
    <div class="versions">${d.exes.list.map(p => `<button class="version" data-exe="${esc(p)}"><span class="who">${esc(p.split(/[\\/]/).pop())}</span><span class="meta">${esc(p)}</span></button>`).join('')}</div>` : '';
  const desc = stripHtml(Array.isArray(v.description) ? v.description.join('\n') : v.description);
  return `<div class="d-hero"><div class="bg" style="background:${tint(title)}"></div>
      <div class="cover" data-cover="${esc(v.identifier)}" style="background:${tint(title)}"></div>
      <button class="x" data-close aria-label="Close">&#10005;</button>
      <div class="titles"><h2>${esc(title)}</h2><div class="by">archive.org · ${esc(v._sourceLabel || '')}${v.addeddate ? ` · ${fmtDate(v.addeddate)}` : ''}</div></div></div>
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
        <button class="btn" disabled title="Port installs are step 3 of docs/AGENT-BRIEF.md">Install</button>
        <button class="btn" data-href="https://github.com/${esc(p.repository)}">Repository</button>
      </div>
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

async function onAction(action, el) {
  const d = state.detail;
  const v = d?.version;
  switch (action) {
    case 'install': return installGame(v);
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
    case 'refresh-ports': toast('Checking the catalogs…', 2000); return loadPorts(true);
    case 'mark-seen':
      await Promise.all(state.review.map(r => api.markCatalogSeen(r.id)));
      return loadPorts();
    case 'save-settings': return saveSettingsForm();
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
  const t = e.target.closest('button, a, [data-close]');
  if (!t) return;
  if (t.matches('[data-close]')) return closeDetail();
  if (t.dataset.href) { e.preventDefault(); return api.openExternal(t.dataset.href); }
  if (t.dataset.view) return go(t.dataset.view, t.dataset.arg || null);
  if (t.dataset.go) return go(t.dataset.go, t.dataset.arg || null);
  if (t.dataset.open) return openDetail(t.dataset.open, t.dataset.id);
  if (t.dataset.togglePort) return togglePort(t.dataset.togglePort);
  if (t.dataset.version && state.detail) {
    state.detail.version = state.detail.game._versions.find(x => x.identifier === t.dataset.version) || state.detail.version;
    state.detail.exes = null;
    return renderDetail();
  }
  if (t.dataset.exe && state.detail?.exes) {
    const { purpose } = state.detail.exes;
    state.detail.exes = null;
    renderDetail();
    return purpose === 'steam' ? addToSteam(state.detail.version, t.dataset.exe) : launch(state.detail.version, t.dataset.exe);
  }
  if (t.dataset.wallUploader !== undefined) { state.wallFilter.uploader = t.dataset.wallUploader || null; return render(); }
  if (t.dataset.shelfTag !== undefined) { state.shelfFilter = { tag: t.dataset.shelfTag || null, dataOnly: false }; return render(); }
  if (t.dataset.shelfData) { state.shelfFilter = { tag: null, dataOnly: !state.shelfFilter.dataOnly }; return render(); }
  if (t.dataset.action) return onAction(t.dataset.action, t);
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'wall-sort') { state.wallFilter.sort = e.target.value; render(); }
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
  if (e.key === 'Escape') { if (state.detail) closeDetail(); else if (state.query) { $('#q').value = ''; state.query = ''; render(); } }
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

(async function init() {
  state.settings = await api.getSettings().catch(() => ({}));
  state.sources = (await api.getSources()).sources;
  await reloadLibrary();
  render();
  // The two halves load side by side: GitHub for the shelves, archive.org for the wall
  loadPorts();
  loadWall();
})();
