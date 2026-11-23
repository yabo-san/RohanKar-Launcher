'use strict';
/**
 * The backend's log on disk: <data dir>/logs/main.log, one timestamped line
 * per message (scans, installs, local-store hits, export writes). Past
 * maxBytes it rotates to main.log.1 .. main.log.<keep>, the oldest dropped.
 * A write that fails is skipped: logging never breaks the app.
 */
const fs   = require('fs');
const path = require('path');

function createFileLog(dir, { maxBytes = 1024 * 1024, keep = 3, now = () => new Date() } = {}) {
  const file = path.join(dir, 'main.log');
  function rotate() {
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* none */ }
    }
    try { fs.renameSync(file, `${file}.1`); } catch { /* none */ }
  }
  function write(msg) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new file */ }
      if (size >= maxBytes) rotate();
      fs.appendFileSync(file, `${now().toISOString()} ${String(msg)}\n`);
    } catch { /* disk full or read-only: skip */ }
  }
  write.file = file;
  return write;
}

module.exports = { createFileLog };
