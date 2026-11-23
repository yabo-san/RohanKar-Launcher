'use strict';
/**
 * Unfinished installs, written down in <data>/installs-pending.json while
 * they run. An install that finishes, fails or is cancelled cleans up after
 * itself and leaves the list. One that is cut short (the app killed, a
 * crash, a power cut) is still listed at the next start: recover() removes
 * exactly the files it had created and reports it, so the app can offer to
 * install it again.
 *
 * Only these are ever removed, by their recorded path:
 *   part      a download still in progress (<name>.part)
 *   download  a finished download that was never unpacked
 *   staging   the hidden folder an archive unpacks into (.y4bo-unpack-*)
 * Never the install folder, and never anything the install didn't create.
 */
const fs   = require('fs');
const path = require('path');

const STAGING_PREFIX = '.y4bo-unpack-';
const INTERRUPTED = 'y4bo closed before this install finished. The partly downloaded files were removed; install it again to retry.';

// Removes one recorded path if it is still what the install made
function removeRecorded({ path: p, kind }, { busy = () => false } = {}) {
  let removed = false;
  try {
    const st = fs.lstatSync(p);
    if (kind === 'staging') {
      if (!st.isDirectory() || !path.basename(p).startsWith(STAGING_PREFIX)) return false;
      fs.rmSync(p, { recursive: true, force: true });
    } else if (kind === 'part' || kind === 'download') {
      if (!st.isFile() || (kind === 'part' && !p.endsWith('.part'))) return false;
      fs.rmSync(p, { force: true });
    } else {
      return false;
    }
    removed = true;
  } catch { /* already gone */ }
  // A download's own folder (<downloads>/<identifier>) too, when that left it
  // empty. Never a staging folder's parent: that is the install folder itself.
  if (kind === 'part' || kind === 'download') {
    if (!busy(path.resolve(path.dirname(p)))) try { fs.rmdirSync(path.dirname(p)); } catch { /* not empty */ }
  }
  return removed;
}

// file: null keeps the list in memory only (tests that don't need a restart).
// busy(dir): true for a download folder another download is writing into.
function createJournal(file, { log = () => {}, busy = () => false } = {}) {
  let entries = {};
  if (file) {
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { entries = {}; }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(entries, null, 1));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`[installs] couldn't write ${file}: ${e.message}`);
    }
  };

  return {
    // job: { id, itemId, file, title, kind }
    begin(job) {
      entries[job.id] = { itemId: job.itemId, file: job.file || null, title: job.title || null, kind: job.kind, startedAt: Date.now(), paths: [] };
      save();
    },
    track(id, p, kind) {
      const e = entries[id];
      if (!e || e.paths.some(x => x.path === p)) return;
      e.paths.push({ path: p, kind });
      save();
    },
    // ok: the install finished, so what it made is the install (or already gone)
    end(id, { ok }) {
      const e = entries[id];
      if (!e) return;
      if (!ok) for (const p of [...e.paths].reverse()) removeRecorded(p, { busy });
      delete entries[id];
      save();
    },
    // At start: cleans up after every install that never ended. Returns
    // [{ id, itemId, file, title, kind, startedAt, removed }].
    recover() {
      const out = [];
      for (const [id, e] of Object.entries(entries)) {
        const removed = [...(e.paths || [])].reverse().filter(removeRecorded).map(x => x.path);
        log(`[installs] ${e.itemId} was interrupted; removed ${removed.length ? removed.join(', ') : 'nothing'}`);
        out.push({ id, itemId: e.itemId, file: e.file, title: e.title, kind: e.kind, startedAt: e.startedAt, removed });
      }
      entries = {};
      save();
      return out;
    },
  };
}

module.exports = { createJournal, removeRecorded, STAGING_PREFIX, INTERRUPTED };
