'use strict';
/**
 * y4bo — list-view.js
 * The model behind the library pages' list view (after Cider 2's song list),
 * with no DOM: the columns for games and ports, Cider's sort and search, which
 * columns show, what a click on a column header does to the sort, a row's
 * status and favourite, and the row-action registry that the ⋯ button and the
 * right-click menu both read. Loaded as a plain <script> before new/app.js
 * (as the ListView global), and required as CommonJS by the node:test suite.
 */
const ListView = (() => {
  // getTitle comes from sources.js: a global in the page, required under node
  const titleOf = typeof getTitle === 'function' ? getTitle : require('./sources.js').getTitle;

  // ─── sort and search (Cider's searchLibraryAlbums) ────────────────────────
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

  // ─── what a row says about itself ─────────────────────────────────────────
  // ctx: { library: { [identifier]: row }, downloads: Map(identifier → { percent, status }) }
  const versionsOf = (g) => g._versions || [g];
  const isInstalled = (g, ctx) => versionsOf(g).some(v => ctx.library[v.identifier]?.install_dir);
  const isFavorite = (item, ctx) => (item.identifier ? versionsOf(item).some(v => ctx.library[v.identifier]?.is_favorite) : !!ctx.library[item.id]?.is_favorite);
  // The installed version that has a newer upload (the backend's `newer`)
  const outdated = (g, ctx) => versionsOf(g).find(v => v._newer && ctx.library[v.identifier]?.install_dir) || null;

  // { label, kind } for the Status column; label '' when there's nothing to say
  function gameStatus(g, ctx) {
    const dl = ctx.downloads?.get(g.identifier);
    if (dl) return { label: dl.status === 'downloading' ? `${dl.percent || 0}%` : 'Installing…', kind: 'busy' };
    if (isInstalled(g, ctx)) return outdated(g, ctx) ? { label: 'Newer release', kind: 'update' } : { label: 'Installed', kind: 'ok' };
    return { label: '', kind: '' };
  }
  function portStatus(p, ctx) {
    const dl = ctx.downloads?.get(p.id);
    if (dl) return { label: dl.status === 'downloading' ? `${dl.percent || 0}%` : 'Installing…', kind: 'busy' };
    if (ctx.library[p.id]?.install_dir) return { label: 'Installed', kind: 'ok' };
    if (ctx.library[p.id]) return { label: 'In library', kind: '' };
    if (p.data?.status === 'available') return { label: 'Game data', kind: 'data' };
    if (p.data?.status === 'missing') return { label: 'Needs data', kind: 'warn' };
    return { label: '', kind: '' };
  }
  const STATUS_RANK = { busy: 4, update: 3, ok: 2, data: 1 };

  const fmtDate = (d) => { if (!d) return ''; const t = new Date(d); return Number.isNaN(t.getTime()) ? String(d) : t.toISOString().slice(0, 10); };
  const fmtNum = (n) => (n ? Number(n).toLocaleString('en-US') : '');
  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
  };
  // archive.org's date is free text: "1999", "1999-05-01" or a timestamp
  const released = (d) => (d ? String(d).trim().slice(0, 10) : '');

  // ─── columns ──────────────────────────────────────────────────────────────
  // id, label, text(item, ctx) → what the cell says, sort → the pref's sort
  // key (see *_SORTS), first → the order of a first click, width → grid track,
  // required → always shown, num → right-aligned
  const GAME_COLUMNS = [
    { id: 'name',      label: 'Name',      sort: 'name',      first: 'asc',  width: 'minmax(0, 3fr)',   required: true, text: (g) => titleOf(g) },
    { id: 'uploader',  label: 'Uploader',  sort: 'uploader',  first: 'asc',  width: 'minmax(0, 1.5fr)', text: (g) => g._sourceLabel || '' },
    { id: 'platform',  label: 'Platform',  sort: 'platform',  first: 'asc',  width: 'minmax(0, .8fr)',  text: (g) => g.platform || '' },
    { id: 'released',  label: 'Released',  sort: 'year',      first: 'desc', width: 'minmax(0, .8fr)',  text: (g) => released(g.date) },
    { id: 'added',     label: 'Added',     sort: 'dateAdded', first: 'desc', width: 'minmax(0, .8fr)',  text: (g) => fmtDate(g.addeddate) },
    { id: 'size',      label: 'Size',      sort: 'size',      first: 'desc', width: 'minmax(0, .6fr)',  num: true, text: (g) => fmtBytes(g.size) },
    { id: 'downloads', label: 'Downloads', sort: 'downloads', first: 'desc', width: 'minmax(0, .7fr)',  num: true, text: (g) => fmtNum(g.downloads) },
    { id: 'status',    label: 'Status',    sort: 'status',    first: 'desc', width: 'minmax(0, .9fr)',  text: (g, ctx) => gameStatus(g, ctx).label },
  ];
  const PORT_COLUMNS = [
    { id: 'name',       label: 'Name',       sort: 'name',   first: 'asc',  width: 'minmax(0, 2.4fr)', required: true, text: (p) => p.name || '' },
    { id: 'project',    label: 'Project',    sort: 'project', first: 'asc', width: 'minmax(0, 1.4fr)', text: (p) => p.project || '' },
    { id: 'repository', label: 'Repository', sort: 'repo',   first: 'asc',  width: 'minmax(0, 1.6fr)', text: (p) => p.repository || '' },
    { id: 'platform',   label: 'Platform',   sort: 'shelf',  first: 'asc',  width: 'minmax(0, .8fr)',  text: (p) => p.shelfName || '' },
    { id: 'status',     label: 'Status',     sort: 'status', first: 'desc', width: 'minmax(0, .9fr)',  text: (p, ctx) => portStatus(p, ctx).label },
  ];

  // Sort keys, as [label for the Sort by menu, value(item, ctx)]
  const GAME_SORTS = {
    name:      ['Title', g => titleOf(g)],
    dateAdded: ['Date added', g => g.addeddate],
    uploader:  ['Uploader', g => g._sourceLabel],
    downloads: ['Downloads', g => g.downloads || 0],
    year:      ['Year', g => (g.date || g.addeddate || '').slice(0, 4)],
    platform:  ['Platform', g => g.platform || ''],
    size:      ['Size', g => g.size || 0],
    status:    ['Status', (g, ctx) => STATUS_RANK[gameStatus(g, ctx).kind] || 0],
  };
  const PORT_SORTS = {
    data:    ['Game data', p => (p.data?.status === 'available' ? 1 : 0)],
    name:    ['Name', p => p.name],
    project: ['Project', p => p.project],
    repo:    ['Repository', p => p.repository],
    shelf:   ['Shelf', p => p.shelfName],
    status:  ['Status', (p, ctx) => STATUS_RANK[portStatus(p, ctx).kind] || 0],
  };

  // The value function for a sort key: the first table that has it, else the fallback key's
  function sortValue(key, tables, fallback) {
    for (const t of tables) if (t[key]) return t[key][1];
    for (const t of tables) if (t[fallback]) return t[fallback][1];
    return () => '';
  }

  // Sorted by the page's pref; the item's name breaks ties so a sort is stable
  function sortRows(list, { sort, order }, tables, fallback, ctx, nameOf = titleOf) {
    const value = sortValue(sort, tables, fallback);
    return ciderSort(ciderSort(list, nameOf, 'asc'), x => value(x, ctx), order);
  }

  // A click on a column header: the same column flips the order, another
  // column sorts by it in its first order. Null for a column that can't sort.
  function headerSort(prefs, col) {
    if (!col?.sort) return null;
    if (prefs.sort === col.sort) return { sort: col.sort, order: prefs.order === 'asc' ? 'desc' : 'asc' };
    return { sort: col.sort, order: col.first || 'asc' };
  }

  // 'ascending' | 'descending' | 'none', for aria-sort and the arrow
  const ariaSort = (prefs, col) => (col.sort && prefs.sort === col.sort ? (prefs.order === 'asc' ? 'ascending' : 'descending') : 'none');

  const hasData = (col, rows, ctx) => rows.some(r => col.text(r, ctx) !== '');

  // The columns a list shows: required ones, and the rest unless the user
  // hid them or no row has anything to put in them
  function visibleColumns(columns, hidden, rows, ctx) {
    const off = new Set(hidden || []);
    return columns.filter(c => c.required || (!off.has(c.id) && hasData(c, rows, ctx)));
  }

  // The column picker's entries: every column that can be hidden, whether
  // it's on, and whether the rows have anything for it
  function columnChoices(columns, hidden, rows, ctx) {
    const off = new Set(hidden || []);
    return columns.filter(c => !c.required).map(c => ({ id: c.id, label: c.label, on: !off.has(c.id), empty: !hasData(c, rows, ctx) }));
  }

  // The hidden list after the picker toggles one column
  function toggleColumn(hidden, id) {
    const off = new Set(hidden || []);
    off.has(id) ? off.delete(id) : off.add(id);
    return [...off];
  }

  // The grid tracks for a list: star, play, the columns, then the ⋯ button
  const gridTemplate = (cols) => ['22px', '26px', ...cols.map(c => c.width), '44px'].join(' ');

  // ─── row actions ──────────────────────────────────────────────────────────
  // One registry for every row menu. An action is
  //   { id, label, icon, group, kinds, when(item, ctx), run(item, ctx), danger, children }
  // label may be a function of (item, ctx); kinds lists the item kinds it
  // applies to ('game', 'port'); children makes it a submenu of actions. The
  // menus draw one section per group, in MENU_GROUPS order, with a divider
  // between sections; an empty group draws nothing. 'admin' holds the
  // actions only admin mode shows (Make a Tile).
  const MENU_GROUPS = ['pin', 'collection', 'play', 'manage', 'goto', 'admin', 'remove'];

  function createActions() {
    const actions = [];
    const byId = new Map();
    const index = (a) => { byId.set(a.id, a); (a.children || []).forEach(index); };

    function register(a) {
      if (!a?.id) throw new Error('an action needs an id');
      if (!MENU_GROUPS.includes(a.group)) throw new Error(`unknown menu group ${a.group} for ${a.id}`);
      const at = actions.findIndex(x => x.id === a.id);
      if (at >= 0) actions.splice(at, 1, a); else actions.push(a);
      index(a);
      return a;
    }

    const applies = (a, item, ctx) => (!a.kinds || a.kinds.includes(ctx.kind)) && (!a.when || !!a.when(item, ctx));
    const entry = (a, item, ctx) => {
      const children = a.children ? a.children.filter(c => applies(c, item, ctx)).map(c => entry(c, item, ctx)) : null;
      return { id: a.id, label: typeof a.label === 'function' ? a.label(item, ctx) : a.label, icon: a.icon || '', danger: !!a.danger, children };
    };

    // [[entry, …], …]: the non-empty groups, in order
    function sections(item, ctx) {
      return MENU_GROUPS.map(g => actions.filter(a => a.group === g && applies(a, item, ctx))
        .map(a => entry(a, item, ctx))
        .filter(e => !e.children || e.children.length))
        .filter(s => s.length);
    }

    return { register, sections, get: (id) => byId.get(id) || null, all: () => actions.slice() };
  }

  return {
    ciderSort, ciderSearch, searchKey,
    isInstalled, isFavorite, outdated, gameStatus, portStatus,
    GAME_COLUMNS, PORT_COLUMNS, GAME_SORTS, PORT_SORTS,
    sortValue, sortRows, headerSort, ariaSort, visibleColumns, columnChoices, toggleColumn, gridTemplate,
    MENU_GROUPS, createActions,
  };
})();

if (typeof module !== 'undefined') module.exports = ListView;
