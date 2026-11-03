'use strict';
// The Add box (docs/AGENT-BRIEF.md, "The user loop"): a pasted link resolves
// to an account, an upload or a repo; repos install from GitHub or GitLab.
const test = require('node:test');
const assert = require('node:assert/strict');
const { testApi, makeZip } = require('./helpers');

test('POST /add/resolve: repos, accounts, and an upload with its title and uploader', async (t) => {
  const state = { metadata: { 'raze-package': { title: 'Raze', uploader: 'someone@example.com' } } };
  const { call } = await testApi(t, { state });
  const resolve = (link) => call('POST', '/add/resolve', { link });

  assert.deepEqual((await resolve('https://github.com/a/b/releases')).body, { kind: 'repo', repository: 'a/b', repositorySource: 'github' });
  assert.deepEqual((await resolve('https://gitlab.com/g/sub/p/-/releases')).body, { kind: 'repo', repository: 'g/sub/p', repositorySource: 'gitlab' });
  assert.deepEqual((await resolve('https://archive.org/details/@pstriple')).body, { kind: 'account', uploader: '@pstriple' });
  assert.deepEqual((await resolve('https://archive.org/details/raze-package')).body,
    { kind: 'upload', identifier: 'raze-package', title: 'Raze', uploader: 'someone@example.com' });

  const missing = await resolve('https://archive.org/details/not-there');
  assert.deepEqual([missing.status, missing.body.error], [404, 'not_found']);
  const bad = await resolve('hello');
  assert.deepEqual([bad.status, bad.body.error], [400, 'bad_link']);
  assert.equal((await call('POST', '/add/resolve', [1])).status, 400);
});

test('a GitLab repo of yours, in a subgroup, installs from GitLab', async (t) => {
  const zip = makeZip({ 'Game.exe': 'MZ' });
  const state = { routes: {} };
  const { call, backend, fake } = await testApi(t, { state });
  state.routes['/projects/g%2Fsub%2Fp/releases'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ tag_name: 'v1', released_at: '2026-01-01T00:00:00Z',
      assets: { links: [{ name: 'p-windows.zip', direct_asset_url: `${fake.base}/files/p-windows.zip` }] } }]));
  };
  state.routes['/files/p-windows.zip'] = (req, res) => { res.writeHead(200, { 'content-length': zip.length }); res.end(zip); };
  backend.settings.save({ installPath: `${backend.dataDir}/games` });

  const put = await call('PUT', `/repos/${encodeURIComponent('g/sub/p')}`, { repositorySource: 'gitlab' });
  assert.deepEqual([put.status, put.body], [200, { repository: 'g/sub/p', repositorySource: 'gitlab' }]);
  assert.equal((await call('PUT', `/repos/${encodeURIComponent('g/sub/p')}`, {})).status, 400, 'GitHub repos are owner/repo');
  assert.equal((await call('PUT', `/repos/${encodeURIComponent('a/b')}`, { repositorySource: 'codeberg' })).status, 400);
  await call('PUT', `/repos/${encodeURIComponent('g/sub/p')}`, { repositorySource: 'gitlab' });

  await call('GET', '/catalogs');
  const { items } = (await call('GET', '/catalogs/local/items')).body;
  const p = items.find(i => i.repository === 'g/sub/p');
  assert.deepEqual([p.repositorySource, p.repositoryUrl], ['gitlab', 'https://gitlab.com/g/sub/p']);
  const r = await call('POST', '/installs', { id: p.id });
  await backend.installs.wait(r.body.installs[0].id);
  const job = backend.installs.get(r.body.installs[0].id);
  assert.deepEqual([job.status, job.error, job.file], ['done', null, 'p-windows.zip']);
});

test('Settings > GitHub token goes on GitHub API requests; a used-up limit says to add one', async (t) => {
  const zip = makeZip({ 'Port.exe': 'MZ' });
  const seen = [];
  const state = { routes: {} };
  const { call, backend, fake } = await testApi(t, { state });
  let limited = true;
  state.routes['/repos/me/port/releases'] = (req, res) => {
    seen.push(req.headers.authorization || null);
    if (limited) { res.writeHead(403, { 'x-ratelimit-remaining': '0' }); return res.end('{"message":"API rate limit exceeded"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ tag_name: 'v1', assets: [{ name: 'port-win64.zip', browser_download_url: `${fake.base}/files/port-win64.zip` }] }]));
  };
  state.routes['/files/port-win64.zip'] = (req, res) => { res.writeHead(200, { 'content-length': zip.length }); res.end(zip); };
  backend.settings.save({ installPath: `${backend.dataDir}/games` });
  await call('PUT', `/repos/${encodeURIComponent('me/port')}`, {});
  await call('GET', '/catalogs');
  const install = async () => {
    const r = await call('POST', '/installs', { id: 'quiver:local:me/port' });
    await backend.installs.wait(r.body.installs[0].id);
    return backend.installs.get(r.body.installs[0].id);
  };

  assert.match((await install()).error, /60 release checks an hour without a token/);
  backend.settings.save({ githubToken: 'ghp_test' });
  assert.match((await install()).error, /limit for your token is used up/);
  limited = false;
  assert.equal((await install()).status, 'done');
  assert.deepEqual(seen, [null, 'Bearer ghp_test', 'Bearer ghp_test']);
});
