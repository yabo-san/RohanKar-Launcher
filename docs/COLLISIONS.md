# Collisions

A collision binds a port's GitHub release to the game data it needs on archive.org, and says how
the two go together in the install folder. It's a feed, like the art and title overrides: a JSON
file in Git that anyone can publish and anyone can subscribe to. GitHub hosts the binaries,
archive.org hosts the data, and the launcher puts them together. There's no server of our own.

## Where they come from

The launcher merges three layers per repository (lowercase `owner/repo`). A later layer replaces
an earlier one's entry for the same repository outright; entries aren't merged field by field.

1. `catalog/collisions.json`, bundled with the app (this repo's own).
2. Collision feeds the user subscribes to by URL (`POST /collision-feeds`), in subscription order.
   Entries that fail validation are dropped and listed under `rejected`.
3. The user's own, saved with `PUT /collisions/:repo` into `catalogs/collisions.local.json`.

A collision for a repository that no subscribed catalog lists defines a port of its own. Those show
on a **Your ports** shelf, which is how an arbitrary GitHub repository gets into the launcher.

## Feeds: what you curate

A feed file carries both halves of a curation: ports (collisions, as below) and the archive.org
uploaders its author trusts, as `uploaders: [{ "uploader": "someone@example.com", "label": "someone" }]`
(`catalog/uploaders.json`'s `uploaderEmail`/`handle` entries read too). Quiver's catalogs are only
read, as shelves; a feed is what users keep and share.

- **Your feed**: Settings > Feeds > Copy my feed (`GET /collisions/export`) gives your own
  collisions and every uploader you have on, ready to publish anywhere.
- **Import**: Settings > Feeds > Import a feed file (`POST /feed/import`) makes the file's
  collisions yours and adds its uploaders to your list, turned on. Importing again changes nothing.
- **Subscribe**: a subscribed feed's collisions apply right away (layer 2 above). Its uploaders are
  listed with a **Trust** button and stay out of the wall until you trust each one
  (`POST /sources/trust`), so a subscription never brings in a stranger's uploads by itself.

## The file

An array of entries, `{ "collisions": [...] }`, or an object keyed by repository. All three parse.

```json
{
  "schemaVersion": 1,
  "collisions": [
    {
      "repository": "owner/repo",
      "name": "Shown when no catalog lists the repo",
      "folderName": "Install folder name",
      "assetPattern": "(?i)x86_64-windows",
      "base": "data",
      "binaryTarget": "",
      "sources": [
        { "ia": "some-item", "path": "Full Game.zip", "extract": true }
      ]
    }
  ]
}
```

| field | meaning |
| --- | --- |
| `repository` | Required. The GitHub repository, `owner/repo`. The join key; titles never match. |
| `name`, `folderName` | The port's name and install folder when no catalog lists it. `folderName` also names the folder when one does. |
| `assetPattern` | Regex (`(?i)` prefix for case-insensitive) that picks the release asset. Wins over the catalog's `releaseAssetFilter`. |
| `base` | Which half lays down first: `"binary"` (default) or `"data"`. The other goes on top and wins on clashes. |
| `binaryTarget` | Folder, relative to the install folder, that the release unpacks into. Default: the install folder itself. |
| `sources` | archive.org data, in order. See below. |
| `iaIdentifier`, `contentUrl`, `dataFiles` | The first version of the schema, still read: download `contentUrl`, pick each `dataFiles[].name` out of it, place it in `targetSubpath`, check its `sha1`. A `dataFiles[].patch` (a `.bps` file) is applied first, so `sha1` is the patched file's: a URL, else a path found in the unpacked download, then the install folder (a release can ship its patch), then the same archive.org item. |

### Sources

Each source takes files straight from an archive.org item. No zip has to be downloaded just to get
one file out of it.

| field | meaning |
| --- | --- |
| `ia` | Required. The archive.org item identifier. |
| `path` | Required. A file (`roms/game.z64`), a folder (`roms/*`, every file under it, keeping the layout below it), or `*` for the whole item. archive.org's own bookkeeping files (`_meta.xml`, `_files.xml`, torrents, thumbnails, derivatives) never count. |
| `target` | Folder, relative to the install folder, the files land in. Default: the install folder. |
| `extract` | `true` unpacks a zip/7z/rar into `target` instead of copying the archive itself. Default `false`. |
| `sha1` | For a single file: the sha1 it must have. Without it, archive.org's own sha1 from the item's file list is checked. Folder sources are always checked against archive.org's. |
| `optional` | `true` skips the source when the item doesn't have it, instead of failing. |

Paths never climb out of the install folder: `..`, drive letters and leading slashes are refused.

## The two shapes

**Game rip plus port (today's case).** The archive.org item is the whole game; the GitHub release
unpacks over it. This is Quiver's "Locate Existing Install, then Update", done in one step.

```json
{
  "repository": "owner/port",
  "base": "data",
  "binaryTarget": "",
  "sources": [{ "ia": "game-rip", "path": "Game.zip", "extract": true }]
}
```

**Port plus a file or folder (the next case).** The release is the base; a ROM, or a folder of
data, goes beside it or into a subfolder.

```json
{
  "repository": "owner/port",
  "sources": [
    { "ia": "big-rom-set", "path": "Nintendo 64/Game (USA).z64", "target": "", "sha1": "…" },
    { "ia": "big-rom-set", "path": "Nintendo 64/Game textures/*", "target": "mods/textures" }
  ]
}
```

One big item with every ROM in it can serve many collisions, each picking its own file.

## Building one

`GET /items/:id/files` lists an item's files and folders. `POST /collisions/preview` with a
`sources` array says which files each source would place, where, and how many bytes, before
anything is saved. `PUT /collisions/:repo` saves and validates; a bad entry comes back `400` with
every problem listed.
