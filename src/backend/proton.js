'use strict';
/**
 * Running games on Linux, as Quiver does. A Linux build runs directly. A
 * Windows .exe runs through Proton: umu-launcher when the user has it, else
 * a Proton Steam installed (Valve's newest numbered one, then Experimental,
 * then a custom one such as GE-Proton), else Wine. Each game gets its own
 * Wine prefix in the app's data folder, which holds its saves and stays when
 * the game is uninstalled.
 *
 * Everything here works out what to run; index.js starts it.
 */
const fs   = require('fs');
const path = require('path');

const WINDOWS_PROGRAM = /\.(exe|bat)$/i;
const needsProton = (exePath) => WINDOWS_PROGRAM.test(exePath);

// Steam's folders: native, the old ~/.steam link, and Flatpak Steam's
const steamRoots = (home) => [
  path.join(home, '.steam', 'steam'),
  path.join(home, '.local', 'share', 'Steam'),
  path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
];

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// The other Steam libraries listed in a Steam folder's libraryfolders.vdf
function libraryFolders(steam) {
  let text;
  try { text = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8'); } catch { return []; }
  return [...text.matchAll(/^\s*"path"\s+"((?:[^"\\]|\\.)*)"/gm)].map(m => m[1].replace(/\\\\/g, '\\'));
}

// The Protons on this computer: Valve's in every Steam library's
// steamapps/common, and custom builds in compatibilitytools.d. Each once,
// newest name first: [{ name, path }]
function listProtons(home) {
  const steams = steamRoots(home).filter(isDir);
  const places = [];
  for (const steam of steams) {
    places.push([path.join(steam, 'compatibilitytools.d'), false]);
    places.push([path.join(steam, 'steamapps', 'common'), true]);
    for (const lib of libraryFolders(steam)) places.push([path.join(lib, 'steamapps', 'common'), true]);
  }
  places.push(['/usr/share/steam/compatibilitytools.d', false]);
  const found = new Map();   // real path -> { name, path }
  for (const [place, valve] of places) {
    let entries;
    try { entries = fs.readdirSync(place, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const dir = path.join(place, e.name);
      if ((valve && !e.name.startsWith('Proton')) || !isFile(path.join(dir, 'proton'))) continue;
      const real = realPath(dir);
      if (!found.has(real)) found.set(real, { name: e.name, path: dir });
    }
  }
  return [...found.values()].sort((a, b) => b.name.localeCompare(a.name));
}

// The Proton a Windows game runs through when nothing else is chosen, as on a
// Steam Deck: Valve's newest numbered Proton, else Experimental, else the
// newest other (GE-Proton), Hotfix last (it's for particular games)
function automaticProton(list) {
  const numbers = (name) => (name.match(/\d+/g) || []).map(Number);
  const tier = (p) => (/^Proton \d/.test(p.name) ? 0 : /Experimental/.test(p.name) ? 1 : /Hotfix/.test(p.name) ? 3 : 2);
  const newer = (a, b) => {
    const x = numbers(a.name), y = numbers(b.name);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
    return 0;
  };
  return [...(list || [])].sort((a, b) => tier(a) - tier(b) || newer(a, b))[0] || null;
}

// A program on PATH, or null
function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

// The environment a game starts with: the app's own, without what an AppImage
// set for itself (its libraries first on LD_LIBRARY_PATH and PATH), which a
// game would load instead of its own or the system's, and without Electron's
function cleanEnv(env = process.env) {
  const out = { ...env };
  const appdir = env.APPDIR;
  if (appdir) {
    for (const key of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'PYTHONPATH', 'PERLLIB', 'QT_PLUGIN_PATH']) {
      if (out[key] === undefined) continue;
      const kept = String(out[key]).split(':').filter(p => p && !p.startsWith(appdir));
      if (kept.length) out[key] = kept.join(':'); else delete out[key];
    }
    for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete out[key];
  }
  for (const key of Object.keys(out)) if (key.startsWith('ELECTRON_') || key === 'CHROME_DESKTOP') delete out[key];
  return out;
}

// What to run for exePath on Linux: { cmd, args, env, cwd, runner } or
// { error }. runner: 'native', 'umu', 'proton' or 'wine'.
//   prefix: this game's Wine prefix folder (STEAM_COMPAT_DATA_PATH; Wine's
//           own prefix is its pfx/ inside, as Proton lays it out)
//   home, env: for finding Steam, Proton, umu-run and wine
function launchCommand(exePath, { prefix, home, env = process.env, protons = null, umu = undefined, wine = undefined }) {
  const cwd = path.dirname(exePath);
  const base = cleanEnv(env);
  if (!needsProton(exePath)) return { runner: 'native', cmd: exePath, args: [], env: base, cwd };

  const proton = automaticProton(protons ?? listProtons(home));
  const steam = steamRoots(home).find(isDir) || steamRoots(home)[0];
  const umuRun = umu === undefined ? onPath('umu-run', env) : umu;
  if (umuRun) {
    return { runner: 'umu', cmd: umuRun, args: [exePath], cwd, env: {
      ...base, WINEPREFIX: path.join(prefix, 'pfx'), GAMEID: 'umu-0', ...(proton ? { PROTONPATH: proton.path } : {}),
    } };
  }
  if (proton) {
    return { runner: 'proton', proton: proton.name, cmd: path.join(proton.path, 'proton'), args: ['run', exePath], cwd, env: {
      ...base, STEAM_COMPAT_DATA_PATH: prefix, STEAM_COMPAT_CLIENT_INSTALL_PATH: steam,
    } };
  }
  const winePath = wine === undefined ? onPath('wine', env) : wine;
  if (winePath) return { runner: 'wine', cmd: winePath, args: [exePath], cwd, env: { ...base, WINEPREFIX: path.join(prefix, 'pfx') } };
  return { error: 'This is a Windows game, and there is no Proton to run it. Install Proton in Steam (Library, Tools, search for Proton), or add the game to Steam.' };
}

module.exports = { needsProton, steamRoots, libraryFolders, listProtons, automaticProton, onPath, cleanEnv, launchCommand };
