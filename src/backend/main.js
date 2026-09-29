'use strict';
/**
 * Standalone backend: `node src/backend/main.js --data-dir <dir> [--port N]`.
 * Prints one JSON line, { port, token, url }, once listening, so a parent
 * process (or a person) can find it. The token is random per start unless
 * LAUNCHER_TOKEN is set. OS actions that need Electron answer 501.
 */
const path = require('path');
const { createBackend } = require('./index');
const { createServer, newToken } = require('./server');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}

async function run(argv = process.argv.slice(2), env = process.env, print = (line) => process.stdout.write(line)) {
  const args = parseArgs(argv);
  const dataDir = path.resolve(args['data-dir'] || env.LAUNCHER_DATA_DIR || path.join(process.cwd(), '.launcher-data'));
  const backend = createBackend({
    dataDir,
    ...(args['archive-base'] ? { archiveBase: args['archive-base'] } : {}),
    ...(args['overrides-url'] ? { overridesUrl: args['overrides-url'] } : {}),
    log: (msg) => process.stderr.write(msg + '\n'),
  });
  const api = createServer(backend, { token: env.LAUNCHER_TOKEN || newToken(), log: (msg) => process.stderr.write(msg + '\n') });
  const info = await api.listen(Number(args.port || env.LAUNCHER_PORT || 0));
  print(JSON.stringify(info) + '\n');

  const stop = async () => { await api.close(); backend.close(); };
  return { ...info, backend, api, stop };
}

if (require.main === module) {
  run().then(({ stop }) => {
    const quit = () => stop().then(() => process.exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  }).catch((e) => {
    process.stderr.write(`backend failed to start: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { run, parseArgs };
