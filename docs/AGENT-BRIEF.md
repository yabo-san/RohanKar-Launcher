# Agent brief: Quiver catalogs, collisions, one core model

Read `PRODUCT.md` and `USER-LOOP.md` first. This file is the work order.

## Goal

Turn this fork into one launcher with two kinds of shelf and one install button: the archive.org
uploader walls it has today, plus Quiver's catalogs of open-source ports as browsable shelves you
Add from, with the collision catalog joining the two so a port that needs game data installs end
to end with the data verified by hash. The current web UI will be replaced later; build the model
and sources so the UI is only a renderer.

## Architecture rule

All sources (archive.org uploaders, Quiver catalogs, the collision catalog) feed one normalized
model (`items`, `versions`, `library`) in `src/core/` with no DOM references. The renderer reads it
over IPC and draws it. No fetching, joining or platform logic in `renderer.js`.

## Reference code

Primary spec is `tgeorgiadis/quiver-launcher` (MIT): clone it and read `Services/` and `Models/`
for the catalog schema, the subscribe, browse, review, add loop, release lookup and
`releaseAssetFilter`, download and extraction, installed-version tracking and update checks;
`docs/` and `MIGRATING.md` for how `apps.json` and the library file evolved. Port that logic into
`src/core/`; keep their MIT notice where ported. `SirDiabo/GithubLauncher` only where Quiver's
history references it.

The data half is ours and Quiver has none of it. Four JSON files will be supplied at a URL:

- `catalog.json`: port entries with `repository`, `iaIdentifier`, `contentUrl`,
  `dataFiles[{name,targetSubpath,sha1,optional}]`
- `ia-matches.json`: owner-confirmed `identifier::path` pairs
- `collisions.json`: fully resolved port plus data with checksums
- `uploaders.json`: the curated archive.org uploaders

No C# in this repo.

## Steps, one PR each

### Step 0: research, no code

Report with file:line references:

1. the full catalog entry schema and how the four `community-app-catalog/*.json` files are
   structured and discovered;
2. how an entry becomes a download: GitHub and GitLab release lookup, how `releaseAssetFilter`
   selects an asset, prerelease handling, rate limits, auth;
3. the subscribe, browse by catalog, review, add loop: how a catalog is subscribed, how the review
   screen presents new, changed and removed entries, what Add writes to the user's library, how
   library and catalog stay separate;
4. install semantics: extraction, `filesToAdd`, version tracking, updates;
5. confirm Quiver carries no game-data mechanism.

Stop and wait for a go.

### Step 1: catalogs as shelves

Source type `quiver`: a catalog URL (defaults: the four community files; a Settings list to add
more). Fetch, cache to disk, refresh on demand, logged like archive traffic. A Ports area with one
shelf per subscribed catalog (Nintendo, PlayStation, Xbox, Other: the console the port came from).
Shelf cards show title, `appIconUrl`, "Source: Quiver / <catalog>", tags, grouped via `titleKey`,
but are not in the library. Add puts an entry in the library (recorded in `library.db` with
source = catalog URL); Remove takes it out without deleting installed files. A review view lists
entries new, changed or removed since the catalog was last seen, with per-item Add. Windows asset
selection happens at install time via `releaseAssetFilter`, not as a shelf filter.

### Step 2: the collision catalog

Third input, `collisions`, fetched from the supplied URL with a bundled fallback: JSON keyed by
`repository` (lowercase `owner/repo`) to
`{ iaIdentifier, contentUrl, sourcePath, dataFiles: [{ name, targetSubpath, sha1, optional, patch? }] }`
where `sourcePath` is `identifier::path` inside the archive item and `patch` is an optional `.bps`
path or URL. Join to Quiver entries on `repository` only; never match by title. A matched card, on
the shelf and in the library, shows "Binary: GitHub, Data: archive.org (<uploader>)"; an unmatched
port card installs the binary only and says "needs <dataFiles[].name>, not in the catalog". Unit
tests with fixtures cut from the real files.

### Step 3: install

Port: resolve the latest non-prerelease release unless the entry says otherwise, apply
`releaseAssetFilter` exactly as Quiver does, download to the library folder, extract, apply
`filesToAdd`. Data, when a collision exists: download the archive item file at `sourcePath` with
resume, list and extract members, stage each `dataFiles[].name` into `targetSubpath`, apply the
`.bps` patch if named, verify sha1 after staging (the hash is of the staged file, never the
download), fail loudly naming the file on mismatch. Adopt an install that already exists on disk
(matching folder and exe) instead of re-downloading. Same progress UI and Add-to-Steam path as
archive.org installs; source and versions recorded in `library.db`.

### Step 4: updates

"Newer release" badge per Quiver's check; no auto-update; data files never re-downloaded while the
staged sha1 still matches.

### Step 5: see it without Windows

A `mise run ui` task that serves `src/renderer/` from a static server with a stub
`window.electronAPI` backed by cached JSON (sources, catalogs, collisions, a fake library), so the
shelves and cards render in a browser through the devcontainer's forwarded port. No installs in
that mode.

### Step 5b: User-added sources

Comes before the Quiver import (6.4) in the order of things; 6.4 had already merged, so it landed
after it. The full rules are in [USER-SOURCES.md](USER-SOURCES.md).

- Default is the curated list only: our uploaders (`catalog/uploaders.json`) and `catalog/`.
- A Settings toggle, **Allow additional sources**, off by default. Turning it on shows a Cider-style
  modal (centered, dimmed backdrop, clear title, one primary and one secondary button) every time
  it goes from off to on: title "Additional sources", body "Warning: we do not monitor additional
  sources. Make sure you trust the repo or uploader before you add it.", buttons "I understand"
  (turns it on) and "Cancel" (leaves it off).
- `user.json`: a local file path in Settings (no URLs for now). Schema version 1 with three arrays in
  the curated catalog's shapes: `collisions` (GitHub repo + archive.org data files), `archive`
  (standalone archive.org downloads), `github` (standalone GitHub release binaries). sha1 is
  optional per file.
- Every other non-curated input sits behind the same toggle and badge: the user's own collisions,
  feeds, and uploaders not on the curated list.
- Rules: every card from an additional source shows "Your source · not reviewed", curated cards
  never do; curated wins, and a user entry with a curated repository or identifier is ignored and
  listed as a conflict in Settings; a sha1 is verified like curated entries, and without one the
  hash is recorded on first install and a later change asks in the same modal style; user.json is
  validated on load and each invalid entry is shown with why, never skipped silently; turning the
  toggle off hides user entries and leaves installed files on disk.
- Logic in the backend (`src/backend/`, the core), the renderer only renders. Tests with fixture
  user.json files: valid, invalid, conflicting with curated.

### Step 6: Supersede Quiver

This fork supersedes Quiver: users switch to it, and it does not integrate with Quiver. Quiver's
community catalogs stay a data source for the port shelves (Step 1); nothing else of Quiver's is
read at runtime. The only library integrations are this fork's Playnite export (Step 7) and Drop
OSS, which is handled outside this repo.

What Quiver has that steps 1 to 5 do not cover, so nobody loses anything by switching. One PR each;
6.4 first (it is the switch path), then 6.1, 6.2, 6.3.

1. **Manually managed apps.** An entry with no repository and no archive item: the user names it,
   drops files into its folder, the library launches it. Adopt-existing (step 3) handles installs
   we recognise; this handles ones we do not.
2. **Tags and library search.** User tags on library entries; the search box filters by name, tag,
   repository or folder, as Quiver does.
3. **Portable data layout.** Option to keep `library.db`, settings, cache and installs beside the
   executable instead of `%APPDATA%`, so a folder is the whole install and can be moved. Quiver's
   default; ours should be a Settings choice with a migration.
4. **Import a Quiver library.** Read a Quiver `apps.json` plus its `Apps/` folder and adopt
   everything it lists, so a Quiver user can switch without reinstalling. A one-way import, not a
   sync: nothing is written back to Quiver.
5. **Mod management** (Thunderstore, GameBanana) as Quiver does it. Last; large; only if asked for.
6. **Announcements.** A remote `announcement.json` shown once per message id. Small; do it with 1.

Not needed: Linux and Android builds (Electron can, nobody asked), code signing (a purchase, not a
PR), and any integration with Quiver itself beyond reading its catalogs and the one-way import.

### Step 7: Playnite export, trivial by design

Playnite is the owner's front end. Exporting to it must never be a manual step.

- On every library change, write `playnite-export.json` next to `library.db`: one record per
  library entry with `id`, `name`, `source` (archive.org uploader, quiver catalog URL, manual),
  `installDir`, `exe`, `args`, `workingDir`, `installed`, `version`, `coverPath` (the cached cover
  on disk), `heroPath`, `platform` (the console shelf for ports, `PC` otherwise), `tags`,
  `lastPlayed`, `playtimeSeconds`. Atomic write (temp file then rename). Stable ids so Playnite
  keeps its own metadata across re-imports.
- A `--export-playnite <path>` CLI flag that writes the same file on demand and exits, for the
  Playnite plugin to call.
- Add to Steam stays as is; this is the Playnite equivalent and it costs nothing at runtime.
- The Playnite library plugin in `yabo-san/playnite-extensions` reads this file; document the
  schema in `docs/PLAYNITE-EXPORT.md` with an example record, and version it (`schemaVersion`).

## Rules

- One PR per step against `main`; stop after each and wait for the merge; do not stack on unmerged
  PRs.
- Unit tests for schema mapping, asset filter, the review diff, the collision join and the sha1
  staging.
- No changes to the archive.org uploader code paths beyond moving them under `src/core/`.
- No new runtime dependencies unless GitLab or `.bps` needs one, and say why.
- Fixtures only in CI: never live GitHub or archive.org.
- Conventional-commit titles; PR bodies say what changed and the one manual check to do.
