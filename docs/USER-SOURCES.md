# User-added sources

The launcher's default is the curated list only: the archive.org uploaders in
`catalog/uploaders.json` and the collisions in `catalog/collisions.json`, plus the Quiver community
catalogs as port shelves. Anything else is an **additional source**, and needs Settings >
**Allow additional sources**, which is off by default.

Turning it on shows a warning every time it goes from off to on:

> **Additional sources**
> Warning: we do not monitor additional sources. Make sure you trust the repo or uploader before
> you add it.
> [Cancel] [I understand]

Cancel (or Escape, or a click on the dimmed backdrop) leaves it off. Turning it off needs no
confirmation: everything from additional sources is hidden, and installed files stay on disk.

## What counts as an additional source

| Source | Where it's added |
| --- | --- |
| `user.json` | Settings > Allow additional sources > user.json (a file path) |
| Your own collisions | Game data… on a port, Add a GitHub repo, Import a feed file, the Quiver import's repos no catalog lists |
| Collision feeds | Settings > Feeds (subscribed by URL) |
| Uploaders not in `catalog/uploaders.json` | Settings > Uploaders, or Trust on a feed's uploader |

Every card from one of these carries a **Your source · not reviewed** badge: a wall game whose
every upload is from an additional source, a port on Your ports, and a curated port whose game
data an additional source supplies. Curated cards never carry it. A single upload from an
additional source inside a curated game's versions is badged in the detail panel's version list.

## user.json

A local file (no URLs for now), named by its full path in Settings. Schema version 1, three arrays,
each in the same shape as the curated catalog:

```json
{
  "schemaVersion": 1,
  "collisions": [
    { "repository": "me/my-port", "name": "My Port", "sources": [{ "ia": "my-port-data", "path": "data.zip", "extract": true }] }
  ],
  "archive": [
    { "identifier": "my-homebrew", "title": "My Homebrew", "files": [{ "name": "my-homebrew.zip", "sha1": "0123…" }] },
    { "identifier": "my-demo" }
  ],
  "github": [
    { "repository": "me/tool", "name": "My Tool", "assetPattern": "(?i)windows", "sha1": "…" }
  ]
}
```

- `collisions`: a GitHub repository plus the archive.org data it needs, exactly as in
  [COLLISIONS.md](COLLISIONS.md). A repository no catalog lists shows on Your ports.
- `archive`: a standalone archive.org download. `title` is optional (archive.org's title
  otherwise); `files` lists sha1s for files you want checked.
- `github`: a standalone GitHub release binary: `repository`, and optionally `name`,
  `folderName`, `assetPattern` and the `sha1` of the release asset.

`sha1` is optional everywhere.

## Rules

1. **Badge.** Every card from user.json (and every other additional source) shows
   "Your source · not reviewed". Curated cards never do.
2. **Curated wins.** A user entry with the same repository or identifier as a curated one is
   ignored and listed under the file in Settings as a conflict: a collision or `github` entry for a
   repository `catalog/collisions.json` has, a `github` entry for a repository a port shelf lists,
   and an `archive` entry for an item a curated uploader has. The collision editor won't save over a
   curated repository either (`409 curated`).
3. **sha1.** A file with a sha1 is checked like curated entries, and a mismatch fails the install.
   A file without one has its sha1 recorded on first install (`pins.json` in the data folder). If
   a later install of the same file gets a different sha1, the install stops before anything is
   written and a modal asks:
   **File changed**: "… is not the file you installed before … Only continue if you trust the
   source." [Cancel] [Install anyway]. Install anyway re-pins the new sha1.
   archive.org files are pinned per item and file name; GitHub release assets per release tag and
   asset name, so a new release pins afresh and a replaced asset in the same release asks.
4. **Validation.** The file is validated whenever it is read. A file that can't be used at all
   (missing, not JSON, wrong `schemaVersion`, a section that isn't an array) shows its error; each
   invalid entry is listed with its section, index, key and every reason, and the valid entries
   still load. Nothing is skipped silently.
5. **Off hides.** Turning Allow additional sources off hides every user entry; installed files and
   library rows stay.

The logic is in `src/backend/user-sources.js` (read, validate, pins), `catalogs.js` (collisions and
the curated-wins join), `items.js` (uploaders and `archive` entries) and `installs.js` (sha1 checks
and pins). The renderer only draws what `GET /v1/user-sources` and the items say.
