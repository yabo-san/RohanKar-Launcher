'use strict';
/**
 * Install engine: download an archive.org file, extract it, find its
 * executable, record it in library.db. Ports (catalog items) take the latest
 * GitHub or GitLab release's build for this system (ports.js); game data is the user's job.
 * Files from additional sources are checked against the user's sha1, or
 * pinned on first install (pins); a changed file stops with hashChange set.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const { getFollow, getText } = require('./net');
const { installableFiles, ARCHIVE_FILE } = require('./archive');
const disk = require('./disk');
const ports = require('./ports');
const { checkPin } = require('./user-sources');
const { findSevenZip, WINDOWS_7ZIP } = require('./sevenzip');
const { createJournal, STAGING_PREFIX, INTERRUPTED } = require('./install-journal');

const SEVEN_ZIP = WINDOWS_7ZIP;
const GITHUB_API = 'https://api.github.com';
const GITLAB_API = 'https://gitlab.com/api/v4';
const NO_PINS = { get: () => null, set: () => {} };

// Runs an unpacker with no stdin (so a password prompt fails instead of
// waiting forever) and without buffering its output (a big archive's file
// list used to overflow execFile's buffer). Resolves { ok } or
// { ok: false, code, output } with the output's last few KB; 'Cancelled'
// when signal aborts it.
function runTool(cmd, args, { signal, onOutput = () => {} } = {}) {
  return new Promise((resolve) => {
    let tail = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const keep = (d) => { const text = d.toString(); tail = (tail + text).slice(-4000); onOutput(text); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => resolve({ ok: false, error: e.name === 'AbortError' ? 'Cancelled' : e.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, code, output: tail }));
  });
}

// 7-Zip's failure in words: what it means for the user, not an exit code
function sevenZipError(name, { code, output = '', error }) {
  if (error) return error === 'Cancelled' ? error : `Couldn't run 7-Zip to unpack ${name}: ${error}`;
  if (/wrong password|encrypted/i.test(output)) return `${name} is password protected, so it can't be unpacked.`;
  if (/not enough space|no space left|disk full/i.test(output)) return `There isn't enough free disk space to unpack ${name}.`;
  if (/can ?not open .*as archive|unexpected end|data error|crc failed|headers error|is not archive/i.test(output)) {
    return `${name} looks damaged or incomplete. Install again to download it fresh.`;
  }
  const last = output.split(/[\r\n\b]+/).map(l => l.trim()).filter(Boolean).pop();
  return `7-Zip couldn't unpack ${name} (exit code ${code})${last ? `: ${last}` : ''}`;
}

// A percent from 7-Zip's -bsp1 progress output (" 42% 12 - file"), or null
function lastPercent(text) {
  const all = [...String(text).matchAll(/(\d{1,3})%/g)].map(m => Number(m[1])).filter(n => n <= 100);
  return all.length ? all.at(-1) : null;
}

// Moves a finished unpack into place: a rename when the folder is new, else
// its files go over the existing folder (an update, or a reinstall)
async function place(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); return; } catch { /* another drive, or held open: copy instead */ }
  }
  await fs.promises.cp(from, to, { recursive: true, force: true });
  await fs.promises.rm(from, { recursive: true, force: true });
}

// journalFile: where unfinished installs are written down, so the next start
// can remove what an install killed midway left behind (install-journal.js).
// stallMs: how long a download may go without receiving anything.
function createInstalls({ settings, library, archive, gamesDir, pins = NO_PINS, emit = () => {}, log = () => {}, netLog = () => {}, platform = process.platform, deck = platform === 'linux' && ports.onSteamDeck(), sevenZip = findSevenZip({ platform }), githubApi = GITHUB_API, gitlabApi = GITLAB_API, journalFile = null, stallMs = 60000 }) {
  const activeDownloads = new Map();  // key → { cancel }
  const jobs = new Map();             // install id → job
  const journal = createJournal(journalFile, { log, busy: (dir) => [...activeDownloads.values()].some(d => d.dir === dir) });

  const downloadDir = () => settings.load().downloadPath || gamesDir;
  const installDir  = () => settings.load().installPath  || gamesDir;

  // Once installed, nothing reads the download again (a reinstall or update
  // fetches it fresh), so it goes. A file that was copied in as it is can be
  // the installed file itself when both folders are the same: that one stays.
  // The emptied folder goes too, unless another download is about to write
  // into it (an item's second file): removing it would fail that download.
  function removeDownload(filePath, copiedTo = null) {
    if (copiedTo && path.resolve(copiedTo) === path.resolve(filePath)) return;
    fs.rmSync(filePath, { force: true });
    const dir = path.resolve(path.dirname(filePath));
    if ([...activeDownloads.values()].some(d => d.dir === dir)) return;
    try { fs.rmdirSync(dir); } catch { /* not empty */ }
  }

  // Downloads url into <download folder>/<identifier>/<fileName>, writing
  // <fileName>.part until the last byte is in, so a cut-off download never
  // looks finished. Resolves { ok, filePath } or { ok: false, error } (the
  // .part file removed); cancel(key) resolves it as 'Cancelled'.
  // onFile(path, kind): each file it creates, for the journal.
  function download({ key, identifier, url, fileName, onProgress = () => {}, onFile = () => {} }) {
    const destDir = path.join(downloadDir(), disk.sanitizeFolderName(identifier));
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, path.basename(fileName));
    const partFile = destFile + '.part';
    onFile(partFile, 'part');

    return new Promise((resolve) => {
      let settled = false;
      let file = null;
      const settle = (r) => {
        if (settled) return;
        settled = true;
        activeDownloads.delete(key);
        if (r.ok) return resolve(r);
        // The .part goes once the file is closed (Windows won't delete an open file)
        const drop = () => fs.rm(partFile, { force: true }, () => resolve(r));
        if (file && !file.closed) { file.once('close', drop); file.destroy(); } else drop();
      };

      // Registered before any request, so cancel works during redirects too
      const handle = getFollow(url, {
        // A download that gets no data for stallMs fails instead of waiting forever
        kind: 'download', log: netLog, timeoutMs: stallMs,
        onError: (e) => settle({ ok: false, error: file && /timed out/i.test(e.message)
          ? 'The download stalled: nothing arrived for a while. Check your connection and try again.' : e.message }),
        onResponse: (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return settle({ ok: false, error: `HTTP ${res.statusCode}` });
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          file = fs.createWriteStream(partFile);
          res.on('data', (chunk) => {
            if (settled) return;
            received += chunk.length;
            if (total > 0) onProgress(Math.min(100, Math.round(received / total * 100)));
          });
          // pipeline reports a connection cut midway, which a bare pipe() never did
          pipeline(res, file, (err) => {
            if (settled) return;
            const pct = total > 0 ? Math.floor(received / total * 100) : null;
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !/aborted|ECONNRESET/i.test(`${err.code} ${err.message}`)) return settle({ ok: false, error: err.message });
            if (err || (total > 0 && received < total)) {
              return settle({ ok: false, error: `The download was cut off${pct !== null ? ` at ${pct}%` : ''}. Try again.` });
            }
            try { fs.renameSync(partFile, destFile); } catch (e) { return settle({ ok: false, error: e.message }); }
            onFile(destFile, 'download');
            settle({ ok: true, filePath: destFile });
          });
        },
      });

      activeDownloads.set(key, {
        dir: path.resolve(destDir),
        cancel: () => {
          handle.aborted = true;
          try { handle.req?.destroy(); } catch { /* already gone */ }
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
  // The archive unpacks into a hidden folder beside it first and is moved
  // into place only once it is whole, so a failed, cancelled or killed unpack
  // never leaves a half-unpacked game where the game goes.
  // into: an existing install folder to unpack over instead (an update).
  // onProgress(percent) while it unpacks; signal cancels it; onFile(path, kind)
  // as download(). Resolves { ok, installDir, parentInstallDir } or { ok: false, error }.
  async function extract({ filePath, identifier, subFolder, into = null, onProgress = () => {}, signal = null, onFile = () => {}, onPlacing = () => {} }) {
    const parentDir = into || path.join(installDir(), disk.sanitizeFolderName(identifier));
    const destDir = subFolder ? path.join(parentDir, '_GAME_' + disk.sanitizeFolderName(subFolder)) : parentDir;
    const done = (copiedTo = null) => {
      removeDownload(filePath, copiedTo);
      return { ok: true, installDir: destDir, parentInstallDir: parentDir };
    };
    if (!fs.existsSync(filePath)) return { ok: false, error: `${path.basename(filePath)} is missing` };

    // Not an archive: the file itself is the install, moved in as it is
    if (!isUnpackable(filePath)) {
      const copiedTo = path.join(destDir, path.basename(filePath));
      if (path.resolve(copiedTo) === path.resolve(filePath)) return done(copiedTo);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        onPlacing();
        try { fs.renameSync(filePath, copiedTo); } catch { await fs.promises.copyFile(filePath, copiedTo); }
      } catch (e) {
        return { ok: false, error: e.message };
      }
      return done();
    }

    const staging = path.join(path.dirname(destDir), `${STAGING_PREFIX}${crypto.randomUUID()}`);
    onFile(staging, 'staging');
    try {
      const r = await extractTo(filePath, staging, { onProgress, signal });
      if (!r.ok) return r;
      if (signal?.aborted) return { ok: false, error: 'Cancelled' };
      await disk.unblockDirectory(staging, { platform, log });
      await disk.makeRunnable(staging, { platform, log });
      onPlacing();
      await place(staging, destDir);
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    return done();
  }

  // What extractTo unpacks rather than copies, on this system
  function isUnpackable(filePath) {
    const lower = filePath.toLowerCase();
    if (ports.TAR_EXT.test(lower) || lower.endsWith('.zip')) return true;
    return /\.(7z|rar)$/.test(lower) && (platform === 'linux' || !!(sevenZip && fs.existsSync(sevenZip)));
  }

  // Unpacks an archive into destDir: 7-Zip when there is one (zip/7z/rar),
  // extract-zip for .zip otherwise, the system's tar for a tarball (a Linux
  // build); any other file is copied in as it is. onProgress(percent) while
  // 7-Zip or extract-zip unpacks; signal stops it ('Cancelled').
  // Resolves { ok } ({ ok, copiedTo } for a copied file) or { ok: false, error }.
  async function extractTo(filePath, destDir, { onProgress = () => {}, signal = null } = {}) {
    fs.mkdirSync(destDir, { recursive: true });
    const lower = filePath.toLowerCase();
    const name = path.basename(filePath);
    if (ports.TAR_EXT.test(lower)) {
      const r = await runTool('tar', ['-xf', filePath, '-C', destDir], { signal });
      return r.ok ? r : { ok: false, error: r.error || `Couldn't unpack ${name}: ${r.output.trim().split('\n').pop() || `tar exit code ${r.code}`}` };
    }
    if (/\.(zip|7z|rar)$/.test(lower) && sevenZip && fs.existsSync(sevenZip)) {
      let last = -1;
      // -bsp1: progress percent on stdout; -bso0: no file list; -p: no password prompt
      const r = await runTool(sevenZip, ['x', filePath, `-o${destDir}`, '-y', '-bsp1', '-bso0', '-p'], {
        signal,
        onOutput: (text) => {
          const pct = lastPercent(text);
          if (pct !== null && pct !== last) { last = pct; onProgress(pct); }
        },
      });
      return r.ok ? r : { ok: false, error: sevenZipError(name, r) };
    }
    if (lower.endsWith('.zip')) {
      try {
        let n = 0, last = -1;
        await require('extract-zip')(filePath, {
          dir: path.resolve(destDir),
          onEntry: (entry, zip) => {
            if (signal?.aborted) throw new Error('Cancelled');
            const pct = Math.floor(++n / Math.max(1, zip.entryCount) * 100);
            if (pct !== last) { last = pct; onProgress(pct); }
          },
        });
        return { ok: true };
      } catch (e) {
        if (e.message === 'Cancelled') return { ok: false, error: 'Cancelled' };
        return { ok: false, error: /end of central directory|invalid|corrupt|unexpected/i.test(e.message)
          ? `${name} looks damaged or incomplete. Install again to download it fresh. (${e.message})` : e.message };
      }
    }
    // On Linux a .7z or .rar copied in as it is would look installed and never run
    if (platform === 'linux' && /\.(7z|rar)$/.test(lower)) {
      return { ok: false, error: `Couldn't unpack ${name}: 7-Zip isn't available. Install 7-Zip (7zz) or use the Flatpak, which brings its own.` };
    }
    // Not an archive: kept as it is, the launcher is just its download client
    try {
      const copiedTo = path.join(destDir, name);
      if (path.resolve(copiedTo) !== path.resolve(filePath)) fs.copyFileSync(filePath, copiedTo);
      return { ok: true, copiedTo };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ─── Jobs (POST /installs) ────────────────────────────────────────────────

  // step: 'binary' while a port installs, null for archive.org items.
  // percent: of the download while downloading, of the unpack while extracting.
  // interrupted: a job from before the last restart that never finished.
  const view = (job) => ({
    id: job.id, itemId: job.itemId, file: job.file, status: job.status, step: job.step ?? null, percent: job.percent,
    error: job.error, installDir: job.installDir, exePath: job.exePath,
    ...(job.into ? { into: job.into.identifier } : {}),
    ...(job.hashChange ? { hashChange: job.hashChange } : {}),
    ...(job.interrupted ? { interrupted: true, title: job.title, kind: job.kind } : {}),
    startedAt: job.startedAt, finishedAt: job.finishedAt,
  });

  function update(job, fields) {
    Object.assign(job, fields);
    if (['done', 'error', 'cancelled'].includes(job.status) && !job.finishedAt) job.finishedAt = Date.now();
    emit('install', view(job));
  }

  const isRunning = (j) => ['downloading', 'extracting', 'verifying'].includes(j.status);

  // Installs a previous run of the app never finished: their leftovers go
  // now, and they are listed as failed so the app can offer them again
  for (const r of journal.recover()) {
    jobs.set(r.id, {
      id: r.id, itemId: r.itemId, file: r.file, title: r.title, kind: r.kind, status: 'error', step: null, percent: 0,
      error: INTERRUPTED, interrupted: true, installDir: null, exePath: null, startedAt: r.startedAt, finishedAt: Date.now(),
    });
  }

  // A job's journal entry, and what its steps need to report into it
  function track(job, kind, title) {
    job.abort = new AbortController();
    journal.begin({ id: job.id, itemId: job.itemId, file: job.file, title, kind });
    return (p, k) => journal.track(job.id, p, k);
  }
  // Runs a job's steps; whatever they leave behind goes unless it finished
  async function runTracked(job, steps) {
    try {
      await steps();
    } catch (e) {
      if (job.status !== 'cancelled') update(job, { status: 'error', error: e.message });
    } finally {
      if (isRunning(job)) update(job, { status: 'error', error: job.error || 'The install stopped unexpectedly.' });
      journal.end(job.id, { ok: job.status === 'done' });
    }
  }

  // A downloaded file from an additional source: its sha1 against the user's,
  // else against the pin from its first install. true, or fails the job.
  async function checkUserFile(job, { pinKey, name, filePath, expected }) {
    update(job, { status: 'verifying' });
    const r = checkPin({ file: name, expected, pinned: pins.get(pinKey, name), actual: await ports.sha1File(filePath), accept: job.acceptHashChange });
    if (!r.ok) {
      update(job, { status: 'error', error: r.error, ...(r.changed ? { hashChange: { ...r.changed, itemId: job.itemId } } : {}) });
      return false;
    }
    if (r.pin) pins.set(pinKey, name, r.pin);
    return true;
  }

  async function runJob(job, subFolder) {
    const onFile = track(job, 'game', job.meta.title);
    const progress = (percent) => { if (percent !== job.percent) update(job, { percent }); };
    const r = await download({
      key: job.id, identifier: job.itemId, url: archive.downloadUrl(job.itemId, job.file), fileName: job.file, onProgress: progress, onFile,
    });
    if (job.status === 'cancelled') return;
    if (!r.ok) return update(job, { status: 'error', error: r.error });
    if (job.check) {
      const expected = job.check.files.find(f => f.name === job.file)?.sha1 || null;
      if (!(await checkUserFile(job, { pinKey: `archive:${job.itemId}`, name: job.file, filePath: r.filePath, expected }))) return;
    }

    update(job, { status: 'extracting', percent: 0 });
    const x = await extract({
      filePath: r.filePath, identifier: job.itemId, subFolder, into: job.into?.installDir,
      onProgress: progress, signal: job.abort.signal, onFile, onPlacing: () => { job.placing = true; },
    });
    if (job.status === 'cancelled') return;
    if (!x.ok) return update(job, { status: 'error', error: x.error });

    // The item is registered against the parent folder: findExes walks into
    // a collection's _GAME_ folders from there
    const exes = disk.findExes(x.parentInstallDir, 0, { platform });
    const exePath = exes.length === 1 ? exes[0] : null;
    if (job.into) {
      library.recordUpdate(job.into.identifier, { upload: job.itemId, uploadDate: job.meta.uploadDate, title: job.meta.title, exePath });
    } else {
      library.recordInstall(job.itemId, x.parentInstallDir, exePath, job.meta);
    }
    update(job, { status: 'done', percent: 100, installDir: x.parentInstallDir, exePath });
  }

  // Starts one job per file. files: names from the item's file list; when
  // omitted the item must have exactly one installable file. check: for an
  // upload from an additional source, { files: [{ name, sha1? }] } (items.userCheck);
  // acceptHashChange re-pins a file that changed. meta: { title, uploadDate }
  // saved with the install. into: the library identifier of an install this
  // upload updates (a reupload of the same game): its files go over that
  // folder and the entry keeps its identifier. Resolves
  // { ok, jobs } or { ok: false, error, detail, choices? }.
  async function start({ itemId, files, check = null, acceptHashChange = false, meta = {}, into = null }) {
    let target = null;
    if (into) {
      const row = library.get(into);
      if (!row?.install_dir || !fs.existsSync(row.install_dir)) return { ok: false, error: 'not_installed', detail: `${into} isn't installed, so there's nothing to update.` };
      target = { identifier: into, installDir: row.install_dir };
    }
    const list = await archive.fileList(itemId);
    if (!list.ok) return { ok: false, error: 'file_list_failed', detail: list.error };
    const installable = installableFiles(list.files);
    if (!installable.length) return { ok: false, error: 'no_installable_file', detail: 'This item has no files of its own to download.' };

    let chosen;
    if (files == null) {
      if (installable.length > 1) {
        return { ok: false, error: 'choose_files', detail: 'This item has several files; pass files.', choices: installable };
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
      const running = [...jobs.values()].find(j => (j.itemId === itemId || (target && j.into?.identifier === into)) && j.file === f.name && isRunning(j));
      if (running) { started.push(view(running)); continue; }
      const job = {
        id: crypto.randomUUID(), itemId, file: f.name, status: 'downloading', percent: 0, error: null,
        installDir: null, exePath: null, startedAt: Date.now(), finishedAt: null, check, acceptHashChange,
        meta: { title: meta.title || null, uploadDate: meta.uploadDate || null }, into: target,
      };
      jobs.set(job.id, job);
      emit('install', view(job));
      // A collection (several archives) extracts each game into its own folder;
      // plain files all land in the item's folder
      const subFolder = installable.length > 1 && ARCHIVE_FILE.test(f.name) ? f.name.replace(/\.[^.]+$/, '') : null;
      job.done = runTracked(job, () => runJob(job, subFolder));
      started.push(view(job));
    }
    return { ok: true, jobs: started };
  }

  // ─── Ports (POST /installs with a catalog item id) ─────────────────────────

  // item: a catalog item from catalogs.items(). One from an additional source
  // (userSource) has its release binary checked or pinned per release tag.
  // Resolves { ok, jobs } or { ok: false, error, detail }.
  function startPort({ item, acceptHashChange = false }) {
    if (!item.repository) return { ok: false, error: 'no_repository', detail: `${item.title} has no repository to install from.` };
    if (item.sourceOnly) return { ok: false, error: 'source_only', detail: `${item.title} is source only: it publishes no download. Build it from ${item.repositoryUrl || item.repository}.` };
    const running = [...jobs.values()].find(j => j.itemId === item.id && isRunning(j));
    if (running) return { ok: true, jobs: [view(running)] };
    const job = {
      id: crypto.randomUUID(), itemId: item.id, file: null, status: 'downloading', step: 'binary', percent: 0, error: null,
      installDir: null, exePath: null, startedAt: Date.now(), finishedAt: null, acceptHashChange,
    };
    jobs.set(job.id, job);
    emit('install', view(job));
    job.done = runTracked(job, () => runPortJob(job, item));
    return { ok: true, jobs: [view(job)] };
  }

  // Settings > GitHub token, when set, lifts GitHub's 60 requests an hour.
  // Only sent to the GitHub API, never logged (netLog keeps response headers).
  function githubHeaders() {
    const token = String(settings.load().githubToken || '').trim();
    return { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  const rateLimited = (r) => r.status === 429 || (r.status === 403 && String(r.headers?.['x-ratelimit-remaining']) === '0');

  // The newest published release, from GitHub or GitLab (repositorySource "gitlab")
  async function latestRelease(item) {
    const gitlab = item.repositorySource === 'gitlab' || item.entry?.repositorySource === 'gitlab';
    const repository = item.repository;
    const r = gitlab
      ? await getText(ports.gitlabReleasesUrl(gitlabApi, repository), { kind: 'gitlab', log: netLog, timeoutMs: 15000, headers: { Accept: 'application/json' } })
      : await getText(`${githubApi}/repos/${repository}/releases?per_page=30`, {
        kind: 'github', log: netLog, timeoutMs: 15000, headers: githubHeaders(),
      });
    if (!gitlab && rateLimited(r)) {
      throw new Error(settings.load().githubToken
        ? "GitHub's hourly limit for your token is used up. Try again in an hour."
        : "GitHub allows 60 release checks an hour without a token, and they're used up. Add a GitHub token in Settings, or try again in an hour.");
    }
    if (r.status !== 200) throw new Error(`Couldn't read the releases of ${repository} (${r.error || `HTTP ${r.status}`})`);
    const list = JSON.parse(r.body);
    const release = ports.pickRelease(gitlab ? ports.releasesFromGitlab(list) : list);
    if (!release) throw new Error(`${repository} has no published release`);
    return { release, source: gitlab ? 'gitlab' : 'github' };
  }

  // The latest release's build for this system, unpacked into the port's folder
  async function runPortJob(job, item) {
    const entry = item.entry || {};
    const folderName = disk.sanitizeFolderName(entry.folderName || item.repository.replace('/', '.'));
    const dest = path.join(installDir(), folderName);
    const onFile = track(job, 'port', item.title || item.name || null);
    const progress = (percent) => { if (percent !== job.percent) update(job, { percent }); };
    const fail = (error) => update(job, { status: 'error', error });

    update(job, { status: 'downloading', step: 'binary', percent: 0 });
    const { release, source } = await latestRelease(item);
    if (job.status === 'cancelled') return;
    const pick = ports.pickAsset(release.assets, { pattern: entry.assetPattern, filter: entry.releaseAssetFilter, platform, deck });
    if (!pick.asset) throw new Error(`${pick.error} of ${item.repository} (${release.tag_name}): ${pick.names.join(', ') || 'no assets'}`);
    update(job, { file: pick.asset.name });
    const bin = await download({ key: job.id, identifier: folderName, url: pick.asset.browser_download_url, fileName: pick.asset.name, onProgress: progress, onFile });
    if (job.status === 'cancelled') return;
    if (!bin.ok) return fail(bin.error);
    // A GitLab package link's name has no extension: name it after what it holds
    if (!ports.isArchive(bin.filePath) && !/\.exe$/i.test(bin.filePath)) {
      const ext = ports.sniffArchiveExt(bin.filePath);
      if (ext) { fs.renameSync(bin.filePath, bin.filePath + ext); bin.filePath += ext; onFile(bin.filePath, 'download'); }
    }
    if (item.userSource) {
      const ok = await checkUserFile(job, { pinKey: `${source}:${item.repository.toLowerCase()}@${release.tag_name}`, name: pick.asset.name, filePath: bin.filePath, expected: entry.sha1 || null });
      if (!ok) return;
    }
    update(job, { status: 'extracting', percent: 0 });
    let copiedTo = null;
    if (ports.isArchive(bin.filePath)) {
      // Unpacked beside the download first: a release that is one folder
      // (pd-x86_64-windows/) lays down that folder's contents. Only a whole
      // unpack reaches the port's folder.
      const staging = path.join(path.dirname(bin.filePath), `${STAGING_PREFIX}${job.id}`);
      onFile(staging, 'staging');
      try {
        await fs.promises.rm(staging, { recursive: true, force: true });
        const x = await extractTo(bin.filePath, staging, { onProgress: progress, signal: job.abort.signal });
        if (job.status === 'cancelled') return;
        if (!x.ok) return fail(x.error);
        await disk.unblockDirectory(staging, { platform, log });
        await disk.makeRunnable(staging, { platform, log });
        job.placing = true;
        await place(ports.releaseRoot(staging), dest);
      } finally {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      job.placing = true;
      fs.mkdirSync(dest, { recursive: true });
      copiedTo = path.join(dest, path.basename(bin.filePath));
      if (path.resolve(copiedTo) !== path.resolve(bin.filePath)) await fs.promises.copyFile(bin.filePath, copiedTo);
      await disk.unblockDirectory(dest, { platform, log });
      await disk.makeRunnable(dest, { platform, log });
    }
    for (const f of [].concat(entry.filesToAdd || [])) {
      const target = ports.inside(dest, f);
      if (target && !fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ''); }
    }

    // Record it against the catalog item, keeping its library row
    removeDownload(bin.filePath, copiedTo);
    const exes = disk.findExes(dest, 0, { platform });
    const exePath = exes.length === 1 ? exes[0] : null;
    library.adoptInstall(item.id, dest, exePath);
    // The release tag, so a newer release can be offered as an update
    library.setDetails(item.id, { version: release.tag_name });
    releaseChecks.delete(item.id);
    update(job, { status: 'done', step: null, percent: 100, installDir: dest, exePath });
  }

  // ─── Newer releases and the file picker ──────────────────────────────────

  // The latest release's files, for the picker when a repo is added
  async function releaseFiles(item) {
    const { release } = await latestRelease(item);
    return ports.releaseFiles(release, { platform, deck });
  }

  // Installed ports whose repo has published a newer release than the one
  // installed (the tag recorded at install). One check per port an hour, so
  // opening the app doesn't use up GitHub's 60 requests an hour; a port
  // installed before tags were recorded is left out. Errors are skipped.
  const releaseChecks = new Map();   // item id -> { at, latest }
  const CHECK_MS = 60 * 60 * 1000;
  async function portUpdates(items, { now = Date.now() } = {}) {
    const lib = library.all();
    const out = [];
    for (const item of items) {
      const row = lib[item.id];
      if (!row?.install_dir || !row.version || item.sourceOnly || !item.repository) continue;
      let c = releaseChecks.get(item.id);
      if (!c || now - c.at > CHECK_MS) {
        try { c = { at: now, latest: (await latestRelease(item)).release.tag_name }; } catch (e) { log(`[updates] ${item.repository}: ${e.message}`); continue; }
        releaseChecks.set(item.id, c);
      }
      if (c.latest && c.latest !== row.version) out.push({ id: item.id, installed: row.version, latest: c.latest });
    }
    return out;
  }

  const get  = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
  const list = () => [...jobs.values()].map(view);
  const wait = (id) => jobs.get(id)?.done;

  // Stops a job while it downloads or unpacks; what it made so far goes.
  // Once the unpacked files are being moved into place it runs to the end.
  // An interrupted job from the last run is dismissed: the app has offered it.
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.interrupted) { jobs.delete(id); return view(job); }
    if (['downloading', 'extracting'].includes(job.status) && !job.placing) {
      update(job, { status: 'cancelled', step: null, error: 'Cancelled' });
      cancelDownload(id);
      job.abort?.abort();
    }
    return view(job);
  }

  // ─── Adopt installs already on disk ───────────────────────────────────────

  // scanDirs: several folders in one pass (install, download, default); a
  // folder found under two of them is adopted once
  function scan({ scanDir, scanDirs, knownIdentifiers, titleMap }) {
    if (!library.available) return { found: [] };
    const found = [];
    const dirs = [...new Set([scanDir, ...(scanDirs || [])].filter(Boolean).map(d => path.resolve(d)))];
    const matches = dirs.flatMap(d => disk.matchInstallFolders(d, knownIdentifiers, titleMap));
    const titleOf = new Map(Object.entries(titleMap || {}).map(([t, id]) => [id, t]));
    for (const m of matches) {
      if (found.some(f => f.identifier === m.identifier)) continue;
      const existing = library.get(m.identifier);
      if (existing?.install_dir && fs.existsSync(existing.install_dir)) continue;
      const exes = disk.findExes(m.folderPath, 0, { platform });
      const exePath = exes.length === 1 ? exes[0] : null;
      library.adoptInstall(m.identifier, m.folderPath, exePath, { title: titleOf.get(m.identifier) || null });
      log(`[scan] Found pre-existing install (${m.matchedBy}): ${m.identifier} → ${m.folderPath}`);
      found.push({ identifier: m.identifier, installDir: m.folderPath, exePath, matchedBy: m.matchedBy });
    }
    return { found };
  }

  return { download, cancelDownload, extract, extractTo, start, startPort, get, list, wait, cancel, scan, releaseFiles, portUpdates };
}

module.exports = { createInstalls, SEVEN_ZIP, GITHUB_API, GITLAB_API };
