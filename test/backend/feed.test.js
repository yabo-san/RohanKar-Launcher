'use strict';
// Feed files: ports (collisions) and trusted archive.org uploaders
const { test } = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../../src/backend/feed');

test('parseUploaders: ours, uploaders.json shape, bare strings; bad and repeated ones dropped', () => {
  assert.deepEqual(feed.parseUploaders([
    { uploader: ' a@x.com ', label: 'A' },
    { uploaderEmail: 'b@x.com', handle: 'bee' },
    'c@x.com',
    { uploader: 'A@X.COM' },
    { uploader: 'has space' },
    { uploader: 'x'.repeat(201) },
    { uploaderEmail: null, handle: 'creator-query-only' },
    null, 7,
  ]), [
    { uploader: 'a@x.com', label: 'A' },
    { uploader: 'b@x.com', label: 'bee' },
    { uploader: 'c@x.com', label: 'c' },
  ]);
  assert.deepEqual(feed.parseUploaders(undefined), []);
});

test('parseFeed: every collisions shape, with or without uploaders', () => {
  const c = { repository: 'o/r', sources: [] };
  assert.deepEqual(feed.parseFeed(JSON.stringify([c])), { collisions: [c], uploaders: [] });
  assert.deepEqual(feed.parseFeed(JSON.stringify({ collisions: [c], uploaders: ['u@x.com'] })).uploaders, [{ uploader: 'u@x.com', label: 'u' }]);
  const keyed = feed.parseFeed(JSON.stringify({ schemaVersion: 1, _comment: 'x', 'o/r': { sources: [] }, uploaders: [] }));
  assert.deepEqual(keyed.collisions, [{ repository: 'o/r', sources: [] }]);
  assert.deepEqual(feed.parseFeed('null'), { collisions: [], uploaders: [] });
  assert.throws(() => feed.parseFeed('nope'));
});

test('exportFeed: your collisions and the uploaders you have on', () => {
  const out = feed.exportFeed({
    collisions: [{ repository: 'o/r' }],
    sources: [{ uploader: 'a@x.com', label: 'A' }, { uploader: 'off@x.com', enabled: false }, { uploader: 'n@x.com' }],
  });
  assert.deepEqual(out, { schemaVersion: 1, collisions: [{ repository: 'o/r' }], uploaders: [{ uploader: 'a@x.com', label: 'A' }, { uploader: 'n@x.com', label: 'n' }] });
});

test('trustUploaders: adds new ones on, turns an off one back on, leaves the rest', () => {
  const sources = [{ uploader: 'a@x.com', label: 'A', enabled: true }, { uploader: 'off@x.com', label: 'Off', enabled: false }];
  const r = feed.trustUploaders(sources, [{ uploader: 'A@x.com', label: 'a' }, { uploader: 'OFF@x.com', label: 'o' }, { uploader: 'new@x.com', label: 'New' }]);
  assert.deepEqual(r.added, ['new@x.com']);
  assert.deepEqual(r.enabled, ['off@x.com']);
  assert.deepEqual(r.sources.map(s => [s.uploader, s.label, s.enabled]), [['a@x.com', 'A', true], ['off@x.com', 'Off', true], ['new@x.com', 'New', true]]);
  assert.equal(sources[1].enabled, false, 'the input is not changed');
});

test('importFeed: saves valid collisions, reports the rest, merges uploaders', () => {
  const saved = [];
  const saveCollision = (c) => (c.repository === 'o/refused' ? { ok: false, errors: ['no'] } : (saved.push(c), { ok: true, entry: c }));
  const text = JSON.stringify({
    collisions: [{ repository: 'o/r', sources: [{ ia: 'item', path: 'a.bin' }] }, { repository: 'o/bad', sources: 'x' }, { repository: 'o/refused', sources: [] }, 'junk'],
    uploaders: ['u@x.com'],
  });
  const r = feed.importFeed(text, { saveCollision, sources: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.collisions, ['o/r']);
  assert.deepEqual(r.rejected.map(x => x.repository), ['o/bad', 'o/refused', null]);
  assert.deepEqual(r.uploaders, ['u@x.com']);
  assert.deepEqual(r.sources, [{ uploader: 'u@x.com', label: 'u', enabled: true }]);
  assert.match(feed.importFeed('{', { saveCollision, sources: [] }).error, /^Not a feed file/);
  assert.equal(feed.importFeed('{}', { saveCollision, sources: [] }).error, 'The file has no collisions or uploaders');
});
