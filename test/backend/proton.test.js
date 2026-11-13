'use strict';
// Running games on Linux: Proton discovery and choice, the launch command,
// and a real launch through a stand-in Proton that writes down how it ran
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const proton = require('../../src/backend/proton');
const { tmpDir, testApi } = require('./helpers');

const script = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); fs.chmodSync(file, 0o755); };

test('listProtons: Valve\'s in every Steam library and custom ones in compatibilitytools.d, each once', (t) => {
  const home = tmpDir(t);
  const steam = path.join(home, '.steam', 'steam');
  const library = path.join(home, 'Games', 'SteamLibrary');
  for (const dir of [path.join(steam, 'steamapps/common/Proton 9.0'), path.join(steam, 'compatibilitytools.d/GE-Proton9-20'), path.join(library, 'steamapps/common/Proton - Experimental')]) {
    script(path.join(dir, 'proton'), '');
  }
  // Not Protons: a game with a file called proton, and a tool folder without the script
  script(path.join(steam, 'steamapps/common/Celeste/proton'), '');
  fs.mkdirSync(path.join(steam, 'compatibilitytools.d/Empty'), { recursive: true });
  fs.writeFileSync(path.join(steam, 'steamapps/libraryfolders.vdf'), `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${library}"\n\t}\n}\n`);
  // ~/.local/share/Steam as a link to the same Steam: found once
  fs.mkdirSync(path.join(home, '.local', 'share'), { recursive: true });
  fs.symlinkSync(steam, path.join(home, '.local', 'share', 'Steam'));
  assert.deepEqual(proton.listProtons(home).map(p => p.name), ['Proton 9.0', 'Proton - Experimental', 'GE-Proton9-20']);
  assert.deepEqual(proton.libraryFolders(steam), [library]);
  assert.deepEqual(proton.listProtons(path.join(home, 'nobody')), []);
});

test('automaticProton: Valve\'s newest numbered, then Experimental, then the newest other, Hotfix last', () => {
  const pick = (...names) => proton.automaticProton(names.map(name => ({ name, path: `/p/${name}` })))?.name ?? null;
  assert.equal(pick('Proton - Experimental', 'Proton 9.0 (Beta)', 'Proton Hotfix', 'GE-Proton9-26'), 'Proton 9.0 (Beta)');
  assert.equal(pick('Proton 9.0', 'Proton 10.0', 'Proton 8.0'), 'Proton 10.0');
  assert.equal(pick('Proton Hotfix', 'GE-Proton9-26', 'Proton - Experimental'), 'Proton - Experimental');
  assert.equal(pick('Proton Hotfix', 'GE-Proton9-26', 'GE-Proton10-3'), 'GE-Proton10-3');
  assert.equal(pick('Proton Hotfix'), 'Proton Hotfix');
  assert.equal(pick(), null);
  assert.equal(proton.automaticProton(null), null);
});

test('cleanEnv: what an AppImage set for itself, and Electron\'s, stay out of a game\'s environment', () => {
  const env = proton.cleanEnv({
    APPDIR: '/tmp/.mount_y4bo', APPIMAGE: '/home/deck/y4bo.AppImage', ARGV0: 'y4bo', OWD: '/home/deck',
    LD_LIBRARY_PATH: '/tmp/.mount_y4bo/usr/lib', PATH: '/tmp/.mount_y4bo/usr/bin:/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '1', HOME: '/home/deck', SteamDeck: '1',
  });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', HOME: '/home/deck', SteamDeck: '1' });
  assert.deepEqual(proton.cleanEnv({ PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/lib' }), { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/lib' });
});

test('launchCommand: a Linux build directly; a Windows one through umu, Proton or Wine, in its own prefix', () => {
  const home = '/home/deck';
  const prefix = '/data/proton/game';
  const env = { PATH: '/usr/bin', HOME: home };
  const p9 = { name: 'Proton 9.0', path: '/steam/common/Proton 9.0' };

  const native = proton.launchCommand('/games/pd/pd.x86_64', { prefix, home, env });
  assert.deepEqual(native, { runner: 'native', cmd: '/games/pd/pd.x86_64', args: [], env, cwd: '/games/pd' });

  const viaProton = proton.launchCommand('/games/halo/halo.exe', { prefix, home, env, protons: [p9], umu: null });
  assert.deepEqual([viaProton.runner, viaProton.proton, viaProton.cmd, viaProton.args, viaProton.cwd],
    ['proton', 'Proton 9.0', '/steam/common/Proton 9.0/proton', ['run', '/games/halo/halo.exe'], '/games/halo']);
  assert.equal(viaProton.env.STEAM_COMPAT_DATA_PATH, prefix);
  assert.equal(viaProton.env.STEAM_COMPAT_CLIENT_INSTALL_PATH, path.join(home, '.steam', 'steam'));

  const viaUmu = proton.launchCommand('/games/halo/halo.exe', { prefix, home, env, protons: [p9], umu: '/usr/bin/umu-run' });
  assert.deepEqual([viaUmu.runner, viaUmu.cmd, viaUmu.args], ['umu', '/usr/bin/umu-run', ['/games/halo/halo.exe']]);
  assert.deepEqual([viaUmu.env.WINEPREFIX, viaUmu.env.PROTONPATH, viaUmu.env.GAMEID], [path.join(prefix, 'pfx'), p9.path, 'umu-0']);
  assert.equal(proton.launchCommand('/g/a.exe', { prefix, home, env, protons: [], umu: '/u/umu-run' }).env.PROTONPATH, undefined);

  const viaWine = proton.launchCommand('/g/setup.bat', { prefix, home, env, protons: [], umu: null, wine: '/usr/bin/wine' });
  assert.deepEqual([viaWine.runner, viaWine.cmd, viaWine.args, viaWine.env.WINEPREFIX], ['wine', '/usr/bin/wine', ['/g/setup.bat'], path.join(prefix, 'pfx')]);

  assert.match(proton.launchCommand('/g/a.exe', { prefix, home, env, protons: [], umu: null, wine: null }).error, /no Proton to run it/);
});

test('onPath: a program on PATH, or null', (t) => {
  const bin = tmpDir(t);
  script(path.join(bin, 'umu-run'), '');
  assert.equal(proton.onPath('umu-run', { PATH: bin }), path.join(bin, 'umu-run'));
  assert.equal(proton.onPath('wine', { PATH: bin }), null);
  assert.equal(proton.onPath('wine', {}), null);
});

// What a stand-in program writes when started: its arguments and the variables Proton reads
const RECORDER = (out) => `#!/bin/sh\n{ echo "args=$*"; echo "data=$STEAM_COMPAT_DATA_PATH"; echo "client=$STEAM_COMPAT_CLIENT_INSTALL_PATH"; echo "cwd=$(pwd)"; } > "${out}"\n`;
const waitFor = async (file) => { for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 30)); return fs.readFileSync(file, 'utf8'); };

test('Play on Linux: a Windows game runs through Steam\'s Proton in its own prefix; a Linux build runs itself', { skip: process.platform === 'win32' }, async (t) => {
  const home = tmpDir(t);
  const out = path.join(home, 'proton-ran.txt');
  script(path.join(home, '.steam/steam/steamapps/common/Proton 9.0/proton'), RECORDER(out));
  const { call, backend } = await testApi(t, { platform: 'linux', homeDir: home });
  // No umu-run or wine of this computer's: Steam's Proton is the one
  const saved = process.env.PATH;
  process.env.PATH = path.join(home, 'empty');
  t.after(() => { process.env.PATH = saved; });

  const dir = path.join(backend.dataDir, 'halo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'halo.exe'), 'MZ');
  backend.library.recordInstall('halo', dir, path.join(dir, 'halo.exe'));
  assert.equal((await call('POST', '/library/halo/launch', {})).body.ok, true);
  const ran = await waitFor(out);
  const prefix = path.join(backend.dataDir, 'proton', 'halo');
  assert.match(ran, new RegExp(`args=run ${path.join(dir, 'halo.exe').replace(/[.]/g, '\\.')}`));
  assert.match(ran, new RegExp(`data=${prefix}`));
  assert.match(ran, new RegExp(`client=${path.join(home, '.steam', 'steam')}`));
  assert.match(ran, new RegExp(`cwd=${dir}`));
  assert.ok(fs.existsSync(prefix), 'the prefix folder is made');
  assert.ok(backend.library.get('halo').last_played_at, 'marked played');

  // A Linux build that lost its run permission still runs, directly
  const pd = path.join(backend.dataDir, 'pd');
  const nativeOut = path.join(home, 'native-ran.txt');
  script(path.join(pd, 'pd.x86_64'), RECORDER(nativeOut));
  fs.chmodSync(path.join(pd, 'pd.x86_64'), 0o644);
  backend.library.recordInstall('pd', pd, path.join(pd, 'pd.x86_64'));
  assert.equal((await call('POST', '/library/pd/launch', {})).body.ok, true);
  assert.match(await waitFor(nativeOut), /args=\n/);
  assert.ok(!fs.existsSync(path.join(backend.dataDir, 'proton', 'pd')), 'no prefix for a Linux build');
});

test('Play on Linux with no Proton or Wine says how to get Proton', { skip: process.platform === 'win32' }, async (t) => {
  const home = tmpDir(t);
  const { backend } = await testApi(t, { platform: 'linux', homeDir: home });
  const dir = path.join(backend.dataDir, 'g');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'g.exe'), 'MZ');
  const saved = process.env.PATH;
  process.env.PATH = home;   // no umu-run or wine on it
  t.after(() => { process.env.PATH = saved; });
  const r = await backend.launch('g', path.join(dir, 'g.exe'));
  assert.equal(r.ok, false);
  assert.match(r.error, /Install Proton in Steam/);
});
