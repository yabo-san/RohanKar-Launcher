'use strict';
/**
 * Command-line actions for the Playnite plugin, run headless against the
 * backend. Ids are playnite-export.json ids (see docs/PLAYNITE-EXPORT.md).
 *
 *   --export-playnite <path>  write the export there and exit
 *   --install <id>            download and install, wait, exit
 *   --uninstall <id>          move the install folder to the Recycle Bin, keep the entry
 *   --launch <id>             start the installed game and exit
 *   --export-sources <path>   write the uploader list (settings.json's "sources", switched-off ones too) there
 *   --import-sources <path>   add the uploaders a --export-sources file (or a pasted config) lists; removes nothing
 *
 * Each prints one JSON line with the result. Exit codes: 0 done, 1 failed,
 * 2 usage. A command that needs the window (--launch on a game that isn't
 * installed, --install on one that needs a choice or isn't an archive.org
 * item) returns { open: identifier } for the host to show that item instead.
 */
const fs   = require('fs');
const path = require('path');
const { findRow } = require('./playnite');
const config = require('./config');
const { sourcesFromSettings } = require('./sources');

const COMMANDS = ['export-playnite', 'install', 'uninstall', 'launch', 'export-sources', 'import-sources'];

// The first command flag and its value, or null when there is none
function parseCli(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i] || '');
    if (!m || !COMMANDS.includes(m[1])) continue;
    const value = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
    return { command: m[1], value };
  }
  return null;
}

async function runCli({ command, value }, backend, { print = (line) => process.stdout.write(line) } = {}) {
  const out = (obj) => print(JSON.stringify(obj) + '\n');
  const done = async (code, obj) => { out(obj); await backend.flushPlayniteExport(); return { code }; };
  if (!value) return done(2, { ok: false, error: 'usage', detail: `--${command} needs a value` });

  if (command === 'export-playnite') {
    const r = await backend.exportPlaynite(path.resolve(value));
    return done(0, { ok: true, ...r });
  }

  if (command === 'export-sources' || command === 'import-sources') return sourcesCommand(command, path.resolve(value), backend, done);

  const row = findRow(backend.library.all(), value);

  if (command === 'launch') {
    if (!row?.install_dir || !row.exe_path) return { open: row?.identifier || value };
    const r = await backend.launch(row.identifier, row.exe_path);
    return done(r.ok ? 0 : 1, { id: value, ...r });
  }

  if (command === 'uninstall') {
    if (!row) return done(1, { id: value, ok: false, error: 'not_in_library' });
    const r = await backend.uninstall(row.identifier);
    return done(r.ok ? 0 : 1, { id: value, ...r });
  }

  // install: archive.org items only; ports and manual entries install from the window
  const identifier = row?.identifier || value;
  if (identifier.startsWith('quiver:') || row?.source === 'manual') return { open: identifier };
  const r = await backend.installs.start({ itemId: identifier, meta: backend.items.installMeta(identifier) });
  if (!r.ok) return r.error === 'choose_files' ? { open: identifier } : done(1, { id: value, ...r });
  await Promise.all(r.jobs.map(j => backend.installs.wait(j.id)));
  const jobs = r.jobs.map(j => backend.installs.get(j.id));
  const failed = jobs.find(j => j.status !== 'done');
  if (failed) return done(1, { id: value, ok: false, error: failed.error || failed.status });
  return done(0, { id: value, ok: true, installDir: jobs[0].installDir, exePath: jobs[0].exePath });
}

// Backs the uploader list up, or adds one back. Importing merges as pasting a
// config does: nothing is removed, and installed games are never touched.
async function sourcesCommand(command, file, backend, done) {
  const sources = sourcesFromSettings(backend.settings.load(), await backend.getDefaultSources());
  if (command === 'export-sources') {
    const list = sources.map(s => ({ uploader: s.uploader, label: s.label || null, enabled: s.enabled !== false }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sources: list }, null, 2));
    return done(0, { ok: true, file, count: list.length });
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return done(1, { ok: false, error: 'unreadable', detail: e.message }); }
  const r = config.readConfig(text);
  if (!r.ok) return done(1, { ok: false, error: 'bad_config', detail: r.error });
  const m = config.mergeConfig({ sources, repos: [], hidden: backend.settings.load().excludeItems || [] }, { ...r.config, repos: [] });
  backend.settings.save({ sources: m.sources, excludeItems: m.excludeItems });
  return done(0, { ok: true, added: m.added.packs });
}

module.exports = { parseCli, runCli, COMMANDS };
