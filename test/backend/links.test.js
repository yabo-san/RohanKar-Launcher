'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLink } = require('../../src/backend/links');

test('classifyLink: GitHub repo links and owner/repo', () => {
  const gh = (repository) => ({ kind: 'repo', repository, repositorySource: 'github' });
  assert.deepEqual(classifyLink('https://github.com/murkantor/Project-Midas'), gh('murkantor/Project-Midas'));
  assert.deepEqual(classifyLink('github.com/murkantor/Project-Midas/releases/latest'), gh('murkantor/Project-Midas'));
  assert.deepEqual(classifyLink('https://www.github.com/a/b.git'), gh('a/b'));
  assert.deepEqual(classifyLink('perfect-dark-pc-port/perfect_dark'), gh('perfect-dark-pc-port/perfect_dark'));
  assert.ok(classifyLink('https://github.com/murkantor').error);
});

test('classifyLink: GitLab projects, subgroups included, up to the first page', () => {
  const gl = (repository) => ({ kind: 'repo', repository, repositorySource: 'gitlab' });
  assert.deepEqual(classifyLink('https://gitlab.com/sonicdcer/Starfox64Recomp'), gl('sonicdcer/Starfox64Recomp'));
  assert.deepEqual(classifyLink('https://gitlab.com/sonicdcer/Starfox64Recomp/-/releases'), gl('sonicdcer/Starfox64Recomp'));
  assert.deepEqual(classifyLink('gitlab.com/group/sub/project/-/tree/main?x=1'), gl('group/sub/project'));
  assert.ok(classifyLink('https://gitlab.com/sonicdcer').error);
});

test('classifyLink: archive.org accounts and single uploads', () => {
  assert.deepEqual(classifyLink('https://archive.org/details/@pstriple'), { kind: 'account', uploader: '@pstriple' });
  assert.deepEqual(classifyLink('archive.org/details/@pstriple/uploads?sort=-date'), { kind: 'account', uploader: '@pstriple' });
  assert.deepEqual(classifyLink('@r4ze'), { kind: 'account', uploader: '@r4ze' });
  assert.deepEqual(classifyLink('someone@example.com'), { kind: 'account', uploader: 'someone@example.com' });
  assert.deepEqual(classifyLink('https://archive.org/details/raze-package'), { kind: 'upload', identifier: 'raze-package' });
  assert.deepEqual(classifyLink('https://archive.org/download/raze-package/raze.zip'), { kind: 'upload', identifier: 'raze-package' });
});

test('classifyLink: anything else says what to paste', () => {
  for (const s of ['', '   ', 'raze-package', 'https://example.com/x/y/z', 'https://archive.org/search?query=doom']) {
    assert.ok(classifyLink(s).error, s);
  }
});
