'use strict';
/**
 * The backend process: `node src/backend/main.js --data-dir <dir> [--port N]`
 * (--heroes-dir for the app's bundled heroes; tests add --archive-base,
 * --overrides-url, --uploaders-url, --featured-url, --curated-ports-url,
 * --announcement-url and --github-api).
 * Prints one JSON line, { port, token, url }, once listening, so a parent
 * process (or a person) can find it. The token is random per start unless
 * LAUNCHER_TOKEN is set.
 *
 * Given a Playnite command (--install, --uninstall, --launch,
 * --export-playnite; see cli.js) it runs that instead of the server, prints
 * one JSON line and resolves with { exitCode }: 3 means the command needs the
 * window (the item isn't installed, or needs a choice).
 *
 * Standalone, OS actions that need the desktop app answer 501. Started by
 * the desktop app as its utility process, it also reports { type: 'listening' }
 * over process.parentPort and asks the app for those actions (parent.js).
 */
const path = require('path');
const { createBackend } = require('./index');
const { createServer, newToken } = require('./server');
const { connectParent } = require('./parent');
const { parseCli, runCli } = require('./cli');
const { findRow } = require('./playnite');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}

// parent: the desktop app's port (process.parentPort), when it started us
async function run(argv = process.argv.slice(2), env = process.env, print = (line) => process.stdout.write(line), { parent = null } = {}) {
  const args = parseArgs(argv);
  const dataDir = path.resolve(args['data-dir'] || env.LAUNCHER_DATA_DIR || path.join(process.cwd(), '.launcher-data'));
  const bridge = parent ? connectParent(parent) : null;
  const backend = createBackend({
    dataDir,
    ...(args['heroes-dir'] ? { heroesDir: path.resolve(args['heroes-dir']) } : {}),
    ...(args['archive-base'] ? { archiveBase: args['archive-base'] } : {}),
    ...(args['overrides-url'] ? { overridesUrl: args['overrides-url'] } : {}),
    ...(args['uploaders-url'] ? { uploadersUrl: args['uploaders-url'] } : {}),
    ...(args['github-api'] ? { githubApi: args['github-api'] } : {}),
    ...(args['featured-url'] ? { featuredUrl: args['featured-url'] } : {}),
    ...(args['curated-ports-url'] ? { curatedPortsUrl: args['curated-ports-url'] } : {}),
    ...(args['announcement-url'] ? { announcementUrl: args['announcement-url'] } : {}),
    ...(bridge ? { host: bridge.host } : {}),
    log: (msg) => process.stderr.write(msg + '\n'),
  });

  const cli = parseCli(argv);
  if (cli) {
    let r = await runCli(cli, backend, { print });
    if (r.open) {
      print(JSON.stringify({ ok: false, error: 'needs_window', id: r.open }) + '\n');
      r = { code: 3 };
    }
    backend.close();
    return { exitCode: r.code };
  }

  const api = createServer(backend, { token: env.LAUNCHER_TOKEN || newToken(), log: (msg) => process.stderr.write(msg + '\n') });
  let info;
  try {
    info = await api.listen(Number(args.port || env.LAUNCHER_PORT || 0));
  } catch (e) {
    backend.close();
    throw e;
  }
  print(JSON.stringify(info) + '\n');

  // Warm the catalogs, and drop library rows whose install folder is gone
  backend.getOverrides();
  backend.getDefaultSources();
  backend.library.clearMissingInstalls();
  // playnite-export.json is rewritten on every library change; this covers a first run
  backend.exportPlaynite(undefined, { loadItems: false }).catch(() => {});

  const stop = async () => { await api.close(); backend.close(); };
  if (bridge) {
    bridge.on('updater', (msg) => backend.setUpdaterStatus(msg.status));
    // Playnite asked the app to show an item; id is an export id or a library id
    bridge.on('open-item', (msg) => backend.requestOpen(findRow(backend.library.all(), msg.id)?.identifier || msg.id));
    bridge.send({ type: 'listening', ...info });
  }
  return { ...info, backend, api, stop, bridge };
}

// The process entry: runs until SIGINT/SIGTERM or the app's shutdown message.
// Resolves with the function that stops it.
function main({ exit = (code) => process.exit(code), print } = {}) {
  return run(process.argv.slice(2), process.env, print, { parent: process.parentPort || null }).then(({ stop, bridge, exitCode }) => {
    if (exitCode !== undefined) return exit(exitCode);
    const quit = () => stop().then(() => exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    bridge?.on('shutdown', quit);
    return quit;
  }).catch((e) => {
    process.stderr.write(`backend failed to start: ${e.message}\n`);
    exit(1);
  });
}

if (require.main === module) main();

module.exports = { run, main, parseArgs };
