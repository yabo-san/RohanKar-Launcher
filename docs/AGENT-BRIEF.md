# Agent brief: the smallest launcher that does the job

Read `PRODUCT.md` first. This file is the work order.

## Goal

This fork supersedes upstream RohanKar (`Kilted-Kraken/-RohanKar-Launcher`) and Quiver with the
smallest feature set that does the job. Users of either switch to it and lose nothing: a Quiver user
imports their library, an upstream RohanKar user installs over their copy and keeps their data
folder, library and installed games. Neither is integrated with: nothing is written back to them.
Upstream's commits still arrive through the weekly upstream-sync PR and are taken only where they
help; upstream is a source of fixes, not a roadmap.

## The product, in full

- **Sources:** our curated archive.org uploaders plus any uploader the user adds.
- **Ports:** Quiver's community catalogs (port shelves stay) plus any catalog URL or GitHub repo the
  user adds. A port installs its release binary only; game data is the user's job.
- **Quiver import:** a Quiver library (`apps.json` + `Apps/` folder), adopting every entry without
  reinstalling.
- **Playnite export:** `playnite-export.json` + `--export-playnite` stays; it feeds our one
  extension (`yabo-san/playnite-extensions`). Schema in [PLAYNITE-EXPORT.md](PLAYNITE-EXPORT.md).
- **Curation:** `overrides.json`, `catalog/art.json` (SteamGridDB) and the dupe handling (separate
  cards where a shared title would merge uploads).

Anything not on this list is out.

## Removed from the plan

User.json collisions, mods, portable mode, announcements, manual apps, tags/search. Collisions (a
port joined to the archive.org data it needs) are parked on the `parked/collisions` branch, not
deleted; nothing on main depends on them.

## Work order

One PR per item, against `main`, in this order. `git fetch` and list open PRs before each; stop
after each for the merge; don't stack on unmerged PRs.

1. **Park collisions.** `parked/collisions` from main, pushed. On main remove
   `catalog/collisions.json`, `catalog/ia-matches.json`, the collisions fetch, data-file staging,
   sha1-of-staged-data verification, `.bps` handling and the "Binary: GitHub, Data: archive.org" /
   "needs <file>" card text, with their tests. The PR says where the code lives and how many lines
   it removed.
2. **Art.** Drop the `hero.png` special case (code, README note, docs). A card's cover and banner
   come from, in order: the `overrides.json` `artUrl` if pinned, else the archive.org item's own
   image, else `catalog/art.json`. Nothing else.
3. **Releases.** No drafts left behind: a release is published as a prerelease automatically once
   the installer is attached and the packaged smoke test passes; stable promotion stays a manual PR.
   Publish the latest existing draft and delete the stale ones (cloud sessions can't edit releases;
   give the owner the `gh` commands, `-R yabo-san/RohanKar-Launcher`).
4. **Settings > Sources.** One place to add or remove an archive.org uploader, a GitHub repo, or a
   Quiver catalog URL. The first time, a Cider-style modal (patterns from
   `yabo-san/yabo-launcher` `dev/archive/cider-ui-map.md`, copied into `docs/` where used):
   "Warning: we do not monitor additional sources. Make sure you trust the repo or uploader before
   you add it." User-added entries show a "Your source" badge.
5. **Quiver library import**, with a real-shaped `apps.json` fixture under `test/fixtures`.
6. **README.** Replaced with the owner's text; the current Development and Releases sections move
   unchanged into `docs/DEVELOPMENT.md`; the upstream screenshot goes.

## Rules

- Logic in core (`src/backend/`), the renderer only renders.
- Tests for every core change; no network in tests (fixtures only, never live GitHub or
  archive.org).
- Before/after in every PR description; `mise run ui` for the screenshots in every UI PR.
- No new runtime dependencies without saying why.
- Conventional-commit titles. Merging is a human step.
