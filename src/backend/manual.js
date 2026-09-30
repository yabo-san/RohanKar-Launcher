'use strict';
/**
 * Manually managed apps: no repository and no archive.org item. The user
 * names one, gets a folder, drops the app's files in it, and the library
 * launches it. After Quiver's ManualAppFolderService: the folder is created
 * in the install folder (or an existing one is used), and holds
 * "Place app files here.txt" until something launchable is in it.
 *
 * Rows are `manual:<folder name>` with source 'manual' and the name in
 * `title`, the same shape the Quiver import writes.
 */
const fs   = require('fs');
const path = require('path');
const { sanitizeFolderName } = require('./disk');

const INSTRUCTIONS_FILE = 'Place app files here.txt';
const INSTRUCTIONS = [
  'This app has no GitHub release or archive.org item, so the launcher cannot download or update it.',
  '',
  'Download it yourself and put its files in this folder. The launcher finds the executable and launches it.',
  'Keeping it up to date is up to you.',
  '',
].join('\n');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const manualId = (dir) => `manual:${path.basename(dir)}`;

// { name, folder? }: folder is an existing folder to use as is; without one a
// folder named after the app is made in root. { ok, id } or { ok: false, code, error }
function createManualApp({ name, folder = null, root, library, findExes }) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title) return { ok: false, code: 'bad_request', error: 'name is required' };
  let dir;
  if (folder) {
    if (!isDir(folder)) return { ok: false, code: 'no_folder', error: `Not a folder: ${folder}` };
    dir = folder;
  } else {
    dir = path.join(root, sanitizeFolderName(title));
  }
  const id = manualId(dir);
  if (library.get(id)) return { ok: false, code: 'exists', error: `${id} is already in the library` };

  fs.mkdirSync(dir, { recursive: true });
  const exes = findExes(dir);
  if (!exes.length) {
    const note = path.join(dir, INSTRUCTIONS_FILE);
    if (!fs.existsSync(note)) fs.writeFileSync(note, INSTRUCTIONS);
  }
  const r = library.add(id, 'manual');
  if (!r.ok) return { ok: false, code: 'library_unavailable', error: 'library.db could not be opened' };
  library.setDetails(id, { title });
  library.adoptInstall(id, dir, exes.length === 1 ? exes[0] : null);
  return { ok: true, id };
}

module.exports = { createManualApp, INSTRUCTIONS_FILE };
