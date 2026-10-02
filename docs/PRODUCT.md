# What this launcher is

A Windows launcher for PC games and ports, with the smallest feature set that does the job. It
supersedes upstream RohanKar and Quiver.

## The product, in full

- **Sources:** our curated archive.org uploaders, plus any uploader the user adds. The default view
  is a wall of everything they have posted: one card per title, a version picker when two
  uploaders have the same game.
- **Ports:** Quiver's community catalogs as port shelves (Nintendo, PlayStation, Xbox, Other), plus
  any catalog URL or GitHub repo the user adds. A port installs its release binary only; game data
  is the user's job.
- **Quiver users:** import a Quiver library (`apps.json` plus its `Apps/` folder) and keep every
  install, nothing downloaded again.
- **Playnite:** `playnite-export.json` (and `--export-playnite`) feeds our one Playnite extension.
- **Curation:** `overrides.json`, `catalog/art.json` (SteamGridDB) and the dupe handling (separate
  cards where a shared title would merge uploads).

## What happens on Install

- An archive.org game: download the item, extract, register it.
- A port: look up its latest GitHub release, pick the Windows asset, download, extract.

## What it tracks

A library database: what is installed, from which source, at which version, and whether a newer
port release exists. Add to Steam writes the shortcut. Adopt-existing recognises installs already
on disk instead of re-downloading them.

## What sits behind it

| feed | what it is | who curates |
| --- | --- | --- |
| `catalog/uploaders.json` | archive.org uploader accounts to search | this repo |
| Quiver catalogs | `apps.json` files of ports, by console | `tgeorgiadis/quiver-community-app-catalog`, by PR |
| `overrides.json`, `catalog/art.json` | titles, covers and banners | this repo |

All of them are files, fetched at launch and cached. The logic lives in the backend
(`src/backend/`) with no UI in it; the renderer only renders what the API serves.

Collisions (a port joined to the archive.org data it needs) are parked on the
`parked/collisions` branch, not deleted.
