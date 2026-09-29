# Catalog data

The data half of the launcher. Fetched at runtime from `main`; the launcher bundles a copy as a
fallback. Every file changes by pull request.

| file | what | entries |
| --- | --- | --- |
| `catalog.json` | ports with `repository`, `iaIdentifier`, `contentUrl`, `dataFiles[{name,targetSubpath,sha1,optional}]` | 518 |
| `ia-matches.json` | owner-confirmed `identifier::path` pairs, keyed by entry name | 21 |
| `collisions.json` | fully resolved port plus data with checksums | 12 |
| `uploaders.json` | curated archive.org uploaders: handle, email (what `uploader:` matches), aliases, `track`, notes | 14 |
| `favorite-artists.json` | curated SteamGridDB artists in priority order (`steam64`, `name`); the only sources `scripts/box-art` pins covers from | 43 |

Rules: `dataFiles[].sha1` is the hash of the file after extraction and staging, not of the archive.
Match ports and data on `repository`, never on title. A sha1 mismatch after staging is a failure,
not a warning. Uploader emails are what archive.org's `uploader:` field matches; handles are labels.

Kept in this repo for now; may move to its own repo without changing the launcher.
