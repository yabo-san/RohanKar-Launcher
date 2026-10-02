# Catalog data

The data half of the launcher. Fetched at runtime from `main`; the launcher bundles a copy as a
fallback. Every file changes by pull request.

| file | what | entries |
| --- | --- | --- |
| `uploaders.json` | curated archive.org uploaders: handle, email (what `uploader:` matches), aliases, `track`, notes | 14 |
| `favorite-artists.json` | curated SteamGridDB artists in priority order (`steam64`, `name`); the only sources `scripts/box-art` pins covers from | 43 |
| `art.json` | every SteamGridDB portrait grid (600x900) and hero (1920x620) found per pstriple item, keyed by archive.org identifier: grid id, CDN URL, artist, style, votes, curated. Written by `scripts/box-art` in CI; picks and lookups read it instead of the API | per item |

Rules: uploader emails are what archive.org's `uploader:` field matches; handles are labels.

Kept in this repo for now; may move to its own repo without changing the launcher.

The collision files (`catalog.json`, `ia-matches.json`, `collisions.json`) are parked on the
`parked/collisions` branch.
