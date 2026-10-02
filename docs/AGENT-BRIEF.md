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
- **Imports:** `user.json` with single archive.org items and single GitHub (or GitLab) repos.
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
- Quiver compatibility: no full-Quiver-catalog toggle, no Quiver library import. Remove both,
  including `src/backend/quiver-import.js` and the four Quiver catalog URLs in the frontend.
  (`scripts/curated-ports.js` may still read Quiver's catalogs at build time to borrow names,
  icons and asset filters; that is a data source, not a feature.)
- Adding a whole archive.org uploader from the app (see Locked down).

## Locked down

- **The curated uploader list changes only in source.** Remove the "trust this uploader" button
  and the feed import of uploaders (`src/backend/feed.js` `trustUploaders`/`importFeed`,
  `server.js` trust route, the frontend button). A user who wants different uploaders edits
  `catalog/uploaders.json` and builds their own copy; `docs/BUILD-YOUR-OWN.md` explains how.
- **`user.json` accepts single items only:** an archive.org identifier, or a GitHub repository.
  Drop its `collisions` section. Validation and "curated wins on conflict" stay.
- **`catalog/curated-ports.json` is a one-time pass, refreshed by hand only.** The owner re-runs
  `scripts/curated-ports.js` locally when they want; no workflow, schedule or CI check runs it.
  Its source URL comes from `CURATED_PORTS_SOURCE_URL` in the owner's shell and never appears in
  the repo, commits, PRs or logs. Never write that URL, its document ID or its author anywhere.

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
3. **The port shelf = curated only.** Load `catalog/curated-ports.json` (raw URL from main,
   cached, bundled copy as fallback) plus the user's `user.json` repos. Remove the Quiver catalog
   URLs, the full-Quiver option and Quiver library import, with their tests.
4. **Card states from tags:** "source only" shows "Source only, no download" plus a repository
   link instead of Install; "work in progress" gets a badge; "engine"/"launcher" tiles show their
   description (what the user brings).
5. **GitLab releases:** `repositorySource: "gitlab"` installs from
   `https://gitlab.com/api/v4/projects/<url-encoded owner/repo>/releases` with
   `releaseAssetFilter`. Fixture of GitLab's response; no network in tests.
6. **Art:** drop the `hero.png` special case. Cover and banner order: `overrides.json` artUrl,
   else the archive.org item's own image, else `catalog/art.json`.
7. **Optional API tokens.** Settings fields "GitHub token" and "GitLab token" (optional, empty by
   default), stored in the user's settings, never logged. When set, send them on GitHub/GitLab API
   requests; when empty, keep working unauthenticated. Explain in Settings why: GitHub allows 60
   API requests an hour without one, and a big shelf or an update check can hit that. Show a clear
   message when the limit is hit, suggesting the token.
8. **"Newer release" badge in the launcher.** The logic exists (`src/backend/playnite.js`
   `updateAvailable`, `installs.js`); move it into core and show a badge on installed cards whose
   source has a newer release, with an Update button that reinstalls into the same folder. No
   automatic updates.
9. **Live ports job, binaries only.** Bring back a non-blocking scheduled CI job (nightly plus
   workflow_dispatch) that really installs the Acceptance tiles below into a temp folder with the
   app's own install engine, against the real GitHub and GitLab: pick the release asset, download,
   extract, list what landed. No game data. It catches a port renaming its release files or
   breaking its filter. Report results in the job summary; failures never block PRs. The old
   collision version lives on `parked/collisions` (`scripts/live-port.js`,
   `.github/workflows/live-ports.yml`) and can be the starting point.
10. **README**: replace it with exactly the text in "README" below; move Development and Releases
   into `docs/DEVELOPMENT.md`; remove the upstream screenshot.
11. **Builds:** add macOS (`.dmg`) and Linux (`.AppImage`) jobs to `release.yml`, labelled
   community-supported; add `CONTRIBUTING.md`: "I only test Windows. Mac and Linux builds are
   community-supported. PRs that add sources, catalog entries or asset filters for other
   platforms are welcome."

## Acceptance: installs must work

Before calling the shelf done, prove these install end to end with `mise run sandbox` and attach
the log lines to the PR:

| tile | source | why |
|---|---|---|
| Zelda 64: Recompiled | GitHub | the common case |
| Star Fox 64: Recompiled | GitLab | item 5 |
| Quake (ironwail) | GitHub, owner pick | releaseAssetFilter `win64` |
| Doom Launcher | GitHub, owner pick | two zips in the release; the portable one must win |
| r2modman | GitHub, owner pick | portable exe, not the Setup installer |
| a "source only" entry | n/a | shows no Install button |

## README

Use this text exactly:

```markdown
# y4bo

A launcher that downloads and installs games and ports from archive.org and GitHub.
It's a semi-curated list: my picks are built in, and you can add your own.

I made this to test a CI/CD pipeline (see the commit history), not to show what a
proper frontend looks like. **The frontend is vibecoded.**

## What it does

- **archive.org:** browse a few uploaders I trust; one-click download and extract (zip, 7z, rar).
- **GitHub and GitLab:** install release builds of decomp and recomp ports.
- **Add your own:** single archive.org items or GitHub repos in a `user.json`.
  Want a different curated list? Fork it and build your own: [docs/BUILD-YOUR-OWN.md](docs/BUILD-YOUR-OWN.md).
- **Launch:** picks the right exe, or lets you choose when there are several.
- **Add to Steam:** adds an installed game to Steam as a non-Steam shortcut (Big Picture, Steam Deck).
- **Playtime:** tracks how long you've played each game.
- **Uninstall:** moves the game's folder to the Recycle Bin, so it can be undone.
- **Open folder:** opens the install folder, for adding data files, mods or saves by hand.
- **Updates:** the launcher updates itself; installed ports show when a newer release is out.
- **Playnite:** the [RohanKar extension](https://github.com/yabo-san/playnite-extensions/releases?q=rohankar-playnite) puts your library in Playnite.

## Install

Download `y4bo-Setup-x.x.x.exe` from the [latest release](https://github.com/yabo-san/RohanKar-Launcher/releases/latest).
SmartScreen will warn (unsigned): **More info, then Run anyway**.
Verify a download: `gh attestation verify y4bo-Setup-x.x.x.exe --repo yabo-san/RohanKar-Launcher`

## Credits

Fork of the RohanKar Launcher by Kilted-Kraken. Not affiliated with the Internet Archive.
Games belong to their owners and are hosted publicly on archive.org.
```

## Rules

Logic in core, the renderer only renders. Tests for every core change. No network in tests.
Before/after and `mise run ui` screenshots in every UI PR. No em dashes in docs or PR text.
