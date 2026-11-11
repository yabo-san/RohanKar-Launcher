'use strict';
/**
 * Your config: what a user added, as one block of text they can copy to
 * another machine or hand to a friend, and paste back in.
 *
 *   { "y4bo": 1,
 *     "packs":  [{ "uploader": "@handle or an archive.org link", "label": "..." }],
 *     "repos":  [{ "repository": "owner/repo", "repositorySource": "gitlab"?, "assetPattern": "..."? }],
 *     "hidden": ["archive.org identifier", ...] }
 *
 * Pasting merges: nothing already there is removed or changed.
 */
const { itemIdFrom } = require('./sources');

const VERSION = 1;
const REPO_KEYS = ['repository', 'repositorySource', 'name', 'folderName', 'releaseAssetFilter', 'assetPattern'];
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// The config of what's set up now: the enabled packs, the repos added in the app, the hidden uploads
function buildConfig({ sources = [], repos = [], hidden = [] }) {
  return {
    y4bo: VERSION,
    packs: sources.filter(s => s && s.uploader && s.enabled !== false)
      .map(s => ({ uploader: s.uploader, ...(s.label ? { label: s.label } : {}) })),
    repos: repos.filter(r => r && r.repository)
      .map(r => Object.fromEntries(REPO_KEYS.filter(k => r[k] != null).map(k => [k, r[k]]))),
    hidden: [...new Set(hidden.filter(x => typeof x === 'string' && x))],
  };
}

// Pasted text (or an object) as a config. { ok, config } or { ok: false, error }
function readConfig(input) {
  let c = input;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { return { ok: false, error: "That isn't a y4bo config: it isn't JSON." }; }
  }
  if (!c || typeof c !== 'object' || Array.isArray(c) || c.y4bo === undefined) return { ok: false, error: "That isn't a y4bo config." };
  if (c.y4bo !== VERSION) return { ok: false, error: `This config is version ${c.y4bo}; this app reads version ${VERSION}.` };
  const list = (k) => (c[k] === undefined ? [] : Array.isArray(c[k]) ? c[k] : null);
  const packs = list('packs'), repos = list('repos'), hidden = list('hidden');
  if (!packs || !repos || !hidden) return { ok: false, error: 'packs, repos and hidden must be lists.' };
  const badPack = packs.find(p => !p || typeof p.uploader !== 'string' || !p.uploader.trim());
  if (badPack !== undefined) return { ok: false, error: 'Every pack needs an uploader.' };
  const badRepo = repos.find(r => !r || typeof r.repository !== 'string' || !r.repository.trim());
  if (badRepo !== undefined) return { ok: false, error: 'Every repo needs a repository (owner/repo).' };
  const badHidden = hidden.find(x => !itemIdFrom(x));
  if (badHidden !== undefined) return { ok: false, error: `Not an archive.org upload: ${String(badHidden)}` };
  return {
    ok: true,
    config: {
      y4bo: VERSION,
      packs: packs.map(p => ({ uploader: p.uploader.trim(), ...(typeof p.label === 'string' && p.label.trim() ? { label: p.label.trim() } : {}) })),
      repos: repos.map(r => Object.fromEntries(REPO_KEYS.filter(k => r[k] != null).map(k => [k, typeof r[k] === 'string' ? r[k].trim() : r[k]]))),
      hidden: hidden.map(itemIdFrom),
    },
  };
}

// The settings and repos after pasting config into what's there now. Packs
// already present (enabled or not) are switched on; repos already added are
// left as they are. { sources, excludeItems, repos: [new ones], added: { packs, repos, hidden } }
function mergeConfig({ sources = [], repos = [], hidden = [] }, config) {
  const nextSources = sources.slice();
  let packs = 0;
  for (const p of config.packs) {
    const i = nextSources.findIndex(s => same(s.uploader, p.uploader));
    if (i === -1) { nextSources.push({ uploader: p.uploader, label: p.label || null, enabled: true }); packs++; }
    else if (nextSources[i].enabled === false) { nextSources[i] = { ...nextSources[i], enabled: true }; packs++; }
  }
  const newRepos = config.repos.filter((r, i, all) => !repos.some(x => same(x.repository, r.repository))
    && all.findIndex(y => same(y.repository, r.repository)) === i);
  const excludeItems = [...new Set([...hidden, ...config.hidden])];
  return {
    sources: nextSources, excludeItems, repos: newRepos,
    added: { packs, repos: newRepos.length, hidden: excludeItems.length - new Set(hidden).size },
  };
}

module.exports = { buildConfig, readConfig, mergeConfig, VERSION };
