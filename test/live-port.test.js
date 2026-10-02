'use strict';
// scripts/live-port.js: only the parts that don't need the network
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, skipReason, itemFor, DEFAULT } = require('../scripts/live-port');
const curated = require('../catalog/curated-ports.json').apps;

test('live-port: the default list by default, repos and --keep from the command line', () => {
  assert.deepEqual(parseArgs([]), { repos: DEFAULT, keep: false });
  assert.deepEqual(parseArgs(['a/b', '--keep', 'c/d']), { repos: ['a/b', 'c/d'], keep: true });
});

test('live-port: every default repo is a curated port it can install', () => {
  for (const repo of DEFAULT) {
    const e = curated.find(x => x.repository?.toLowerCase() === repo.toLowerCase());
    assert.ok(e, `${repo} is in catalog/curated-ports.json`);
    assert.equal(skipReason(e), null);
  }
});

test('live-port: source-only and GitLab entries are skipped, not failed', () => {
  assert.equal(skipReason({ repository: 'a/b', tags: ['source only'] }), 'source only, nothing to install');
  assert.equal(skipReason({ repository: 'a/b', repositorySource: 'gitlab' }), "gitlab releases aren't supported yet");
  assert.equal(skipReason({ repository: 'a/b', repositorySource: 'github' }), null);
});

test('live-port: a curated entry becomes the catalog item the install engine takes', () => {
  const e = { repository: 'Owner/Repo', name: 'Game', folderName: 'Game', releaseAssetFilter: 'win64' };
  assert.deepEqual(itemFor(e), { id: 'quiver:live:owner/repo', title: 'Game', repository: 'Owner/Repo', entry: e });
  assert.equal(itemFor({ repository: 'a/b' }).title, 'a/b');
});
