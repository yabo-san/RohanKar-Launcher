# User-added sources

The launcher ships with a starting list: the archive.org uploaders in `catalog/uploaders.json`
and the built-in port shelf (`catalog/curated-ports.json`). Anyone can add their own on top, with
no switch to turn on and no warning to click through. What you add loads next to what ships and
looks the same.

## Where you add your own

| Source | Where it's added |
| --- | --- |
| `user.json` | Settings > Your sources > user.json (a file path) |
| Your own GitHub repos | Add a GitHub repo |
| Any other uploader | Settings > Uploaders |

## user.json

A local file (no URLs for now), named by its full path in Settings. Schema version 1, two arrays:

```json
{
  "schemaVersion": 1,
  "archive": [
    { "identifier": "my-homebrew", "title": "My Homebrew", "files": [{ "name": "my-homebrew.zip", "sha1": "0123…" }] },
    { "identifier": "my-demo" }
  ],
  "github": [
    { "repository": "me/tool", "name": "My Tool", "assetPattern": "(?i)windows", "sha1": "…" }
  ]
}
```

- `archive`: a standalone archive.org download. `title` is optional (archive.org's title
  otherwise); `files` lists sha1s for files you want checked.
- `github`: a standalone GitHub release binary: `repository`, and optionally `name`,
  `folderName`, `assetPattern` and the `sha1` of the release asset. A repository no catalog lists
  shows on Your ports.

An older file's `collisions` array is not read: each entry is listed as invalid ("collisions are
no longer supported"), since collisions are parked on the `parked/collisions` branch.

`sha1` is optional everywhere.

## Rules

1. **Built-in wins.** A user entry with the same repository or identifier as a built-in one is
   ignored and listed under the file in Settings as a conflict: a `github` entry for a repository a
   port shelf lists, and an `archive` entry for an item a built-in uploader has.
2. **sha1.** A file with a sha1 is checked, and a mismatch fails the install.
   A file without one has its sha1 recorded on first install (`pins.json` in the data folder). If
   a later install of the same file gets a different sha1, the install stops before anything is
   written and a modal asks:
   **File changed**: "… is not the file you installed before … Only continue if you trust the
   source." [Cancel] [Install anyway]. Install anyway re-pins the new sha1.
   archive.org files are pinned per item and file name; GitHub release assets per release tag and
   asset name, so a new release pins afresh and a replaced asset in the same release asks.
3. **Validation.** The file is validated whenever it is read. A file that can't be used at all
   (missing, not JSON, wrong `schemaVersion`, a section that isn't an array) shows its error; each
   invalid entry is listed with its section, index, key and every reason, and the valid entries
   still load. Nothing is skipped silently.

The logic is in `src/backend/user-sources.js` (read, validate, pins), `catalogs.js` (`github`
entries and Your ports), `items.js` (uploaders and `archive` entries) and `installs.js` (sha1 checks
and pins). The renderer only draws what `GET /v1/user-sources` and the items say.
