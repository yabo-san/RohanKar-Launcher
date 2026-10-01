'use strict';
/**
 * `mise run sandbox`: the real launcher in a browser, with real installs, in a
 * throwaway folder.
 *
 *   node scripts/sandbox.js [--reset] [--dir sandbox] [--admin]
 *
 * The standalone backend and src/frontend, as `mise run dev` runs them, but
 * everything lives under ./sandbox/: library.db, settings, downloads and
 * installed games. Nothing touches %APPDATA% or the desktop app's library.
 * Installs download and unpack for real; launching and opening folders need
 * the desktop app and answer 501. --reset empties the folder first. --admin
 * is the owner's console (`mise run admin`): the curated collisions in
 * catalog/collisions.json are edited in place, for a PR (docs/ADMIN.md).
 */
const fs   = require('fs');
const path = require('path');
const dev  = require('./dev');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { reset: false, admin: false, dir: path.join(ROOT, 'sandbox') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reset') out.reset = true;
    else if (argv[i] === '--dir') out.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--admin') out.admin = true;
  }
  return out;
}

async function start(opts, env = process.env, print = (l) => process.stdout.write(l)) {
  if (opts.reset) fs.rmSync(opts.dir, { recursive: true, force: true });
  fs.mkdirSync(opts.dir, { recursive: true });
  print(`sandbox   ${opts.dir}${opts.reset ? ' (emptied)' : ''}\n`);
  if (opts.admin) print('admin     on: edits go to catalog/collisions.json (docs/ADMIN.md)\n');
  return dev.start('dev', { ...env, LAUNCHER_DATA_DIR: opts.dir }, { print, extraArgs: opts.admin ? ['--admin'] : [] });
}

if (require.main === module) {
  start(parseArgs(process.argv.slice(2))).then(({ stop }) => {
    const quit = () => stop().then(() => process.exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  }).catch((e) => {
    process.stderr.write(`sandbox: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, start };
