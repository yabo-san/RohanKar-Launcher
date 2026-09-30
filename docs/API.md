# Launcher API, v1

The contract between the backend (`src/backend/`) and any frontend. The current UI
(`src/frontend/`) reaches the backend only through this API, via `src/frontend/api.js`, and a
new UI is written against it too.

## Connecting

- Base URL: `http://127.0.0.1:<port>/v1`. The backend binds to loopback only, on a random port
  unless one is given.
- Token: random per launch. Send it on every request as `Authorization: Bearer <token>`. Where a
  header can't be set (`EventSource`, `<img src>`), pass `?token=<token>` instead. A missing or wrong
  token is `401`.
- Bodies are JSON in and out (`Content-Type: application/json`), 1 MB max.
- Errors are `{ "error": "<code>", "detail": "<human text>" }`, sometimes with extra fields
  (`choices`, `errors`). Status codes: `400` bad input, `401` token, `404` not found, `405` wrong
  method, `409` a choice is needed or a name is taken, `413` body too big, `422` the action can't
  be done for this item, `501` needs the desktop app, `502` archive.org or a catalog failed,
  `503` library.db is unavailable.
- CORS allows any origin: the token is what's checked, so a frontend served from anywhere works.

How the frontend finds it:

- In the desktop app, `src/electron/main.js` starts the backend as a utility process, waits for
  it to report its port and token, and `src/electron/preload.js` hands both to the page as
  `window.launcher = { apiBase, token }`. The backend asks the app for OS actions (dialogs,
  the Recycle Bin, the window, the browser, Steam, the updater) over that process's message
  port; see `src/backend/parent.js`. Quitting the app stops the backend.
- The desktop app opens `src/frontend/new/index.html` (the new UI) unless settings say
  `"ui": "legacy"`, then `src/frontend/index.html` (the classic one). Both take the same
  connection details.
- In a plain browser, pass both in the page URL:
  `src/frontend/index.html?api=http://127.0.0.1:7777/v1&token=<token>`, served by any static
  server (the e2e tests use `e2e/fixture-server.js`).

Standalone:

```sh
node src/backend/main.js --data-dir ./.launcher-data --port 7777
# {"port":7777,"token":"3f9c…","url":"http://127.0.0.1:7777/v1"}
```

`LAUNCHER_TOKEN` fixes the token, `LAUNCHER_PORT` and `LAUNCHER_DATA_DIR` the others;
`--archive-base`, `--overrides-url`, `--uploaders-url`, `--github-api` and `--collisions-file`
point archive.org, the catalog fetches, the GitHub API and the collision catalog elsewhere
(fixtures). Without Electron, the endpoints that need the desktop app (dialogs,
the Recycle Bin, the window, the browser, Steam, the updater) answer `501`.

The examples below use `curl -H "Authorization: Bearer $T"`, shortened to `curl`.

## Model

An **item** is one title. archive.org uploads from every enabled source are grouped by title (the
first upload names the group; all of them are its `versions`), and each catalog entry is its own
item. Library state is joined in on every read.

```json
{
  "id": "rk-e2e-zoo-tycoon",
  "title": "Zoo Tycoon (Complete Collection)",
  "originalTitle": "Zoo Tycoon (Complete Collection)",
  "source": { "type": "archive.org", "uploader": "rohanjackson071@gmail.com", "label": "rohanjackson071" },
  "shelf": "wall",
  "addeddate": "2024-03-01T10:00:00Z", "date": null, "downloads": 1200, "description": null,
  "subject": ["pc", "tycoon"],
  "override": null,
  "versions": [
    { "id": "rk-e2e-zoo-tycoon", "title": "Zoo Tycoon (Complete Collection)", "source": { "…": "…" }, "addeddate": "…" },
    { "id": "rk-e2e-zoo-tycoon-pstriple", "title": "Zoo Tycoon [v1.0]", "source": { "label": "pstriple", "…": "…" } }
  ],
  "installed": true,
  "library": { "identifier": "rk-e2e-zoo-tycoon-pstriple", "install_dir": "C:\\Games\\rk-e2e-zoo-tycoon-pstriple", "…": "…" }
}
```

- `shelf` is `wall` for archive.org items and the catalog's shelf name (Nintendo, PlayStation…)
  for catalog items.
- `override` is the item's `overrides.json` entry; its `title` already replaced `title`.
- `library` is the library row of the installed version if any, else of the first version.

A catalog item has `id` `quiver:<catalog id>:<repository>`, `source`
`{ type: "quiver", catalog, name, url }`, `repository`, `icon`, `tags`, `versions: []`, `entry`
(the raw catalog entry) and `data`: the matching `collisions.json` record
(`{ iaIdentifier, contentUrl, dataFiles }`) joined on `repository`, or `null`.

A **library row** is what `library.db` holds: `identifier`, `install_dir`, `exe_path`, `category`,
`playtime_secs`, `added_at`, `is_favorite` (0/1), `notes`, `source`.

## Endpoints

### `GET /health`

```sh
curl http://127.0.0.1:7777/v1/health
# {"ok":true,"api":"v1","version":"1.6.0"}
```

### `GET /featured`

The hand-picked games and ports that lead the New page, in display order, from
`catalog/featured.json` (the copy on main at launch, the bundled one if that fails). Each pick names
an archive.org item by `identifier` or a port by `repository` (lowercase `owner/repo`); `blurb`, when
set, replaces the item's own description on its card. A pick that isn't on the wall is skipped by
the page.

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7777/v1/featured
# {"picks":[{"identifier":"devil-may-cry-4_202603","blurb":null},{"repository":"perfect-dark-pc-port/perfect_dark","blurb":null}]}
```

### `GET /announcement`, `POST /announcement/dismiss`

The message in `announcement.json` on main (`{ id, enabled, message, link? }`, Quiver's shape),
or `null` when it is disabled, can't be fetched, or its `id` was dismissed. Publish one by editing
that file and pushing; change `id` to show it again. `POST /announcement/dismiss` with `{ "id" }`
remembers the id in settings (`dismissedAnnouncements`) and answers `204`.

```sh
curl http://127.0.0.1:7777/v1/announcement
# {"announcement":{"id":"2026-09-30-quiver","message":"Coming from Quiver? …","link":"https://…"}}
```

### `GET /items`

All items. Filters, all optional and combinable: `source` (uploader email, source label or catalog
id; a group matches if any version does), `shelf`, `search` (title substring, any version),
`installed` (`true`/`false`), `inLibrary` (`true`/`false`), `refresh=true` (refetch the sources;
otherwise the first load is reused). The first call waits for every enabled source, one at a time.

```sh
curl 'http://127.0.0.1:7777/v1/items?search=tycoon&installed=false'
# {"items":[{"id":"rk-e2e-rollercoaster-tycoon",…}],"errors":[]}
```

Each version carries `newer`: the id of the newest upload of the same title added after it
(a later `addeddate`), or `null`. An installed version with a `newer` is what the launcher badges
"Newer release" and the Playnite export reports as `updateAvailable`; nothing updates by itself.

`errors` lists sources that failed while others loaded
(`[{"source":"x@y","label":"x","error":"HTTP 503"}]`). All sources failing is
`502 {"error":"sources_failed","detail":"…","errors":[…]}`.

### `GET /items/:id`

One item; any version's id finds its group.

```sh
curl http://127.0.0.1:7777/v1/items/rk-e2e-zoo-tycoon-pstriple
# {"id":"rk-e2e-zoo-tycoon","versions":[…],…}
```

### `GET /items/:id/files`

The archive.org file list, its folders, and the files an install can use (zip/7z/rar, or a lone .exe).

```sh
curl http://127.0.0.1:7777/v1/items/rk-e2e-halo-ce/files
# {"files":[{"name":"rk-e2e-halo-ce.zip","size":"148"}],"folders":[],"installable":[{"name":"rk-e2e-halo-ce.zip","size":"148"}]}
```

### `GET /items/:id/reviews`

```sh
curl http://127.0.0.1:7777/v1/items/rk-e2e-halo-ce/reviews
# {"reviews":[{"reviewtitle":"Works","stars":"5",…}]}
```

### `GET /items/:id/cover`, `GET /items/:id/hero`

Image bytes from the covers cache. The cover is the `overrides.json` art if set, else the
archive.org thumbnail, each downloaded once. The hero is the override hero, else a `hero.*` in the
install folder, else the `<id>.png` shipped with the app. `?from=override|install|bundled` asks
for one of those only (`400` for anything else). `404 no_image` when there is none.

```html
<img src="http://127.0.0.1:7777/v1/items/rk-e2e-halo-ce/cover?token=…">
<img src="http://127.0.0.1:7777/v1/items/rk-e2e-halo-ce/hero?from=bundled&token=…">
```

### `GET /catalogs`

Subscribed catalogs with entry count, last fetch time and last error.

```sh
curl http://127.0.0.1:7777/v1/catalogs
# {"catalogs":[{"id":"8c1f0e2a9b3d","url":"https://…/nintendo.json","name":"nintendo","shelf":"Nintendo","entries":214,"fetchedAt":1790000000000,"error":null}]}
```

### `POST /catalogs`

Subscribe by URL (`{ url, name?, shelf? }`). Fetches and caches it; the first copy counts as
reviewed. `201` when new, `200` when already subscribed.

```sh
curl -X POST -d '{"url":"https://raw.githubusercontent.com/…/nintendo.json","shelf":"Nintendo"}' http://127.0.0.1:7777/v1/catalogs
# {"id":"8c1f0e2a9b3d","url":"…","name":"nintendo","shelf":"Nintendo","entries":214,"fetchedAt":…,"error":null}
```

### `GET /catalogs/:id`, `DELETE /catalogs/:id`

One subscription; delete unsubscribes and drops its cache (`204`).

```sh
curl -X DELETE http://127.0.0.1:7777/v1/catalogs/8c1f0e2a9b3d
```

### `POST /catalogs/:id/refresh`

Fetch again. A failed fetch keeps the last good copy and sets `error`.

```sh
curl -X POST http://127.0.0.1:7777/v1/catalogs/8c1f0e2a9b3d/refresh
# {"id":"8c1f0e2a9b3d","entries":215,"error":null,…}
```

### `GET /catalogs/:id/items`

That catalog's entries as items (the same shape as catalog items in `GET /items`, with library
state joined in), without waiting for archive.org.

```sh
curl http://127.0.0.1:7777/v1/catalogs/8c1f0e2a9b3d/items
# {"items":[{"id":"quiver:8c1f0e2a9b3d:banjorecomp/banjorecomp","title":"Banjo-Kazooie","shelf":"Nintendo","repository":"BanjoRecomp/BanjoRecomp","data":{"iaIdentifier":"banjo-kazooie-recompiled.-7z",…},"library":null,…}]}
```

### `GET /catalogs/:id/review`

Entries new, changed or removed since the catalog was last marked seen, keyed on `repository`.

```sh
curl http://127.0.0.1:7777/v1/catalogs/8c1f0e2a9b3d/review
# {"new":[{"name":"2Ship2Harkinian","repository":"HarbourMasters/2ship2harkinian",…}],"changed":[],"removed":[]}
```

### `POST /catalogs/:id/seen`

Marks the current copy as reviewed (`204`).

```sh
curl -X POST http://127.0.0.1:7777/v1/catalogs/8c1f0e2a9b3d/seen
```

### Collisions

The user's own collisions and the collision feeds they subscribe to. The schema is in
[COLLISIONS.md](COLLISIONS.md). `:repo` is `owner/repo` URL-encoded (`owner%2Frepo`).

| route | does |
| --- | --- |
| `GET /collisions` | `{ local: [...] }`, the user's own |
| `GET /collisions/export` | `{ schemaVersion: 1, collisions: [...] }`, the user's own as a feed file |
| `GET /collisions/:repo` | The collision in effect: `{ origin: "local" \| "feed" \| "bundled", entry, feed? }`, `404` if none |
| `PUT /collisions/:repo` | Saves one (replacing the user's own for that repo); `400 bad_collision` lists every problem |
| `DELETE /collisions/:repo` | Removes the user's own (`204`), `404` if there wasn't one |
| `POST /collisions/preview` | `{ sources }` → per source, the archive.org files it places (`to`) and `bytes`, or `error` |
| `GET /collision-feeds` | Subscribed feeds with `entries`, `rejected`, `fetchedAt`, `error` |
| `POST /collision-feeds` | `{ url, name? }` subscribes and fetches; `201` new, `200` already subscribed |
| `POST /collision-feeds/:id/refresh`, `DELETE /collision-feeds/:id` | Refetch; unsubscribe |

```sh
curl -X PUT -d '{"base":"data","sources":[{"ia":"game-rip","path":"Game.zip","extract":true}]}' \
  http://127.0.0.1:7777/v1/collisions/owner%2Fport
```

### `GET /library`

Every library row, keyed by identifier.

```sh
curl http://127.0.0.1:7777/v1/library
# {"library":{"rk-e2e-halo-ce":{"identifier":"rk-e2e-halo-ce","install_dir":"C:\\Games\\rk-e2e-halo-ce",…}}}
```

### `POST /library`

Add: `{ id, source? }` puts an item in the library without installing it. `201` when new, `200`
when it was already there; returns the row.

```sh
curl -X POST -d '{"id":"quiver:8c1f0e2a9b3d:harbourmasters/shipwright","source":"https://…/nintendo.json"}' http://127.0.0.1:7777/v1/library
# {"identifier":"quiver:8c1f0e2a9b3d:harbourmasters/shipwright","install_dir":null,"source":"https://…/nintendo.json",…}
```

### `GET /library/:id`, `PATCH /library/:id`

Read or change a row. Patchable: `category`, `favorite` (bool), `notes`, `exePath`, `installDir`,
`title` (the name of an entry no item describes, such as a manual app).
`installDir` adopts a folder already on disk (Locate Existing Install) and picks its executable when
there's only one. `favorite`, `notes` and `installDir` create the row if needed; the others need it
to exist.

```sh
curl -X PATCH -d '{"favorite":true,"notes":"needs dgVoodoo"}' http://127.0.0.1:7777/v1/library/rk-e2e-halo-ce
# {"identifier":"rk-e2e-halo-ce","is_favorite":1,"notes":"needs dgVoodoo",…}
```

### `DELETE /library/:id`

Takes the entry out of the library (`204`). Installed files stay unless `?files=trash`, which moves
the install folder to the Recycle Bin first (the desktop app's Delete).

```sh
curl -X DELETE 'http://127.0.0.1:7777/v1/library/rk-e2e-halo-ce?files=trash'
```

### `GET /library/:id/exes`

Executables to offer for an installed entry (a collection lists every game's).

```sh
curl http://127.0.0.1:7777/v1/library/rk-e2e-halo-ce/exes
# {"exes":["C:\\Games\\rk-e2e-halo-ce\\Halo\\halo.exe"]}
```

### `GET /library/:id/readme`

```sh
curl http://127.0.0.1:7777/v1/library/rk-e2e-halo-ce/readme
# {"text":"Halo: Combat Evolved\r\n…","fileName":"README.txt"}
```

### `POST /library/:id/launch`

`{ exePath? }`. Without one, uses the saved exe, or the only one found; several found is
`409 choose_exe` with `choices`.

```sh
curl -X POST -d '{}' http://127.0.0.1:7777/v1/library/rk-e2e-halo-ce/launch
# {"ok":true,"exePath":"C:\\Games\\rk-e2e-halo-ce\\Halo\\halo.exe"}
```

### `POST /library/:id/reveal`

Opens the install folder in Explorer.

```sh
curl -X POST http://127.0.0.1:7777/v1/library/rk-e2e-halo-ce/reveal
# {"ok":true}
```

### `POST /library/scan`

Adopts installs already on disk: folders in `dir` (default: the install folder, then the download
folder) named after a loaded item's identifier or title.

```sh
curl -X POST -d '{"dir":"D:\\Games"}' http://127.0.0.1:7777/v1/library/scan
# {"found":[{"identifier":"rk-e2e-halo-ce","installDir":"D:\\Games\\Halo_ Combat Evolved","exePath":null,"matchedBy":"title"}]}
```

### `POST /library/manual`

Adds a manually managed app: one with no GitHub release and no archive.org item, that the user
fills and keeps up to date. `{ "name", "folder"? }`: without `folder`, a folder named after the app
is made in the install folder with a "Place app files here.txt" note; with one, that existing
folder is used as is. The row is `manual:<folder name>`, source `manual`, `title` the name, and
its executable is picked when the folder holds exactly one. `201` with the row; `409 exists`,
`422 no_folder`.

```sh
curl -X POST -d '{"name":"My Homebrew"}' http://127.0.0.1:7777/v1/library/manual
# {"identifier":"manual:My Homebrew","install_dir":"C:\\Games\\My Homebrew","source":"manual","title":"My Homebrew",…}
```

### `POST /library/import/quiver`

Reads a Quiver Launcher folder (`dir`: the folder holding `apps.json`, or `apps.json` itself) and
says what importing it would do; with `"apply": true` it imports. Nothing is downloaded: installed
apps are adopted where they are, found the way Quiver finds them (`installPath`, else
`settings.json`'s `AppsPath` or `Apps/`, plus `folderName`; `install-incomplete.txt` means not
installed; `version.txt` and `selected_executable.txt` are read).

Each app's `kind` is `port` (a subscribed catalog lists the repository; the row is that item),
`new` (none does; a collision with just the repository and name puts it on "Your ports", id
`quiver:local:<repo>`) or `manual` (no GitHub repository; row `manual:<folderName>`, kept only when
its folder has something to launch). Tags, the display name and the installed version go to the
row's `tags`, `title` and `version`. An install already in the library is left as it is, so a
second import changes nothing. 400 `not_quiver` when there is no readable `apps.json`.

```sh
curl -X POST -d '{"dir":"D:\\QuiverLauncher","apply":true}' http://127.0.0.1:7777/v1/library/import/quiver
# {"root":"D:\\QuiverLauncher","appsPath":"D:\\QuiverLauncher\\Apps",
#  "apps":[{"name":"Perfect Dark","repository":"fgsfdsfgs/perfect_dark","kind":"port","id":"quiver:…",
#           "installed":true,"installDir":"D:\\QuiverLauncher\\Apps\\PerfectDark","exe":"…\\pd.exe","version":"v1.2.0",…}],
#  "skipped":[{"name":"Old thing","reason":"manual app with nothing installed"}],
#  "result":{"added":1,"adopted":4,"ports":2,"unchanged":0}}
```

### Collections

`GET /collections`, `POST /collections` (`{ name }`, `409 name_taken` on a duplicate),
`PATCH /collections/:id` (`{ name?, color? }`), `DELETE /collections/:id`,
`PUT /collections/:id/items/:itemId`, `DELETE /collections/:id/items/:itemId`.

```sh
curl -X POST -d '{"name":"Shooters"}' http://127.0.0.1:7777/v1/collections
# {"id":1,"name":"Shooters","created_at":1790000000000,"color":null,"games":[]}
curl -X PUT http://127.0.0.1:7777/v1/collections/1/items/rk-e2e-halo-ce
```

### `POST /installs`

Start installing an archive.org item: `{ id, files? }`. One job per file. An item with several
archives needs `files` (`409 choose_files` lists `choices`); each then extracts into its own
`_GAME_<name>` folder, as the desktop app's collection picker does. Returns `202` at once; follow
progress on `/events` or poll `/installs/:id`.

A catalog port (`quiver:` id) is one job in two steps. `step: "binary"` takes the latest
non-draft, non-prerelease GitHub release of the port's repository and picks its Windows asset:
the collision catalog's `assetPattern` wins, then Quiver's `releaseAssetFilter`, then a Windows
heuristic. It downloads and extracts into `<install folder>/<folderName>`. When the collision
catalog lists game data, `step: "data"` downloads the archive.org file named by `contentUrl`,
extracts it, copies each `dataFiles` entry to its `targetSubpath` and checks its sha1 (`status:
"verifying"`). A mismatch fails the job and names the file; `optional` files may be missing.
Unknown ports answer `404`, ports that can't start (no repository) `422`.

```sh
curl -X POST -d '{"id":"rk-e2e-halo-ce"}' http://127.0.0.1:7777/v1/installs
# {"installs":[{"id":"b7e1…","itemId":"rk-e2e-halo-ce","file":"rk-e2e-halo-ce.zip","status":"downloading","percent":0,…}]}
```

### `GET /installs`, `GET /installs/:id`

A job: `status` is `downloading`, `extracting`, `verifying` (ports), `done`, `error` or `cancelled`; `step` (ports); `percent`,
`error`, and when done `installDir` and `exePath` (null when there are several to choose from).

```sh
curl http://127.0.0.1:7777/v1/installs/b7e1…
# {"id":"b7e1…","status":"done","percent":100,"installDir":"C:\\Games\\rk-e2e-halo-ce","exePath":"…\\halo.exe",…}
```

### `DELETE /installs/:id`

Cancels a job still downloading; returns the job.

```sh
curl -X DELETE http://127.0.0.1:7777/v1/installs/b7e1…
# {"id":"b7e1…","status":"cancelled","error":"Cancelled",…}
```

### `GET /events`

Server-sent events. Types:

- `install`: a job changed (same shape as `GET /installs/:id`); sent on each percent step.
- `library`: a row changed, `{ "identifier": "…" }`, or `{}` for bulk changes.
- `items`: the sources were (re)loaded, `{ "count": 6, "errors": [] }`.
- `updater`: the desktop app's update check found something, `{ "status": "available", "version",
  "releaseNotes", "releaseDate" }` or `{ "status": "error", "message" }`.

```js
const es = new EventSource(`${apiBase}/events?token=${token}`);
es.addEventListener('install', (e) => console.log(JSON.parse(e.data)));
```

### `GET /sources`

The archive.org uploaders the wall loads. `defaults` come from `catalog/uploaders.json` (the copy
on main at launch, the bundled one as fallback): on only where `launcher` is true, `track` isn't
false and there's an `uploaderEmail`. `sources` is the saved list from settings when there is
one, else the defaults.

```sh
curl http://127.0.0.1:7777/v1/sources
# {"defaults":[{"uploader":"rohanjackson071@gmail.com","label":"rohanjackson071","enabled":true},…],"sources":[…]}
```

### `GET /settings`, `PUT /settings`

`settings.json`. `PUT` merges, so keys it doesn't send survive; returns the merged settings.

```sh
curl -X PUT -d '{"installPath":"D:\\Games","deleteAfterInstall":true}' http://127.0.0.1:7777/v1/settings
# {"sources":[…],"installPath":"D:\\Games","deleteAfterInstall":true}
```

### `POST /export/playnite`

Writes `playnite-export.json` next to `library.db`, or to an absolute `path`. Atomic: temp file,
then rename. The backend also rewrites it after every library change. Schema, ids and the
matching CLI flags: [PLAYNITE-EXPORT.md](PLAYNITE-EXPORT.md).

```sh
curl -X POST -d '{}' http://127.0.0.1:7777/v1/export/playnite
# {"file":"C:\\Users\\k\\AppData\\Roaming\\rohankar-launcher\\playnite-export.json","count":12}
```

### `POST /os/choose-folder`

Shows the desktop app's folder picker. `{ "path": null }` when cancelled; `501` standalone.

```sh
curl -X POST http://127.0.0.1:7777/v1/os/choose-folder
# {"path":"D:\\Games"}
```

### `POST /os/open-external`

Opens an `http(s)` URL in the default browser; `400` for any other scheme.

```sh
curl -X POST -d '{"url":"https://archive.org/donate"}' http://127.0.0.1:7777/v1/os/open-external
# {"ok":true}
```

### `POST /os/window`

Minimizes, maximizes (or restores) or closes the app window. `action` is `minimize`, `maximize`
or `close`.

```sh
curl -X POST -d '{"action":"minimize"}' http://127.0.0.1:7777/v1/os/window
# {"ok":true}
```

### `POST /os/add-to-steam`

Adds a non-Steam shortcut for every Steam user on this PC. Needs `appName`, `exePath` and
`startDir`; `alreadyAdded` when a shortcut with that exe exists.

```sh
curl -X POST -d '{"appName":"Halo","exePath":"C:\\Games\\Halo\\halo.exe","startDir":"C:\\Games\\Halo"}' http://127.0.0.1:7777/v1/os/add-to-steam
# {"ok":true,"alreadyAdded":false,"updatedUsers":1}
```

### `GET /os/updater`, `POST /os/updater-install`

The latest update status (the same object as the `updater` event, or `null`), and the action
that sends the user to the release download.

```sh
curl http://127.0.0.1:7777/v1/os/updater
# {"status":{"status":"available","version":"1.7.0","releaseNotes":"…","releaseDate":"…"}}
```

### `GET /os/open-item`, `DELETE /os/open-item`

The item Playnite asked the window to show (`--launch` on a game that isn't installed; see
[PLAYNITE-EXPORT.md](PLAYNITE-EXPORT.md)), or `null`. The same request arrives as an `open-item`
event; the frontend clears it with `DELETE` once it has shown the item.

```sh
curl http://127.0.0.1:7777/v1/os/open-item
# {"identifier":"rk-e2e-halo-ce"}
```

## Versioning

Everything is under `/v1/`. Adding fields or endpoints keeps v1; renaming or removing either, or
changing a field's meaning, is `/v2/`, served alongside v1 until the frontend has moved.
