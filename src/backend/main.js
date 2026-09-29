'use strict';
/**
 * The backend process: `node src/backend/main.js --data-dir <dir> [--port N]`
 * (--heroes-dir for the app's bundled heroes; tests add --archive-base,
 * --overrides-url and --uploaders-url).
 * Prints one JSON line, { port, token, url }, once listening, so a parent
 * process (or a person) can find it. The token is random per start unless
 * LAUNCHER_TOKEN is set.
 *
 * Standalone, OS actions that need the desktop app answer 501. Started by
 * the desktop app as its utility process, it also reports { type: 'listening' }
 * over process.parentPort and asks the app for those actions (parent.js).
 */
const path = require('path');
const { createBackend } = require('./index');
const { createServer, newToken } = require('./server');
const { connectParent } = require('./parent');

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
    ...(bridge ? { host: bridge.host } : {}),
    log: (msg) => process.stderr.write(msg + '\n'),
  });
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

  const stop = async () => { await api.close(); backend.close(); };
  if (bridge) {
    bridge.on('updater', (msg) => backend.setUpdaterStatus(msg.status));
    bridge.send({ type: 'listening', ...info });
  }
  return { ...info, backend, api, stop, bridge };
}

// The process entry: runs until SIGINT/SIGTERM or the app's shutdown message.
// Resolves with the function that stops it.
function main({ exit = (code) => process.exit(code), print } = {}) {
  return run(process.argv.slice(2), process.env, print, { parent: process.parentPort || null }).then(({ stop, bridge }) => {
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
