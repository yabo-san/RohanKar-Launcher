'use strict';
/**
 * RohanKar Launcher — main.js
 * Window, auto-updater and Add-to-Steam. Everything else (sources, library.db,
 * downloads, extraction, covers, the net log) lives in src/backend/; the IPC
 * handlers below are thin wrappers over it, same channels and replies as before.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const { createBackend } = require('../backend');
const { fileUrl } = require('../backend/covers');
const disk = require('../backend/disk');

// ─── Backend ─────────────────────────────────────────────────────────────────

const USER_DATA = app.getPath('userData');

let mainWindow;

const backend = createBackend({
  dataDir: USER_DATA,
  appDir:  app.getAppPath(),
  host: {
    openPath:     (p) => shell.openPath(p),   // ShellExecute: handles UAC prompts, unlike execFile
    trashItem:    (p) => shell.trashItem(p),
    openExternal: (url) => shell.openExternal(url),
    chooseFolder: async () => {
      const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      return res.canceled ? null : res.filePaths[0];
    },
  },
});
const { library, archive, covers, installs } = backend;
const loadSettings = () => backend.settings.load();

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    frame:  false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  backend.getOverrides();
  backend.getDefaultSources();
  createWindow();
  setupAutoUpdater();
  // Validate installs on every launch — clears DB entries whose folders were deleted
  library.clearMissingInstalls();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('will-quit', () => backend.close());

// ─── Window controls ─────────────────────────────────────────────────────────

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('heroes-path', () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'heroes');
  }
  return path.join(__dirname, '../../assets/heroes');
});

ipcMain.on('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// ─── Settings ─────────────────────────────────────────────────────────────────

ipcMain.handle('settings-get',  ()     => loadSettings());
ipcMain.handle('settings-save', (_, s) => { backend.settings.save(s); return { ok: true }; });
ipcMain.handle('choose-folder', ()     => backend.os.chooseFolder());

// ─── Library ──────────────────────────────────────────────────────────────────

ipcMain.handle('library-get',          ()                              => library.all());
ipcMain.handle('library-get-game',     (_, { identifier })             => library.get(identifier));
ipcMain.handle('library-set-category', (_, { identifier, category })   => library.setCategory(identifier, category));
ipcMain.handle('library-set-favorite', (_, { identifier, isFavorite }) => library.setFavorite(identifier, isFavorite));
ipcMain.handle('library-set-notes',    (_, { identifier, notes })      => library.setNotes(identifier, notes));
ipcMain.handle('install-game',         (_, { identifier, installDir, exePath }) => library.recordInstall(identifier, installDir, exePath));
ipcMain.handle('set-exe-path',         (_, { identifier, exePath })    => library.setExePath(identifier, exePath));
ipcMain.handle('delete-game',          (_, { identifier, installDir }) => backend.removeFromLibrary(identifier, { installDir, trash: true }));
ipcMain.handle('scan-for-games',       (_, opts)                       => installs.scan(opts));

// ─── Collections ──────────────────────────────────────────────────────────────

ipcMain.handle('collections-get',         ()                                => library.collections());
ipcMain.handle('collections-create',      (_, { name })                     => library.createCollection(name));
ipcMain.handle('collections-delete',      (_, { id })                       => library.deleteCollection(id));
ipcMain.handle('collections-rename',      (_, { id, name })                 => library.renameCollection(id, name));
ipcMain.handle('collections-set-color',   (_, { id, color })                => library.setCollectionColor(id, color));
ipcMain.handle('collections-add-game',    (_, { collectionId, identifier }) => library.addToCollection(collectionId, identifier));
ipcMain.handle('collections-remove-game', (_, { collectionId, identifier }) => library.removeFromCollection(collectionId, identifier));

// ─── archive.org ──────────────────────────────────────────────────────────────

ipcMain.handle('archive-search',  (_, { params })     => archive.search(params));
ipcMain.handle('fetch-file-list', (_, { identifier }) => archive.fileList(identifier));
ipcMain.handle('fetch-reviews',   (_, { identifier }) => archive.reviews(identifier));

// ─── Covers ───────────────────────────────────────────────────────────────────

ipcMain.handle('get-overrides',       ()                  => backend.getOverrides());
ipcMain.handle('get-default-sources', ()                  => backend.getDefaultSources());
ipcMain.handle('get-thumb',         async (_, { identifier }) => fileUrl(await covers.thumb(identifier)));
ipcMain.handle('get-override-hero', async (_, { identifier }) => fileUrl((await covers.overrideArt(identifier, 'hero')) ?? null));
ipcMain.handle('check-game-hero',   (_, { installDir })  => fileUrl(covers.installHero(installDir)));

// ─── Download / extract / launch ──────────────────────────────────────────────

ipcMain.handle('download-start', (event, { identifier, downloadUrl, fileName }) => installs.download({
  key: identifier, identifier, url: downloadUrl, fileName,
  onProgress: (percent) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('download-progress', { identifier, percent });
    } catch {}
  },
}));
ipcMain.handle('download-cancel',    (_, { identifier }) => installs.cancelDownload(identifier));
ipcMain.handle('extract-archive',    (_, opts)           => installs.extract(opts));
ipcMain.handle('find-exes',          (_, { installDir }) => disk.findExes(installDir));
ipcMain.handle('launch-game',        (_, { identifier, exePath }) => backend.launch(identifier, exePath));
ipcMain.handle('open-game-location', (_, { installDir }) => backend.openFolder(installDir));
ipcMain.handle('read-readme',        (_, { installDir }) => disk.readReadme(installDir));

// ─── Auto-updater ────────────────────────────────────────────────────────────
//
// electron-updater checks GitHub releases on launch, downloads in background,
// and sends IPC events to the renderer so the UI can show a non-intrusive bar.
//
// In development (app.isPackaged === false) we skip the update check entirely
// so you don't get errors about missing release files.

// Releases for this build live on the fork, not upstream
const RELEASES_REPO = 'yabo-san/RohanKar-Launcher';
// latest.yml per channel, served from the gh-pages branch
const UPDATE_CHANNEL_BASE = 'https://yabo-san.github.io/RohanKar-Launcher';
let availableVersion = null;

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[updater] Dev mode — skipping update check');
    return;
  }
  // Off unless turned on in Settings
  if (!loadSettings().checkForUpdates) {
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

  const channel = loadSettings().betaUpdates ? 'beta' : 'stable';
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
      mainWindow?.webContents.send('updater-status', {
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
    mainWindow?.webContents.send('updater-status', {
      status:  'error',
      message: msg,
    });
  });

  // Check after the window is ready so the user sees the UI first
  mainWindow?.once('ready-to-show', () => {
    setTimeout(() => autoUpdater.checkForUpdates(), 3000);
  });

}  

// IPC: renderer asks to download update — always registered, opens GitHub releases page.
// Fork releases are GitHub pre-releases, which /releases/latest skips, so link the tag.
ipcMain.removeHandler('updater-install');
ipcMain.handle('updater-install', () => {
  const page = availableVersion ? `tag/v${availableVersion}` : 'latest';
  shell.openExternal(`https://github.com/${RELEASES_REPO}/releases/${page}`);
});

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

ipcMain.handle('add-to-steam', async (_, { appName, exePath, startDir, iconPath }) => {
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
});
