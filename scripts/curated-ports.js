#!/usr/bin/env node
'use strict';
// Builds catalog/curated-ports.json: the default port shelf.
//
// Source of truth is a community-kept list of decomp and recomp projects made by people, not
// vibecoded. Its URL is not in this repo: set CURATED_PORTS_SOURCE_URL (a document export URL
// returning HTML), as an environment variable or a repo secret in CI. This script takes every
// repository linked in it,
// records which section of the doc it sits under, and adds the must-haves from
// catalog/curated-extras.json. Display metadata (name, folder, icon URL hosted in the port's
// own repo, release asset filter, tags) comes from catalog/curated-metadata.json, which we own;
// entries without it get a minimal entry built from the list. A metadata entry may set only some
// fields (say, just releaseAssetFilter), and its "section" replaces the section the list files the
// repository under, e.g. "source only" for a port the list calls a port but that publishes no
// release.
//
//   node scripts/curated-ports.js            fetch the list, write the file
//   node scripts/curated-ports.js --check    exit 1 if the file on disk is out of date
//
// To add a pick or swap a source-only entry for a repo that ships builds, edit
// catalog/curated-extras.json: name, repository, repositorySource ("gitlab" if not GitHub),
// section ("recomp port", "decomp port", "work in progress"), and optionally "replaces"
// with the doc entry's repository.

const fs = require('fs');
const path = require('path');

const DOC_URL = process.env.CURATED_PORTS_SOURCE_URL;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'catalog', 'curated-ports.json');
const EXTRAS = path.join(ROOT, 'catalog', 'curated-extras.json');
const METADATA = path.join(ROOT, 'catalog', 'curated-metadata.json');

// Section headings in the doc, in the order they appear. "source-only" sections list
// decompilations that publish source but no playable build.
const SECTIONS = [
  { heading: 'RECOMPILATIONS - WORK IN PROGRESS', tag: 'work in progress' },
  { heading: 'DECOMP PORTS', tag: 'decomp port' },
  { heading: 'RECOMP PORTS', tag: 'recomp port' },
  { heading: 'DECOMPILATIONS', tag: 'source only' },
];

const repoKey = (source, repo) => `${source}:${repo.toLowerCase().replace(/\/+$/, '')}`;
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();

function parseRepoUrl(url) {
  let m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/#?]+\/[^/#?]+)/i);
  if (m) return { source: 'github', repository: m[1].replace(/\.git$/, '') };
  m = url.match(/^https?:\/\/(?:www\.)?gitlab\.com\/(.+?)(?:\/-\/|[#?]|$)/i);
  if (m) return { source: 'gitlab', repository: m[1].replace(/\/+$/, '') };
  return null;
}

// Walks the exported HTML in order: a heading sets the current section, a link inherits it.
function parseDoc(html) {
  const events = [];
  for (const s of SECTIONS) {
    let at = html.indexOf(s.heading);
    while (at !== -1) { events.push({ at, section: s.tag }); at = html.indexOf(s.heading, at + 1); }
  }
  // "DECOMP PORTS" contains no other heading, but "DECOMPILATIONS" is a prefix-free match only
  // when not part of "RECOMPILATIONS"; drop matches that sit inside a longer heading.
  // Exported documents often wrap links in a redirect (...?q=<real url>&...); unwrap it.
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const unwrap = (href) => { const q = href.replace(/&amp;/g, '&').match(/[?&]q=([^&]+)/); return q ? decodeURIComponent(q[1]) : href; };
  let m;
  while ((m = linkRe.exec(html))) events.push({ at: m.index, url: unwrap(m[1]), text: stripTags(m[2]) });
  events.sort((a, b) => a.at - b.at || (a.section ? -1 : 1));

  const out = new Map();
  let section = null;
  for (const e of events) {
    if (e.section) {
      const inside = html.slice(Math.max(0, e.at - 2), e.at) === 'RE'; // the "DECOMPILATIONS" inside "RECOMPILATIONS"
      if (!inside) section = e.section;
      continue;
    }
    const r = parseRepoUrl(e.url);
    if (!r || !section) continue;
    const key = repoKey(r.source, r.repository);
    if (!out.has(key)) out.set(key, { ...r, docName: e.text, section });
  }
  return [...out.values()];
}

async function getText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// The catalog from the list's repositories (parseDoc), the extras and the metadata (by repository)
function build(docRepos, extras, metadata) {
  const known = new Map();
  for (const [repository, m] of Object.entries(metadata || {})) {
    known.set(repoKey(m.repositorySource === 'gitlab' ? 'gitlab' : 'github', repository), { ...m, repository });
  }

  // An extra can replace a doc entry, e.g. a fork that ships builds for a source-only decomp:
  //   { "repository": "someone/sm64-builds", "replaces": "n64decomp/sm64", ... }
  const replaced = new Set(extras.filter((x) => x.replaces).map((x) => repoKey(x.replacesSource === 'gitlab' ? 'gitlab' : 'github', x.replaces)));
  const wanted = [
    ...docRepos.filter((r) => !replaced.has(repoKey(r.source, r.repository))).map((r) => ({ ...r, from: 'doc' })),
    ...extras.map((x) => ({ source: x.repositorySource === 'gitlab' ? 'gitlab' : 'github', repository: x.repository, docName: x.name, section: x.section || 'pick', from: 'extras', extra: x })),
  ];

  const apps = [];
  const seen = new Set();
  for (const w of wanted) {
    const key = repoKey(w.source, w.repository);
    if (seen.has(key)) continue;
    seen.add(key);
    const q = known.get(key);
    const x = w.extra || {};
    const { section = w.section, ...meta } = q || {};
    const name = w.docName || w.repository.split('/').pop();
    // Full metadata as it is; metadata that sets only some fields (no name) on top of the minimal entry
    const base = q?.name ? meta : {
      name,
      repository: w.repository,
      folderName: x.folderName || name.replace(/[^A-Za-z0-9]+/g, ''),
      ...(x.releaseAssetFilter ? { releaseAssetFilter: x.releaseAssetFilter } : {}),
      ...(x.appIconUrl ? { appIconUrl: x.appIconUrl } : {}),
      tags: [],
      ...meta,
    };
    if (x.note) base.description = x.note;
    if (w.source === 'gitlab') base.repositorySource = 'gitlab';
    base.tags = [...new Set([...(base.tags || []), section, w.from === 'doc' ? 'curated' : 'owner pick'])];
    delete base.mods;
    apps.push(base);
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  const withMeta = apps.filter((a) => known.has(repoKey(a.repositorySource === 'gitlab' ? 'gitlab' : 'github', a.repository))).length;
  return { apps, withMeta };
}

async function main() {
  const check = process.argv.includes('--check');
  if (!DOC_URL) throw new Error('CURATED_PORTS_SOURCE_URL is not set');
  const docRepos = parseDoc(await getText(DOC_URL));
  if (docRepos.length < 10) throw new Error(`only ${docRepos.length} repositories found in the source list; its layout probably changed`);
  const extras = JSON.parse(fs.readFileSync(EXTRAS, 'utf8')).apps || [];
  const { apps, withMeta } = build(docRepos, extras, JSON.parse(fs.readFileSync(METADATA, 'utf8')).ports);

  const catalog = {
    name: 'y4bo curated ports',
    description: 'Decomp and recomp projects made by people, from a community-kept list, plus owner picks. Generated by scripts/curated-ports.js; do not edit by hand.',
    version: 1,
    apps,
  };
  const text = JSON.stringify(catalog, null, 2) + '\n';
  const summary = `${apps.length} ports (${docRepos.length} from the list, ${extras.length} extras; ${withMeta} with metadata)`;

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== text) { console.error(`catalog/curated-ports.json is out of date: ${summary}`); process.exit(1); }
    console.log(`up to date: ${summary}`);
    return;
  }
  fs.writeFileSync(OUT, text);
  console.log(`wrote catalog/curated-ports.json: ${summary}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { build, parseDoc };
