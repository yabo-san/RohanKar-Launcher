# playnite-export.json

The launcher's library, written for the y4bo Playnite library plugin
(the `RohanKar` plugin in `yabo-san/playnite-extensions`). Playnite reads this
file; it never opens `library.db`.

## Where and when

- **Where:** next to `library.db`, in the launcher's data folder
  (`%APPDATA%\y4bo-launcher\playnite-export.json` on Windows). An install
  that had data before the rename to y4bo keeps its old folder,
  `%APPDATA%\rohankar-launcher`, so a reader should look in both
  (see `src/electron/user-data.js`).
- **When:** after every library change (install, uninstall, add, remove,
  favourite, collections, play), batched so a scan writes it once, and at
  startup. Nothing is fetched to write it: names come from what the launcher
  has loaded, else from the previous export, else the id.
- **How:** written to `playnite-export.json.<pid>.tmp`, then renamed over the
  old file, so a reader sees the old file or the new one, never half of one.
- **On demand:** `y4bo.exe --export-playnite <path>` writes it to `<path>` and exits.

## Schema, version 1

```jsonc
{
  "schemaVersion": 1,                 // bumped only for a breaking change
  "generatedAt": "2026-09-29T02:30:00.000Z",
  "launcherVersion": "1.6.0-fork.3",
  "games": [ /* one record per library entry */ ]
}
```

| field | type | meaning |
|---|---|---|
| `id` | string | Stable id, see below. Never changes for an entry. |
| `name` | string | Display name. |
| `source` | string | `archive.org:<uploader>`, `quiver:<catalog url>` or `manual`. The part after the colon can be empty when the launcher has not loaded that source yet. |
| `platform` | string | `PC`, `Nintendo`, `PlayStation`, `Xbox` or `Other`. archive.org and manual entries are `PC`; a port takes its catalog's shelf. |
| `installed` | bool | Has an install folder. |
| `installDir` | string\|null | Install folder. |
| `exe` | string\|null | Executable to run, when one was picked. |
| `args` | string | Arguments for `exe`. Empty for now. |
| `workingDir` | string\|null | Folder to run `exe` in (its folder, else `installDir`). |
| `version` | string\|null | Installed version, when the source has one. Null for now. |
| `updateAvailable` | bool | A newer upload of the same title exists than the one installed. |
| `coverPath` | string\|null | Cover image on disk, in the cover order (overrides.json artUrl, else the archive.org image, else catalog/art.json). Null when none is downloaded yet. |
| `heroPath` | string\|null | Hero banner on disk, in the same order (overrides.json hero, else the archive.org image, else catalog/art.json). Null when none is downloaded yet. |
| `tags` | string[] | The entry's collections. |
| `lastPlayed` | string\|null | ISO time of the last launch from the launcher. |
| `playtimeSeconds` | number | Playtime the launcher recorded. |
| `favorite` | bool | Optional. Favourited in the launcher. |

Readers ignore fields they do not know; new optional fields do not bump
`schemaVersion`.

### Ids

| entry | id | example |
|---|---|---|
| archive.org upload | the archive.org identifier | `rk-e2e-halo-ce` |
| Quiver catalog port | `quiver:<repository>` (lowercase `owner/repo`; `quiver:name:<name>` when the entry has no repository) | `quiver:harbourmasters/shipwright` |
| manual entry | a UUID made once and kept in `library.db` (`games.export_id`) | `6f1c2a1e-0b7d-4c55-9f0e-3d2a8b1c4e77` |

For archive.org items the id is the library id (`games.identifier` in
`library.db`), which the Playnite plugin uses as its GameId. A port keeps its
id when it moves to another catalog, and an archive.org item
keeps its id when its title changes, so Playnite keeps its own metadata (art,
categories, notes) across re-exports.

## Example record

```json
{
  "id": "rk-e2e-halo-ce",
  "name": "Halo: Combat Evolved",
  "source": "archive.org:rohanjackson071@gmail.com",
  "platform": "PC",
  "installed": true,
  "installDir": "C:\\Games\\rk-e2e-halo-ce",
  "exe": "C:\\Games\\rk-e2e-halo-ce\\Halo\\halo.exe",
  "args": "",
  "workingDir": "C:\\Games\\rk-e2e-halo-ce\\Halo",
  "version": null,
  "updateAvailable": false,
  "coverPath": "C:\\Users\\k\\AppData\\Roaming\\y4bo-launcher\\thumbcache\\rk-e2e-halo-ce.jpg",
  "heroPath": null,
  "tags": ["Shooters"],
  "lastPlayed": "2026-09-28T21:04:11.000Z",
  "playtimeSeconds": 5400,
  "favorite": true
}
```

## Commands

The plugin drives the launcher through these flags. Each runs without a
window, prints one JSON line and exits: `0` done, `1` failed, `2` usage.

| flag | does |
|---|---|
| `--export-playnite <path>` | Writes the export to `<path>`. |
| `--install <id>` | Downloads and installs an archive.org item, waits, then writes the export. An item with several archives, a port or a manual entry opens the launcher on that item instead. |
| `--uninstall <id>` | Moves the install folder to the Recycle Bin and keeps the entry (favourite, collections, playtime). |
| `--launch <id>` | Starts the installed game. When it is not installed, opens the launcher on that item (the running launcher, if one is open). |

The same flags work on the standalone backend (`node src/backend/main.js
--data-dir <dir> --install <id>`), where anything that needs the window exits
`3`.
