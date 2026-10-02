# Catalog data

The data half of the launcher. Fetched at runtime from `main`; the launcher bundles a copy as a
fallback. Every file changes by pull request.

| file | what | entries |
| --- | --- | --- |
| `uploaders.json` | curated archive.org uploaders: handle, email (what `uploader:` matches), aliases, `track`, notes | 14 |
| `favorite-artists.json` | curated SteamGridDB artists in priority order (`steam64`, `name`); the only sources `scripts/box-art` pins covers from | 43 |
| `featured.json` | the Home page's hand-picked games and ports, in display order: `{ picks: [{ identifier \| repository, blurb?, banner? }] }` (see Home banners below) | per pick |
| `banners.json` | one SteamGridDB hero per featured pick, keyed by archive.org identifier or lowercase `owner/repo`: `{ url, source: "pinned" \| "auto", hero?, artist?, steam64?, favorite?, sgdb? }`. Written by `scripts/box-art/banners.py` in CI; pinned entries are never overwritten | per pick |
| `art.json` | every SteamGridDB portrait grid (600x900) and hero (1920x620) found per pstriple item, keyed by archive.org identifier: grid id, CDN URL, artist, style, votes, curated. Written by `scripts/box-art` in CI; picks and lookups read it instead of the API | per item |

Rules: uploader emails are what archive.org's `uploader:` field matches; handles are labels.

## Home banners

Every banner on the Home carousel is a SteamGridDB **hero** (the wide 1920x620 art), for uploads
and ports alike. Heroes are 3.1:1; recommend 3840x1240, minimum 1920x620. The launcher only shows
CDN images (`https://cdn2.steamgriddb.com/hero/<hash>.png|jpg|webp`), never a port's square icon
or a portrait cover; a pick with no hero yet shows a plain colour banner with its title.

Where a pick's banner comes from, first match wins:

1. `banner` on the pick in `featured.json` (pinned by hand).
2. Its entry in `banners.json`, `"source": "pinned"` (by hand) or `"source": "auto"` (picked by
   the workflow).

To pin one, set `banner` on the pick, or add `"<key>": { "url": "…", "source": "pinned" }` to
`banners.json`. Either may be a CDN URL or a hero page link (`https://www.steamgriddb.com/hero/<id>`).
The launcher ignores page links; the **Box art report** workflow resolves them to CDN URLs in
`banners.json`.

The workflow (`.github/workflows/box-art.yml`, manual only: Actions > Box art report > Run
workflow; tick "Only refresh the Home banners" to skip the pstriple covers) runs
`scripts/box-art/banners.py` with the repo's `STEAMGRIDDB_API_KEY` secret. For each pick without a
pin it matches the game on SteamGridDB the way the pstriple covers are matched (the game in
`art.json`, else an alias or the cleaned title through the search), lists its static heroes, and
takes the first by an artist in `favorite-artists.json`, in that file's priority order
(`"favorite": true`); with none, the top-voted hero (`"favorite": false`); with no hero at all the
entry is dropped. Run from main it opens a PR with previews of each pick; run from a branch it
commits `banners.json` (and `art.json`) back to that branch. Review the picks in the diff; to
override one, pin it.

Kept in this repo for now; may move to its own repo without changing the launcher.

The collision files (`catalog.json`, `ia-matches.json`, `collisions.json`) are parked on the
`parked/collisions` branch.
