'use strict';
/**
 * Quiver library import: reads a Quiver folder (apps.json, settings.json and
 * the Apps/ folder beside them) and adopts every entry into library.db
 * without downloading anything. Follows Quiver's own model (QuiverLauncher
 * AppCatalogService, GameInfo, GameStatusService):
 *
 *   - apps.json is { apps: [...] }, a bare array, or the legacy
 *     { standard, experimental, custom } sections; entries repeat by
 *     source:repository:folderName (or manual:folderName) and the first wins
 *   - an entry lives in installPath when set, else <AppsPath>/<folderName>,
 *     where AppsPath comes from settings.json and defaults to <root>/Apps
 *   - it counts as installed when that folder exists, holds no
 *     install-incomplete.txt and has an executable
 *   - version.txt holds the installed release tag; selected_executable.txt
 *     the path the user picked to launch
 *   - no repository means a manually managed app
 *
 * readQuiverLibrary only reads; planImport matches entries to catalog items;
 * applyImport writes library rows (and a local collision for a repository no
 * catalog lists, which puts it on "Your ports").
 */
const fs   = require('fs');
const path = require('path');

const INCOMPLETE = 'install-incomplete.txt';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const readText = (file) => { try { return str(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// The folder holding apps.json, given it or apps.json itself
function quiverRoot(p) {
  if (!str(p)) return null;
  if (isFile(p) && path.basename(p).toLowerCase() === 'apps.json') return path.dirname(p);
  return isFile(path.join(p, 'apps.json')) ? p : null;
}

// The entries of an apps.json document, in file order
function appEntries(doc) {
  if (Array.isArray(doc)) return doc;
  if (!doc || typeof doc !== 'object') return [];
  return ['apps', 'standard', 'experimental', 'custom'].flatMap(k => (Array.isArray(doc[k]) ? doc[k] : []));
}

const repositorySource = (s) => (String(s || '').trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github');
function instanceKey(app) {
  if (!app.repository) return `manual:${(app.folderName || '').toLowerCase()}`;
  return `${app.source}:${app.repository.toLowerCase()}:${(app.folderName || '').toLowerCase()}`;
}

// selected_executable.txt: an absolute path, or one relative to the folder
function selectedExe(dir) {
  const saved = readText(path.join(dir, 'selected_executable.txt'));
  if (!saved) return null;
  const full = path.isAbsolute(saved) ? saved : path.join(dir, saved);
  return isFile(full) ? full : null;
}

// { root, appsPath, apps: [...], skipped: [{ name, reason }] } or { error }
function readQuiverLibrary(dir, { findExes = () => [] } = {}) {
  const root = quiverRoot(dir);
  if (!root) return { error: `No apps.json in ${dir}` };
  let doc;
  try { doc = readJson(path.join(root, 'apps.json')); } catch (e) { return { error: `apps.json: ${e.message}` }; }
  let settings = {};
  try { settings = readJson(path.join(root, 'settings.json')) || {}; } catch { /* Quiver's defaults */ }
  const appsPath = str(settings.AppsPath) || str(settings.appsPath) || path.join(root, 'Apps');

  const apps = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of appEntries(doc)) {
    if (!raw || typeof raw !== 'object') continue;
    const app = {
      name:       str(raw.customDisplayName) || str(raw.name) || str(raw.folderName) || str(raw.repository),
      repository: str(raw.repository),
      source:     repositorySource(raw.repositorySource),
      folderName: str(raw.folderName),
      tags:       Array.isArray(raw.tags) ? [...new Set(raw.tags.map(str).filter(Boolean))] : [],
    };
    if (!app.name) continue;
    const key = instanceKey(app);
    if (seen.has(key)) continue;
    seen.add(key);

    const installDir = str(raw.installPath) || (app.folderName ? path.join(appsPath, app.folderName) : null);
    if (!installDir) {
      skipped.push({ name: app.name, reason: 'no folder name or install path' });
      continue;
    }
    const exes = isDir(installDir) && !isFile(path.join(installDir, INCOMPLETE)) ? findExes(installDir) : [];
    const installed = exes.length > 0;
    apps.push({
      ...app,
      installDir,
      installed,
      exe:     installed ? selectedExe(installDir) || (exes.length === 1 ? exes[0] : null) : null,
      version: installed ? readText(path.join(installDir, 'version.txt')) : null,
    });
  }
  return { root, appsPath, apps, skipped };
}

// What importing would do, per app:
//   port    - a catalog lists the repository; the row is that item's id
//   new     - no catalog does; a local collision adds it to "Your ports"
//   manual  - no GitHub repository (manual, or GitLab, which ports can't
//             install yet); kept only when its folder has something to launch
// items: catalogs.items(); rows: library.all()
function planImport(read, { items = [], rows = {} } = {}) {
  const byRepo = new Map();
  for (const it of items) {
    const k = it.repository?.toLowerCase();
    if (k && !byRepo.has(k)) byRepo.set(k, it);
  }
  const apps = [];
  const skipped = [...(read.skipped || [])];
  for (const app of read.apps || []) {
    let kind, id;
    if (app.repository && app.source === 'github') {
      const item = byRepo.get(app.repository.toLowerCase());
      kind = item ? 'port' : 'new';
      id = item ? item.id : `quiver:local:${app.repository.toLowerCase()}`;
    } else if (app.installed) {
      kind = 'manual';
      id = `manual:${app.folderName || path.basename(app.installDir)}`;
    } else {
      skipped.push({ name: app.name, reason: app.repository ? 'GitLab app with nothing installed' : 'manual app with nothing installed' });
      continue;
    }
    if (apps.some(a => a.id === id)) {
      skipped.push({ name: app.name, reason: `same port as ${apps.find(a => a.id === id).name}` });
      continue;
    }
    const row = rows[id];
    apps.push({ ...app, kind, id, inLibrary: !!row, alreadyInstalled: !!row?.install_dir });
  }
  return { root: read.root, appsPath: read.appsPath, apps, skipped };
}

// Writes the plan. An install already in library.db, or an entry already
// there with nothing to adopt, is left alone, so a second import changes
// nothing. Returns counts.
function applyImport(plan, { library, catalogs }) {
  const out = { added: 0, adopted: 0, ports: 0, unchanged: 0 };
  for (const app of plan.apps) {
    if (app.kind === 'new') {
      const r = catalogs.saveCollision({ repository: app.repository, name: app.name, ...(app.folderName ? { folderName: app.folderName } : {}) });
      if (r.ok) out.ports++;
    }
    if (app.alreadyInstalled || (app.inLibrary && !app.installed)) { out.unchanged++; continue; }
    library.add(app.id, app.kind === 'manual' ? 'manual' : 'quiver');
    library.setDetails(app.id, {
      ...(app.kind === 'manual' ? { title: app.name } : {}),
      ...(app.tags.length ? { tags: app.tags } : {}),
      ...(app.version ? { version: app.version } : {}),
    });
    if (app.installed) {
      library.adoptInstall(app.id, app.installDir, app.exe);
      out.adopted++;
    } else {
      out.added++;
    }
  }
  return out;
}

module.exports = { readQuiverLibrary, planImport, applyImport, quiverRoot, appEntries };
