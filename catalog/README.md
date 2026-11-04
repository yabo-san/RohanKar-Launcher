# Catalog data

The data half of the launcher. Fetched at runtime from `main`; the launcher bundles a copy as a
fallback. Every file changes by pull request.

| file | what | entries |
| --- | --- | --- |
| `uploaders.json` | the built-in archive.org uploaders (Rohan, r4ze, pstriple): handle, email (what `uploader:` matches), aliases, `track`, notes | 3 |
| `favorite-artists.json` | curated SteamGridDB artists in priority order (`steam64`, `name`); the only sources `scripts/box-art` pins covers from | 43 |
| `curated-ports.json` | the port shelf: three personal picks, edited by hand (see Port shelf below) | 3 |
| `art.json` | every SteamGridDB portrait grid (600x900) and hero (1920x620) found per pstriple item, keyed by archive.org identifier: grid id, CDN URL, artist, style, votes, curated. Some entries also carry a `banner` (a hero URL), which the covers service serves as the item's hero. Written by `scripts/box-art` in CI; picks and lookups read it instead of the API; pinned banners are never overwritten | per item |

Rules: uploader emails are what archive.org's `uploader:` field matches; handles are labels.

## Port shelf

`curated-ports.json` is the port shelf. It holds a few personal picks (Project Midas, Perfect
Dark, Star Fox 64: Recompiled), not a list of recommended ports: given the state of AI game
porting, the launcher doesn't judge which ports are good. Users add any other GitHub or GitLab
repo themselves. It is written by hand; nothing generates it. To add a port, copy an entry,
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
| `more` | legacy | `true`: hidden unless an older launcher's Settings > More ports is on (or once installed). No entry uses it now |

Section tags decide how a tile behaves:

| tag | the tile |
| --- | --- |
| `recomp port`, `decomp port` | installs the latest release |
| `work in progress` | installs, with a "work in progress" badge |
| `engine`, `launcher` | installs, and shows its description (what the user brings) |
| `source only` | no Install button; links to the repository. The Live ports check skips it |

Covers and banners come from `art.json` / `overrides.json` as for everything else. The Live ports
workflow checks every entry nightly, so a wrong `releaseAssetFilter` or a renamed repository
shows up in its summary.

Kept in this repo for now; may move to its own repo without changing the launcher.

The collision files (`catalog.json`, `ia-matches.json`, `collisions.json`) are parked on the
`parked/collisions` branch.
