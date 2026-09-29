'use strict';
/**
 * Install engine: download an archive.org file, extract it, find its
 * executable, record it in library.db. The pieces (download, extract) are
 * also exported one by one for the IPC calls the current renderer makes.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { getFollow } = require('./net');
const { installableFiles } = require('./archive');
const disk = require('./disk');

const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';

function createInstalls({ settings, library, archive, gamesDir, emit = () => {}, log = () => {}, netLog = () => {}, platform = process.platform, sevenZip = SEVEN_ZIP }) {
  const activeDownloads = new Map();  // key → { cancel }
  const jobs = new Map();             // install id → job

  const downloadDir = () => settings.load().downloadPath || gamesDir;
  const installDir  = () => settings.load().installPath  || gamesDir;

  // Downloads url into <download folder>/<identifier>/<fileName>. Resolves
  // { ok, filePath } or { ok: false, error }; cancel(key) resolves it as 'Cancelled'.
  function download({ key, identifier, url, fileName, onProgress = () => {} }) {
    const destDir = path.join(downloadDir(), disk.sanitizeFolderName(identifier));
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, path.basename(fileName));

    return new Promise((resolve) => {
      let settled = false;
      let file = null;
      const settle = (r) => {
        if (settled) return;
        settled = true;
        activeDownloads.delete(key);
        resolve(r);
      };

      // Registered before any request, so cancel works during redirects too
      const handle = getFollow(url, {
        kind: 'download', log: netLog,
        onError: (e) => settle({ ok: false, error: e.message }),
        onResponse: (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return settle({ ok: false, error: `HTTP ${res.statusCode}` });
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          file = fs.createWriteStream(destFile);
          res.on('data', (chunk) => {
            if (settled) return;
            received += chunk.length;
            if (total > 0) onProgress(Math.round(received / total * 100));
          });
          res.pipe(file);
          file.on('finish', () => { file.close(); settle({ ok: true, filePath: destFile }); });
          file.on('error', (err) => { fs.unlink(destFile, () => {}); settle({ ok: false, error: err.message }); });
        },
      });

      activeDownloads.set(key, {
        cancel: () => {
          handle.aborted = true;
          try { handle.req?.destroy(); } catch { /* already gone */ }
          try { file?.close(); } catch { /* not open */ }
          settle({ ok: false, error: 'Cancelled' });
        },
      });
    });
  }

  function cancelDownload(key) {
    activeDownloads.get(key)?.cancel();
    return { ok: true };
  }

  // Extracts into <install folder>/<identifier>, or for one game of a
  // collection into <identifier>/_GAME_<subFolder>, which findExes groups by.
  // 7-Zip when installed (zip/7z/rar), extract-zip for .zip otherwise.
  async function extract({ filePath, identifier, subFolder }) {
    const s = settings.load();
    const parentDir = path.join(installDir(), disk.sanitizeFolderName(identifier));
    const destDir = subFolder ? path.join(parentDir, '_GAME_' + disk.sanitizeFolderName(subFolder)) : parentDir;
    fs.mkdirSync(destDir, { recursive: true });

    const done = () => {
      disk.unblockDirectory(destDir, { platform, log });
      if (s.deleteAfterInstall) {
        fs.unlink(filePath, () => {
          try { fs.rmdirSync(path.dirname(filePath)); } catch { /* not empty */ }
        });
      }
      return { ok: true, installDir: destDir, parentInstallDir: parentDir };
    };

    const lower = filePath.toLowerCase();
    if (/\.(zip|7z|rar)$/.test(lower) && fs.existsSync(sevenZip)) {
      return new Promise((resolve) => {
        execFile(sevenZip, ['x', filePath, `-o${destDir}`, '-y'], (err) => {
          resolve(err ? { ok: false, error: err.message } : done());
        });
      });
    }
    if (lower.endsWith('.zip')) {
      try {
        await require('extract-zip')(filePath, { dir: destDir });
        return done();
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'Unsupported archive format' };
  }

  // ─── Jobs (POST /installs) ────────────────────────────────────────────────

  const view = (job) => ({
    id: job.id, itemId: job.itemId, file: job.file, status: job.status, percent: job.percent,
    error: job.error, installDir: job.installDir, exePath: job.exePath,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
  });

  function update(job, fields) {
    Object.assign(job, fields);
    if (['done', 'error', 'cancelled'].includes(job.status) && !job.finishedAt) job.finishedAt = Date.now();
    emit('install', view(job));
  }

  async function runJob(job, subFolder) {
    const r = await download({
      key: job.id, identifier: job.itemId, url: archive.downloadUrl(job.itemId, job.file), fileName: job.file,
      onProgress: (percent) => { if (percent !== job.percent) update(job, { percent }); },
    });
    if (job.status === 'cancelled') return;
    if (!r.ok) return update(job, { status: 'error', error: r.error });

    update(job, { status: 'extracting', percent: 100 });
    const x = await extract({ filePath: r.filePath, identifier: job.itemId, subFolder });
    if (!x.ok) return update(job, { status: 'error', error: x.error });

    // The item is registered against the parent folder: findExes walks into
    // a collection's _GAME_ folders from there
    const exes = disk.findExes(x.parentInstallDir);
    const exePath = exes.length === 1 ? exes[0] : null;
    library.recordInstall(job.itemId, x.parentInstallDir, exePath);
    update(job, { status: 'done', installDir: x.parentInstallDir, exePath });
  }

  // Starts one job per file. files: names from the item's file list; when
  // omitted the item must have exactly one installable file. Resolves
  // { ok, jobs } or { ok: false, error, detail, choices? }.
  async function start({ itemId, files }) {
    const list = await archive.fileList(itemId);
    if (!list.ok) return { ok: false, error: 'file_list_failed', detail: list.error };
    const installable = installableFiles(list.files);
    if (!installable.length) return { ok: false, error: 'no_installable_file', detail: 'No downloadable file found for this item.' };

    let chosen;
    if (files == null) {
      if (installable.length > 1) {
        return { ok: false, error: 'choose_files', detail: 'This item has several archives; pass files.', choices: installable };
      }
      chosen = installable;
    } else {
      chosen = [].concat(files).map(name => installable.find(f => f.name === name));
      const missing = [].concat(files).filter((_, i) => !chosen[i]);
      if (missing.length || !chosen.length) {
        return { ok: false, error: 'unknown_file', detail: `Not an installable file of ${itemId}: ${missing.join(', ') || '(none given)'}` };
      }
    }

    const started = [];
    for (const f of chosen) {
      const running = [...jobs.values()].find(j => j.itemId === itemId && j.file === f.name && ['downloading', 'extracting'].includes(j.status));
      if (running) { started.push(view(running)); continue; }
      const job = {
        id: crypto.randomUUID(), itemId, file: f.name, status: 'downloading', percent: 0, error: null,
        installDir: null, exePath: null, startedAt: Date.now(), finishedAt: null,
      };
      jobs.set(job.id, job);
      emit('install', view(job));
      // A collection (several archives) extracts each game into its own folder
      const subFolder = installable.length > 1 ? f.name.replace(/\.[^.]+$/, '') : null;
      job.done = runJob(job, subFolder).catch(e => update(job, { status: 'error', error: e.message }));
      started.push(view(job));
    }
    return { ok: true, jobs: started };
  }

  const get  = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
  const list = () => [...jobs.values()].map(view);
  const wait = (id) => jobs.get(id)?.done;

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status === 'downloading') {
      update(job, { status: 'cancelled', error: 'Cancelled' });
      cancelDownload(id);
    }
    return view(job);
  }

  // ─── Adopt installs already on disk ───────────────────────────────────────

  function scan({ scanDir, knownIdentifiers, titleMap }) {
    if (!library.available) return { found: [] };
    const found = [];
    for (const m of disk.matchInstallFolders(scanDir, knownIdentifiers, titleMap)) {
      const existing = library.get(m.identifier);
      if (existing?.install_dir && fs.existsSync(existing.install_dir)) continue;
      const exes = disk.findExes(m.folderPath);
      const exePath = exes.length === 1 ? exes[0] : null;
      library.adoptInstall(m.identifier, m.folderPath, exePath);
      log(`[scan] Found pre-existing install (${m.matchedBy}): ${m.identifier} → ${m.folderPath}`);
      found.push({ identifier: m.identifier, installDir: m.folderPath, exePath, matchedBy: m.matchedBy });
    }
    return { found };
  }

  return { download, cancelDownload, extract, start, get, list, wait, cancel, scan };
}

module.exports = { createInstalls, SEVEN_ZIP };
