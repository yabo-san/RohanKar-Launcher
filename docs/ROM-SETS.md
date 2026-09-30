# ROM sets and port recipes (draft)

Status: proposal, nothing here is built yet. It builds on [COLLISIONS.md](COLLISIONS.md) and keeps
every collision that exists today working.

## The problem

Today a collision pins its data: Perfect Dark says "take `Perfect Dark (USA) (Rev A).zip` from the
archive.org item `N64TOSEC`". That's fine for two games, but every port × every place its data
lives is another hand-written entry, and each odd case (a byteswapped ROM, a `.ciso` in a repack, a
folder of files) lands in whichever entry hit it first.

## Two kinds of entry

Split what a collision carries into the two things that vary on their own:

1. **ROM sets**: what's out there. "The archive.org item `N64TOSEC` is a set of N64 ROMs, one zip
   per ROM, named the No-Intro way." A set says nothing about any port. Users mount sets; we curate
   some.
2. **Port recipes**: what a port needs. "Perfect Dark needs the N64 game *Perfect Dark (USA) (Rev A)*,
   as `data/pd.ntsc-final.z64`, sha1 `af8788ac…`." A recipe says nothing about where the ROM lives.

The launcher joins them at install time: for each thing a recipe needs, it looks through the
mounted sets of that platform, takes the first that has the game, unpacks it, normalizes it and
checks the sha1. A new set needs no new recipes, and a new port needs one recipe, whatever sets
people have.

## ROM sets

```json
{
  "schemaVersion": 1,
  "sets": [
    { "id": "n64-tosec", "platform": "n64", "ia": "N64TOSEC", "naming": "no-intro", "layout": "zip-per-rom" },
    { "id": "my-gc-folder", "platform": "gc", "ia": "some-item", "path": "GameCube/*", "naming": "no-intro", "layout": "loose" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `platform` | One of the platform keys below. |
| `ia`, `path` | The same source shapes collisions already take: a whole item, a `folder/*`, or one file. Mounting "an entire ROM folder" and "one specific file" is the same entry. |
| `naming` | How a file's name maps to a game: `no-intro` (and TOSEC, which uses the same titles) strips the extension and matches the title with its region and revision tags, e.g. `Perfect Dark (USA) (Rev A)`. |
| `layout` | `zip-per-rom`: each game is an archive holding its one ROM. `loose`: the files are the ROMs. |

Where sets come from follows the rule already in place for every other source:

- **Curated**: `catalog/sets.json`, shipped with the app, on for everyone.
- **Mounted by the user**: Settings > ROM sets > Mount (an archive.org item, folder or file), or a
  subscribed feed's `sets`. These are additional sources: they apply only while Allow additional
  sources is on, and are badged "Your source · not reviewed".

## Port recipes

A recipe is a collision with `needs` in place of pinned `sources`:

```json
{
  "repository": "perfect-dark-pc-port/perfect_dark",
  "assetPattern": "(?i)^pd-x86_64-windows\\.zip$",
  "exe": "pd.x86_64.exe",
  "needs": [
    {
      "platform": "n64",
      "game": "Perfect Dark (USA) (Rev A)",
      "as": "pd.ntsc-final.z64",
      "target": "data",
      "sha1": "af8788ac4d1a57260eae9c53ffe851fcf2a3319b"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `platform`, `game` | What to look for. `game` may be a list of titles the port accepts, best first. |
| `as`, `target` | Where it lands, as in collisions today. |
| `sha1` | The file the port needs, after normalizing. May be a list. It's what keeps a mislabeled or bad dump out, whatever set it came from. |
| `formats` | Optional: the extensions the port reads, e.g. `["iso", "ciso"]`, when the platform has several. |
| `optional` | As in collisions today. |

## Matching, in order

1. Take the mounted sets for the recipe's platform: curated first, then the user's in mount order.
2. In each, find a file whose title (per the set's `naming`) equals one of `game`, ignoring case.
3. Download it and unpack it if the set's layout says so.
4. Normalize it by the platform's rules (below).
5. Check `sha1`. If it doesn't match, try the next candidate. If nothing matches, the install stops
   and says so: "Perfect Dark needs *Perfect Dark (USA) (Rev A)* (N64). Mount a set that has it."

archive.org lists a zip's own sha1, not the ROM's inside it, so matching goes by name first and
the sha1 check comes after unpacking. Shipping No-Intro DAT files in `catalog/` would let us check a
title against its sha1 before downloading; that's a later step.

## Platform rules

Special cases that belong to a platform are written once, here, not per port:

| Platform | Rule |
| --- | --- |
| `n64` | A ROM written as `.z64` is turned big-endian from `.v64`/`.n64` byte order (built in #96: TOSEC's Perfect Dark is a byteswapped `.n64`). |
| `gc` | No conversion. `formats` picks which of `iso`, `ciso`, `rvz`, `gcm` a port accepts. |

A platform gets a row when the first port that needs it arrives.

## Special cases that stay special

- **Pinned sources still work.** A collision with `sources` (today's shape) is kept as the escape
  hatch for data that isn't a ROM set: Dusklight's archive.org upload is a repack holding the
  `.ciso` and more, so it stays pinned until a GameCube set covers it.
- **Ports that ask for the ROM at first launch** and keep it in their own app data folder, not
  beside the exe. A recipe can't place files there yet; it would need a `placement` beyond the
  install folder. Out of scope for the first cut.

## How today's entries map

| Today | As a recipe |
| --- | --- |
| Perfect Dark: `sources: [{ ia: "N64TOSEC", path: "Perfect Dark (USA) (Rev A).zip", extract: true, as: … }]` | `needs: [{ platform: "n64", game: "Perfect Dark (USA) (Rev A)", as: …, sha1: … }]` plus the curated `n64-tosec` set. |
| Dusklight: `dataFiles` from `twilight-princess-ddsk` | Unchanged (pinned). |

## Rollout

1. Sets: `catalog/sets.json`, the Settings > ROM sets list and Mount, behind Allow additional
   sources for user sets. Tests on fixtures, no network.
2. Recipes: `needs` in the collision schema, validation, the matching above; Perfect Dark moves to
   it. The Live ports job proves it for real.
3. Admin console: "New game tile" picks a platform and a title from the mounted sets instead of a
   file, and fills in the sha1 from the first good install.
4. Later: No-Intro DATs, more platform rules as ports need them.
