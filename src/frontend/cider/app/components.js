'use strict';
/**
 * The components of the Cider fork, for the x-templates in ../index.html.
 * Derived from Cider's component scripts (github.com/ciderapp/Cider,
 * AGPL-3.0; see ../LICENSE and ../NOTICE): svg-icon and sidebar-library-item
 * (main/components/), and the <script> halves of views/components/
 * menu-panel, mediaitem-artwork, mediaitem-square, mediaitem-list-item,
 * mediaitem-scroller-horizontal, pagination, add-to-playlist and
 * settings-window, and views/pages/home, library-albums and cider-playlist.
 * Where Cider asked MusicKit for items, ratings or library state, these ask
 * the launcher (the Vue root, vueapp.js).
 */
/* global Launcher */

// Helpers every template can reach as they did in Cider ($root, app)
const shared = {
  data() { return { app: this.$root, api }; },
  methods: { enc: encodeURIComponent },
};
Vue.mixin({ methods: { enc: encodeURIComponent } });

// ─── main/components ─────────────────────────────────────────────────────────

Vue.component('svg-icon', {
  template: '#svg-icon',
  props: {
    name: { type: String, required: false },
    classes: { type: String, required: false },
    url: { type: String, required: true, default: './assets/repeat.svg' },
  },
});

Vue.component('sidebar-library-item', {
  template: '#sidebar-library-item',
  props: {
    name: { type: String, required: true },
    page: { type: String, required: true },
    svgIcon: { type: String, required: false, default: '' },
    svgIconName: { type: String, required: false },
    // Launcher additions: a count at the right, and a round initial for people
    count: { type: [String, Number], required: false, default: '' },
    attention: { type: Boolean, default: false },
    round: { type: Boolean, default: false },
  },
});

// ─── views/components/sidebar.ejs, app-content.ejs ───────────────────────────

Vue.component('cider-app-sidebar', {
  template: '#cider-app-sidebar',
  mixins: [shared],
  methods: {
    uploaderCount(s) {
      const failed = this.app.wall.failed.some(f => f.src.uploader === s.uploader);
      if (failed) return '!';
      if (this.app.wall.loading) return '…';
      return this.app.versions.filter(v => v._uploader === s.uploader).length;
    },
  },
});

Vue.component('app-content-area', {
  template: '#app-content-area',
  data() { return { scrollPos: 0 }; },
});

// ─── views/components/menu-panel.ejs ─────────────────────────────────────────

Vue.component('cider-menu-panel', {
  template: '#cider-menu-panel',
  data() {
    return {
      app: this.$root,
      menuPanel: this.$root.menuPanel,
      content: this.$root.menuPanel.content,
      position: [0, 0],
      size: [0, 0],
      event: this.$root.menuPanel.event,
      direction: 'down',
      elStyle: { opacity: 0 },
    };
  },
  mounted() {
    if (this.event) {
      this.position = [this.event.clientX, this.event.clientY];
      this.$nextTick(() => { setTimeout(this.getStyle, 0.8); });
    } else {
      this.$nextTick(() => { setTimeout(this.getStyle, 0.8); });
    }
  },
  methods: {
    getBodyClasses() {
      if (this.direction === 'down') return ['menu-panel-body-down'];
      if (this.direction === 'up') return ['menu-panel-body-up'];
      return ['foo'];
    },
    getClasses(item) {
      if (item.active) return 'active';
    },
    getStyle() {
      const style = {};
      if (!this.$refs.menubody) return;
      this.size = [this.$refs.menubody.offsetWidth, this.$refs.menubody.offsetHeight];
      if (this.event) {
        // The keyboard menu key reports 0,0: anchor to the element instead
        let x = this.event.clientX, y = this.event.clientY;
        if (!x && !y && this.event.target?.getBoundingClientRect) {
          const r = this.event.target.getBoundingClientRect();
          x = r.left + r.width / 2; y = r.top + r.height / 2;
        }
        style.position = 'absolute';
        style.left = `${x}px`;
        style.top = `${y}px`;
        // make sure the menu panel isnt off the screen
        if (x + this.size[0] > window.innerWidth) style.left = `${x - this.size[0]}px`;
        if (y + this.size[1] > window.innerHeight) style.top = `${y - this.size[1]}px`;
        // if the panel is above the mouse, set the direction to up
        this.direction = y < this.size[1] ? 'up' : 'down';
      }
      style.opacity = 1;
      this.elStyle = style;
    },
    getItemStyle(item) {
      return item.disabled ? { 'pointer-events': 'none', opacity: '0.5' } : {};
    },
    canDisplay(item) {
      return !item.hidden;
    },
    action(item) {
      item.action();
      if (!item.keepOpen) this.menuPanel.visible = false;
    },
  },
});

// ─── views/components/mediaitem-artwork.ejs ──────────────────────────────────
// Cider's app.getMediaItemArtwork filled {w}x{h} into an Apple Music URL; here
// a url is "cover:<identifier>" (the backend's /items/:id/cover, fetched as an
// object URL) or a plain image URL (a port's icon)

Vue.component('mediaitem-artwork', {
  template: '#mediaitem-artwork',
  props: {
    size: { type: [String, Number], default: '120' },
    width: { type: [String, Number], required: false },
    bgcolor: { type: String, default: '' },
    url: { type: String, default: '' },
    type: { type: String, default: '' },
    shadow: { type: String, default: '' },
    // Launcher addition: the name, drawn on the tinted plate while there's no art
    label: { type: String, default: '' },
  },
  data() {
    return {
      app: this.$root,
      awStyle: { background: this.bgcolor },
      imgStyle: { opacity: 0, transition: 'opacity .25s linear' },
      classes: [],
      imgSrc: '',
    };
  },
  watch: {
    url() { this.load(); },
  },
  mounted() {
    this.getClasses();
    this.load();
  },
  methods: {
    load() {
      const url = this.url;
      Launcher.resolveArtwork(url).then((src) => { if (this.url === url) this.imgSrc = src; });
    },
    imgLoaded() {
      this.imgStyle.opacity = 1;
    },
    getClasses() {
      switch (this.shadow) {
        case 'none': this.classes.push('no-shadow'); break;
        case 'large': this.classes.push('shadow'); break;
        case 'subtle': this.classes.push('subtle-shadow'); break;
        default: break;
      }
      return this.classes;
    },
  },
});

// ─── views/components/mediaitem-square.ejs ───────────────────────────────────

Vue.component('mediaitem-square', {
  template: '#mediaitem-square',
  props: {
    item: { type: Object, required: true },
    kind: { type: String, default: '' },
    size: { type: String, default: '190' },
    noScale: { type: Boolean, default: false, required: false },
  },
  data() {
    return { isVisible: false, app: this.$root };
  },
  methods: {
    getContextMenu(event) {
      return this.app.contextMenu(this.item, event);
    },
    // An uploader's name goes to their page, a port's project to its shelf
    getSubtitleNavigation() {
      const g = this.item._game, p = this.item._port;
      if (g?._uploader) return this.app.appRoute(`uploader/${encodeURIComponent(g._uploader)}`);
      if (p) return this.app.appRoute(`shelf/${encodeURIComponent(p.shelf)}`);
      return this.app.routeView(this.item);
    },
    installed() {
      const p = this.item._port;
      return p ? !!this.app.library[p.id]?.install_dir : this.app.isInstalled(this.item._game);
    },
    playLabel() {
      return this.installed() ? 'Play' : 'Install';
    },
    // Where Cider drew friends' avatars, the launcher's tags
    badges() {
      const g = this.item._game, p = this.item._port;
      const out = [];
      const dl = this.app.downloads[this.item.id];
      if (dl) out.push(`${dl.percent || 0}%`);
      else if (this.installed()) out.push('INSTALLED');
      if (g && (g._versions?.length || 1) > 1) out.push(`${g._versions.length} VERSIONS`);
      if (p && p.data.status === 'available') out.push('DATA');
      if (p && !this.installed() && this.app.inPortLibrary(p)) out.push('IN LIBRARY');
      return out;
    },
    getClasses() {
      const classes = [];
      if (this.noScale) classes.push('noscale');
      if (this.item.type === 'port') classes.push('launcher-port');
      if (this.kind === 'small') classes.push('mediaitem-small');
      return classes;
    },
    visibilityChanged(isVisible) {
      if (isVisible) this.isVisible = true;
    },
  },
});

// ─── views/components/mediaitem-list-item.ejs ────────────────────────────────

Vue.component('mediaitem-list-item', {
  template: '#mediaitem-list-item',
  props: {
    item: { type: Object, required: true },
    index: { type: Number, required: false, default: -1 },
    showArtwork: { type: Boolean, default: true },
    showMetaData: { type: Boolean, default: false },
    showIndex: { type: Boolean, required: false },
    // Launcher additions: the metainfo columns, a pill, a selected row
    meta: { type: Array, default: () => [] },
    badge: { type: String, default: '' },
    selected: { type: Boolean, default: false },
  },
  data() {
    return { isVisible: false, app: this.$root };
  },
  methods: {
    visibilityChanged(isVisible) {
      if (isVisible) this.isVisible = true;
    },
    onClick() {
      if (this.$listeners.select) return this.$emit('select', this.item);
      if (this.item._game || this.item._port) this.app.routeView(this.item);
    },
    contextMenu(event) {
      if (this.item._game || this.item._port) this.app.contextMenu(this.item, event);
    },
  },
});

// ─── views/components/mediaitem-scroller-horizontal.ejs ──────────────────────

Vue.component('mediaitem-scroller-horizontal', {
  template: '#mediaitem-scroller-horizontal',
  props: {
    items: { type: Array, required: false },
    kind: { type: String, required: false, default: '' },
  },
  data() { return { app: this.$root }; },
});

// ─── views/components/pagination.ejs (unchanged but for the formatting) ─────

Vue.component('pagination', {
  template: '#pagination',
  props: {
    length: { type: Number, required: true },
    pageSize: { type: Number, required: true },
    scroll: { type: String, required: true },
    scrollSelector: { type: String, required: true },
  },
  data() { return { currentPage: 1 }; },
  mounted() {
    document.querySelector(this.scrollSelector).addEventListener('scroll', this.handleScroll);
  },
  destroyed() {
    document.querySelector(this.scrollSelector)?.removeEventListener('scroll', this.handleScroll);
  },
  watch: {
    length() {
      if (this.isInfinite) {
        // If a search reduces the number of things to show, limit the number shown too
        if (this.currentPage > this.numPages) {
          this.currentPage = this.numPages;
          this.$emit('onRangeChange', this.currentRange);
        }
      } else {
        this.$emit('onRangeChange', this.currentRange);
      }
    },
    scroll() {
      // When changing modes, set the page to 1
      this.currentPage = 1;
      this.$emit('onRangeChange', this.currentRange);
    },
  },
  computed: {
    isInfinite() { return this.scroll === 'infinite'; },
    currentRange() {
      if (this.isInfinite) return [0, this.currentPage * this.pageSize];
      const startingPage = Math.min(this.numPages, this.currentPage);
      return [(startingPage - 1) * this.pageSize, startingPage * this.pageSize];
    },
    effectivePage() { return Math.min(this.currentPage, this.numPages); },
    numPages() { return Math.ceil(this.length / this.pageSize) || 1; },
    pagesToShow() {
      let start = this.currentPage - 2;
      let end = this.currentPage + 2;
      if (start < 1) { end += (1 - start); start = 1; }
      const endDifference = end - this.numPages;
      if (endDifference > 0) { end = this.numPages; start = Math.max(1, start - endDifference); }
      const array = [];
      for (let idx = start; idx <= end; idx++) array.push(idx);
      return array;
    },
  },
  methods: {
    // Infinite Scrolling
    handleScroll(event) {
      if (this.isInfinite && this.currentPage < this.numPages
        && event.target.scrollTop >= event.target.scrollHeight - event.target.clientHeight - 400) {
        this.currentPage += 1;
        this.$emit('onRangeChange', this.currentRange);
      }
    },
    // Pagination
    isCurrentPage(idx) {
      return idx === this.currentPage || (idx === this.numPages && this.currentPage > this.numPages);
    },
    changePage(event) {
      const value = event.target.valueAsNumber;
      if (!isNaN(value) && value >= 1 && value <= this.numPages) {
        this.currentPage = value;
        this.$emit('onRangeChange', this.currentRange);
      }
    },
    goToPage(page) { this.currentPage = page; this.$emit('onRangeChange', this.currentRange); },
    goToPrevious() { if (this.currentPage > 1) { this.currentPage -= 1; this.$emit('onRangeChange', this.currentRange); } },
    goToNext() { if (this.currentPage < this.numPages) { this.currentPage += 1; this.$emit('onRangeChange', this.currentRange); } },
    goToEnd() { this.currentPage = this.numPages; this.$emit('onRangeChange', this.currentRange); },
  },
});

// ─── pages ───────────────────────────────────────────────────────────────────

Vue.component('wall-notice', {
  template: '#wall-notice',
  mixins: [shared],
  props: { uploader: { type: String, default: null } },
  computed: {
    failed() { return this.app.wall.failed.filter(x => !this.uploader || x.src.uploader === this.uploader); },
  },
});

// views/pages/home.ejs: the newest games, each uploader's most played, each shelf
Vue.component('cider-home', {
  template: '#cider-home',
  mixins: [shared],
  computed: {
    sections() {
      const a = this.app, L = Launcher;
      const item = new Map(a.gameItems.map(i => [i.id, i]));
      const out = [];
      const newest = a.games.slice().sort(L.byNewest).slice(0, 24).map(g => item.get(g.identifier));
      out.push({ key: 'newest', title: 'Newest on the wall', items: newest, seeAll: 'wall' });
      for (const s of a.enabledSources) {
        if (a.wall.failed.some(f => f.src.uploader === s.uploader)) continue;
        const list = a.games.filter(g => (g._versions || [g]).some(v => v._uploader === s.uploader)).sort(L.byDownloads);
        if (!list.length && !a.wall.loading) continue;
        out.push({ key: `u:${s.uploader}`, title: `Most played from ${L.sourceName(s)}`, count: list.length || null,
          items: list.slice(0, 20).map(g => item.get(g.identifier)), seeAll: `uploader/${encodeURIComponent(s.uploader)}` });
      }
      const ports = new Map(a.portItems.map(i => [i.id, i]));
      for (const shelf of a.ports?.shelves || []) {
        const list = a.ports.items.filter(i => i.shelf === shelf.id)
          .sort((x, y) => (y.data.status === 'available') - (x.data.status === 'available'));
        if (!list.length) continue;
        out.push({ key: `s:${shelf.id}`, title: `${shelf.name} ports`, count: list.length,
          items: list.slice(0, 20).map(p => ports.get(p.id)), seeAll: `shelf/${encodeURIComponent(shelf.id)}` });
      }
      if (!a.ports && !a.portsError) out.push({ key: 'ports', title: 'Ports', items: [] });
      return out;
    },
  },
});

// New: the hand-picked games and ports, then what landed most recently
Vue.component('cider-new', {
  template: '#cider-new',
  mixins: [shared],
  computed: {
    byNewest() {
      const L = Launcher;
      return this.app.games.slice().sort((a, b) => L.byNewest(L.newestVersion(a), L.newestVersion(b)));
    },
    picks() {
      const a = this.app;
      return a.featured.flatMap((pick) => {
        if (pick.identifier) {
          const g = a.games.find(x => (x._versions || [x]).some(v => v.identifier === pick.identifier));
          return g ? [a.gameItems.find(i => i.id === g.identifier)] : [];
        }
        const p = a.ports?.items.find(x => String(x.repository).toLowerCase() === pick.repository);
        return p ? [a.portItems.find(i => i.id === p.id)] : [];
      }).filter(Boolean);
    },
    recent() {
      return this.byNewest.slice(0, 8).map(g => Launcher.gameItem(Launcher.newestVersion(g))).map((it, i) => ({ ...it, _game: this.byNewest[i] }));
    },
    week() {
      const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
      const ids = new Set(this.byNewest.filter(g => String(Launcher.newestVersion(g).addeddate || '') >= weekAgo).map(g => g.identifier));
      return this.app.gameItems.filter(i => ids.has(i.id));
    },
    newPorts() {
      const added = new Set(this.app.review.flatMap(r => r.added.map(x => `${r.id}|${String(x.repository).toLowerCase()}`)));
      return this.app.portItems.filter(i => added.has(`${i._port.shelf}|${String(i._port.repository).toLowerCase()}`));
    },
  },
});

// views/pages/library-albums.ejs, for the wall, an uploader, a port shelf and the library
Vue.component('cider-library-page', {
  template: '#cider-library-page',
  mixins: [shared],
  props: {
    kind: { type: String, required: true },   // wall | uploader | shelf | library
    arg: { type: String, default: null },
  },
  data() {
    const pageSize = 60;
    return { pageSize, start: 0, end: pageSize, searchTerm: '', shelfTag: '' };
  },
  computed: {
    prefsKey() { return this.kind === 'uploader' ? 'wall' : this.kind; },
    prefs() { return this.app.libraryPrefs[this.prefsKey]; },
    sorts() {
      const L = Launcher;
      if (this.kind === 'shelf') return L.PORT_SORTS;
      if (this.kind === 'library') {
        return {
          name: ['Title', x => x.attributes.name],
          dateAdded: ['Date added', x => this.app.library[x.id]?.added_at || this.app.library[this.installedId(x)]?.added_at],
        };
      }
      return L.GAME_SORTS;
    },
    shelf() { return this.kind === 'shelf' ? this.app.ports?.shelves.find(s => s.id === this.arg) : null; },
    shelfTags() {
      const all = (this.app.ports?.items || []).filter(i => i.shelf === this.arg);
      return [...new Set(all.flatMap(i => i.tags))].slice(0, 12);
    },
    loading() {
      if (this.kind === 'shelf') return !this.app.ports;
      return this.app.wall.loading;
    },
    list() {
      const a = this.app, L = Launcher, p = this.prefs;
      const sort = (this.sorts[p.sort] || Object.values(this.sorts)[0])[1];
      if (this.kind === 'shelf') {
        let ports = (a.ports?.items || []).filter(i => i.shelf === this.arg)
          .filter(i => (!this.shelfTag || i.tags.includes(this.shelfTag)) && (!p.data || i.data.status === 'available'));
        ports = L.ciderSearch(ports, this.searchTerm, i => [i.name, i.project, i.repository, ...i.tags]);
        ports = L.ciderSort(L.ciderSort(ports, i => i.name, 'asc'), sort, p.order);
        const byId = new Map(a.portItems.map(i => [i.id, i]));
        return ports.map(i => byId.get(i.id));
      }
      if (this.kind === 'library') {
        const installed = Object.values(a.library).filter(l => l.install_dir && !l.identifier.startsWith('quiver:'));
        const games = [...new Map(installed.map(l => {
          const g = a.games.find(x => (x._versions || [x]).some(v => v.identifier === l.identifier))
            || { identifier: l.identifier, title: l.identifier, _sourceLabel: 'archive.org' };
          return [g.identifier, g];
        })).values()].map(g => a.gameItems.find(i => i.id === g.identifier) || Object.freeze(L.gameItem(g)));
        const ports = a.portItems.filter(i => a.library[i.id]);
        const items = L.ciderSearch([...games, ...ports], this.searchTerm, i => [i.attributes.name, i.attributes.artistName]);
        return L.ciderSort(items, sort, p.order);
      }
      const who = this.kind === 'uploader' ? this.arg : p.uploader || null;
      let games = a.games.filter(g => !who || (g._versions || [g]).some(v => v._uploader === who));
      games = L.ciderSearch(games, this.searchTerm, g => [getTitle(g), g._sourceLabel, g.identifier, ...(g._versions || []).map(v => getTitle(v))]);
      games = L.ciderSort(games, sort, p.order);
      const byId = new Map(a.gameItems.map(i => [i.id, i]));
      return games.map(g => byId.get(g.identifier));
    },
    currentSlice() { return this.list.slice(this.start, this.end); },
    countLine() {
      const n = Launcher.fmtNum(this.list.length);
      if (this.kind === 'shelf' && this.shelf) {
        return `${n} ports · Source: Quiver / ${this.shelf.name}${this.shelf.withData ? ` · ${this.shelf.withData} with data from archive.org` : ''}`;
      }
      if (this.kind === 'library') return `${n} in your library`;
      return `${n} titles${this.app.wall.loading ? ' · still loading uploaders…' : ''}`;
    },
    emptyText() {
      if (this.searchTerm) return 'Nothing matches that search.';
      if (this.kind === 'library') return 'Your library is empty. Install something from the game wall, or open a Ports shelf and add a port.';
      if (this.kind === 'shelf' && this.app.portsError) return `Couldn't load the catalogs: ${this.app.portsError}`;
      return 'Nothing here yet.';
    },
    reload() {
      if (this.kind === 'shelf') return () => { this.app.toast('Checking the catalogs…', 'info', 2000); this.app.loadPorts(true); };
      if (this.kind === 'library') return () => this.app.reloadLibrary();
      return () => this.app.loadWall({ refresh: true });
    },
  },
  watch: {
    prefs: { deep: true, handler() { Launcher.savePrefs(this.app.libraryPrefs); } },
  },
  methods: {
    onRangeChange(newRange) {
      this.start = newRange[0];
      this.end = newRange[1];
    },
    installedId(item) {
      return item._game ? (this.app.installedVersion(item._game) || item._game).identifier : item.id;
    },
    metaFor(item) {
      const L = Launcher;
      if (item._port) return [item._port.repository, item._port.shelfName];
      const g = item._game;
      return [L.fmtDate(g.addeddate), g.downloads ? `${L.fmtNum(g.downloads)} downloads` : ''];
    },
    badgeFor(item) {
      if (item._port) return this.app.library[item.id]?.install_dir ? 'Installed' : item._port.data.status === 'available' ? 'Data' : '';
      const n = item._game._versions?.length || 1;
      return this.app.isInstalled(item._game) ? 'Installed' : n > 1 ? `${n} versions` : '';
    },
  },
});

// Keep current: catalog entries added, changed or removed since last seen
Vue.component('cider-updates', {
  template: '#cider-updates',
  mixins: [shared],
  methods: {
    rows(r) {
      const a = this.app;
      const all = [...r.added.map(x => ['added', x]), ...r.changed.map(x => ['changed', x]), ...r.removed.map(x => ['removed', x])];
      return all.map(([what, x]) => {
        const port = a.ports?.items.find(i => i.shelf === r.id && i.repository === x.repository && i.folderName === (x.folderName || ''));
        const item = port ? a.portItems.find(i => i.id === port.id)
          : { id: `${r.id}:${x.repository}`, type: 'port', attributes: { name: x.name, artistName: x.repository, artwork: { url: x.appIconUrl || '', bgColor: Launcher.tint(x.repository) } } };
        return { what, port, item };
      });
    },
  },
});

Vue.component('cider-search', {
  template: '#cider-search',
  mixins: [shared],
  computed: {
    needle() { return this.app.search.term.trim().toLowerCase(); },
    games() {
      const n = this.needle;
      if (!n) return [];
      return this.app.gameItems.filter(i => (i._game._versions || [i._game]).some(v => getTitle(v).toLowerCase().includes(n) || v.identifier.includes(n)));
    },
    ports() {
      const n = this.needle;
      if (!n) return [];
      return this.app.portItems.filter(i => [i._port.name, i._port.project, i._port.repository, ...i._port.tags].some(x => String(x).toLowerCase().includes(n)));
    },
  },
});

// views/pages/cider-playlist.ejs: a game (its versions as the track list) or a port
Vue.component('cider-detail', {
  template: '#cider-detail',
  mixins: [shared],
  props: {
    kind: { type: String, required: true },   // game | port
    id: { type: String, required: true },
  },
  data() { return { version: null, tab: 'details', artSrc: '' }; },
  computed: {
    game() { return this.kind === 'game' ? this.app.findGame(this.id) : null; },
    port() { return this.kind === 'port' ? this.app.findPort(this.id) : null; },
    target() { return this.game || this.port; },
    versions() { return this.game ? (this.game._versions || [this.game]) : []; },
    v() { return this.version || (this.game && (this.app.installedVersion(this.game) || this.game)); },
    targetId() { return this.game ? this.v.identifier : this.port.id; },
    actTarget() { return this.game ? this.v : this.app.portTarget(this.port); },
    name() { return this.game ? getTitle(this.v) : this.port.name; },
    genre() {
      if (this.game) return `archive.org${this.v.addeddate ? ` · ${Launcher.fmtDate(this.v.addeddate)}` : ''}${this.versions.length > 1 ? ` · ${this.versions.length} versions` : ''}`;
      return `Quiver / ${this.port.shelfName}${this.port.data.status === 'available' ? ' · game data on archive.org' : ''}`;
    },
    artist() { return this.game ? (this.v._sourceLabel || '') : (this.port.project || this.port.repository); },
    artUrl() { return this.game ? Launcher.coverUrl(this.v.identifier) : (this.port.iconUrl || ''); },
    tintBg() { return Launcher.tint(this.game ? this.name : this.port.repository); },
    description() {
      if (this.game) return Launcher.stripHtml(Array.isArray(this.v.description) ? this.v.description.join('\n') : this.v.description);
      return this.port.description ? Launcher.stripHtml(this.port.description) : '';
    },
    blurb() {
      const b = this.description.replace(/\s+/g, ' ').trim();
      return b.length > 220 ? `${b.slice(0, 217)}…` : b;
    },
    installed() { return !!this.app.library[this.targetId]?.install_dir; },
    inLibrary() { return this.port ? this.app.inPortLibrary(this.port) : false; },
    dl() { return this.app.downloads[this.targetId] || null; },
    stepText() {
      const steps = { binary: 'The build from GitHub · ', data: 'The game data from archive.org · ' };
      return steps[this.dl?.step] || '';
    },
    details() {
      const L = Launcher, lib = this.app.library[this.targetId];
      if (this.game) {
        const v = this.v;
        return [
          ['Uploader', v._uploader || ''],
          ['Item', v.identifier, `https://archive.org/details/${v.identifier}`],
          ['Downloads', L.fmtNum(v.downloads)],
          ['Added', L.fmtDate(v.addeddate)],
          ...(lib?.install_dir ? [['Installed to', lib.install_dir]] : []),
        ];
      }
      const p = this.port;
      const data = p.data.status === 'available'
        ? `archive.org (${p.data.uploader || p.data.iaIdentifier}), ${p.data.files.join(', ') || 'item contents'}, sha1-checked after staging`
        : 'None needed, as far as the catalog knows';
      return [
        ['Binary', `GitHub release from ${p.repository}`],
        ['Game data', data],
        ['Repository', p.repository, `https://github.com/${p.repository}`],
        ['Folder', p.folderName],
        ...(p.releaseAssetFilter ? [['Asset filter', p.releaseAssetFilter]] : []),
        ...(p.filesToAdd.length ? [['Files to add', p.filesToAdd.join(', ')]] : []),
        ['Catalog', p.catalogUrl],
        ...(lib?.install_dir ? [['Installed to', lib.install_dir]] : []),
      ];
    },
  },
  watch: {
    artUrl: { immediate: true, handler(url) { Launcher.resolveArtwork(url).then((src) => { this.artSrc = src; }); } },
    target: { immediate: true, handler(t) { if (t && this.versions.length > 1 && this.tab === 'details' && !this.touched) this.tab = 'versions'; } },
    tab() { this.touched = true; },
  },
  methods: {
    versionItem(v) {
      return { id: v.identifier, type: 'version', attributes: { name: v._sourceLabel || v._uploader || v.identifier, artistName: getTitle(v) } };
    },
    install() { return this.game ? this.app.installGame(this.v) : this.app.installPort(this.port); },
    play() { return this.game ? this.app.playGame(this.v) : this.app.launchPort(this.port); },
    menu(event) {
      return this.game ? this.app.gameMenu(this.game, event) : this.app.portMenu(this.port, event);
    },
    artistClick() {
      if (this.game && this.v._uploader) this.app.appRoute(`uploader/${encodeURIComponent(this.v._uploader)}`);
      else if (this.port) this.api.openExternal(`https://github.com/${this.port.repository}`);
    },
  },
});

// Game data: the collision editor (new/app.js's viewCollision, docs/COLLISIONS.md)
const ARCHIVE_RE = /\.(zip|7z|rar)$/i;
const blankSource = () => ({ ia: '', path: '', target: '', extract: false, sha1: '', optional: false });
const fmtBytes = (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`; };

Vue.component('cider-collision', {
  template: '#cider-collision',
  mixins: [shared],
  props: { repo: { type: String, default: null } },
  data() { return { ed: null }; },
  computed: {
    fromText() {
      const ed = this.ed;
      if (ed.origin === 'local') return 'Yours.';
      if (ed.origin === 'feed') return `From the ${ed.feed?.name || ''} feed. Saving makes a copy of your own that wins over it.`;
      if (ed.origin === 'bundled') return 'Bundled with the launcher. Saving makes a copy of your own that wins over it.';
      return 'Nothing yet.';
    },
    legacy() {
      const x = this.ed.extra;
      if (!x.dataFiles?.length) return '';
      return `Also picks ${x.dataFiles.map(d => d.name).join(', ')} out of ${decodeURIComponent(String(x.contentUrl || '').split('/').pop())} (the first version of the schema). That part is kept as it is.`;
    },
    browseFolders() {
      const b = this.ed.browse, f = b.filter.toLowerCase();
      return b.folders.filter(d => d.toLowerCase().includes(f));
    },
    browseFiles() {
      const b = this.ed.browse, f = b.filter.toLowerCase();
      return b.files.filter(x => x.name.toLowerCase().includes(f) && x.source !== 'metadata' && x.source !== 'derivative'
        && !/(_meta\.xml|_files\.xml|_meta\.sqlite|_reviews\.xml|_archive\.torrent|__ia_thumb\.jpg)$/i.test(x.name));
    },
  },
  mounted() { this.start(); },
  methods: {
    fmtBytes,
    // Loads the collision in effect for repo (or a blank one for a new repo)
    async start() {
      const repo = this.repo;
      const port = repo && this.app.ports?.items.find(i => i.repository?.toLowerCase() === repo.toLowerCase());
      const ed = {
        repo: repo || '', isNew: !repo, loading: !!repo, origin: null, feed: null, extra: {},
        name: port?.name || '', folderName: port?.folderName || '', assetPattern: '', base: 'binary', binaryTarget: '',
        sources: repo ? [] : [blankSource()], browse: null, preview: null, errors: null,
      };
      this.ed = ed;
      if (!repo) return;
      const c = await api.getCollision(repo);
      if (this.ed !== ed) return;
      if (c) {
        const { repository, name, folderName, assetPattern, base, binaryTarget, sources, ...extra } = c.entry;
        void repository;
        Object.assign(ed, {
          origin: c.origin, feed: c.feed || null, extra,
          name: name || ed.name, folderName: folderName || ed.folderName, assetPattern: assetPattern || '',
          base: base === 'data' ? 'data' : 'binary', binaryTarget: binaryTarget || '',
          sources: (sources || []).map(x => ({ ...blankSource(), ...x, sha1: x.sha1 || '', target: x.target || '' })),
        });
      }
      if (!ed.sources.length) ed.sources.push(blankSource());
      ed.loading = false;
    },
    addSource() { this.ed.sources.push(blankSource()); },
    removeSource(i) {
      this.ed.sources.splice(i, 1);
      if (this.ed.browse?.i === i) this.ed.browse = null;
    },
    async browse(i) {
      const ed = this.ed;
      const ia = ed.sources[i].ia.trim();
      if (!ia) return this.app.toast('Type an archive.org item first.', 'error');
      const b = { i, ia, loading: true, files: [], folders: [], filter: '', error: null };
      ed.browse = b;
      const r = await api.fetchItemFiles(ia);
      if (ed.browse !== b) return;
      Object.assign(b, { loading: false, files: r.files || [], folders: r.folders || [], error: r.ok ? null : r.error });
    },
    // A pick from the browser: a file (with archive.org's sha1), a folder/* or *
    take(p) {
      const ed = this.ed, b = ed.browse;
      if (!b) return;
      const x = ed.sources[b.i];
      const file = b.files.find(f => f.name === p);
      const archive = !!file && ARCHIVE_RE.test(p);
      Object.assign(x, { ia: b.ia, path: p, sha1: file?.sha1 || '', extract: archive && (x.extract || ed.base === 'data') });
      ed.browse = null;
    },
    entry() {
      const ed = this.ed;
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
    },
    async preview() {
      const ed = this.ed;
      const sources = this.entry().sources || [];
      if (!sources.length) return this.app.toast('Add a source to preview.', 'error');
      ed.preview = { loading: true };
      const list = await api.previewCollision(sources);
      if (this.ed !== ed) return;
      ed.preview = list ? { list } : null;
      if (!list) this.app.toast("Couldn't reach the backend for a preview.", 'error');
    },
    async save() {
      const ed = this.ed;
      const repo = ed.repo.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { ed.errors = ['The repository must look like owner/repo.']; return; }
      const r = await api.saveCollision(repo, this.entry());
      if (!r.ok) { ed.errors = r.error.split('; '); return; }
      this.app.toast(`Saved the game data for ${ed.name || repo}. It's yours now, and wins over any feed's.`, 'success');
      await this.app.loadPorts();
      const port = this.app.ports?.items.find(i => i.repository?.toLowerCase() === repo.toLowerCase());
      this.app.appRoute(port ? `port/${encodeURIComponent(port.id)}` : `collision/${encodeURIComponent(repo)}`);
    },
    async remove() {
      const ed = this.ed;
      if (!confirm(`Remove your game data for ${ed.repo}? A feed's or the bundled one takes over again, if there is one.`)) return;
      await api.deleteCollision(ed.repo);
      this.app.toast('Removed yours.');
      await this.app.loadPorts();
      this.start();
    },
    async exportFeed() {
      const feed = await api.exportCollisions();
      try {
        await navigator.clipboard.writeText(JSON.stringify(feed, null, 2));
        this.app.toast(`Copied ${feed.collisions.length} collision${feed.collisions.length === 1 ? '' : 's'} as a feed file. Publish it anywhere and others can subscribe to its URL.`, 'success', 6000);
      } catch {
        this.app.toast("Couldn't reach the clipboard.", 'error');
      }
    },
  },
});

// views/components/settings-window.ejs
Vue.component('settings-window', {
  template: '#settings-window',
  mixins: [shared],
  data() {
    const s = this.$root.settings;
    return {
      maxed: false,
      tab: 0,
      tabs: [
        { id: 'general', name: 'General', icon: './assets/settings.svg' },
        { id: 'catalogs', name: 'Catalogs', icon: './assets/feather/globe.svg' },
        { id: 'interface', name: 'Interface', icon: './assets/feather/style.svg' },
        { id: 'about', name: 'About', icon: './assets/feather/zap.svg' },
      ],
      form: { sourcesText: formatSources(this.$root.sources), installPath: s.installPath || '', downloadPath: s.downloadPath || '' },
      feeds: null,
      feedUrl: '',
    };
  },
  mounted() { this.loadFeeds(); },
  methods: {
    close() { this.app.modals.settings = false; },
    // Collision feeds (new/app.js's Settings)
    async loadFeeds() { this.feeds = await api.getCollisionFeeds().catch(() => []); },
    async addFeed() {
      const url = this.feedUrl.trim();
      if (!url) return this.app.toast('Paste the URL of a collisions feed.', 'error');
      const r = await api.addCollisionFeed({ url });
      if (!r.ok) return this.app.toast(`Couldn't subscribe: ${r.error}`, 'error');
      this.app.toast(`Subscribed to ${r.feed.name}: ${r.feed.entries} collisions${r.feed.error ? ` (${r.feed.error})` : ''}.`, 'success');
      this.feedUrl = '';
      await this.loadFeeds();
      this.app.loadPorts();
    },
    async refreshFeed(id) { await api.refreshCollisionFeed(id); return this.loadFeeds(); },
    async removeFeed(id) { await api.removeCollisionFeed(id); await this.loadFeeds(); return this.app.loadPorts(); },
    async choose(key) {
      const p = await api.chooseFolder();
      if (p) this.form[key] = p;
    },
  },
});

// views/components/add-to-playlist.ejs, as the executable picker
Vue.component('exe-picker', {
  template: '#exe-picker',
  data() {
    return { sorted: [], searchQuery: '', focused: '', app: this.$root };
  },
  computed: {
    title() {
      return { steam: 'Pick the executable for Steam', default: 'Pick the executable to launch by default', play: 'Pick the executable' }[this.app.exePicker.purpose];
    },
  },
  mounted() {
    this.search();
    this.$refs.searchInput.focus();
    this.$refs.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.focused !== '') this.app.choseExe(this.focused);
    });
  },
  methods: {
    close() { this.app.modals.exePicker = false; },
    search() {
      this.focused = '';
      const list = this.app.exePicker.list;
      if (this.searchQuery === '') {
        this.sorted = list;
      } else {
        this.sorted = list.filter(x => x.toLowerCase().includes(this.searchQuery.toLowerCase()));
        if (this.sorted.length === 1) this.focused = this.sorted[0];
      }
    },
  },
});
