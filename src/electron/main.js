'use strict';
/**
 * RohanKar Launcher — src/electron/main.js
 * A thin host. Starts the backend (src/backend/main.js) as a utility process,
 * waits for it to report its port and token, then opens the window on
 * src/frontend/ with both. The OS side stays here: window controls,
 * dialogs, the shell, the auto-updater and Add to Steam, which the backend
 * asks for over the process's message port (src/backend/parent.js).
 * Quitting the app shuts the backend down.
 */

const { app, BrowserWindow, dialog, shell, utilityProcess } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');

const USER_DATA   = app.getPath('userData');
const HEROES_DIR  = app.isPackaged ? path.join(process.resourcesPath, 'heroes') : path.join(__dirname, '../../assets/heroes');
const BACKEND_MAIN = path.join(__dirname, '../backend/main.js');

let mainWindow;
let windowShown = false;
let backendInfo = null;   // { port, token, url } once the backend is listening

// ─── OS actions the backend asks for ─────────────────────────────────────────

const host = {
  openPath:     (p) => shell.openPath(p),   // ShellExecute: handles UAC prompts, unlike execFile
  trashItem:    (p) => shell.trashItem(p),
  openExternal: (url) => shell.openExternal(url),
  chooseFolder: async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  },
  window: (action) => {
    if (action === 'minimize') mainWindow?.minimize();
    else if (action === 'close') mainWindow?.close();
    else if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  },
  addToSteam:     (opts) => addToSteam(opts),
  updaterInstall: () => updaterInstall(),
};

// ─── Backend process ─────────────────────────────────────────────────────────

let backend = null;         // the utility process
let backendExited = false;
let quitting = false;

// Resolves with { port, token, url } once the backend is listening
function startBackend() {
  backend = utilityProcess.fork(BACKEND_MAIN, ['--data-dir', USER_DATA, '--heroes-dir', HEROES_DIR], {
    serviceName: 'Launcher backend',
    stdio:       'inherit',
  });

  backend.on('message', async (msg) => {
    if (msg?.type !== 'host') return;
    const reply = (res) => { if (!backendExited) backend.postMessage({ type: 'host-result', id: msg.id, ...res }); };
    if (!Object.hasOwn(host, msg.method)) {
      return reply({ ok: false, error: { message: `Unknown host action ${msg.method}`, code: 'unsupported' } });
    }
    try {
      reply({ ok: true, value: (await host[msg.method](...(msg.args || []))) ?? null });
    } catch (e) {
      reply({ ok: false, error: { message: e.message, code: e.code } });
    }
  });

  return new Promise((resolve, reject) => {
    backend.on('message', (msg) => { if (msg?.type === 'listening') resolve(msg); });
    backend.once('exit', (code) => {
      backendExited = true;
      reject(new Error(`the backend exited (code ${code}) before it was ready`));
      if (!quitting) {
        dialog.showErrorBox('RohanKar Launcher', `The launcher's backend stopped unexpectedly (code ${code}).`);
        app.quit();
      }
    });
  });
}

const setUpdaterStatus = (status) => { if (backend && !backendExited) backend.postMessage({ type: 'updater', status }); };

// Settings, read through the API like any other client
async function loadSettings() {
  try {
    const res = await fetch(`${backendInfo.url}/settings`, { headers: { authorization: `Bearer ${backendInfo.token}` } });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow({ url, token }) {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    frame:  false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Read by preload.js and handed to the page as window.launcher
      additionalArguments: [`--launcher-api=${url}`, `--launcher-token=${token}`],
    },
  });
  mainWindow.once('ready-to-show', () => { windowShown = true; });
  mainWindow.loadFile(path.join(__dirname, '../frontend/index.html'));
}

app.whenReady().then(async () => {
  try {
    backendInfo = await startBackend();
  } catch (e) {
    console.error(`[backend] ${e.message}`);
    return;
  }
  createWindow(backendInfo);
  setupAutoUpdater();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (backendInfo && BrowserWindow.getAllWindows().length === 0) createWindow(backendInfo);
});

// Let the backend close library.db and its server before the app exits
app.on('will-quit', (event) => {
  quitting = true;
  if (!backend || backendExited) return;
  event.preventDefault();
  const force = setTimeout(() => backend.kill(), 3000);
  backend.once('exit', () => { clearTimeout(force); app.quit(); });
  backend.postMessage({ type: 'shutdown' });
});

// ─── Auto-updater ────────────────────────────────────────────────────────────
//
// electron-updater checks GitHub releases on launch, downloads in background,
// and reports through the backend (GET /os/updater and the `updater` event)
// so the UI can show a non-intrusive bar.
//
// In development (app.isPackaged === false) we skip the update check entirely
// so you don't get errors about missing release files.

// Releases for this build live on the fork, not upstream
const RELEASES_REPO = 'yabo-san/RohanKar-Launcher';
// latest.yml per channel, served from the gh-pages branch
const UPDATE_CHANNEL_BASE = 'https://yabo-san.github.io/RohanKar-Launcher';
let availableVersion = null;

async function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[updater] Dev mode — skipping update check');
    return;
  }
  // Off unless turned on in Settings
  if (!(await loadSettings()).checkForUpdates) {
    console.log('[updater] Update check disabled in settings');
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.error('[updater] electron-updater not available:', e.message);
    return;
  }

  autoUpdater.autoDownload         = false; // don't auto-download — GitHub releases don't report progress
  autoUpdater.allowDowngrade        = false;

  const channel = (await loadSettings()).betaUpdates ? 'beta' : 'stable';
  autoUpdater.setFeedURL({ provider: 'generic', url: `${UPDATE_CHANNEL_BASE}/${channel}/` });
  console.log(`[updater] Channel: ${channel}`);

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update available:', info.version);
    availableVersion = info.version;

    // Fetch release notes from GitHub API
    const releaseUrl = `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/v${info.version}`;
    const fetchNotes = () => new Promise((resolve) => {
      https.get(releaseUrl, {
        headers: {
          'User-Agent':  'RohanKar-Launcher',
          'Accept':      'application/vnd.github+json',
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json  = JSON.parse(data);
            resolve(json.body || null);   // GitHub release body is markdown
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });

    fetchNotes().then((releaseNotes) => {
      setUpdaterStatus({
        status:       'available',
        version:      info.version,
        releaseNotes: releaseNotes || null,
        releaseDate:  info.releaseDate || null,
      });
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] Up to date.');
  });

  // No download-progress or update-downloaded handlers needed —
  // we send users to GitHub to download manually instead.

  autoUpdater.on('error', (err) => {
    const msg = err.message || '';
    // 404 = no GitHub release published yet, not a real error worth surfacing
    if (msg.includes('404')) {
      console.log('[updater] No published release found yet — skipping update check.');
      return;
    }
    console.error('[updater] Error:', msg);
    setUpdaterStatus({
      status:  'error',
      message: msg,
    });
  });

  // Check after the window is ready so the user sees the UI first
  const check = () => setTimeout(() => autoUpdater.checkForUpdates(), 3000);
  if (windowShown) check();
  else mainWindow?.once('ready-to-show', check);

}  

// The frontend's Install button opens the GitHub release page.
// Fork releases are GitHub pre-releases, which /releases/latest skips, so link the tag.
function updaterInstall() {
  const page = availableVersion ? `tag/v${availableVersion}` : 'latest';
  shell.openExternal(`https://github.com/${RELEASES_REPO}/releases/${page}`);
}

// ─── Add to Steam ───────────────────────────────────────────────────────────
//
// Writes a non-Steam game shortcut into Steam's shortcuts.vdf binary file.
// This is the same approach used by Heroic Games Launcher.
// After writing, Steam must be restarted for the shortcut to appear.

function findSteamPath() {
  if (process.platform === 'win32') {
    // Try registry first
    try {
      const { execSync } = require('child_process');
      const result = execSync(
        'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath',
        { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
      );
      const match = result.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      if (match) {
        const p = match[1].trim();
        if (fs.existsSync(p)) return p;
      }
    } catch {}
    // Fallback to common paths
    const candidates = [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      path.join(process.env.ProgramFiles || '', 'Steam'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Steam'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function getSteamUserIds(steamPath) {
  const userdataDir = path.join(steamPath, 'userdata');
  if (!fs.existsSync(userdataDir)) return [];
  return fs.readdirSync(userdataDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== '0')
    .map(e => e.name);
}

// ─── Binary VDF shortcuts.vdf parser / writer ─────────────────────────────────
// Valve's binary VDF format (used for shortcuts.vdf):
//   \x00key\x00  = object/sub-map start
//   \x01key\x00value\x00 = string value
//   \x02key\x00<4-byte LE int32> = int32 value
//   \x08 = end of object

function readVdfShortcuts(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const buf = fs.readFileSync(filePath);
  const shortcuts = [];
  let i = 0;

  // Skip root object header (\x00shortcuts\x00)
  if (buf[i] === 0x00) {
    i++; // type byte
    while (i < buf.length && buf[i] !== 0x00) i++; // skip key string
    i++; // null terminator
  }

  while (i < buf.length) {
    if (buf[i] === 0x08) break; // end of root
    if (buf[i] !== 0x00) { i++; continue; } // unexpected byte — skip
    i++; // type 0x00 = object

    // Read index key (e.g. "0", "1", "2")
    while (i < buf.length && buf[i] !== 0x00) i++;
    i++; // null terminator after key

    // Read object fields until 0x08
    const entry = {};
    while (i < buf.length && buf[i] !== 0x08) {
      const type = buf[i]; i++;
      // Read key string
      let key = '';
      while (i < buf.length && buf[i] !== 0x00) { key += String.fromCharCode(buf[i]); i++; }
      i++; // null terminator

      if (type === 0x01) {
        // String value
        let val = '';
        while (i < buf.length && buf[i] !== 0x00) { val += String.fromCharCode(buf[i]); i++; }
        i++;
        entry[key] = val;
      } else if (type === 0x02) {
        // Int32 LE
        entry[key] = buf.readInt32LE(i);
        i += 4;
      } else if (type === 0x00) {
        // Nested object (e.g. tags) — read and skip
        const nested = {};
        while (i < buf.length && buf[i] !== 0x08) {
          const ntype = buf[i]; i++;
          let nkey = '';
          while (i < buf.length && buf[i] !== 0x00) { nkey += String.fromCharCode(buf[i]); i++; }
          i++;
          if (ntype === 0x01) {
            let nval = '';
            while (i < buf.length && buf[i] !== 0x00) { nval += String.fromCharCode(buf[i]); i++; }
            i++;
            nested[nkey] = nval;
          } else if (ntype === 0x02) {
            nested[nkey] = buf.readInt32LE(i); i += 4;
          }
        }
        i++; // 0x08 end of nested
        entry[key] = nested;
      } else {
        // Unknown type — stop parsing this entry
        break;
      }
    }
    if (buf[i] === 0x08) i++; // end of entry
    if (Object.keys(entry).length > 0) shortcuts.push(entry);
  }
  return shortcuts;
}

function writeVdfShortcuts(filePath, shortcuts) {
  const parts = [];

  const writeStr = (s) => {
    const b = Buffer.from(s + '\x00', 'latin1');
    parts.push(b);
  };
  const writeInt32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    parts.push(b);
  };
  const writeByte = (n) => parts.push(Buffer.from([n]));

  // Root object header: \x00 shortcuts \x00
  writeByte(0x00);
  writeStr('shortcuts');

  shortcuts.forEach((entry, idx) => {
    writeByte(0x00);          // type: object
    writeStr(String(idx));    // index key

    const writeField = (type, key, value) => {
      writeByte(type);
      writeStr(key);
      if (type === 0x01) writeStr(value);
      else if (type === 0x02) writeInt32(value);
    };

    writeField(0x02, 'appid',              entry.appid              || 0);
    writeField(0x01, 'appname',            entry.appname            || entry.AppName || '');
    writeField(0x01, 'Exe',                entry.Exe                || entry.exe     || '');
    writeField(0x01, 'StartDir',           entry.StartDir           || '');
    writeField(0x01, 'icon',               entry.icon               || '');
    writeField(0x01, 'ShortcutPath',       entry.ShortcutPath       || '');
    writeField(0x01, 'LaunchOptions',      entry.LaunchOptions      || '');
    writeField(0x02, 'IsHidden',           entry.IsHidden           || 0);
    writeField(0x02, 'AllowDesktopConfig', entry.AllowDesktopConfig !== undefined ? entry.AllowDesktopConfig : 1);
    writeField(0x02, 'AllowOverlay',       entry.AllowOverlay       !== undefined ? entry.AllowOverlay       : 1);
    writeField(0x02, 'OpenVR',             entry.OpenVR             || 0);
    writeField(0x02, 'Devkit',             entry.Devkit             || 0);
    writeField(0x01, 'DevkitGameID',       entry.DevkitGameID       || '');
    writeField(0x02, 'DevkitOverrideAppID',entry.DevkitOverrideAppID|| 0);
    writeField(0x02, 'LastPlayTime',       entry.LastPlayTime       || 0);
    writeField(0x01, 'FlatpakAppID',       entry.FlatpakAppID       || '');
    writeField(0x01, 'sortas',             '');

    // Tags sub-object
    writeByte(0x00);
    writeStr('tags');
    const tags = entry.tags || {};
    const tagEntries = typeof tags === 'object' && !Array.isArray(tags)
      ? Object.entries(tags)
      : (Array.isArray(tags) ? tags.map((v,i) => [String(i), v]) : []);
    for (const [tk, tv] of tagEntries) {
      writeByte(0x01);
      writeStr(tk);
      writeStr(tv);
    }
    writeByte(0x08); // end tags

    writeByte(0x08); // end entry
  });

  writeByte(0x08); // end shortcuts
  writeByte(0x08); // end root

  fs.writeFileSync(filePath, Buffer.concat(parts));
}

// Generate a stable non-Steam appid from exe path + app name.
// Steam's algorithm: CRC32(quotedExe + appName) | 0x80000000, as a signed int32.
// The exe string passed here must be the quoted form ("C:\path\game.exe")
// because that is what Steam itself stores in the Exe field.
function generateNonSteamAppId() {
  // Generate a random non-Steam appid matching exactly what Steam itself does:
  // a random 32-bit unsigned integer with the top bit set (non-Steam game range).
  const rand = Math.floor(Math.random() * 0x7FFFFFFF);
  return (rand | 0x80000000) >>> 0;
}

async function addToSteam({ appName, exePath, startDir }) {
  try {
    const steamPath = findSteamPath();
    if (!steamPath) return { ok: false, error: 'Steam installation not found.' };

    const userIds = getSteamUserIds(steamPath);
    if (!userIds.length) return { ok: false, error: 'No Steam user accounts found.' };

    // Exe field is stored with surrounding quotes in the VDF — Steam requires this.
    // The appID CRC is computed from the quoted exe string + appName, matching
    // what Steam ROM Manager, SteamTinkerLaunch, and the ICE project all use.
    const quotedExe = `"${exePath}"`;
    const appId     = generateNonSteamAppId();
    const updated = [];
    const skipped = [];

    for (const userId of userIds) {
      const configDir     = path.join(steamPath, 'userdata', userId, 'config');
      const shortcutsPath = path.join(configDir, 'shortcuts.vdf');

      // Ensure config dir exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Read existing shortcuts
      let shortcuts = [];
      try {
        shortcuts = readVdfShortcuts(shortcutsPath);
      } catch (e) {
        console.warn(`[add-to-steam] Could not read shortcuts.vdf for user ${userId}:`, e.message);
      }

      // Check if already added (match by exe or appid)
      const normalizedExe = exePath.replace(/\\/g, '/').toLowerCase();
      const alreadyExists = shortcuts.some(s => {
        const sExe = (s.Exe || s.exe || '').replace(/\\/g, '/').toLowerCase()
          .replace(/^"|"$/g, ''); // strip surrounding quotes for comparison
        return sExe === normalizedExe || s.appid === appId;
      });

      if (alreadyExists) {
        skipped.push(userId);
        continue;
      }

      // Backup the existing file before modifying
      if (fs.existsSync(shortcutsPath)) {
        try {
          fs.copyFileSync(shortcutsPath, shortcutsPath + '.bak');
        } catch {}
      }

      // Add the new shortcut.
      // Exe: quoted path (Steam requires this for the launch command).
      // StartDir: bare path WITHOUT quotes (quotes here break Steam's launch on Windows).
      // Ensure StartDir has a trailing backslash — Steam writes it this way
      const startDirSlashed = startDir.endsWith('\\') ? startDir : startDir + '\\';
      shortcuts.push({
        appid:              appId,
        appname:            appName,
        Exe:                quotedExe,
        StartDir:           startDirSlashed,
        icon:               '',
        ShortcutPath:       '',
        LaunchOptions:      '',
        IsHidden:           0,
        AllowDesktopConfig: 1,
        AllowOverlay:       1,
        OpenVR:             0,
        Devkit:             0,
        DevkitGameID:       '',
        DevkitOverrideAppID:0,
        LastPlayTime:       0,
        FlatpakAppID:       '',
        tags:               {},
      });

      writeVdfShortcuts(shortcutsPath, shortcuts);
      updated.push(userId);
      console.log(`[add-to-steam] Added "${appName}" for user ${userId}`);
    }

    if (updated.length === 0 && skipped.length > 0) {
      return { ok: true, alreadyAdded: true };
    }

    return { ok: true, alreadyAdded: false, updatedUsers: updated.length };
  } catch (e) {
    console.error('[add-to-steam] Error:', e.message);
    return { ok: false, error: e.message };
  }
}
