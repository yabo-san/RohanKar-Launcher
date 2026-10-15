'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSources, parseExcludes, formatSources, preferredVersion, versionLabel } = require('../src/frontend/sources.js');
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

test('parseSources: @handles and profile URLs, labelled by the handle', () => {
  assert.deepEqual(parseSources('@pstriple\nhttps://archive.org/details/@eldritchpenumbra/uploads?x=1\nhttps://archive.org/details/one-upload/\nbare'), [
    { uploader: '@pstriple', label: 'pstriple', enabled: true },
    { uploader: 'https://archive.org/details/@eldritchpenumbra/uploads?x=1', label: 'eldritchpenumbra', enabled: true },
    { uploader: 'https://archive.org/details/one-upload/', label: 'one-upload', enabled: true },
    { uploader: 'bare', label: 'bare', enabled: true },
  ]);
});

test('parseSources: -exclude and +include fields, anywhere after the uploader, label kept', () => {
  assert.deepEqual(parseSources('@e, Eldritch, -DVD|PS3, +Windows| Linux\n# a@x.com, -discography, -leak\nb@x.com, +USA, One, Two'), [
    { uploader: '@e', label: 'Eldritch', enabled: true, titleExclude: 'DVD|PS3', titleInclude: 'Windows| Linux' },
    { uploader: 'a@x.com', label: 'a', enabled: false, titleExclude: 'discography|leak' },
    { uploader: 'b@x.com', label: 'One, Two', enabled: true, titleInclude: 'USA' },
  ]);
  assert.deepEqual(parseSources('a@x.com, -, +')[0], { uploader: 'a@x.com', label: 'a', enabled: true }, 'empty filters are none');
});

test('parseExcludes: "- upload" lines; parseSources skips them', () => {
  const text = 'a@x.com\n- https://archive.org/details/bad-upload\n-other-id\n# - off-id\n-';
  assert.deepEqual(parseExcludes(text), ['https://archive.org/details/bad-upload', 'other-id']);
  assert.deepEqual(parseSources(text), [{ uploader: 'a@x.com', label: 'a', enabled: true }]);
});

test('formatSources: filters and excludes round-trip', () => {
  const list = [
    { uploader: '@e', label: 'Eldritch', enabled: true, titleExclude: 'DVD|PS3', titleInclude: 'Windows' },
    { uploader: 'a@x.com', label: 'a', enabled: false, titleExclude: 'discography' },
  ];
  const text = formatSources(list, ['bad-upload', 'other']);
  assert.equal(text, '@e, Eldritch, -DVD|PS3, +Windows\n# a@x.com, a, -discography\n- bad-upload\n- other');
  assert.deepEqual(parseSources(text), list);
  assert.deepEqual(parseExcludes(text), ['bad-upload', 'other']);
  assert.equal(formatSources([{ uploader: 'a@x.com' }], null), 'a@x.com');
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
    { uploader: 'on@x.com', label: 'on', enabled: true, handles: ['on'] },
    { uploader: 'u@x.com', label: 'untracked', enabled: false, handles: ['untracked'] },
    { uploader: 'n@x.com', label: 'noflag', enabled: false, handles: ['noflag'] },
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
