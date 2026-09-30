'use strict';
/**
 * y4bo — src/electron/user-data.js
 * Picks the data folder (Electron's userData) across the rename to y4bo.
 *
 * Electron names userData after package.json's top-level "productName", else
 * its "name" (electron-builder's build.productName never reaches the packaged
 * package.json). Up to 1.6.0-fork.11 "name" was "rohankar-launcher", so data
 * lives in %APPDATA%\rohankar-launcher; now it is "y4bo-launcher".
 *
 * An install that already has data keeps using the old folder instead of
 * getting a copy: the default games folder is <userData>/games (possibly
 * hundreds of GB), library.db stores absolute install paths into it, and the
 * Playnite plugin reads playnite-export.json from it. Fresh installs get the
 * new folder. Nothing is moved or deleted.
 */

const fs   = require('fs');
const path = require('path');

// Old folder names under appData, most likely first
const LEGACY_NAMES = ['rohankar-launcher', 'RohanKar Launcher'];

// Files only the launcher writes; Chromium's own cache files don't count
const DATA_FILES = ['settings.json', 'library.db', 'library.json'];

const hasLauncherData = (dir, exists = fs.existsSync) =>
  DATA_FILES.some(f => exists(path.join(dir, f)));

/**
 * Returns the folder userData should be, and why.
 *   current: app.getPath('userData') as Electron resolved it
 *   appData: app.getPath('appData')
 *   name:    app.name (what Electron derived `current` from)
 * An explicit override (app.setPath or --user-data-dir, e.g. the e2e stub)
 * makes `current` differ from appData/name, and is left alone.
 */
function resolveUserData({ current, appData, name, legacyNames = LEGACY_NAMES, exists = fs.existsSync }) {
  if (path.resolve(current) !== path.resolve(appData, name)) return { dir: current, reason: 'override' };
  if (hasLauncherData(current, exists)) return { dir: current, reason: 'current' };
  for (const legacy of legacyNames) {
    const dir = path.join(appData, legacy);
    if (path.resolve(dir) !== path.resolve(current) && hasLauncherData(dir, exists)) return { dir, reason: 'legacy' };
  }
  return { dir: current, reason: 'fresh' };
}

module.exports = { resolveUserData, hasLauncherData, LEGACY_NAMES };
