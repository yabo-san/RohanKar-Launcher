'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSources, formatSources, preferredVersion, versionLabel } = require('../src/frontend/sources.js');
const { sourcesFromCatalog, titleKey } = require('../src/backend/sources.js');

test('parseSources: uploader with label', () => {
  assert.deepEqual(parseSources('a@x.com, Alpha'), [
    { uploader: 'a@x.com', label: 'Alpha', enabled: true },
  ]);
});

test('parseSources: label defaults to the part before @', () => {
  assert.deepEqual(parseSources('someone@example.com'), [
    { uploader: 'someone@example.com', label: 'someone', enabled: true },
  ]);
});

test('parseSources: leading # disables, with or without a space', () => {
  assert.deepEqual(parseSources('# a@x.com, A\n#b@y.com'), [
    { uploader: 'a@x.com', label: 'A', enabled: false },
    { uploader: 'b@y.com', label: 'b', enabled: false },
  ]);
});

test('parseSources: commas after the first stay in the label', () => {
  assert.equal(parseSources('a@x.com, One, Two')[0].label, 'One, Two');
});

test('parseSources: trims whitespace, skips blank lines, handles CRLF', () => {
  assert.deepEqual(parseSources('  a@x.com ,  A  \r\n\r\n   \nb@y.com'), [
    { uploader: 'a@x.com', label: 'A', enabled: true },
    { uploader: 'b@y.com', label: 'b', enabled: true },
  ]);
});

test('parseSources: drops lines with no uploader', () => {
  assert.deepEqual(parseSources(', Label only\n#\n# , x'), []);
});

test('parseSources: empty or missing input', () => {
  assert.deepEqual(parseSources(''), []);
  assert.deepEqual(parseSources(undefined), []);
  assert.deepEqual(parseSources(null), []);
});

test('formatSources: one line per source, # for disabled', () => {
  assert.equal(
    formatSources([
      { uploader: 'a@x.com', label: 'A', enabled: true },
      { uploader: 'b@y.com', label: 'B', enabled: false },
    ]),
    'a@x.com, A\n# b@y.com, B',
  );
});

test('formatSources: missing label and missing enabled', () => {
  assert.equal(formatSources([{ uploader: 'a@x.com' }]), 'a@x.com');
  assert.equal(formatSources([]), '');
});

test('formatSources and parseSources round-trip', () => {
  const list = [
    { uploader: 'a@x.com', label: 'Alpha', enabled: true },
    { uploader: 'b@y.com', label: 'b', enabled: false },
    { uploader: 'c@z.com', label: 'One, Two', enabled: true },
  ];
  assert.deepEqual(parseSources(formatSources(list)), list);
});

test('titleKey: ignores case, punctuation, leading "the" and bracketed tags', () => {
  const key = titleKey({ title: 'The Last Remnant' });
  assert.equal(key, 'lastremnant');
  assert.equal(titleKey({ title: 'last-remnant' }), key);
  assert.equal(titleKey({ title: 'Last Remnant (v1.0.3) [Repack]' }), key);
  assert.equal(titleKey({ title: 'THE LAST REMNANT!' }), key);
});

test('titleKey: "the" is only stripped as a leading word', () => {
  assert.equal(titleKey({ title: 'Theme Hospital' }), 'themehospital');
  assert.equal(titleKey({ title: 'Escape the Room' }), 'escapetheroom');
});

test('titleKey: uses the first title and falls back to the identifier', () => {
  assert.equal(titleKey({ title: ['Doom', 'Other'] }), 'doom');
  assert.equal(titleKey({ identifier: 'quake-ii' }), 'quakeii');
  assert.equal(titleKey({ title: '   ', identifier: 'half-life' }), 'halflife');
});

test('titleKey: empty when nothing alphanumeric remains', () => {
  assert.equal(titleKey({ title: '(Repack)' }), '');
});

test('preferredVersion: installed version wins', () => {
  const a = { identifier: 'a' };
  const b = { identifier: 'b' };
  a._versions = b._versions = [a, b];
  assert.equal(preferredVersion(a, { b: { install_dir: 'C:\\games\\b' } }), b);
});

test('preferredVersion: falls back to the entry itself', () => {
  const a = { identifier: 'a' };
  const b = { identifier: 'b' };
  a._versions = b._versions = [a, b];
  assert.equal(preferredVersion(a, {}), a);
  assert.equal(preferredVersion(b, { a: { install_dir: null } }), b);
});

test('preferredVersion: first installed version in group order', () => {
  const a = { identifier: 'a' };
  const b = { identifier: 'b' };
  const c = { identifier: 'c' };
  a._versions = [a, b, c];
  assert.equal(preferredVersion(a, { b: { install_dir: 'x' }, c: { install_dir: 'y' } }), b);
});

test('preferredVersion: ungrouped game', () => {
  const g = { identifier: 'solo' };
  assert.equal(preferredVersion(g, {}), g);
  assert.equal(preferredVersion(g, { solo: { install_dir: 'x' } }), g);
});

test('versionLabel: source label and UTC added date', () => {
  assert.equal(
    versionLabel({ _sourceLabel: 'Alpha', addeddate: '2025-03-04T23:30:00Z' }),
    'Alpha — 2025-03-04',
  );
});

test('versionLabel: either part alone, or neither', () => {
  assert.equal(versionLabel({ _sourceLabel: 'Alpha' }), 'Alpha');
  assert.equal(versionLabel({ addeddate: '2025-03-04T00:00:00Z' }), '2025-03-04');
  assert.equal(versionLabel({}), '');
});

test('sourcesFromCatalog: on only with launcher, tracked, and an email', () => {
  assert.deepEqual(sourcesFromCatalog({ uploaders: [
    { handle: 'on', uploaderEmail: 'on@x.com', launcher: true },
    { handle: 'untracked', uploaderEmail: 'u@x.com', launcher: true, track: false },
    { handle: 'noflag', uploaderEmail: 'n@x.com' },
    { handle: 'noemail', launcher: true },
    { uploaderEmail: 'nohandle@x.com' },
    { note: 'neither' },
  ] }), [
    { uploader: 'on@x.com', label: 'on', enabled: true },
    { uploader: 'u@x.com', label: 'untracked', enabled: false },
    { uploader: 'n@x.com', label: 'noflag', enabled: false },
    { uploader: 'noemail', label: 'noemail', enabled: false },
    { uploader: 'nohandle@x.com', label: 'nohandle', enabled: false },
  ]);
});

test('sourcesFromCatalog: missing or malformed catalog', () => {
  assert.deepEqual(sourcesFromCatalog(undefined), []);
  assert.deepEqual(sourcesFromCatalog({}), []);
  assert.deepEqual(sourcesFromCatalog({ uploaders: 'x' }), []);
  assert.deepEqual(sourcesFromCatalog({ uploaders: [null] }), []);
});

test('sourcesFromCatalog: the bundled catalog turns on exactly the three launcher uploaders', () => {
  const on = sourcesFromCatalog(require('../catalog/uploaders.json')).filter(s => s.enabled);
  assert.deepEqual(on.map(s => s.label).sort(), ['hailstormttv', 'r4zel1ght', 'rohanjackson071']);
});
