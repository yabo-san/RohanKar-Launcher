# What this launcher is

One launcher, two kinds of shelf, one install button.

## What you see

The default view is a scrollable wall of everything the curated archive.org uploaders have posted:
PC games, cover art, one card per title, a version picker when two uploaders have the same game.
That is the archive.org half, working today.

Next to it, a Ports area: shelves named Nintendo, PlayStation, Xbox, Other, pulled from Quiver's
community catalogs. Each shelf lists open-source ports and recompilations. You browse a shelf, hit
Add, and the port sits in your library beside the archive.org games. That is the Quiver half.

## What happens on Install

- An archive.org game: download the item, extract, run its setup if it has one, register it.
- A port: look up its latest GitHub or GitLab release, pick the Windows asset, download, extract.
- A port that needs game data: the part nobody else has. The collision catalog says, for that
  repository, which archive.org item and which file inside it is the data the port needs, and what
  its sha1 must be after staging. The launcher fetches both halves, puts the data where the port
  expects it, verifies the hash, applies a translation patch if the entry names one, and the port is
  playable in one click. Ship of Harkinian plus the Ocarina ROM from the right uploader, verified,
  is the canonical example.

## What it tracks

A library database: what is installed, from which source, at which version, whether a newer port
release exists, whether the data still hashes clean. Add to Steam writes the shortcut. Adopt-existing
recognises installs already on disk instead of re-downloading them.

## What sits behind it

Three inputs, one model:

| feed | what it is | who curates |
| --- | --- | --- |
| `uploaders.json` | archive.org uploader accounts to search | this repo |
| Quiver catalogs | `apps.json` files of ports, by console | `tgeorgiadis/quiver-community-app-catalog`, by PR |
| `collisions.json` | repository to archive item and path, with sha1 per data file | this project's catalog |

All three are files, fetched at launch, cached, joined on `repository` in `src/core/` with no UI in
it. The renderer reads that model over IPC. The current web UI is a placeholder for a custom one;
the model and the sources are what we keep.

No feed is a service. Every feed is a file in Git that changes by pull request.

## In one sentence

A game launcher where the games come from archive.org and the ports come from GitHub, and the only
one that knows how to put the two together.
