'use strict';
/**
 * Install engine: download an archive.org file, extract it, find its
 * executable, record it in library.db. Ports (catalog items) take the latest
 * GitHub release's Windows build and, when the collision catalog names one,
 * stage their game data from archive.org and check its sha1 (ports.js).
 * Files from additional sources are checked against the user's sha1, or
 * pinned on first install (pins); a changed file stops with hashChange set.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { getFollow, getText } = require('./net');
const { installableFiles } = require('./archive');
const disk = require('./disk');
const ports = require('./ports');
const { applyBps, BpsError } = require('./bps');
const { checkPin } = require('./user-sources');

const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
const GITHUB_API = 'https://api.github.com';
const NO_PINS = { get: () => null, set: () => {} };

function createInstalls({ settings, library, archive, gamesDir, pins = NO_PINS, emit = () => {}, log = () => {}, netLog = () => {}, platform = process.platform, sevenZip = SEVEN_ZIP, githubApi = GITHUB_API }) {
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

    const r = await extractTo(filePath, destDir);
    return r.ok ? done() : r;
  }

  // Unpacks an archive into destDir: 7-Zip when installed (zip/7z/rar),
  // extract-zip for .zip otherwise. Resolves { ok } or { ok: false, error }.
  async function extractTo(filePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const lower = filePath.toLowerCase();
    if (/\.(zip|7z|rar)$/.test(lower) && fs.existsSync(sevenZip)) {
      return new Promise((resolve) => {
        execFile(sevenZip, ['x', filePath, `-o${destDir}`, '-y'], (err) => {
          resolve(err ? { ok: false, error: err.message } : { ok: true });
        });
      });
    }
    if (lower.endsWith('.zip')) {
      try {
        await require('extract-zip')(filePath, { dir: path.resolve(destDir) });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'Unsupported archive format' };
  }

  // ─── Jobs (POST /installs) ────────────────────────────────────────────────

  // step: 'binary' or 'data' while a port installs, null for archive.org items
  const view = (job) => ({
    id: job.id, itemId: job.itemId, file: job.file, status: job.status, step: job.step ?? null, percent: job.percent,
    error: job.error, installDir: job.installDir, exePath: job.exePath,
    ...(job.hashChange ? { hashChange: job.hashChange } : {}),
    startedAt: job.startedAt, finishedAt: job.finishedAt,
  });

  function update(job, fields) {
    Object.assign(job, fields);
    if (['done', 'error', 'cancelled'].includes(job.status) && !job.finishedAt) job.finishedAt = Date.now();
    emit('install', view(job));
  }

  const isRunning = (j) => ['downloading', 'extracting', 'verifying'].includes(j.status);

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
    const r = await download({
      key: job.id, identifier: job.itemId, url: archive.downloadUrl(job.itemId, job.file), fileName: job.file,
      onProgress: (percent) => { if (percent !== job.percent) update(job, { percent }); },
    });
    if (job.status === 'cancelled') return;
    if (!r.ok) return update(job, { status: 'error', error: r.error });
    if (job.check) {
      const expected = job.check.files.find(f => f.name === job.file)?.sha1 || null;
      if (!(await checkUserFile(job, { pinKey: `archive:${job.itemId}`, name: job.file, filePath: r.filePath, expected }))) return;
    }

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
  // omitted the item must have exactly one installable file. check: for an
  // upload from an additional source, { files: [{ name, sha1? }] } (items.userCheck);
  // acceptHashChange re-pins a file that changed. Resolves
  // { ok, jobs } or { ok: false, error, detail, choices? }.
  async function start({ itemId, files, check = null, acceptHashChange = false }) {
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
      const running = [...jobs.values()].find(j => j.itemId === itemId && j.file === f.name && isRunning(j));
      if (running) { started.push(view(running)); continue; }
      const job = {
        id: crypto.randomUUID(), itemId, file: f.name, status: 'downloading', percent: 0, error: null,
        installDir: null, exePath: null, startedAt: Date.now(), finishedAt: null, check, acceptHashChange,
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

  // ─── Ports (POST /installs with a catalog item id) ─────────────────────────

  // item: a catalog item from catalogs.items(). One from an additional source
  // (userSource) has its release binary checked or pinned per release tag.
  // Resolves { ok, jobs } or { ok: false, error, detail }.
  function startPort({ item, acceptHashChange = false }) {
    if (!item.repository) return { ok: false, error: 'no_repository', detail: `${item.title} has no GitHub repository to install from.` };
    const running = [...jobs.values()].find(j => j.itemId === item.id && isRunning(j));
    if (running) return { ok: true, jobs: [view(running)] };
    const job = {
      id: crypto.randomUUID(), itemId: item.id, file: null, status: 'downloading', step: 'binary', percent: 0, error: null,
      installDir: null, exePath: null, startedAt: Date.now(), finishedAt: null, acceptHashChange,
    };
    jobs.set(job.id, job);
    emit('install', view(job));
    job.done = runPortJob(job, item).catch(e => update(job, { status: 'error', error: e.message }));
    return { ok: true, jobs: [view(job)] };
  }

  async function latestRelease(repository) {
    const r = await getText(`${githubApi}/repos/${repository}/releases?per_page=30`, {
      kind: 'github', log: netLog, timeoutMs: 15000, headers: { Accept: 'application/vnd.github+json' },
    });
    if (r.status !== 200) throw new Error(`Couldn't read the releases of ${repository} (${r.error || `HTTP ${r.status}`})`);
    const release = ports.pickRelease(JSON.parse(r.body));
    if (!release) throw new Error(`${repository} has no published release`);
    return release;
  }

  // base "binary" (the default): the release lays down first and the data goes
  // into it. base "data": the data lays down first and the release unpacks
  // into binaryTarget on top of it. See docs/COLLISIONS.md.
  async function runPortJob(job, item) {
    const entry = item.entry || {};
    const data = item.data || {};
    const folderName = disk.sanitizeFolderName(entry.folderName || item.repository.replace('/', '.'));
    const dest = path.join(installDir(), folderName);
    const progress = (percent) => { if (percent !== job.percent) update(job, { percent }); };
    const downloads = new Set();
    const fail = (error) => { update(job, { status: 'error', error }); return false; };
    const binDest = ports.inside(dest, data.binaryTarget || '');
    if (!binDest) return fail(`${item.title}'s binaryTarget would land outside the install folder`);
    fs.mkdirSync(dest, { recursive: true });

    // The binary: the latest release's Windows build, unpacked into binDest
    async function binary() {
      update(job, { status: 'downloading', step: 'binary', percent: 0 });
      const release = await latestRelease(item.repository);
      const pick = ports.pickAsset(release.assets, { pattern: data.assetPattern, filter: entry.releaseAssetFilter });
      if (!pick.asset) throw new Error(`${pick.error} of ${item.repository} (${release.tag_name}): ${pick.names.join(', ') || 'no assets'}`);
      update(job, { file: pick.asset.name });
      const bin = await download({ key: job.id, identifier: folderName, url: pick.asset.browser_download_url, fileName: pick.asset.name, onProgress: progress });
      if (job.status === 'cancelled') return false;
      if (!bin.ok) return fail(bin.error);
      downloads.add(bin.filePath);
      if (item.userSource) {
        const ok = await checkUserFile(job, { pinKey: `github:${item.repository.toLowerCase()}@${release.tag_name}`, name: pick.asset.name, filePath: bin.filePath, expected: entry.sha1 || null });
        if (!ok) return false;
      }
      update(job, { status: 'extracting', percent: 100 });
      fs.mkdirSync(binDest, { recursive: true });
      if (ports.ARCHIVE_EXT.test(bin.filePath)) {
        // Unpacked beside the download first: a release that is one folder
        // (pd-x86_64-windows/) lays down that folder's contents, so the data
        // stages next to the exe, unless the entry says keepReleaseFolder
        const staging = path.join(path.dirname(bin.filePath), `.unpack-${job.id}`);
        fs.rmSync(staging, { recursive: true, force: true });
        const x = await extractTo(bin.filePath, staging);
        if (!x.ok) { fs.rmSync(staging, { recursive: true, force: true }); return fail(x.error); }
        fs.cpSync(data.keepReleaseFolder ? staging : ports.releaseRoot(staging), binDest, { recursive: true, force: true });
        fs.rmSync(staging, { recursive: true, force: true });
      } else {
        fs.copyFileSync(bin.filePath, path.join(binDest, path.basename(bin.filePath)));
      }
      for (const f of [].concat(entry.filesToAdd || [])) {
        const target = ports.inside(binDest, f);
        if (target && !fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ''); }
      }
      return true;
    }

    // dataFiles: named files picked out of one archive.org download (contentUrl)
    async function dataFiles() {
      const wanted = data.dataFiles || [];
      if (!wanted.length) return true;
      const src = ports.archiveFile(data.contentUrl);
      if (!src) throw new Error(`The collision catalog's data link for ${item.title} isn't an archive.org download`);
      update(job, { status: 'downloading', step: 'data', percent: 0, file: path.basename(src.file) });
      const got = await download({ key: job.id, identifier: src.identifier, url: archive.downloadUrl(src.identifier, src.file), fileName: src.file, onProgress: progress });
      if (job.status === 'cancelled') return false;
      if (!got.ok) return fail(got.error);
      downloads.add(got.filePath);
      update(job, { status: 'extracting', percent: 100 });
      let staging = null;
      if (ports.ARCHIVE_EXT.test(got.filePath)) {
        staging = path.join(path.dirname(got.filePath), '_staging');
        fs.rmSync(staging, { recursive: true, force: true });
        const x = await extractTo(got.filePath, staging);
        if (!x.ok) return fail(x.error);
      }
      try {
        update(job, { status: 'verifying' });
        for (const df of wanted) {
          const found = (staging && ports.findFile(staging, df.name))
            || (path.basename(got.filePath).toLowerCase() === String(df.name).toLowerCase() ? got.filePath : null);
          if (!found) {
            if (df.optional) continue;
            const has = staging ? ports.largestFiles(staging, 5) : [];
            return fail(`${df.name} isn't in ${src.file}${has.length ? ` (it holds ${has.join(', ')})` : ''}`);
          }
          const target = ports.inside(dest, df.targetSubpath, df.name);
          if (!target) return fail(`${df.name} would land outside the install folder`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (df.patch) {
            const p = await patchFile(String(df.patch), staging, src.identifier);
            if (job.status === 'cancelled') return false;
            if (!p.ok) return fail(`${df.name}'s patch ${df.patch}: ${p.error}`);
            update(job, { status: 'verifying' });
            try {
              fs.writeFileSync(target, applyBps(fs.readFileSync(found), fs.readFileSync(p.filePath)));
            } catch (e) {
              if (!(e instanceof BpsError)) throw e;
              return fail(`${df.name} couldn't be patched with ${path.basename(p.filePath)}: ${e.message}`);
            }
          } else {
            fs.copyFileSync(found, target);
          }
          if (df.sha1) {
            const sum = await ports.sha1File(target);
            if (sum !== String(df.sha1).toLowerCase()) {
              fs.rmSync(target, { force: true });
              return fail(`${df.name} doesn't match the catalog (sha1 ${sum}, expected ${df.sha1})`);
            }
          }
        }
      } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true });
      }
      return true;
    }

    // A dataFiles[].patch: a URL, else a path in the unpacked data download,
    // the install folder (a release can ship its patch) or, failing both, the
    // same archive.org item. { ok, filePath } or { ok: false, error }
    async function patchFile(ref, staging, identifier) {
      const get = async (url, fileName) => {
        update(job, { status: 'downloading', step: 'data', percent: 0, file: path.basename(fileName) });
        const got = await download({ key: job.id, identifier, url, fileName, onProgress: progress });
        if (got.ok) downloads.add(got.filePath);
        return got;
      };
      if (/^https?:\/\//i.test(ref)) {
        const ia = ports.archiveFile(ref);
        if (ia) return get(archive.downloadUrl(ia.identifier, ia.file), ia.file);
        let name;
        try { name = decodeURIComponent(path.posix.basename(new URL(ref).pathname)); } catch { name = ''; }
        return get(ref, name || 'patch.bps');
      }
      for (const root of [staging, dest].filter(Boolean)) {
        const exact = ports.inside(root, ref);
        if (exact && exact !== path.resolve(root) && fs.existsSync(exact) && fs.statSync(exact).isFile()) return { ok: true, filePath: exact };
        const found = ports.findFile(root, path.basename(ref));
        if (found) return { ok: true, filePath: found };
      }
      return get(archive.downloadUrl(identifier, ref.replace(/^\/+/, '')), ref);
    }

    // sources: files, folders (dir/*) or whole archives straight from archive.org
    // items, each checked against the entry's sha1 or else archive.org's own
    async function sources() {
      const list = data.sources || [];
      if (!list.length) return true;
      const listed = new Map();
      for (const s of list) {
        if (!listed.has(s.ia)) {
          update(job, { status: 'downloading', step: 'data', percent: 0, file: s.ia });
          const r = await archive.fileList(s.ia);
          if (!r.ok) return fail(`Couldn't list ${s.ia} on archive.org (${r.error})`);
          listed.set(s.ia, r.files);
        }
        const x = ports.expandSource(s, listed.get(s.ia));
        if (x.error) { if (s.optional) continue; return fail(x.error); }
        const root = ports.inside(dest, s.target || '');
        if (!root) return fail(`${s.path} would land outside the install folder`);
        for (const f of x.files) {
          const to = ports.inside(root, f.rel);
          if (!to) return fail(`${f.name} would land outside the install folder`);
          update(job, { status: 'downloading', step: 'data', percent: 0, file: f.name });
          const got = await download({ key: job.id, identifier: s.ia, url: archive.downloadUrl(s.ia, f.name), fileName: f.name, onProgress: progress });
          if (job.status === 'cancelled') return false;
          if (!got.ok) return fail(`${f.name}: ${got.error}`);
          downloads.add(got.filePath);
          const want = (x.single && s.sha1) || f.sha1;
          if (want) {
            update(job, { status: 'verifying' });
            const sum = await ports.sha1File(got.filePath);
            if (sum !== String(want).toLowerCase()) {
              fs.rmSync(got.filePath, { force: true });
              return fail(`${f.name} doesn't match ${x.single && s.sha1 ? 'the catalog' : 'archive.org'} (sha1 ${sum}, expected ${want})`);
            }
          }
          if (s.extract && ports.ARCHIVE_EXT.test(f.name)) {
            update(job, { status: 'extracting', percent: 100 });
            const xr = await extractTo(got.filePath, root);
            if (!xr.ok) return fail(xr.error);
          } else {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(got.filePath, to);
          }
        }
      }
      return true;
    }

    const order = data.base === 'data' ? [sources, dataFiles, binary] : [binary, dataFiles, sources];
    for (const stage of order) if (!(await stage())) return;

    // Record it against the catalog item, keeping its library row
    if (settings.load().deleteAfterInstall) for (const f of downloads) fs.rmSync(f, { force: true });
    disk.unblockDirectory(dest, { platform, log });
    // The collision's exe when it names one (Perfect Dark ships one per region)
    const named = data.exe && ports.inside(dest, data.exe);
    const exes = disk.findExes(dest);
    const exePath = named && fs.existsSync(named) ? named : exes.length === 1 ? exes[0] : null;
    library.adoptInstall(item.id, dest, exePath);
    update(job, { status: 'done', step: null, installDir: dest, exePath });
  }

  const get  = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
  const list = () => [...jobs.values()].map(view);
  const wait = (id) => jobs.get(id)?.done;

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status === 'downloading') {
      update(job, { status: 'cancelled', step: null, error: 'Cancelled' });
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

  return { download, cancelDownload, extract, extractTo, start, startPort, get, list, wait, cancel, scan };
}

module.exports = { createInstalls, SEVEN_ZIP, GITHUB_API };
