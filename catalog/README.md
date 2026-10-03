# Catalog data

The data half of the launcher. Fetched at runtime from `main`; the launcher bundles a copy as a
fallback. Every file changes by pull request.

| file | what | entries |
| --- | --- | --- |
| `uploaders.json` | curated archive.org uploaders: handle, email (what `uploader:` matches), aliases, `track`, notes | 14 |
| `favorite-artists.json` | curated SteamGridDB artists in priority order (`steam64`, `name`); the only sources `scripts/box-art` pins covers from | 43 |
| `curated-ports.json` | the port shelf, edited by hand (see Port shelf below) | 46 |
| `featured.json` | the Home page's hand-picked games and ports, in display order: `{ picks: [{ identifier \| repository, blurb?, banner? }] }` (see Home banners below) | per pick |
| `art.json` | every SteamGridDB portrait grid (600x900) and hero (1920x620) found per pstriple item, keyed by archive.org identifier: grid id, CDN URL, artist, style, votes, curated. Also each featured pick's Home banner, keyed by archive.org identifier or lowercase `owner/repo`: `banner: { url, source: "pinned" \| "auto", hero?, artist?, steam64?, favorite?, sgdb? }`. Written by `scripts/box-art` in CI; picks and lookups read it instead of the API; pinned banners are never overwritten | per item |

Rules: uploader emails are what archive.org's `uploader:` field matches; handles are labels.

## Port shelf

`curated-ports.json` is the port shelf: GitHub and GitLab projects whose release binary the
launcher installs. It is written by hand; nothing generates it. To add a port, copy an entry,
edit it and open a PR. `npm test` (`test/curated-ports.test.js`) checks every entry. The file
keeps Quiver's catalog shape (`{ name, description, version, apps: [...] }`) because installed
copies of the launcher fetch it from `main`.

```json
{
  "name": "Quake (ironwail)",
  "repository": "andrei-drexler/ironwail",
  "folderName": "ironwail",
  "releaseAssetFilter": "win64",
  "description": "Quake engine. Needs the Quake data (id1/pak0.pak, pak1.pak) from the user.",
  "tags": ["engine", "quake"]
}
```

| field | | what |
| --- | --- | --- |
| `name` | required | the tile's title |
| `repository` | required | `owner/repo` (GitLab: the project path, may have subgroups) |
| `folderName` | required | the install folder's name; letters, digits, `.`, `_`, `-`; unique |
| `tags` | required | exactly one section tag, plus any free tags (platform, series: `n64`, `nintendo`, `zelda`) |
| `repositorySource` | GitLab only | `"gitlab"`; leave out for GitHub |
| `releaseAssetFilter` | when needed | text the release file's name must contain, when a release has several Windows files (`win64`, `DoomLauncher_`) |
| `appIconUrl` | optional | an https image for the tile when there is no cover |
| `description` | optional | shown on the tile's page; for engines and launchers, say what the user brings |
| `filesToAdd` | optional | empty files created in the install folder, e.g. `portable.txt` |
| `more` | optional | `true`: shown only with Settings > More ports on (or once installed). Older launchers ignore it and show the entry |

Section tags decide how a tile behaves:

| tag | the tile |
| --- | --- |
| `recomp port`, `decomp port` | installs the latest release |
| `work in progress` | installs, with a "work in progress" badge |
| `engine`, `launcher` | installs, and shows its description (what the user brings) |
| `source only` | no Install button; links to the repository. The Live ports check skips it |

**More ports.** Entries with `"more": true` are the rest of the community list the shelf started
from: today the 21 `source only` decompilations. They stay off the shelf unless the user turns on
Settings > More ports. To promote one, delete its `more` line.

Covers and banners come from `art.json` / `overrides.json` as for everything else. The Live ports
workflow checks every entry nightly, so a wrong `releaseAssetFilter` or a renamed repository
shows up in its summary.

## Home banners

Every banner on the Home carousel is a SteamGridDB **hero** (the wide 1920x620 art), for uploads
and ports alike. Heroes are 3.1:1; recommend 3840x1240, minimum 1920x620. The launcher only shows
CDN images (`https://cdn2.steamgriddb.com/hero/<hash>.png|jpg|webp`), never a port's square icon
or a portrait cover; a pick with no hero yet shows a plain colour banner with its title.

Where a pick's banner comes from, first match wins:

1. `banner` on the pick in `featured.json` (pinned by hand).
2. The `banner` on its entry in `art.json`, `"source": "pinned"` (by hand) or `"source": "auto"`
   (picked by the workflow).

To pin one, set `banner` on the pick, or set `"banner": { "url": "…", "source": "pinned" }` on the
pick's entry in `art.json` (add `"<key>": { "banner": … }` if it has none). Either may be a CDN
URL or a hero page link (`https://www.steamgriddb.com/hero/<id>`). The launcher ignores page links; the **Box art report** workflow resolves them to CDN URLs in
`art.json`.

The workflow (`.github/workflows/box-art.yml`, manual only: Actions > Box art report > Run
workflow; tick "Only refresh the Home banners" to skip the pstriple covers) runs
`scripts/box-art/banners.py` with the repo's `STEAMGRIDDB_API_KEY` secret. For each pick without a
pin it matches the game on SteamGridDB the way the pstriple covers are matched (the game in
`art.json`, else an alias or the cleaned title through the search), lists its static heroes, and
takes the first by an artist in `favorite-artists.json`, in that file's priority order
(`"favorite": true`); with none, the top-voted hero (`"favorite": false`); with no hero at all the
banner is dropped. It only touches `banner`; the covers in the same entry stay as they are, and
`pstriple-art.py` keeps every `banner` when it rewrites `art.json`. Run from main it opens a PR
with previews of each pick; run from a branch it commits `art.json` back to that branch. Review
the picks in the diff; to override one, pin it.

Kept in this repo for now; may move to its own repo without changing the launcher.

The collision files (`catalog.json`, `ia-matches.json`, `collisions.json`) are parked on the
`parked/collisions` branch.
