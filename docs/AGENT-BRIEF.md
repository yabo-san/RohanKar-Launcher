# Agent brief

This file is the brief. Read it before every PR. It replaces the earlier brief (collisions,
Quiver parity); that plan is retired.

## The user loop

This is the definition of the product. A feature that doesn't serve one of these steps doesn't
belong in the app. Curation is not the point.

1. **Add.** The user pastes a link.
   - An archive.org link adds a catalogue: either the single upload, or the uploader's whole
     account. For a single upload's link, ask which one they mean.
   - A GitHub or GitLab repo link adds a binary.
2. **Browse.** Games come from the user's catalogues and Ports from their repos. Right-click
   excludes an upload from a catalogue, and the exclusion can be undone.
3. **Install.** One click.
   - A repo installs its latest release's Windows build. A repo with no build stays as a tile
     that opens its page.
   - An archive.org upload downloads, and a zip, 7z or rar is extracted. Playing it only really
     works for uploads shaped like Rohan's (one game per upload, ready to run). Anything else is
     just downloaded: for that the app is an archive.org download manager, and the app and README
     say so plainly.
4. **Play.** Play, Add to Steam, Open folder, uninstall to the Recycle Bin, and the Playnite export.
5. **Update.** The launcher updates both: a repo with a newer release, and a catalogue with new or
   changed uploads, get a badge and a one-click update. It never updates on its own.

The app ships with a starting set: the uploaders in `catalog/uploaders.json` (Rohan, r4ze,
pstriple) and K's personal picks in `catalog/curated-ports.json` (GoldenEye 007 via Project Midas, Perfect Dark,
Star Fox 64: Recompiled, plus Doom Retro, DSDA-Doom, Doom Launcher, ironwail, QuakeInjector and DevilutionX). Given the state of AI game porting, the launcher offers no judgement on
which ports are good: only K adds picks; don't grow them into a recommendation list; users add any other
repo themselves. `curated-ports.json` is edited by hand, by pull request; never write the outside
list it was once scraped from (URL, document ID or author) anywhere. It vouches for nothing: no badges, gates or warnings that set
built-in sources apart from what users add. The art and title work in `overrides.json` and
`catalog/art.json` stays, because it makes the starting set look right.

The finished work orders are in git history. Where anything disagrees with this loop, the loop wins.

## User data

- What a user installed lives in their local `library.db` and survives updates and reinstalls of
  the app. Never migrate it in a way that drops entries.
- What a user added lives on their machine. Never copy it into the repo.
- Uninstall moves the folder to the Recycle Bin; it never deletes outright.
- The downloaded archive is deleted once an install succeeds.
- An install saves the game's title and upload date in its row, so an upload pulled from
  archive.org keeps its name (in the app and the Playnite export) and stays as an installed copy.
  A pulled copy joins the card of a loaded upload with the same title, else gets its own card.
- A reupload of an installed game is its update: Update unpacks it over the same folder and keeps
  the same library entry and Playnite id; the row's `upload` says which upload it now holds.
- Never change the default install folder: Playnite and existing installs depend on it.

## Out of scope. Do not build, propose or reopen

- Collisions of any kind (port + data, launcher + engine + data + config). The code is parked on
  `parked/collisions`.
- Grouping tiles into one card, or several Play actions per Playnite game.
- Any mod support: no mod manager, no "browse mods" or "open mods folder", no links to mod sites.
  The Thunderstore mod manager (r2modman) is just another tile in `curated-ports.json`.
- Search UIs for /idgames, Quaddicted or similar. Doom and Quake are separate tiles.
- Announcements, manual apps, Android.
- A second interface. The classic UI is gone; there is one UI, `src/frontend/new/`. Gamepad
  navigation, collections editing and notes went with it (collections still export as Playnite
  tags, from what library.db holds).
- Quiver compatibility: no full-Quiver-catalog toggle, no Quiver library import (both removed).
  The shelf file keeps Quiver's catalog shape only because installed copies of the app read it.
- A Home page, a separate "add to library" step, or a Playnite export button (the export file is
  still written on every library change). The sidebar is Library, Packs, Ports, What's new and
  Settings.
- In-app updates of the app itself (K, 2026-11-11). Users get builds from GitHub releases. The
  update check in `src/electron/main.js` is off unless `checkForUpdates` is set in settings.json,
  and Settings has no switch for it.

## Acceptance: installs must work

Before calling the shelf done, prove these install end to end with `mise run sandbox` and attach
the log lines to the PR:

| tile | source | why |
|---|---|---|
| GoldenEye 007 (Project Midas) | GitHub | a `.7z` release (needs 7-Zip); releaseAssetFilter `windows` skips the Linux and Steam Deck builds |
| Perfect Dark | GitHub | the common case; the release zip holds one folder |
| Star Fox 64: Recompiled | GitLab | installs from GitLab's releases API |

## Rules

No curation framing in the UI (K, 2026-10-15): no Curated or "not reviewed" badges, no trust
warnings or switches in front of what users add. What ships is a starting list; users add
uploaders, uploads and repos freely. Logic in core, the renderer only renders. Tests for every core change. No network in tests.
Before/after and `mise run ui` screenshots in every UI PR. No em dashes in docs or PR text.
