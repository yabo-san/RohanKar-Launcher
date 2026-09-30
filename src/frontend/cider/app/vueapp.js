'use strict';
/**
 * The Vue root of the Cider fork. Derived from Cider's
 * src/renderer/main/vueapp.js (github.com/ciderapp/Cider, AGPL-3.0; see
 * ../LICENSE and ../NOTICE): the chrome, menuPanel, modals and page routing
 * (appRoute, setWindowHash, navigateBack with the wpfade_transform page
 * transitions, showMenuPanel, getAppClasses, setWindowScaleFactor, the notyf
 * toasts and the Mica background) keep Cider's names and shape. MusicKit,
 * audio, lyrics, casting, themes and plugins are gone; the data is the
 * launcher's, from ../api.js through launcher.js.
 */
/* global Launcher, VueObserveVisibility, Notyf */

Vue.use(VueObserveVisibility);
const notyf = new Notyf();
const L = Launcher;
const enc = encodeURIComponent;

// Sidebar groups fold like Cider's cfg.general.sidebarCollapsed, and stay as left
const FOLDED_KEY = 'y4bo.ciderSidebarCollapsed';
function loadFolded() {
  try { return { cider: false, uploaders: false, ports: false, library: false, ...JSON.parse(localStorage.getItem(FOLDED_KEY)) }; } catch { return { cider: false, uploaders: false, ports: false, library: false }; }
}

const PAGE_TITLES = { home: 'Home', new: 'New', wall: 'Game wall', library: 'Library', updates: 'Keep current', search: 'Search', collision: 'Game data' };

const app = new Vue({
  L,                    // launcher.js, for the templates ($root.$options.L)
  data: {
    appMode: 'player',
    platform: /Linux/.test(navigator.platform) ? 'linux' : 'win32',
    version: '',
    search: { term: '' },
    chrome: {
      sidebarCollapsed: false,
      windowState: 'normal',
      desiredPageTransition: 'wpfade_transform',
      menuOpened: false,
      maximized: false,
      windowControlPosition: 'right',
      contentAreaScrolling: true,
    },
    cfg: {
      general: { sidebarCollapsed: loadFolded() },
      visual: { window_background_style: 'mica' },
    },
    page: '',
    menuPanel: {
      visible: false,
      event: null,
      content: { name: '', items: {}, headerItems: {} },
    },
    modals: { settings: false, exePicker: false },
    exePicker: { purpose: 'play', list: [], target: null },
    notyf,

    // The launcher's state (new/app.js's `state`)
    settings: {},
    sources: [],
    library: {},          // library.db rows, keyed by identifier (ports by quiver: id)
    games: [],            // one entry per title, with _versions
    versions: [],
    wall: { loading: true, loaded: [], failed: [] },
    ports: null,          // { shelves, items }
    portsError: null,
    review: [],
    featured: [],
    downloads: {},        // identifier -> { percent, status, step, jobId }
    libraryPrefs: L.loadPrefs(),
  },
  watch: {
    'cfg.general.sidebarCollapsed': {
      deep: true,
      handler(v) { try { localStorage.setItem(FOLDED_KEY, JSON.stringify(v)); } catch { /* storage off */ } },
    },
  },
  computed: {
    route() {
      const [name, ...rest] = this.page.split('/');
      return { name: name || 'home', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
    },
    enabledSources() { return this.sources.filter(s => s.enabled !== false); },
    portLibrary() { return Object.keys(this.library).filter(id => id.startsWith('quiver:')); },
    gameItems() { return this.games.map(g => Object.freeze(L.gameItem(g))); },
    portItems() { return (this.ports?.items || []).map(p => Object.freeze(L.portItem(p))); },
    reviewCount() { return this.review.reduce((n, r) => n + r.added.length + r.changed.length + r.removed.length, 0); },
    libraryCount() { return Object.values(this.library).filter(l => l.install_dir).length + this.portLibrary.filter(id => !this.library[id]?.install_dir).length; },
    // The LCD in the top chrome: the running install, if any
    activeDownload() {
      const id = Object.keys(this.downloads)[0];
      if (!id) return null;
      const g = this.versions.find(v => v.identifier === id);
      const p = this.ports?.items.find(x => x.id === id);
      return { id, dl: this.downloads[id], name: g ? getTitle(g) : p?.name || id, url: g ? L.coverUrl(id) : p?.iconUrl || '' };
    },
    pageTitle() {
      const r = this.route;
      if (r.name === 'uploader') return L.sourceName(this.sources.find(s => s.uploader === r.arg) || { uploader: r.arg || '' });
      if (r.name === 'shelf') return `${this.ports?.shelves.find(s => s.id === r.arg)?.name || ''} ports`;
      return PAGE_TITLES[r.name] || 'Home';
    },
  },
  methods: {
    // ─── Cider's chrome and routing ────────────────────────────────────────
    getLz(key) { return key; },
    setTimeout(func, time) { return setTimeout(func, time); },
    getAppClasses() {
      return { simplebg: this.cfg.visual.window_background_style === 'none' };
    },
    getAppStyle() { return {}; },
    setWindowScaleFactor() {
      let scale = (((window.devicePixelRatio * window.innerWidth) / 1280) * window.innerHeight) / 720;
      const desiredScale = 1.5;
      if (scale <= 1) scale = 1;
      else if (scale >= desiredScale) scale = desiredScale;
      document.documentElement.style.setProperty('--windowRelativeScale', scale);
    },
    setWindowHash(route = '') {
      window.location.hash = `#${route}`;
    },
    appRoute(route) {
      route = String(route || '').replace(/^#/, '');
      if (route === '' || route === '/') route = 'home';
      if (route === 'settings') { this.modals.settings = true; return; }
      this.page = route;
      if (window.location.hash !== `#${route}`) window.location.hash = route;
      this.$nextTick(() => { const c = document.getElementById('app-content'); if (c) c.scrollTop = 0; });
    },
    navigateBack() {
      this.chrome.desiredPageTransition = 'wpfade_transform_backwards';
      return new Promise((resolve) => {
        history.back();
        setTimeout(() => resolve((this.chrome.desiredPageTransition = 'wpfade_transform')), 100);
      });
    },
    navigateForward() {
      history.forward();
    },
    getSidebarItemClass(page) {
      return this.page === page && !this.search.term ? ['active'] : [];
    },
    mainMenuVisibility(val) {
      if (val) {
        (this.chrome.menuOpened = !this.chrome.menuOpened);
        if (this.chrome.menuOpened) this.$refs.mainMenuButton?.focus?.();
      } else {
        setTimeout(() => { this.chrome.menuOpened = false; }, 100);
      }
    },
    showMenuPanel(data, event) {
      app.menuPanel.visible = true;
      app.menuPanel.content.name = data.name ?? '';
      app.menuPanel.content.items = data.items ?? {};
      app.menuPanel.content.headerItems = data.headerItems ?? {};
      if (event) app.menuPanel.event = event;
    },
    searchQuery() {
      if (this.search.term.trim()) this.appRoute('search');
    },
    windowAction(action) {
      if (action === 'maximize') this.chrome.maximized = !this.chrome.maximized;
      return { minimize: api.windowMinimize, maximize: api.windowMaximize, close: api.windowClose }[action]();
    },
    toast(message, type = 'info', duration = 4000) {
      const opts = { message: L.esc(message), duration, dismissible: false };
      if (type === 'error') return notyf.error(opts);
      if (type === 'success') return notyf.success(opts);
      return notyf.open({ ...opts, type: 'info', className: 'notyf-info' });
    },

    // The Mica background: Cider blurs the desktop wallpaper behind the
    // window (spawnMica, main/mica.js); a browser page can't read it, so the
    // launcher's own wall stands in, drawn as a blurred collage of covers
    async spawnMica() {
      if (window.micaSpawned || this.games.length < 4) return;
      window.micaSpawned = true;
      const picks = this.games.slice().sort(L.byDownloads).slice(0, 9);
      const urls = (await Promise.all(picks.map(g => L.thumb(g.identifier)))).filter(Boolean);
      if (!urls.length) { window.micaSpawned = false; return; }
      const canvas = document.createElement('canvas');
      canvas.width = 480; canvas.height = 300;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.filter = 'blur(40px)';
      const imgs = await Promise.all(urls.map(u => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = u; })));
      imgs.filter(Boolean).forEach((img, n) => {
        const w = canvas.width / 3, h = canvas.height / 3;
        ctx.drawImage(img, (n % 3) * w - 20, Math.floor(n / 3) * h - 20, w + 40, h + 40);
      });
      const micaDiv = document.createElement('div');
      micaDiv.id = 'micaEffect';
      Object.assign(micaDiv.style, { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', zIndex: -1 });
      micaDiv.style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.8)})`;
      micaDiv.style.backgroundSize = 'cover';
      document.body.appendChild(micaDiv);
    },

    // ─── loading ───────────────────────────────────────────────────────────
    async reloadLibrary() {
      this.library = await api.getLibrary().catch(() => ({}));
    },
    async loadWall({ refresh = false } = {}) {
      this.wall = { loading: true, loaded: [], failed: [] };
      const { games, versions, failed, loaded } = await L.loadWall(this.sources, { refresh });
      versions.forEach(Object.freeze);
      this.versions = Object.freeze(versions);
      this.games = Object.freeze(games);
      this.wall = { loading: false, loaded, failed };
      if (failed.length) this.toast(`Couldn't load ${failed.map(f => L.sourceName(f.src)).join(', ')}: ${failed[0].error}`, 'error', 8000);
      this.spawnMica();
    },
    async loadPorts(refresh = false) {
      try {
        const { ports, review } = await L.loadPorts(this.settings, refresh);
        ports.items.forEach(Object.freeze);
        this.ports = Object.freeze(ports);
        this.review = review;
        this.portsError = null;
      } catch (e) {
        this.portsError = e.message;
      }
      await this.reloadLibrary();
    },

    // ─── lookups ───────────────────────────────────────────────────────────
    findGame(id) { return this.games.find(x => x.identifier === id) || this.versions.find(x => x.identifier === id); },
    findPort(id) { return this.ports?.items.find(x => x.id === id); },
    isInstalled(g) { return (g._versions || [g]).some(v => this.library[v.identifier]?.install_dir); },
    installedVersion(g) { return (g._versions || [g]).find(v => this.library[v.identifier]?.install_dir); },
    inPortLibrary(p) { return !!this.library[p.id]; },
    portTarget(p) { return { identifier: p.id, title: p.name }; },

    // Cider's routeView: a card opens its page
    routeView(item) {
      this.appRoute(`${item.type === 'port' ? 'port' : 'game'}/${enc(item.id)}`);
    },
    // Cider's playMediaItem: the round button on a card. Installed: launch;
    // otherwise install, with toasts either way
    playMediaItem(item) {
      if (item.type === 'port') {
        const p = item._port;
        return this.library[p.id]?.install_dir ? this.launchPort(p) : this.installPort(p);
      }
      const g = item._game;
      const v = this.installedVersion(g);
      return v ? this.playGame(v) : this.installGame(g);
    },

    // ─── context menus (Cider's menu-panel) ────────────────────────────────
    contextMenu(item, event) {
      return item.type === 'port' ? this.portMenu(item._port, event) : this.gameMenu(item._game, event);
    },
    gameMenu(g, event) {
      const v = this.installedVersion(g) || g;
      const installed = !!this.library[v.identifier]?.install_dir;
      const busy = !!this.downloads[v.identifier];
      this.showMenuPanel({
        headerItems: [
          { icon: './assets/feather/list.svg', id: 'details', name: 'Details', action: () => this.appRoute(`game/${enc(g.identifier)}`) },
          { icon: './assets/feather/external-link.svg', id: 'web', name: 'archive.org', action: () => api.openExternal(`https://archive.org/details/${v.identifier}`) },
        ],
        items: [
          { icon: './assets/feather/play.svg', name: 'Play', hidden: !installed, action: () => this.playGame(v) },
          { icon: './assets/feather/plus-circle.svg', name: 'Install', hidden: installed || busy, action: () => this.installGame(g) },
          { icon: './assets/feather/x-circle.svg', name: 'Cancel download', hidden: !busy, action: () => this.cancelDownload(v.identifier) },
          { icon: './assets/feather/folder.svg', name: 'Open folder', hidden: !installed, action: () => api.openGameLocation({ identifier: v.identifier }) },
          { icon: './assets/feather/zap.svg', name: 'Add to Steam…', hidden: !installed, action: () => this.pickExe(v, 'steam') },
          { icon: './assets/feather/list.svg', name: 'Details', action: () => this.appRoute(`game/${enc(g.identifier)}`) },
          { icon: './assets/feather/x-circle.svg', name: 'Delete', hidden: !installed, action: () => this.deleteGame(v) },
        ],
      }, event);
    },
    portMenu(p, event) {
      const installed = !!this.library[p.id]?.install_dir;
      const busy = !!this.downloads[p.id];
      const added = this.inPortLibrary(p);
      this.showMenuPanel({
        headerItems: [
          { icon: added ? './assets/feather/x-circle.svg' : './assets/feather/plus.svg', id: 'library', active: added, name: added ? 'Remove from Library' : 'Add to Library', action: () => this.togglePort(p.id) },
          { icon: './assets/feather/list.svg', id: 'details', name: 'Details', action: () => this.appRoute(`port/${enc(p.id)}`) },
          { icon: './assets/feather/external-link.svg', id: 'repo', name: 'Repository on GitHub', action: () => api.openExternal(`https://github.com/${p.repository}`) },
        ],
        items: [
          { icon: './assets/feather/x-circle.svg', name: 'Cancel Download', hidden: !busy, action: () => this.cancelDownload(p.id) },
          { icon: './assets/feather/play.svg', name: 'Launch', hidden: !installed || busy, action: () => this.launchPort(p) },
          { icon: './assets/feather/folder.svg', name: 'Open Folder', hidden: !installed || busy, action: () => api.openGameLocation({ identifier: p.id }) },
          { icon: './assets/feather/plus-circle.svg', name: 'Download', hidden: installed || busy, action: () => this.installPort(p) },
          { icon: './assets/feather/hard-drive.svg', name: 'Locate Existing Install…', hidden: installed || busy, action: () => this.locateInstall(p) },
          { icon: './assets/feather/list.svg', name: 'Choose Executable…', hidden: !installed || busy, action: () => this.pickExe(this.portTarget(p), 'default') },
          { icon: './assets/feather/zap.svg', name: 'Add to Steam…', hidden: !installed || busy, action: () => this.pickExe(this.portTarget(p), 'steam') },
          { icon: added ? './assets/feather/x-circle.svg' : './assets/feather/plus.svg', name: added ? 'Remove from Library' : 'Add to Library', action: () => this.togglePort(p.id) },
          { icon: './assets/feather/list.svg', name: 'Details', action: () => this.appRoute(`port/${enc(p.id)}`) },
          { icon: './assets/feather/hard-drive.svg', name: 'Game Data…', id: 'collision', action: () => this.appRoute(`collision/${enc(p.repository)}`) },
          { icon: './assets/feather/external-link.svg', name: 'Game data on archive.org', hidden: !p.data.iaIdentifier, action: () => api.openExternal(`https://archive.org/details/${p.data.iaIdentifier}`) },
          { icon: './assets/feather/x-circle.svg', name: 'Delete', hidden: !installed || busy, action: () => this.deletePort(p) },
        ],
      }, event);
    },

    // ─── installs and launching (new/app.js's actions) ─────────────────────
    async installGame(g) {
      const v = this.installedVersion(g) || g;
      const identifier = v.identifier;
      if (this.downloads[identifier]) return;
      const list = await api.fetchFileList({ identifier });
      if (!list.ok || !list.files?.length) return this.toast(`Couldn't read the file list: ${list.error || 'no files'}`, 'error');
      const files = list.files;
      const archives = files.filter(f => /\.(zip|7z|rar)$/i.test(f.name) || (/\.exe$/i.test(f.name) && !files.some(x => /\.(zip|7z|rar)$/i.test(x.name))));
      if (!archives.length) return this.toast('No downloadable file found for this game.', 'error');
      const file = archives.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
      this.$set(this.downloads, identifier, { percent: 0, status: 'downloading', jobId: null });
      this.toast(`Installing ${getTitle(v)}…`);
      const job = await api.install({
        identifier,
        fileName:     file.name,
        onStart:      (j) => { this.downloads[identifier].jobId = j.id; },
        onProgress:   (percent) => { Object.assign(this.downloads[identifier], { percent, status: 'downloading' }); },
        onExtracting: () => { Object.assign(this.downloads[identifier], { percent: 100, status: 'extracting' }); },
      });
      this.$delete(this.downloads, identifier);
      await this.reloadLibrary();
      if (job.status === 'done') this.toast(`${getTitle(v)} is installed.`, 'success');
      else if (job.status !== 'cancelled') this.toast(`Install failed: ${job.error || 'unknown error'}`, 'error', 8000);
    },
    async installPort(p) {
      if (this.downloads[p.id]) return;
      this.$set(this.downloads, p.id, { percent: 0, status: 'downloading', step: 'binary', jobId: null });
      this.toast(`Installing ${p.name}…`);
      const job = await api.install({
        identifier:   p.id,
        onStart:      (j) => { this.downloads[p.id].jobId = j.id; },
        onProgress:   (percent, j) => { Object.assign(this.downloads[p.id], { percent, status: 'downloading', step: j.step }); },
        onExtracting: (j) => { Object.assign(this.downloads[p.id], { percent: 100, status: j.status, step: j.step }); },
      });
      this.$delete(this.downloads, p.id);
      await this.reloadLibrary();
      if (job.status === 'done') this.toast(`${p.name} is installed.`, 'success');
      else if (job.status !== 'cancelled') this.toast(`Install failed: ${job.error || 'unknown error'}`, 'error', 8000);
    },
    async cancelDownload(identifier) {
      const dl = this.downloads[identifier];
      if (dl?.jobId) await api.cancelInstall({ jobId: dl.jobId });
    },
    async playGame(v) {
      const lib = this.library[v.identifier];
      if (lib?.exe_path) return this.launch(v, lib.exe_path);
      const exes = await api.findExes({ identifier: v.identifier });
      if (!exes.length) return this.toast('No executable found. Try reinstalling.', 'error');
      if (exes.length === 1) return this.launch(v, exes[0]);
      this.openExePicker(v, 'play', exes);
    },
    async launchPort(p) {
      return this.playGame(this.portTarget(p));
    },
    async launch(v, exePath) {
      const r = await api.launchGame({ identifier: v.identifier, exePath });
      if (!r.ok) this.toast(`Couldn't launch: ${r.error}`, 'error');
      else this.toast(`Launching ${v.title ? getTitle(v) : v.identifier}…`);
    },
    async pickExe(v, purpose) {
      const exes = await api.findExes({ identifier: v.identifier });
      if (!exes.length) return this.toast('No executable found in the install folder.', 'error');
      this.openExePicker(v, purpose, exes);
    },
    openExePicker(target, purpose, list) {
      this.exePicker = { target, purpose, list };
      this.modals.exePicker = true;
    },
    async choseExe(exePath) {
      const { target: v, purpose } = this.exePicker;
      this.modals.exePicker = false;
      if (purpose === 'steam') {
        const r = await api.addToSteam({ appName: getTitle(v), exePath, startDir: exePath.replace(/[\\/][^\\/]*$/, '') });
        return this.toast(r.ok ? `Added ${getTitle(v)} to Steam. Restart Steam to see it.` : `Couldn't add to Steam: ${r.error}`, r.ok ? 'success' : 'error');
      }
      if (purpose === 'default') {
        await api.setExePath({ identifier: v.identifier, exePath });
        await this.reloadLibrary();
        return this.toast(`${getTitle(v)} now launches ${exePath.split(/[\\/]/).pop()}.`, 'success');
      }
      return this.launch(v, exePath);
    },
    async togglePort(id) {
      const p = this.findPort(id);
      if (!p) return;
      if (this.inPortLibrary(p)) {
        await api.removeFromLibrary({ id });
        this.toast(`Removed ${p.name} from your library. Installed files stay where they are.`);
      } else {
        await api.addToLibrary({ id, source: p.catalogUrl });
        this.toast(`Added ${p.name} to your library.`, 'success');
      }
      await this.reloadLibrary();
    },
    async locateInstall(p) {
      const dir = await api.chooseFolder();
      if (!dir) return;
      const r = await api.setInstallDir({ identifier: p.id, installDir: dir });
      if (!r.ok) return this.toast(`Couldn't use that folder: ${r.error}`, 'error');
      await this.reloadLibrary();
      this.toast(r.row?.exe_path ? `${p.name} is set up from ${dir}.` : `${p.name} is set up. Pick its executable with Choose Executable.`, 'success', 6000);
    },
    async deleteGame(v) {
      if (!confirm(`Delete ${getTitle(v)}? This removes its files from disk.`)) return;
      const r = await api.deleteGame({ identifier: v.identifier, trash: !!this.library[v.identifier]?.install_dir });
      if (!r.ok) return this.toast(`Couldn't delete: ${r.error}`, 'error');
      this.toast(`Deleted ${getTitle(v)}.`);
      await this.reloadLibrary();
    },
    async deletePort(p) {
      if (!confirm(`Delete ${p.name}? Its install folder goes to the Recycle Bin.`)) return;
      const r = await api.deleteGame({ identifier: p.id, trash: true });
      if (!r.ok) return this.toast(`Couldn't delete: ${r.error}`, 'error');
      this.toast(`Deleted ${p.name}.`);
      await this.reloadLibrary();
    },

    // ─── the main menu's and Settings' actions ─────────────────────────────
    reloadAll() {
      window.micaSpawned = !!document.getElementById('micaEffect');
      this.toast('Reloading the wall and the catalogs…', 'info', 2000);
      this.loadPorts(true);
      return this.loadWall({ refresh: true });
    },
    async markAllSeen() {
      await Promise.all(this.review.map(r => api.markCatalogSeen(r.id)));
      return this.loadPorts();
    },
    async saveSettings({ sourcesText, installPath, downloadPath }) {
      const sources = parseSources(sourcesText);
      if (!sources.length) return this.toast('Add at least one uploader.', 'error');
      const patch = { sources, installPath: installPath.trim(), downloadPath: downloadPath.trim() };
      await api.saveSettings(patch);
      const changed = formatSources(sources) !== formatSources(this.sources);
      this.settings = { ...this.settings, ...patch };
      this.sources = sources;
      this.toast('Settings saved.', 'success');
      if (changed) this.loadWall({ refresh: true });
    },
    // Back to the classic UI or the current new one; the choice is saved
    async switchUi(ui) {
      await api.saveSettings({ ui });
      location.href = `${ui === 'legacy' ? '../index.html' : '../new/index.html'}${location.search}`;
    },
  },
});

window.app = app;

// Cider's hash routing, and its window scale
window.addEventListener('hashchange', () => app.appRoute(window.location.hash));
window.addEventListener('resize', () => app.setWindowScaleFactor());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (app.menuPanel.visible) app.menuPanel.visible = false;
    else if (app.modals.exePicker) app.modals.exePicker = false;
    else if (app.modals.settings) app.modals.settings = false;
    else if (/^(game|port)$/.test(app.route.name)) app.navigateBack();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.querySelector('.app-sidebar-header .search-input')?.focus();
  }
});
// Remote icons that fail to load leave the tinted plate (CSP rules out inline onerror)
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.src && !e.target.src.startsWith('blob:') && !e.target.src.startsWith('data:')) e.target.removeAttribute('src');
}, true);

document.body.setAttribute('platform', app.platform);
app.setWindowScaleFactor();
app.$mount('#app');
app.appRoute(window.location.hash || 'home');
// Cider holds the navigation still while body[loading] is set
document.body.removeAttribute('loading');

(async function init() {
  app.settings = await api.getSettings().catch(() => ({}));
  app.sources = (await api.getSources()).sources;
  app.featured = await api.getFeatured().catch(() => []);
  api.getAppVersion().then(v => { app.version = v; }).catch(() => {});
  await app.reloadLibrary();
  // The two halves load side by side: GitHub for the shelves, archive.org for the wall
  app.loadPorts();
  app.loadWall();
})();
