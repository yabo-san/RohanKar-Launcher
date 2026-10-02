# Agent brief

This file is the work order. Read it before every PR. It replaces the earlier brief (collisions,
Quiver parity); that plan is retired.

## What this is

y4bo downloads GitHub releases and archive.org zips, and gives people a few ways to import
things. That is the whole product. Most users never look at its UI: Playnite is where they play,
through our one Playnite extension. Keep it small. Every feature is something that can break.

## In scope

- **Curated archive.org uploaders** (`catalog/uploaders.json`). Their uploads are the game wall.
- **Curated port shelf** (`catalog/curated-ports.json`, built by `scripts/curated-ports.js` from a
  community list plus `catalog/curated-extras.json`). Installs the release binary from GitHub or
  GitLab. Nothing else: no data files, no wiring between apps.
- **The full Quiver catalogs**, off by default, behind Settings > Sources > "Show the full Quiver
  catalog".
- **Imports:** a Quiver library (`apps.json` + `Apps/`), and `user.json` with single archive.org
  items and single GitHub repos.
- **Playnite export** (`playnite-export.json`, `--export-playnite`, `--install`, `--uninstall`).
- **Curation data:** `overrides.json`, `catalog/art.json`, `catalog/favorite-artists.json`, and
  the dupe handling (separate cards where a shared title would merge different uploads).
- Install, uninstall (folder to the Recycle Bin, entry kept), Open folder, Add to Steam, playtime,
  update checks.

## Out of scope. Do not build, propose or reopen

- Collisions of any kind (port + data, launcher + engine + data + config). The code is parked on
  `parked/collisions`.
- Grouping tiles into one card, or several Play actions per Playnite game.
- Any mod support: no mod manager, no "browse mods" or "open mods folder", no links to mod sites.
  The Thunderstore mod manager (r2modman) is just another tile in `curated-extras.json`.
- Search UIs for /idgames, Quaddicted or similar. Doom and Quake are separate tiles.
- Announcements, manual apps, Android.
- Adding a whole archive.org uploader from the app (see Locked down).

## Locked down

- **The curated uploader list changes only in source.** Remove the "trust this uploader" button
  and the feed import of uploaders (`src/backend/feed.js` `trustUploaders`/`importFeed`,
  `server.js` trust route, the frontend button). A user who wants different uploaders edits
  `catalog/uploaders.json` and builds their own copy; `docs/BUILD-YOUR-OWN.md` explains how.
- **`user.json` accepts single items only:** an archive.org identifier, or a GitHub repository.
  Drop its `collisions` section. Validation and "curated wins on conflict" stay.
- **The curated port list's source URL never appears in the repo,** commits, PRs or logs. It comes
  from `CURATED_PORTS_SOURCE_URL` (env var locally, repo secret in CI). Never write that URL, its
  document ID or its author anywhere.

## User data

- What a user installed lives in their local `library.db` and survives updates and reinstalls of
  the app. Never migrate it in a way that drops entries.
- User additions live in their `user.json` (a path in Settings). Never copy them into the repo.
- Uninstall moves the folder to the Recycle Bin; it never deletes outright.

## Work order, one PR each

`git fetch` and `gh pr list` before each; do not duplicate open work.

1. **Park collisions.** Branch `parked/collisions` from main (merge #99, #100, #101 into it), push.
   Then remove from main: `catalog/collisions.json`, `catalog/ia-matches.json`, the collisions
   fetch, data-file staging, sha1-of-staged-data verification, `.bps` handling, collision card
   text, and `user.json` collisions, with their tests. Report net lines removed.
2. **Lock down** as above, and write `docs/BUILD-YOUR-OWN.md`: fork the repo, edit
   `catalog/uploaders.json` and `catalog/curated-extras.json`, run
   `CURATED_PORTS_SOURCE_URL=... node scripts/curated-ports.js` (or keep the committed file),
   then build: push to your fork and let `release.yml` build the installer, or run
   `npm run build` on Windows.
3. **Default shelf = curated**, full Quiver behind the toggle, a "Curated" badge on curated cards.
4. **Card states from tags:** "source only" shows "Source only, no download" plus a repository
   link instead of Install; "work in progress" gets a badge; "engine"/"launcher" tiles show their
   description (what the user brings).
5. **GitLab releases:** `repositorySource: "gitlab"` installs from
   `https://gitlab.com/api/v4/projects/<url-encoded owner/repo>/releases` with
   `releaseAssetFilter`. Fixture of GitLab's response; no network in tests.
6. **Art:** drop the `hero.png` special case. Cover and banner order: `overrides.json` artUrl,
   else the archive.org item's own image, else `catalog/art.json`.
7. **Nightly refresh** of `catalog/curated-ports.json` with the secret; open or update a PR
   "chore: refresh curated ports"; skip quietly when the secret is missing.
8. **README** exactly as given by the owner (see PR history); move Development and Releases into
   `docs/DEVELOPMENT.md`; remove the upstream screenshot.
9. **Builds:** add macOS (`.dmg`) and Linux (`.AppImage`) jobs to `release.yml`, labelled
   community-supported; add `CONTRIBUTING.md`: "I only test Windows. Mac and Linux builds are
   community-supported. PRs that add sources, catalog entries or asset filters for other
   platforms are welcome."

## Acceptance: installs must work

Before calling the shelf done, prove these install end to end with `mise run sandbox` and attach
the log lines to the PR:

| tile | source | why |
|---|---|---|
| Zelda 64: Recompiled | GitHub, Quiver metadata | the common case |
| Star Fox 64: Recompiled | GitLab | item 5 |
| Quake (ironwail) | GitHub, owner pick | releaseAssetFilter `win64` |
| Doom Launcher | GitHub, owner pick | two zips in the release; the portable one must win |
| r2modman | GitHub, owner pick | portable exe, not the Setup installer |
| a "source only" entry | n/a | shows no Install button |

## Rules

Logic in core, the renderer only renders. Tests for every core change. No network in tests.
Before/after and `mise run ui` screenshots in every UI PR. No em dashes in docs or PR text.
