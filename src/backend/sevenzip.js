'use strict';
/**
 * Which 7-Zip unpacks .7z and .rar files. On Windows the one installed in
 * Program Files, as before. On Linux (a Steam Deck has none, and its system
 * is read-only) one the user installed, else the copy bundled with the app.
 */
const fs   = require('fs');
const path = require('path');

const WINDOWS_7ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';

// platform: process.platform. bundled: the app's own 7zzs (resources/7zip),
// when it is the packaged app. Returns a path, or null on Linux with none.
//   Windows: Program Files' 7z.exe (whether it's there is checked when used)
//   Linux:   7zz or 7zzs on PATH (7-Zip's own), then the bundled copy, then
//            p7zip's 7z on PATH
function findSevenZip({ platform = process.platform, bundled = null, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'win32') return WINDOWS_7ZIP;
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const onPath = (name) => dirs.map(d => path.join(d, name)).find(p => exists(p)) || null;
  return onPath('7zz') || onPath('7zzs') || (bundled && exists(bundled) ? bundled : null) || onPath('7z');
}

module.exports = { findSevenZip, WINDOWS_7ZIP };
