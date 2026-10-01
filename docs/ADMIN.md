# Admin mode

The owner's console for the curated list, `catalog/collisions.json`: the collisions every user gets.
It runs from a source checkout, because the packaged app can't change the catalog bundled inside it.
Changes ship the usual way: commit the file, open a PR, merge.

```sh
mise run admin          # node scripts/sandbox.js --admin
```

That's the sandbox (real installs, everything under `./sandbox/`) with the backend's `--admin` flag.
The sidebar gains **New game tile…** and **Collisions database** above the Ports shelves.

## Making a game tile

The goal: pick the game data on archive.org, pick the GitHub release, and a tile appears that
installs in one click.

1. **New game tile…** opens the collision editor in admin mode. Type the repository (`owner/repo`)
   and a name. The shelf defaults to `y4bo ports`.
2. **Pick a release…** lists the repository's recent releases. Picking an asset sets the release
   pattern to its name with the version made a wildcard, so later releases keep matching
   (`Dusklight-v2.0.3-win32-x86_64.zip` becomes `(?i)^Dusklight-.+-win32-x86_64\.zip$`). The hint
   says what the pattern picks from the latest release.
3. **Executable**: when the release ships several (Perfect Dark ships one per region), name the one
   to launch.
4. **Game data**: search archive.org (e.g. `n64 tosec`), pick the item, then pick a file, a
   folder or the whole item from its file list. For a ROM zip, tick **Unpack the archive** and set
   **Save as** to the name the port expects; **Into folder** is where it goes.
5. **Preview** shows what an install places; **Save to the curated list** writes
   `catalog/collisions.json` and opens the new tile.

A game on the wall also has **Make a game tile…** in its details, which starts a tile with that
archive.org item as its data.

## The collisions database

Every curated entry: its repository, shelf and game data, with **Edit** and **Hide**. A hidden
entry (`"hidden": true`) only shows in admin mode, wherever it's listed: a way to gate a tile until
it installs cleanly. Hidden tiles carry a Hidden pill.

## Proving a port for real

The sandbox reaches the real GitHub and archive.org. CI does too: the **Live ports** job
(`scripts/live-port.js`) installs Perfect Dark and Dusklight from the curated list on every PR that
touches it, and `--ia item:regex` lists an archive.org item's files, to find the one a collision
should use. Run it by hand from the Actions tab with other repositories.

The schema is in [COLLISIONS.md](COLLISIONS.md); the routes in [API.md](API.md#admin-mode).
