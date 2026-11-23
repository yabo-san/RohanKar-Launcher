'use strict';
/**
 * What an install leaves behind when it fails, is cancelled, or is cut short
 * by the app being killed: never a half-unpacked game marked installed, never
 * a .part or staging folder after the next start, never a user file touched.
 * The download is served by the local fake archive; 7-Zip is a sh stand-in.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { createInstalls } = require('../../src/backend/installs');
const { createArchive } = require('../../src/backend/archive');
const { createSettings } = require('../../src/backend/settings');
const { createLibrary } = require('../../src/backend/library');
const { createJournal, removeRecorded, STAGING_PREFIX } = require('../../src/backend/install-journal');
const { fakeArchive, tmpDir, makeZip } = require('./helpers');

const POSIX = process.platform !== 'win32';

async function setup(t, state = {}, opts = {}) {
  const fake = await fakeArchive(t, state);
  const dir = tmpDir(t);
  const settings = createSettings(path.join(dir, 'settings.json'));
  settings.save({ downloadPath: path.join(dir, 'dl'), installPath: path.join(dir, 'games') });
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const events = [];
  const journalFile = path.join(dir, 'installs-pending.json');
  // A fresh start of the app: a new installs module reading the same journal
  const boot = (more = {}) => createInstalls({
    settings, library, archive: createArchive({ base: fake.base }), gamesDir: path.join(dir, 'default'), journalFile,
    emit: (type, data) => events.push(data), ...opts, ...more,
  });
  return { fake, dir, settings, library, installs: boot(), boot, events, journalFile };
}

// Every file and folder under dir, relative, sorted
function tree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(p => p.split(path.sep).join('/')).sort();
}

async function run(installs, itemId) {
  const r = await installs.start({ itemId });
  assert.equal(r.ok, true, r.detail);
  await installs.wait(r.jobs[0].id);
  return installs.get(r.jobs[0].id);
}

// A sh stand-in for 7-Zip: `body` runs with $out as the -o folder
function fake7z(t, body) {
  const file = path.join(tmpDir(t), '7z');
  fs.writeFileSync(file, `#!/bin/sh\nout=$(echo "$3" | sed "s/^-o//")\nmkdir -p "$out"\n${body}\n`, { mode: 0o755 });
  return file;
}

const SEVEN = { files: { seven: [{ name: 'seven.7z', source: 'original' }] }, zips: { 'seven/seven.7z': Buffer.from('7z') } };

// ─── Downloads that go wrong ────────────────────────────────────────────────

test('a download cut off midway fails, says so, and leaves no .part or folder behind', async (t) => {
  const { dir, installs, library, journalFile } = await setup(t, {
    routes: { '/download/cut/cut.zip': (req, res) => { res.writeHead(200, { 'content-length': 100000 }); res.write(Buffer.alloc(5000)); setTimeout(() => res.socket.destroy(), 20); } },
  });
  const job = await run(installs, 'cut');
  assert.equal(job.status, 'error');
  assert.match(job.error, /The download was cut off( at 5%)?\. Try again\./);
  assert.deepEqual(tree(path.join(dir, 'dl')), [], 'no .part file, no empty download folder');
  assert.deepEqual(tree(path.join(dir, 'games')), [], 'nothing where the game goes');
  assert.equal(library.get('cut')?.install_dir ?? null, null, 'not marked installed');
  assert.deepEqual(JSON.parse(fs.readFileSync(journalFile, 'utf8')), {}, 'the journal is empty again');
});

test('a download that sends less than it promised fails instead of unpacking a short file', async (t) => {
  const { dir, installs } = await setup(t, {
    // The connection closes cleanly, but after half the bytes
    routes: { '/download/short/short.zip': (req, res) => { res.writeHead(200, { 'content-length': 200 }); res.write(Buffer.alloc(100)); res.socket.end(); } },
  });
  const job = await run(installs, 'short');
  assert.equal(job.status, 'error');
  assert.match(job.error, /cut off/);
  assert.deepEqual(tree(path.join(dir, 'dl')), []);
});

test('a download that stops sending fails after the stall timeout rather than hanging', async (t) => {
  const { dir, installs } = await setup(t, {
    routes: { '/download/stall/stall.zip': (req, res) => { res.writeHead(200, { 'content-length': 1000 }); res.write('x'); } },
  }, { stallMs: 150 });
  const job = await run(installs, 'stall');
  assert.deepEqual([job.status, job.error], ['error', 'The download stalled: nothing arrived for a while. Check your connection and try again.']);
  assert.deepEqual(tree(path.join(dir, 'dl')), []);
});

test('a cancelled download removes its .part file', async (t) => {
  let started;
  const sending = new Promise(r => { started = r; });
  const { dir, installs } = await setup(t, {
    routes: { '/download/slow/slow.zip': (req, res) => { res.writeHead(200, { 'content-length': 1000 }); res.write('x'); started(); } },
  });
  const job = (await installs.start({ itemId: 'slow' })).jobs[0];
  await sending;
  assert.equal(installs.cancel(job.id).status, 'cancelled');
  await installs.wait(job.id);
  assert.equal(installs.get(job.id).status, 'cancelled');
  assert.deepEqual(tree(path.join(dir, 'dl')), []);
});

// ─── Unpacking that goes wrong ──────────────────────────────────────────────

test('a damaged zip fails with words a person understands; nothing is half-installed', async (t) => {
  const good = makeZip({ 'Game/game.exe': 'MZ', 'Game/data.pak': 'x'.repeat(1000) });
  const { dir, installs, library } = await setup(t, { zips: { 'bad/bad.zip': good.subarray(0, good.length - 30) } });
  const job = await run(installs, 'bad');
  assert.equal(job.status, 'error');
  assert.match(job.error, /^bad\.zip looks damaged or incomplete\. Install again to download it fresh\./);
  assert.deepEqual(tree(path.join(dir, 'games')), [], 'no game folder, no staging folder');
  assert.deepEqual(tree(path.join(dir, 'dl')), [], 'the damaged download is removed too');
  assert.equal(library.get('bad')?.install_dir ?? null, null);
});

test('a zip unpacks with progress, and only a whole unpack reaches the game folder', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Game/f${i}.dat`, String(i)]));
  const { dir, installs, events } = await setup(t, { zips: { 'many/many.zip': makeZip({ ...files, 'Game/game.exe': 'MZ' }) } });
  const job = await run(installs, 'many');
  assert.equal(job.status, 'done');
  const unpacking = events.filter(e => e.status === 'extracting').map(e => e.percent);
  assert.equal(unpacking[0], 0);
  assert.ok(unpacking.length > 5, `progress while unpacking: ${unpacking}`);
  assert.equal(unpacking.at(-1), 100);
  assert.deepEqual(tree(path.join(dir, 'games')).filter(p => p.includes(STAGING_PREFIX)), []);
  assert.ok(fs.existsSync(path.join(dir, 'games', 'many', 'Game', 'game.exe')));
});

test('7-Zip failing partway leaves no partial game, and its error is readable', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  const sevenZip = fake7z(t, 'printf x > "$out/half.exe"\necho "ERROR: Data Error : seven/level1.dat" >&2\nexit 2');
  const { dir, installs, library } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  const job = await run(installs, 'seven');
  assert.deepEqual([job.status, job.error], ['error', 'seven.7z looks damaged or incomplete. Install again to download it fresh.']);
  assert.deepEqual(tree(path.join(dir, 'games')), [], 'the half-unpacked files went with the staging folder');
  assert.equal(library.get('seven')?.install_dir ?? null, null);
});

test('a password-protected archive fails at once instead of waiting for a password', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  // Real 7-Zip asks on stdin when no -p is given; the stand-in does the same
  const sevenZip = fake7z(t, 'case "$*" in *" -p"*) echo "ERROR: Wrong password : seven.7z" >&2; exit 2;; esac\nread pw\nexit 0');
  const { installs } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  const job = await run(installs, 'seven');
  assert.deepEqual([job.status, job.error], ['error', "seven.7z is password protected, so it can't be unpacked."]);
});

test('7-Zip with no stdin cannot hang on a prompt', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  // Waits for input; stdin is closed, so read fails at once
  const sevenZip = fake7z(t, 'if read pw; then exit 0; fi\necho "ERROR: Break signaled" >&2\nexit 255');
  const { installs } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  const job = await run(installs, 'seven');
  assert.equal(job.status, 'error');
  assert.match(job.error, /7-Zip couldn't unpack seven\.7z \(exit code 255\): ERROR: Break signaled/);
});

test('7-Zip progress reaches the app while it unpacks', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  const sevenZip = fake7z(t, 'printf "  0%%\\b\\b\\b\\b 37%% 3 - a\\b\\b\\b\\b 82%%" ; sleep 0.05; printf " 100%%\\n"; printf MZ > "$out/game.exe"');
  const { installs, events } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  const job = await run(installs, 'seven');
  assert.equal(job.status, 'done');
  const seen = events.filter(e => e.status === 'extracting').map(e => e.percent);
  assert.ok(seen.includes(82) && seen.includes(100), `percents: ${seen}`);
});

test('a big 7-Zip output no longer overflows a buffer and fails the install', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  // 2 MB of output: execFile's 1 MB buffer used to kill 7-Zip here
  const sevenZip = fake7z(t, 'head -c 2000000 /dev/zero | tr "\\0" "x"\nprintf MZ > "$out/game.exe"');
  const { installs } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  assert.equal((await run(installs, 'seven')).status, 'done');
});

test('cancel while unpacking stops 7-Zip and leaves nothing installed', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  const sevenZip = fake7z(t, 'printf x > "$out/half.exe"\nprintf " 10%%"\nexec sleep 30');
  const { dir, installs, events, library } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  const job = (await installs.start({ itemId: 'seven' })).jobs[0];
  while (!events.some(e => e.status === 'extracting' && e.percent === 10)) await new Promise(r => setTimeout(r, 10));
  const t0 = Date.now();
  assert.equal(installs.cancel(job.id).status, 'cancelled');
  await installs.wait(job.id);
  assert.ok(Date.now() - t0 < 5000, '7-Zip was stopped, not waited out');
  assert.equal(installs.get(job.id).status, 'cancelled');
  assert.deepEqual(tree(path.join(dir, 'games')), []);
  assert.deepEqual(tree(path.join(dir, 'dl')), []);
  assert.equal(library.get('seven')?.install_dir ?? null, null);
});

test('an update that fails to unpack leaves the installed copy as it was', async (t) => {
  const good = makeZip({ 'Game/game.exe': 'MZ2' });
  const { dir, installs, library } = await setup(t, { zips: { 'v2/v2.zip': good.subarray(0, 40) } });
  const old = path.join(dir, 'games', 'v1');
  fs.mkdirSync(path.join(old, 'Game'), { recursive: true });
  fs.writeFileSync(path.join(old, 'Game', 'game.exe'), 'MZ1');
  fs.writeFileSync(path.join(old, 'Game', 'save.dat'), 'my save');
  library.recordInstall('v1', old, path.join(old, 'Game', 'game.exe'));
  const r = await installs.start({ itemId: 'v2', into: 'v1' });
  await installs.wait(r.jobs[0].id);
  assert.equal(installs.get(r.jobs[0].id).status, 'error');
  assert.deepEqual(tree(old), ['Game', 'Game/game.exe', 'Game/save.dat']);
  assert.equal(fs.readFileSync(path.join(old, 'Game', 'game.exe'), 'utf8'), 'MZ1');
  assert.equal(library.get('v1').upload, null, 'still the old upload');
});

// ─── The app killed midway, then started again ──────────────────────────────

test('killed while downloading: the next start removes the .part and offers the install again', async (t) => {
  let started;
  const sending = new Promise(r => { started = r; });
  const { dir, boot, installs, library } = await setup(t, {
    metadata: { kill: { title: 'Killzone 2' } },
    routes: { '/download/kill/kill.zip': (req, res) => { res.writeHead(200, { 'content-length': 100000 }); res.write(Buffer.alloc(10)); started(); } },
  });
  // A file of the user's beside the download, and another game already installed
  fs.mkdirSync(path.join(dir, 'dl'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dl', 'mine.txt'), 'keep me');
  fs.mkdirSync(path.join(dir, 'games', 'other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'games', 'other', 'other.exe'), 'MZ');

  await installs.start({ itemId: 'kill', meta: { title: 'Killzone 2' } });
  await sending;
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(path.join(dir, 'dl', 'kill', 'kill.zip.part')), 'mid-download');
  // No cancel, no cleanup: the process just stops. A new start reads the journal.
  const next = boot();
  assert.deepEqual(tree(path.join(dir, 'dl')), ['mine.txt'], 'the .part and its folder are gone; the user file stays');
  assert.deepEqual(tree(path.join(dir, 'games')), ['other', 'other/other.exe']);
  assert.equal(library.get('kill')?.install_dir ?? null, null);
  const [job] = next.list();
  assert.deepEqual([job.itemId, job.status, job.interrupted, job.title, job.kind], ['kill', 'error', true, 'Killzone 2', 'game']);
  assert.match(job.error, /closed before this install finished/);
  // A third start has nothing left to report
  assert.deepEqual(boot().list(), []);
});

test('killed while unpacking: the staging folder and the archive go; the game folder never appeared', { skip: !POSIX && 'sh stand-in' }, async (t) => {
  const sevenZip = fake7z(t, 'printf x > "$out/half.exe"\nprintf " 40%%"\nexec sleep 30');
  const { dir, boot, installs, events } = await setup(t, SEVEN, { sevenZip, platform: 'linux' });
  const job = (await installs.start({ itemId: 'seven' })).jobs[0];
  while (!events.some(e => e.status === 'extracting' && e.percent === 40)) await new Promise(r => setTimeout(r, 10));
  assert.equal(tree(path.join(dir, 'games')).filter(p => p.startsWith(STAGING_PREFIX)).length > 0, true, 'unpacking into staging');
  assert.ok(!fs.existsSync(path.join(dir, 'games', 'seven')), 'never straight into the game folder');

  const next = boot();
  assert.deepEqual(tree(path.join(dir, 'games')), []);
  assert.deepEqual(tree(path.join(dir, 'dl')), [], 'the downloaded archive went too');
  assert.equal(next.list()[0].interrupted, true);
  // Let the first 7-Zip go: cancelling it now is the old process's last act
  installs.cancel(job.id);
  await installs.wait(job.id);
});

test('a port killed midway leaves no empty folder where the port goes', async (t) => {
  const { dir, boot, fake, settings } = await setup(t);
  let started;
  const sending = new Promise(r => { started = r; });
  fake.routes['/repos/o/pd/releases'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify([{ tag_name: 'v1', assets: [{ name: 'pd-windows.zip', browser_download_url: `${fake.base}/gh/pd.zip` }] }])); };
  fake.routes['/gh/pd.zip'] = (req, res) => { res.writeHead(200, { 'content-length': 5000 }); res.write('PK'); started(); };
  settings.save({ ...settings.load() });
  const first = boot({ githubApi: fake.base, platform: 'win32', deck: false });
  const item = { id: 'quiver:c:o/pd', title: 'Perfect Dark', repository: 'o/pd', entry: { folderName: 'PerfectDark' } };
  first.startPort({ item });
  await sending;
  assert.ok(!fs.existsSync(path.join(dir, 'games', 'PerfectDark')), 'the port folder only appears once unpacked');
  const next = boot({ githubApi: fake.base, platform: 'win32', deck: false });
  assert.deepEqual(tree(path.join(dir, 'dl')), []);
  assert.deepEqual(next.list().map(j => [j.itemId, j.kind, j.title]), [['quiver:c:o/pd', 'port', 'Perfect Dark']]);
  first.cancel(next.list()[0].id);
});

// ─── The journal itself ─────────────────────────────────────────────────────

test('journal: removes only what it recorded, and only things shaped like its own', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'pending.json');
  const mk = (rel, body = 'x') => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  const part = mk('dl/a/a.zip.part');
  const notPart = mk('dl/b/b.zip');
  const staging = path.join(dir, 'games', `${STAGING_PREFIX}1`);
  mk(`games/${STAGING_PREFIX}1/half.exe`);
  const gameDir = path.join(dir, 'games', 'Halo');
  mk('games/Halo/halo.exe');

  const j = createJournal(file);
  j.begin({ id: 'j1', itemId: 'a', kind: 'game' });
  j.track('j1', part, 'part');
  j.track('j1', part, 'part');                // once only
  j.track('j1', notPart, 'part');             // not a .part: refused at removal
  j.track('j1', staging, 'staging');
  j.track('j1', gameDir, 'staging');          // not a staging folder: refused
  j.track('j1', gameDir, 'download');         // a folder is never a download
  j.track('nope', part, 'part');              // no such job: ignored
  const recovered = createJournal(file).recover();
  assert.deepEqual(recovered.map(r => [r.id, r.itemId, r.removed.length]), [['j1', 'a', 2]]);
  assert.ok(!fs.existsSync(part) && !fs.existsSync(path.join(dir, 'dl', 'a')), 'the .part and its emptied folder');
  assert.ok(!fs.existsSync(staging));
  assert.ok(fs.existsSync(notPart) && fs.existsSync(path.join(gameDir, 'halo.exe')), 'the rest is untouched');
  assert.ok(fs.existsSync(path.join(dir, 'games')), "a staging folder's parent is never removed");
  assert.deepEqual(createJournal(file).recover(), []);

  // A finished install keeps what it made; an unreadable journal is an empty one
  const kept = mk('dl/c/c.zip');
  const j2 = createJournal(file);
  j2.begin({ id: 'j2', itemId: 'c', kind: 'game' });
  j2.track('j2', kept, 'download');
  j2.end('j2', { ok: true });
  j2.end('missing', { ok: false });
  assert.ok(fs.existsSync(kept));
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createJournal(file).recover(), []);
  assert.equal(removeRecorded({ path: kept, kind: 'other' }), false);
  // In memory only, and a journal that can't be written is logged, not thrown
  const mem = createJournal(null);
  mem.begin({ id: 'm', itemId: 'm', kind: 'game' });
  assert.equal(mem.recover().length, 1);
  const logs = [];
  const broken = createJournal(path.join(kept, 'cannot', 'be.json'), { log: m => logs.push(m) });
  broken.begin({ id: 'b', itemId: 'b', kind: 'game' });
  assert.match(logs[0], /couldn't write/);
});
