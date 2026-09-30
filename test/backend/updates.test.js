'use strict';
// "Newer release": the check shared by the launcher and the Playnite export
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newerVersion, updateAvailable, withNewer } = require('../../src/backend/updates');

const item = {
  id: 'zoo',
  versions: [
    { id: 'zoo-2023', addeddate: '2023-01-01T00:00:00Z' },
    { id: 'zoo-2025', addeddate: '2025-01-01T00:00:00Z' },
    { id: 'zoo-2024', addeddate: '2024-01-01T00:00:00Z' },
    { id: 'zoo-undated' },
  ],
};

test('newerVersion: the newest later upload, not just any later one', () => {
  assert.equal(newerVersion(item, 'zoo-2023'), 'zoo-2025');
  assert.equal(newerVersion(item, 'zoo-2024'), 'zoo-2025');
  assert.equal(newerVersion(item, 'zoo-2025'), null);
  assert.equal(newerVersion(item, 'zoo-undated'), null, 'no date, nothing to compare');
  assert.equal(newerVersion(item, 'elsewhere'), null);
  assert.equal(newerVersion(null, 'zoo-2023'), null);
  assert.equal(newerVersion({ id: 'x' }, 'x'), null);
});

test('updateAvailable: only for an installed version with a newer upload', () => {
  assert.equal(updateAvailable({ identifier: 'zoo-2023', install_dir: '/g/zoo' }, item), true);
  assert.equal(updateAvailable({ identifier: 'zoo-2023', install_dir: null }, item), false);
  assert.equal(updateAvailable({ identifier: 'zoo-2025', install_dir: '/g/zoo' }, item), false);
  assert.equal(updateAvailable({ identifier: 'zoo-2023', install_dir: '/g/zoo' }, null), false);
  assert.equal(updateAvailable(null, item), false);
});

test('withNewer: every version gets newer; the item is not changed in place', () => {
  const out = withNewer(item);
  assert.deepEqual(out.versions.map(v => v.newer), ['zoo-2025', null, 'zoo-2025', null]);
  assert.equal(item.versions[0].newer, undefined);
  const port = { id: 'quiver:c:o/r', versions: [] };
  assert.equal(withNewer(port), port);
  assert.equal(withNewer(null), null);
});
