'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const { readQuiverLibrary, planImport, applyImport, quiverRoot, appEntries } = require('../../src/backend/quiver-import');
const { findExes } = require('../../src/backend/disk');
const { createLibrary } = require('../../src/backend/library');
const { tmpDir, testApi } = require('./helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'quiver');

const put = (file, content = 'MZ') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// The fixture's apps.json and settings.json in a temp folder, with Apps/ laid
// out the way Quiver leaves it:
//   PerfectDark    installed, version.txt, two exes and selected_executable.txt
//   SoH            installed out of tree (installPath), one exe
//   ObscurePort    not installed (no folder)
//   Homebrew       manual app with an exe
//   GitLabGame     installed from GitLab
//   HalfInstalled  folder with install-incomplete.txt
function quiverFolder(t, { edit = (doc) => doc } = {}) {
  const root = tmpDir(t, 'rk-quiver-');
  const soh = path.join(root, 'Elsewhere', 'SoH');
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'apps.json'), 'utf8'));
  doc.apps.find(a => a.folderName === 'SoH').installPath = soh;
  fs.writeFileSync(path.join(root, 'apps.json'), JSON.stringify(edit(doc), null, 2));
  fs.copyFileSync(path.join(FIXTURE, 'settings.json'), path.join(root, 'settings.json'));
  const apps = path.join(root, 'Apps');
  put(path.join(apps, 'PerfectDark', 'pd.x86_64.exe'));
  put(path.join(apps, 'PerfectDark', 'pd.exe'));
  put(path.join(apps, 'PerfectDark', 'version.txt'), 'v1.2.0\n');
  put(path.join(apps, 'PerfectDark', 'selected_executable.txt'), path.join(apps, 'PerfectDark', 'pd.exe'));
  put(path.join(soh, 'soh.exe'));
  put(path.join(apps, 'Homebrew', 'thing.exe'));
  put(path.join(apps, 'GitLabGame', 'game.exe'));
  put(path.join(apps, 'HalfInstalled', 'half.exe'));
  put(path.join(apps, 'HalfInstalled', 'install-incomplete.txt'), '');
  return { root, apps, soh };
}

const byName = (list) => Object.fromEntries(list.map(a => [a.name, a]));

test('reads a Quiver folder: install dirs, installed state, exe, version, tags', (t) => {
  const { root, apps, soh } = quiverFolder(t);
  const read = readQuiverLibrary(root, { findExes });
  assert.equal(read.root, root);
  assert.equal(read.appsPath, apps);
  assert.equal(read.apps.length, 6, 'the second Perfect Dark entry is the same instance');
  const a = byName(read.apps);

  assert.deepEqual(a['Perfect Dark'], {
    name: 'Perfect Dark', repository: 'fgsfdsfgs/perfect_dark', source: 'github', folderName: 'PerfectDark',
    tags: ['N64', 'Shooter'], installDir: path.join(apps, 'PerfectDark'), installed: true,
    exe: path.join(apps, 'PerfectDark', 'pd.exe'), version: 'v1.2.0',
  });
  const sohApp = a['Zelda OoT (SoH)'];
  assert.equal(sohApp.installDir, soh, 'installPath wins over Apps/<folderName>');
  assert.equal(sohApp.exe, path.join(soh, 'soh.exe'), 'a single exe is picked');
  assert.equal(sohApp.version, null);
  assert.deepEqual([a['Obscure Port'].installed, a['Obscure Port'].exe], [false, null]);
  assert.equal(a['Homebrew Thing'].repository, null);
  assert.equal(a['GitLab Game'].source, 'gitlab');
  assert.equal(a['Half Installed'].installed, false, 'install-incomplete.txt means not installed');
  assert.deepEqual(read.skipped, []);

  // apps.json itself works as well as its folder
  assert.equal(readQuiverLibrary(path.join(root, 'apps.json'), { findExes }).apps.length, 6);
});

test('reads AppsPath from settings.json and a relative selected_executable.txt', (t) => {
  const { root } = quiverFolder(t);
  const other = path.join(root, 'Games');
  fs.writeFileSync(path.join(root, 'settings.json'), '\uFEFF' + JSON.stringify({ AppsPath: other }));
  put(path.join(other, 'PerfectDark', 'bin', 'a.exe'));
  put(path.join(other, 'PerfectDark', 'bin', 'b.exe'));
  put(path.join(other, 'PerfectDark', 'selected_executable.txt'), 'bin/b.exe');
  put(path.join(other, 'Homebrew', 'x.exe'));
  put(path.join(other, 'Homebrew', 'y.exe'));
  put(path.join(other, 'Homebrew', 'selected_executable.txt'), 'C:/gone/y.exe');
  const a = byName(readQuiverLibrary(root, { findExes }).apps);
  assert.equal(a['Perfect Dark'].exe, path.join(other, 'PerfectDark', 'bin', 'b.exe'));
  assert.equal(a['Homebrew Thing'].installed, true);
  assert.equal(a['Homebrew Thing'].exe, null, 'a missing saved exe and two candidates: the user picks');
});

test('apps.json shapes: { apps }, a bare array, legacy sections; bad input', (t) => {
  assert.deepEqual(appEntries({ apps: [1], standard: [2], experimental: [3], custom: [4] }), [1, 2, 3, 4]);
  assert.deepEqual(appEntries([{ name: 'x' }]), [{ name: 'x' }]);
  assert.deepEqual(appEntries(null), []);
  assert.deepEqual(appEntries('x'), []);

  const dir = tmpDir(t);
  assert.equal(quiverRoot(dir), null);
  assert.equal(quiverRoot(''), null);
  assert.match(readQuiverLibrary(dir).error, /No apps.json/);
  fs.writeFileSync(path.join(dir, 'apps.json'), '{ nope');
  assert.match(readQuiverLibrary(dir).error, /^apps.json:/);

  fs.writeFileSync(path.join(dir, 'apps.json'), JSON.stringify({ standard: [
    { name: 'No folder', repository: 'o/a' },
    null,
    { folderName: '' },
    { repository: 'o/b', folderName: 'B' },
  ] }));
  const read = readQuiverLibrary(dir);
  assert.deepEqual(read.skipped, [{ name: 'No folder', reason: 'no folder name or install path' }]);
  assert.deepEqual(read.apps.map(a => [a.name, a.installed, a.installDir]), [['B', false, path.join(dir, 'Apps', 'B')]]);
});

test('plan: catalog ports, new ports, manual apps, skips', (t) => {
  const { root } = quiverFolder(t);
  const read = readQuiverLibrary(root, { findExes });
  const items = [
    { id: 'quiver:c1:fgsfdsfgs/perfect_dark', repository: 'fgsfdsfgs/perfect_dark' },
    { id: 'quiver:c2:fgsfdsfgs/perfect_dark', repository: 'fgsfdsfgs/perfect_dark' },
    { id: 'quiver:c1:harbourmasters/shipwright', repository: 'HarbourMasters/Shipwright' },
    { id: 'rk-no-repo' },
  ];
  const rows = { 'quiver:c1:harbourmasters/shipwright': { identifier: 'x', install_dir: '/somewhere' } };
  const plan = planImport(read, { items, rows });
  assert.deepEqual(plan.apps.map(a => [a.name, a.kind, a.id, a.inLibrary, a.alreadyInstalled]), [
    ['Perfect Dark', 'port', 'quiver:c1:fgsfdsfgs/perfect_dark', false, false],
    ['Zelda OoT (SoH)', 'port', 'quiver:c1:harbourmasters/shipwright', true, true],
    ['Obscure Port', 'new', 'quiver:local:someone/obscure-port', false, false],
    ['Homebrew Thing', 'manual', 'manual:Homebrew', false, false],
    ['GitLab Game', 'manual', 'manual:GitLabGame', false, false],
    ['Half Installed', 'new', 'quiver:local:someone/half-installed', false, false],
  ]);
  assert.deepEqual(plan.skipped, []);

  // Nothing installed: a manual or GitLab app is skipped; two entries of one port keep the first
  const bare = planImport({ apps: [
    { name: 'M', repository: null, source: 'github', installed: false, tags: [] },
    { name: 'G', repository: 'g/g', source: 'gitlab', installed: false, tags: [] },
    { name: 'P1', repository: 'o/p', source: 'github', folderName: 'P1', installed: false, tags: [] },
    { name: 'P2', repository: 'o/p', source: 'github', folderName: 'P2', installed: false, tags: [] },
  ] });
  assert.deepEqual(bare.apps.map(a => a.name), ['P1']);
  assert.deepEqual(bare.skipped.map(s => s.reason), ['manual app with nothing installed', 'GitLab app with nothing installed', 'same port as P1']);
});

test('apply: adopts installs, adds the rest, and a second import changes nothing', (t) => {
  const { root, apps, soh } = quiverFolder(t);
  const dir = tmpDir(t);
  const library = createLibrary({ dbPath: path.join(dir, 'library.db'), log: () => {} });
  t.after(() => library.close());
  const saved = [];
  const catalogs = { saveCollision: (c) => { saved.push(c); return { ok: true }; } };
  const items = [
    { id: 'quiver:c1:fgsfdsfgs/perfect_dark', repository: 'fgsfdsfgs/perfect_dark' },
    { id: 'quiver:c1:harbourmasters/shipwright', repository: 'HarbourMasters/Shipwright' },
  ];
  const plan = () => planImport(readQuiverLibrary(root, { findExes }), { items, rows: library.all() });

  assert.deepEqual(applyImport(plan(), { library, catalogs }), { added: 2, adopted: 4, ports: 2, unchanged: 0 });
  const rows = library.all();
  const pd = rows['quiver:c1:fgsfdsfgs/perfect_dark'];
  assert.deepEqual([pd.install_dir, pd.exe_path, pd.version, pd.tags, pd.source, pd.title],
    [path.join(apps, 'PerfectDark'), path.join(apps, 'PerfectDark', 'pd.exe'), 'v1.2.0', ['N64', 'Shooter'], 'quiver', null]);
  assert.equal(rows['quiver:c1:harbourmasters/shipwright'].install_dir, soh);
  assert.deepEqual([rows['manual:Homebrew'].title, rows['manual:Homebrew'].source, rows['manual:Homebrew'].tags],
    ['Homebrew Thing', 'manual', ['manual']]);
  assert.equal(rows['quiver:local:someone/obscure-port'].install_dir, null, 'in the library, not installed');
  assert.deepEqual(saved.map(c => [c.repository, c.name, c.folderName]), [
    ['someone/obscure-port', 'Obscure Port', 'ObscurePort'],
    ['someone/half-installed', 'Half Installed', 'HalfInstalled'],
  ]);

  // Re-importing leaves installs alone (a user's own exe pick survives)
  library.setExePath('quiver:c1:fgsfdsfgs/perfect_dark', 'C:/mine.exe');
  const again = applyImport(planImport(readQuiverLibrary(root, { findExes }), { rows: library.all(), items }), { library, catalogs: { saveCollision: () => ({ ok: false }) } });
  assert.deepEqual(again, { added: 0, adopted: 0, ports: 0, unchanged: 6 });
  assert.equal(library.get('quiver:c1:fgsfdsfgs/perfect_dark').exe_path, 'C:/mine.exe');
});

test('POST /library/import/quiver: preview, apply, "Your ports", errors', async (t) => {
  const { call, fake, backend } = await testApi(t);
  const { root, apps } = quiverFolder(t);
  fake.routes['/cat.json'] = (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ apps: [{ name: 'Perfect Dark', repository: 'fgsfdsfgs/perfect_dark' }] }));
  };
  const cat = (await call('POST', '/catalogs', { url: `${fake.base}/cat.json`, name: 'Ports' })).body.id;

  assert.equal((await call('POST', '/library/import/quiver', {})).status, 400);
  const empty = tmpDir(t);
  const bad = await call('POST', '/library/import/quiver', { dir: empty });
  assert.deepEqual([bad.status, bad.body.error], [400, 'not_quiver']);

  const preview = await call('POST', '/library/import/quiver', { dir: root });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.result, undefined);
  assert.deepEqual(preview.body.apps.map(a => a.kind), ['port', 'new', 'new', 'manual', 'manual', 'new']);
  assert.deepEqual((await call('GET', '/library')).body.library, {}, 'a preview writes nothing');

  const done = await call('POST', '/library/import/quiver', { dir: root, apply: true });
  assert.deepEqual(done.body.result, { added: 2, adopted: 4, ports: 3, unchanged: 0, needAdditionalSources: 3 });
  const lib = (await call('GET', '/library')).body.library;
  assert.equal(lib[`quiver:${cat}:fgsfdsfgs/perfect_dark`].install_dir, path.join(apps, 'PerfectDark'));
  assert.equal(lib['manual:Homebrew'].title, 'Homebrew Thing');

  // The repositories no catalog lists are on "Your ports", once additional sources are on
  assert.equal((await call('GET', '/catalogs/local/items')).status, 404);
  await call('PUT', '/settings', { allowAdditionalSources: true });
  const mine = (await call('GET', '/catalogs/local/items')).body.items.map(i => i.repository).sort();
  assert.deepEqual(mine, ['HarbourMasters/Shipwright', 'someone/half-installed', 'someone/obscure-port']);
  assert.equal(lib['quiver:local:harbourmasters/shipwright'].install_dir !== null, true);

  // Second run: the same entries now match catalog items, installs untouched
  const again = await call('POST', '/library/import/quiver', { dir: root, apply: true });
  assert.deepEqual(again.body.result, { added: 0, adopted: 0, ports: 0, unchanged: 6 });
  backend.library.close();
  const down = await call('POST', '/library/import/quiver', { dir: root, apply: true });
  assert.equal(down.status, 503);
});
