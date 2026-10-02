'use strict';
/**
 * The HTTP API against fixtures: every endpoint, the token, and the error
 * shape. Requests go through real sockets with fetch, supertest style.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { testApi, JPEG, makeZip } = require('./helpers');
const { run, parseArgs } = require('../../src/backend/main');

test('token: required on every request, as a Bearer header or ?token=', async (t) => {
  const { call, info } = await testApi(t);
  assert.deepEqual((await call('GET', '/health', undefined, { token: null })).body.error, 'unauthorized');
  assert.equal((await call('GET', '/health', undefined, { token: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/health', undefined, { token: 'test-token-but-longer' })).status, 401);
  const health = (await call('GET', '/health')).body;
  assert.deepEqual(health, { ok: true, api: 'v1', version: require('../../package.json').version });
  assert.equal((await fetch(`${info.url}/health?token=test-token`)).status, 200);
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
});

test('CORS preflight, unknown routes, wrong methods, bad bodies', async (t) => {
  const { call, info } = await testApi(t);
  const pre = await fetch(`${info.url}/items`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual((await call('GET', '/nope')).body, { error: 'not_found', detail: 'No route /v1/nope' });
  assert.equal((await fetch(`${info.url.replace('/v1', '/v2')}/items?token=test-token`)).status, 404);
  const wrong = await call('PUT', '/items');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET');
  assert.equal((await call('POST', '/library', '{oops')).body.error, 'bad_json');
  assert.equal((await call('POST', '/library', '[1]')).body.error, 'bad_request');
  assert.equal((await call('POST', '/library', {})).body.detail, 'id is required');
  assert.equal((await call('PUT', '/settings', 'x'.repeat(1024 * 1024 + 1)).catch(() => ({ status: 413 }))).status, 413);
});

test('GET /items with filters, /items/:id, files, reviews, cover, hero', async (t) => {
  const { call, info } = await testApi(t);
  const all = await call('GET', '/items');
  assert.equal(all.status, 200);
  assert.equal(all.body.items.length, 6);
  assert.deepEqual(all.body.errors, []);
  assert.equal((await call('GET', '/items?search=tycoon&source=hailstormttv')).body.items.length, 2);
  assert.equal((await call('GET', '/items?installed=true')).body.items.length, 0);

  const zoo = await call('GET', '/items/rk-e2e-zoo-tycoon-pstriple');
  assert.equal(zoo.body.id, 'rk-e2e-zoo-tycoon');
  // each version names the newest later upload of its title
  const newer = Object.fromEntries(zoo.body.versions.map(v => [v.id, v.newer]));
  assert.deepEqual(newer, { 'rk-e2e-zoo-tycoon': 'rk-e2e-zoo-tycoon-pstriple', 'rk-e2e-zoo-tycoon-pstriple': null });
  const listed = all.body.items.find(i => i.id === 'rk-e2e-zoo-tycoon');
  assert.equal(listed.versions.find(v => v.id === 'rk-e2e-zoo-tycoon').newer, 'rk-e2e-zoo-tycoon-pstriple');
  assert.equal((await call('GET', '/items/nope')).status, 404);

  const files = await call('GET', '/items/rk-e2e-halo-ce/files');
  assert.deepEqual(files.body.installable.map(f => f.name), ['rk-e2e-halo-ce.zip']);
  assert.equal((await call('GET', '/items/rk-e2e-halo-ce/reviews')).body.reviews.length, 1);

  const cover = await fetch(`${info.url}/items/rk-e2e-halo-ce/cover?token=test-token`);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  assert.equal((await cover.arrayBuffer()).byteLength, JPEG.length);
  assert.equal((await call('GET', '/items/missing-x/cover')).body.error, 'no_image');

  // No pinned hero: the archive.org item's own image
  const hero = await fetch(`${info.url}/items/rk-e2e-halo-ce/hero?token=test-token`);
  assert.equal(hero.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('GET', '/items/missing-x/hero')).body.error, 'no_image');
});

test('items: sources down is a 502 with the per-source errors', async (t) => {
  const { call, backend, fake } = await testApi(t);
  backend.settings.save({ allowAdditionalSources: true, sources: [{ uploader: 'nobody@x' }] });
  const r = await call('GET', '/items');
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'sources_failed');
  assert.equal(r.body.errors[0].source, 'nobody@x');
  assert.equal((await call('GET', '/items/anything')).status, 502);
  fake.routes['/metadata/x'] = (req, res) => { res.writeHead(200); res.end('junk'); };
  assert.equal((await call('GET', '/items/x/files')).status, 502);
  assert.equal((await call('POST', '/library/scan', { dir: backend.dataDir })).status, 502);
});

test('catalogs: list, get, refresh, items, review, seen on the curated shelf', async (t) => {
  let apps = [{ name: 'A', repository: 'o/a' }];
  const state = { routes: { '/curated-ports.json': (req, res) => { res.writeHead(200); res.end(JSON.stringify({ apps })); } } };
  const { call } = await testApi(t, { state, curated: true });
  const id = 'curated';
  assert.equal((await call('GET', '/catalogs')).body.catalogs.length, 1);
  assert.equal((await call('GET', `/catalogs/${id}`)).body.entries, 1);
  assert.equal((await call('GET', '/items?shelf=Curated')).body.items[0].title, 'A');
  const [a] = (await call('GET', `/catalogs/${id}/items`)).body.items;
  assert.deepEqual([a.title, a.repository, a.installed, a.library], ['A', 'o/a', false, null]);
  assert.equal((await call('POST', '/library', { id: a.id, source: 'curated' })).status, 201);
  assert.equal((await call('GET', `/catalogs/${id}/items`)).body.items[0].library.identifier, a.id);

  apps = [...apps, { name: 'B', repository: 'o/b' }];
  assert.equal((await call('POST', `/catalogs/${id}/refresh`)).body.entries, 2);
  assert.deepEqual((await call('GET', `/catalogs/${id}/review`)).body.new.map(e => e.name), ['B']);
  assert.equal((await call('POST', `/catalogs/${id}/seen`)).status, 204);
  assert.deepEqual((await call('GET', `/catalogs/${id}/review`)).body.new, []);
  assert.equal((await call('POST', '/catalogs', { url: 'https://example.com/c.json' })).status, 405, 'no subscribing: the shelf is fixed');
  assert.equal((await call('DELETE', '/catalogs/curated')).status, 405);
  for (const [m, p] of [['GET', ''], ['POST', '/refresh'], ['GET', '/items'], ['GET', '/review'], ['POST', '/seen']]) {
    assert.equal((await call(m, `/catalogs/nope${p}`)).status, 404, `${m} ${p}`);
  }
});

test('library: add, get, patch, exes, readme, launch, reveal, delete', async (t) => {
  const opened = [];
  const { call, backend } = await testApi(t, {
    host: { openPath: async (p) => { opened.push(p); return ''; }, revealPath: () => opened.push('reveal'), trashItem: async () => {} },
  });
  assert.deepEqual((await call('GET', '/library')).body, { library: {} });
  const added = await call('POST', '/library', { id: 'quiver:abc:o/a', source: 'https://c/x.json' });
  assert.equal(added.status, 201);
  assert.equal(added.body.source, 'https://c/x.json');
  assert.equal((await call('POST', '/library', { id: 'quiver:abc:o/a' })).status, 200);
  assert.equal((await call('GET', `/library/${encodeURIComponent('quiver:abc:o/a')}`)).body.identifier, 'quiver:abc:o/a');
  assert.equal((await call('GET', '/library/nope')).status, 404);

  assert.equal((await call('PATCH', '/library/nope', { category: 'x' })).status, 404);
  const fav = await call('PATCH', '/library/fresh', { favorite: true, notes: 'hi' });
  assert.deepEqual([fav.body.is_favorite, fav.body.notes], [1, 'hi']);
  assert.equal((await call('PATCH', '/library/fresh', { category: 'rpg', exePath: '/x.exe' })).body.category, 'rpg');
  assert.equal((await call('PATCH', '/library/fresh', { color: 'x' })).body.detail, 'Unknown fields: color');

  assert.equal((await call('GET', '/library/fresh/exes')).body.error, 'not_installed');
  const dir = path.join(backend.dataDir, 'g');
  fs.mkdirSync(path.join(dir, 'Game'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game', 'a.exe'), '');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'read me');
  backend.library.recordInstall('g', dir, null);
  assert.deepEqual((await call('GET', '/library/g/exes')).body.exes, [path.join(dir, 'Game', 'a.exe')]);
  assert.deepEqual((await call('GET', '/library/g/readme')).body, { text: 'read me', fileName: 'readme.txt' });

  const launched = await call('POST', '/library/g/launch', {});
  assert.deepEqual(launched.body, { ok: true, exePath: path.join(dir, 'Game', 'a.exe') });
  fs.writeFileSync(path.join(dir, 'Game', 'b.exe'), '');
  const choose = await call('POST', '/library/g/launch');
  assert.deepEqual([choose.status, choose.body.error, choose.body.choices.length], [409, 'choose_exe', 2]);
  assert.equal((await call('POST', '/library/g/launch', { exePath: path.join(dir, 'nope.exe') })).body.error, 'launch_failed');
  assert.equal((await call('POST', '/library/g/reveal')).body.ok, true);
  assert.equal(opened.length, 2);

  const empty = path.join(backend.dataDir, 'empty');
  fs.mkdirSync(empty);
  backend.library.recordInstall('e', empty, null);
  assert.equal((await call('POST', '/library/e/launch')).body.error, 'no_exe');
  fs.rmSync(empty, { recursive: true });
  assert.equal((await call('GET', '/library/e/readme')).status, 404);
  assert.equal((await call('POST', '/library/e/reveal')).status, 404);

  // Locate an existing install: adopts the folder, picking the exe when there's only one
  const found = path.join(backend.dataDir, 'found');
  fs.mkdirSync(found);
  fs.writeFileSync(path.join(found, 'port.exe'), '');
  const located = await call('PATCH', `/library/${encodeURIComponent('quiver:abc:o/b')}`, { installDir: found });
  assert.deepEqual([located.body.install_dir, located.body.exe_path], [found, path.join(found, 'port.exe')]);
  assert.equal((await call('PATCH', '/library/x', { installDir: path.join(found, 'nope') })).body.error, 'no_folder');
  assert.equal((await call('PATCH', '/library/x', { installDir: 3 })).status, 400);

  assert.equal((await call('DELETE', '/library/g?files=trash')).status, 204);
  assert.equal(backend.library.get('g'), null);
  assert.equal((await call('DELETE', '/library/g')).status, 404);
});

test('library: delete with trash needs the desktop app when standalone', async (t) => {
  const { call, backend } = await testApi(t);
  backend.library.recordInstall('g', backend.dataDir, null);
  const r = await call('DELETE', '/library/g?files=trash');
  assert.deepEqual([r.status, r.body.error], [501, 'unsupported']);
  assert.equal((await call('DELETE', '/library/g')).status, 204, 'without files=trash the folder stays');
  assert.equal((await call('POST', '/os/choose-folder')).status, 501);
});

test('library: failing trash is a 500; chooseFolder from the host', async (t) => {
  const { call, backend } = await testApi(t, { host: { trashItem: async () => { throw new Error('EPERM'); }, chooseFolder: async () => '/picked' } });
  backend.library.recordInstall('g', backend.dataDir, null);
  assert.deepEqual((await call('DELETE', '/library/g?files=trash')).body, { error: 'delete_failed', detail: 'EPERM' });
  assert.deepEqual((await call('POST', '/os/choose-folder')).body, { path: '/picked' });
});

test('POST /library/scan adopts folders named after items', async (t) => {
  const { call, backend } = await testApi(t);
  assert.equal((await call('POST', '/library/scan', {})).status, 400);
  const dir = path.join(backend.dataDir, 'scan');
  fs.mkdirSync(path.join(dir, 'Halo_ Combat Evolved'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'rk-e2e-the-sims'), { recursive: true });
  backend.settings.save({ installPath: dir });
  const r = await call('POST', '/library/scan', {});
  assert.deepEqual(r.body.found.map(f => [f.identifier, f.matchedBy]).sort(), [['rk-e2e-halo-ce', 'title'], ['rk-e2e-the-sims', 'identifier']]);
});

test('collections: create, rename, colour, add and remove items, delete', async (t) => {
  const { call } = await testApi(t);
  const c = await call('POST', '/collections', { name: 'Faves' });
  assert.equal(c.status, 201);
  assert.equal((await call('POST', '/collections', { name: 'Faves' })).status, 409);
  assert.equal((await call('POST', '/collections', {})).status, 400);
  const other = (await call('POST', '/collections', { name: 'Other' })).body;
  assert.equal((await call('PATCH', `/collections/${other.id}`, { name: 'Faves' })).status, 409);
  const p = await call('PATCH', `/collections/${c.body.id}`, { name: 'Best', color: '#0f0' });
  assert.deepEqual([p.body.name, p.body.color], ['Best', '#0f0']);
  assert.equal((await call('PUT', `/collections/${c.body.id}/items/rk-e2e-halo-ce`)).status, 204);
  assert.deepEqual((await call('GET', '/collections')).body.collections.find(x => x.id === c.body.id).games, ['rk-e2e-halo-ce']);
  assert.equal((await call('DELETE', `/collections/${c.body.id}/items/rk-e2e-halo-ce`)).status, 204);
  assert.equal((await call('DELETE', `/collections/${c.body.id}`)).status, 204);
  assert.equal((await call('PATCH', `/collections/${c.body.id}`, {})).status, 404);
  assert.equal((await call('DELETE', '/collections/abc')).status, 404);
});

test('installs: start, progress over SSE, get, list, cancel, errors', async (t) => {
  const { call, backend, fake, info } = await testApi(t);
  backend.settings.save({ installPath: path.join(backend.dataDir, 'games') });

  const events = [];
  const sse = await new Promise((resolve) => {
    const req = http.get(`${info.url}/events?token=test-token`, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          if (type) events.push({ type, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
        }
      });
      resolve({ req, res });
    });
  });
  assert.equal(sse.res.headers['content-type'], 'text/event-stream');

  const start = await call('POST', '/installs', { id: 'rk-e2e-halo-ce' });
  assert.equal(start.status, 202);
  const job = start.body.installs[0];
  await backend.installs.wait(job.id);
  const done = await call('GET', `/installs/${job.id}`);
  assert.equal(done.body.status, 'done');
  assert.ok(done.body.exePath.endsWith('game.exe'));
  assert.equal((await call('GET', '/installs')).body.installs.length, 1);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(events.some(e => e.type === 'install' && e.data.status === 'done'));
  assert.ok(events.some(e => e.type === 'library' && e.data.identifier === 'rk-e2e-halo-ce'));
  sse.req.destroy();

  fake.files.coll = [{ name: 'a.zip' }, { name: 'b.zip' }];
  const choose = await call('POST', '/installs', { id: 'coll' });
  assert.deepEqual([choose.status, choose.body.error, choose.body.choices.length], [409, 'choose_files', 2]);
  assert.equal((await call('POST', '/installs', { id: 'coll', files: ['c.zip'] })).status, 400);
  assert.equal((await call('POST', '/installs', { id: 'coll', files: 'a.zip' })).status, 400);
  assert.equal((await call('POST', '/installs', { id: 'quiver:x:y' })).status, 404);
  backend.catalogs.items = () => [{ id: 'quiver:x:norepo', title: 'No Repo', repository: null }, { id: 'quiver:x:o/r', title: 'Port', repository: 'o/r', entry: {}, data: null }];
  const norepo = await call('POST', '/installs', { id: 'quiver:x:norepo' });
  assert.deepEqual([norepo.status, norepo.body.error], [422, 'no_repository']);
  const port = await call('POST', '/installs', { id: 'quiver:x:o/r' });
  assert.deepEqual([port.status, port.body.installs[0].step], [202, 'binary']);
  await backend.installs.wait(port.body.installs[0].id);
  fake.files.docs = [{ name: 'manual.pdf' }];
  assert.equal((await call('POST', '/installs', { id: 'docs' })).status, 422);

  fake.routes['/download/slow/slow.zip'] = () => {};
  const slow = (await call('POST', '/installs', { id: 'slow' })).body.installs[0];
  assert.equal((await call('DELETE', `/installs/${slow.id}`)).body.status, 'cancelled');
  assert.equal((await call('GET', '/installs/nope')).status, 404);
  assert.equal((await call('DELETE', '/installs/nope')).status, 404);
});

test('GET /catalogs: the curated shelf first, fetched on the first call, its items marked curated', async (t) => {
  const state = { routes: {
    '/curated-ports.json': (req, res) => { res.writeHead(200); res.end(JSON.stringify({ apps: [{ name: 'Zelda', repository: 'z/zelda' }] })); },
  } };
  const { call, backend } = await testApi(t, { state, curated: true });
  const [shelf] = (await call('GET', '/catalogs')).body.catalogs;
  assert.deepEqual([shelf.id, shelf.shelf, shelf.entries, shelf.error], ['curated', 'Curated', 1, null]);
  const { items } = (await call('GET', '/catalogs/curated/items')).body;
  assert.deepEqual(items.map(i => [i.title, i.curated, i.userSource]), [['Zelda', true, false]]);
  assert.equal(backend.catalogs.list()[0].id, 'curated');
});

// The acceptance test for GitLab releases: Star Fox 64: Recompiled, as the
// curated catalog lists it, installs from the shelf. GitLab answers from a
// fixture of its releases API; its Windows link holds a zip with no extension.
test('Star Fox 64: Recompiled installs from the curated shelf, from GitLab\'s releases', async (t) => {
  const curated = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'catalog', 'curated-ports.json'), 'utf8'));
  const releases = require('../fixtures/gitlab/starfox64recomp-releases.json');
  const zip = makeZip({ 'Starfox64Recompiled.exe': 'MZ', 'assets/.keep': '' });
  const state = { routes: {} };
  const asFake = (base) => JSON.stringify(releases.map(r => ({ ...r, assets: { ...r.assets,
    links: r.assets.links.map(l => ({ ...l, direct_asset_url: l.direct_asset_url.replace('https://gitlab.com', base) })) } })));
  const { call, backend, fake } = await testApi(t, { state, curated: true });
  state.routes['/curated-ports.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify(curated)); };
  state.routes['/projects/sonicdcer%2FStarfox64Recomp/releases'] = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(asFake(fake.base)); };
  state.routes['/sonicdcer/Starfox64Recomp/-/package_files/333158626/download'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
    res.end(zip);
  };
  backend.settings.save({ installPath: path.join(backend.dataDir, 'games') });

  await call('GET', '/catalogs');
  const { items } = (await call('GET', '/catalogs/curated/items')).body;
  const sf = items.find(i => i.repository === 'sonicdcer/Starfox64Recomp');
  assert.deepEqual([sf.title, sf.repositorySource, sf.repositoryUrl], ['Star Fox 64', 'gitlab', 'https://gitlab.com/sonicdcer/Starfox64Recomp']);
  const r = await call('POST', '/installs', { id: sf.id });
  assert.equal(r.status, 202);
  await backend.installs.wait(r.body.installs[0].id);
  const job = backend.installs.get(r.body.installs[0].id);
  assert.deepEqual([job.status, job.error, job.file], ['done', null, 'Starfox64Recompiled-v1.0.3-Windows-RelWithDebInfo']);
  assert.ok(fs.existsSync(path.join(job.installDir, 'Starfox64Recompiled.exe')));
  assert.equal(job.exePath, path.join(job.installDir, 'Starfox64Recompiled.exe'));
  assert.equal(backend.library.get(sf.id).install_dir, job.installDir);

  state.routes['/projects/sonicdcer%2FStarfox64Recomp/releases'] = (req, res) => { res.writeHead(404); res.end('{"message":"404 Project Not Found"}'); };
  const again = await call('POST', '/installs', { id: sf.id });
  await backend.installs.wait(again.body.installs[0].id);
  assert.equal(backend.installs.get(again.body.installs[0].id).error, "Couldn't read the releases of sonicdcer/Starfox64Recomp (HTTP 404)");
});

test('settings and Playnite export', async (t) => {
  const { call, backend } = await testApi(t);
  assert.deepEqual((await call('GET', '/settings')).body, {});
  assert.deepEqual((await call('PUT', '/settings', { betaUpdates: true })).body, { betaUpdates: true });
  assert.deepEqual((await call('PUT', '/settings', { checkForUpdates: false })).body, { betaUpdates: true, checkForUpdates: false });
  assert.equal((await call('PUT', '/settings', [1])).status, 400);
  assert.equal((await call('PUT', '/settings', { morePorts: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/settings', { morePorts: true })).body.morePorts, true);

  backend.library.add('solo');
  const r = await call('POST', '/export/playnite', {});
  assert.equal(r.body.count, 1);
  assert.ok(fs.existsSync(r.body.file));
  const target = path.join(backend.dataDir, 'out', 'p.json');
  assert.equal((await call('POST', '/export/playnite', { path: target })).body.file, target);
  assert.equal((await call('POST', '/export/playnite', { path: 'relative.json' })).status, 400);
});

test('an unexpected error is a 500 with the error shape', async (t) => {
  const { call, backend } = await testApi(t);
  backend.library.all = () => { throw new Error('disk on fire'); };
  assert.deepEqual((await call('GET', '/library')).body, { error: 'internal', detail: 'disk on fire' });
});

test('library.db unavailable is a 503', async (t) => {
  const { call, backend } = await testApi(t);
  backend.library.close();
  assert.equal((await call('POST', '/library', { id: 'x' })).status, 503);
  assert.equal((await call('POST', '/collections', { name: 'x' })).status, 503);
});

test('standalone: prints port and token, serves the API, stops cleanly', async (t) => {
  assert.deepEqual(parseArgs(['loose', '--data-dir', '/d', '--port=5', '--flag']), { 'data-dir': '/d', port: '5', flag: 'true' });
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rk-standalone-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const writes = [];
  const srv = await run(['--data-dir', dataDir, '--archive-base', 'http://127.0.0.1:1', '--overrides-url', 'http://127.0.0.1:1/o.json', '--uploaders-url', 'http://127.0.0.1:1/u.json'],
    { LAUNCHER_TOKEN: 'fixed' }, (line) => writes.push(line));
  const printed = JSON.parse(writes[0]);
  assert.deepEqual([printed.token, printed.port], ['fixed', srv.port]);
  const res = await fetch(`${printed.url}/settings`, { headers: { authorization: 'Bearer fixed' } });
  assert.equal(res.status, 200);
  await srv.stop();
});

test('GET /sources: catalog defaults, fetched from main or bundled; a saved list wins', async (t) => {
  const { call, backend, fake } = await testApi(t);
  const bundled = await call('GET', '/sources');
  assert.deepEqual(bundled.body.defaults.filter(s => s.enabled).map(s => s.label).sort(), ['hailstormttv', 'r4zel1ght', 'rohanjackson071']);
  assert.deepEqual(bundled.body.sources, bundled.body.defaults);
  backend.settings.save({ sources: [{ uploader: 'mine@x' }] });
  assert.deepEqual((await call('GET', '/sources')).body.sources, [{ uploader: 'mine@x' }]);

  // A second backend on the same fake: the fetched copy wins when it has uploaders
  fake.routes['/uploaders.json'] = (req, res) => { res.writeHead(200); res.end(JSON.stringify({ uploaders: [{ handle: 'fetched', uploaderEmail: 'f@x', launcher: true }] })); };
  const { createBackend } = require('../../src/backend');
  const other = createBackend({ dataDir: backend.dataDir + '-2', archiveBase: fake.base, uploadersUrl: `${fake.base}/uploaders.json`, log: () => {} });
  t.after(() => { other.close(); fs.rmSync(backend.dataDir + '-2', { recursive: true, force: true }); });
  assert.deepEqual(await other.getDefaultSources(), [{ uploader: 'f@x', label: 'fetched', enabled: true }]);

  fake.routes['/uploaders.json'] = (req, res) => { res.writeHead(200); res.end('{"uploaders":[]}'); };
  const none = createBackend({ dataDir: backend.dataDir + '-3', appDir: backend.dataDir, archiveBase: fake.base, uploadersUrl: `${fake.base}/uploaders.json`, log: () => {} });
  t.after(() => { none.close(); fs.rmSync(backend.dataDir + '-3', { recursive: true, force: true }); });
  assert.deepEqual(await none.getDefaultSources(), [], 'empty fetch and no bundled copy: no defaults');
});

test('GET /featured: the picks from main, else the bundled copy', async (t) => {
  const { call, backend, fake } = await testApi(t);
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'catalog', 'featured.json'), 'utf8')).picks;
  const { body } = await call('GET', '/featured');
  assert.equal(body.picks.length, bundled.length);
  assert.ok(body.picks.every(p => p.identifier || p.repository));

  fake.routes['/featured.json'] = (req, res) => { res.writeHead(200); res.end('{"picks":[{"identifier":"a","blurb":"Hi"},{"repository":"Owner/Repo"},{"nope":1}]}'); };
  const { createBackend } = require('../../src/backend');
  const other = createBackend({ dataDir: backend.dataDir + '-f', archiveBase: fake.base, featuredUrl: `${fake.base}/featured.json`, log: () => {} });
  t.after(() => { other.close(); fs.rmSync(backend.dataDir + '-f', { recursive: true, force: true }); });
  assert.deepEqual(await other.getFeatured(), [{ identifier: 'a', blurb: 'Hi', banner: null }, { repository: 'owner/repo', blurb: null, banner: null }]);
});

test('os: window, open-external, add-to-steam, updater go to the host; 501 standalone', async (t) => {
  const calls = [];
  const { call, backend } = await testApi(t, {
    host: {
      window: (a) => calls.push(['window', a]),
      openExternal: async (u) => calls.push(['open', u]),
      addToSteam: async (o) => { calls.push(['steam', o.appName]); return { ok: true, alreadyAdded: false, updatedUsers: 1 }; },
      updaterInstall: () => calls.push(['update']),
    },
  });
  assert.equal((await call('POST', '/os/window', { action: 'maximize' })).body.ok, true);
  assert.equal((await call('POST', '/os/window', { action: 'fly' })).status, 400);
  assert.equal((await call('POST', '/os/open-external', { url: 'https://archive.org/donate' })).status, 200);
  assert.equal((await call('POST', '/os/open-external', { url: 'file:///etc/passwd' })).status, 400);
  assert.deepEqual((await call('POST', '/os/add-to-steam', { appName: 'Halo', exePath: 'C:\\g\\h.exe', startDir: 'C:\\g' })).body, { ok: true, alreadyAdded: false, updatedUsers: 1 });
  assert.equal((await call('POST', '/os/add-to-steam', { appName: 'Halo' })).status, 400);
  assert.deepEqual((await call('GET', '/os/updater')).body, { status: null });
  backend.setUpdaterStatus({ status: 'available', version: '9.9.9' });
  assert.equal((await call('GET', '/os/updater')).body.status.version, '9.9.9');
  assert.equal((await call('POST', '/os/updater-install')).body.ok, true);
  const opened = [];
  backend.events.on('event', (e) => { if (e.type === 'open-item') opened.push(e.data.identifier); });
  assert.deepEqual((await call('GET', '/os/open-item')).body, { identifier: null });
  backend.requestOpen('rk-e2e-halo-ce');
  assert.deepEqual((await call('GET', '/os/open-item')).body, { identifier: 'rk-e2e-halo-ce' });
  assert.equal((await call('DELETE', '/os/open-item')).status, 204);
  assert.deepEqual((await call('GET', '/os/open-item')).body, { identifier: null });
  assert.deepEqual(opened, ['rk-e2e-halo-ce']);
  assert.deepEqual(calls, [['window', 'maximize'], ['open', 'https://archive.org/donate'], ['steam', 'Halo'], ['update']]);
});

test('os: standalone answers 501 for window, browser, Steam and updater', async (t) => {
  const { call } = await testApi(t);
  assert.equal((await call('POST', '/os/window', { action: 'close' })).status, 501);
  assert.equal((await call('POST', '/os/open-external', { url: 'https://x' })).status, 501);
  assert.equal((await call('POST', '/os/add-to-steam', { appName: 'a', exePath: 'b', startDir: 'c' })).status, 501);
  assert.equal((await call('POST', '/os/updater-install')).status, 501);
});

test('repos: your own GitHub repos (add, list, replace, remove) make up "Your ports"', async (t) => {
  const { call } = await testApi(t);
  await call('PUT', '/settings', { allowAdditionalSources: true });
  const enc = encodeURIComponent;

  const saved = await call('PUT', `/repos/${enc('me/port')}`, { name: 'My Port', sources: [{ ia: 'x', path: 'y' }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { repository: 'me/port', name: 'My Port' }, 'only the repo fields are kept');
  assert.deepEqual((await call('GET', '/repos')).body.repos, [saved.body]);
  assert.deepEqual((await call('PUT', `/repos/${enc('Me/Port')}`, { name: 'Renamed' })).body, { repository: 'Me/Port', name: 'Renamed' });
  assert.deepEqual((await call('GET', '/repos')).body.repos.map(r => r.name), ['Renamed']);

  const local = (await call('GET', '/catalogs')).body.catalogs.find(c => c.id === 'local');
  assert.deepEqual([local.name, local.entries], ['Your ports', 1]);
  const [item] = (await call('GET', '/catalogs/local/items')).body.items;
  assert.deepEqual([item.repository, item.userSource, 'data' in item], ['Me/Port', true, false]);

  const bad = await call('PUT', `/repos/${enc('not-a-repo')}`, {});
  assert.deepEqual([bad.status, bad.body.error], [400, 'bad_repo']);
  assert.equal((await call('DELETE', `/repos/${enc('me/port')}`)).status, 204);
  assert.equal((await call('DELETE', `/repos/${enc('me/port')}`)).status, 404);
  assert.equal((await call('GET', '/catalogs/local')).status, 404);
});

test('the collision, feed and admin routes are gone', async (t) => {
  const { call } = await testApi(t);
  for (const [method, url] of [['GET', '/collisions'], ['GET', '/collision-feeds'], ['GET', '/admin/collisions'], ['POST', '/feed/import'], ['POST', '/sources/trust']]) {
    assert.equal((await call(method, url, method === 'POST' ? {} : undefined)).status, 404, `${method} ${url}`);
  }
  assert.equal((await call('GET', '/health')).body.admin, undefined);
});
