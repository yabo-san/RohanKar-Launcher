'use strict';
/**
 * What a link pasted into the Add box points at (docs/AGENT-BRIEF.md, "The
 * user loop"): an archive.org account or single upload, or a GitHub or
 * GitLab repo. Pure; the server looks up a single upload's uploader.
 *
 *   { kind: 'account', uploader }                  an @handle, email or profile link
 *   { kind: 'upload', identifier }                 one archive.org upload
 *   { kind: 'repo', repository, repositorySource } 'github' or 'gitlab'
 *   { error }                                      anything else
 */

const { normalizeUploader } = require('./sources');

const SEG = /^[\w.-]+$/;
const FORGE = /^(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com)\/([^?#]*)/i;
// Path segments after the repo that are pages inside it, not more of its name
const GITLAB_STOP = new Set(['-', 'tree', 'blob', 'releases', 'tags', 'issues', 'merge_requests', 'wikis']);

function repoFrom(host, path) {
  const parts = path.split('/').filter(Boolean);
  if (/github/i.test(host)) {
    const [owner, name] = parts;
    if (!owner || !name) return null;
    const repo = name.replace(/\.git$/i, '');
    return SEG.test(owner) && SEG.test(repo) ? { repository: `${owner}/${repo}`, repositorySource: 'github' } : null;
  }
  // GitLab: group/subgroup/.../project, up to the first page segment
  const stop = parts.findIndex(p => GITLAB_STOP.has(p));
  const own = (stop === -1 ? parts : parts.slice(0, stop));
  if (own.length) own[own.length - 1] = own[own.length - 1].replace(/\.git$/i, '');
  if (own.length < 2 || !own.every(p => SEG.test(p))) return null;
  return { repository: own.join('/'), repositorySource: 'gitlab' };
}

function classifyLink(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return { error: 'Paste a link first.' };

  const forge = FORGE.exec(s);
  if (forge) {
    const repo = repoFrom(forge[1], forge[2]);
    return repo ? { kind: 'repo', ...repo } : { error: `${s} isn't a link to a repo. Paste the repo's main page.` };
  }
  // owner/repo on its own means GitHub
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (bare) return { kind: 'repo', repository: `${bare[1]}/${bare[2].replace(/\.git$/i, '')}`, repositorySource: 'github' };

  // archive.org: a bare word could be a handle or an identifier, so it needs
  // an @, an email or a link to say which
  if (!/archive\.org/i.test(s) && !s.includes('@')) {
    return { error: `Paste a link: an archive.org upload or account, or a GitHub or GitLab repo.` };
  }
  const n = normalizeUploader(s);
  if (n.error) return { error: n.error };
  if (n.kind === 'item') return { kind: 'upload', identifier: n.value };
  return { kind: 'account', uploader: n.kind === 'handle' ? `@${n.value}` : n.value };
}

module.exports = { classifyLink };
