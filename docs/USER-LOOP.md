# The user loop

```
                 FEEDS (files, pulled at launch, cached)
     +------------------+   +------------------+
     | uploaders.json   |   | Quiver catalogs  |
     | (curated IA)     |   | Nintendo/PS/Xbox |
     +--------+---------+   +--------+---------+
              | archive.org search   | apps.json
              v                      v
     +------------------+   +------------------+
  1  |  GAME WALL       |   |  PORT SHELVES    |
     |  (default view)  |   |  browse / review |
     +--------+---------+   +--------+---------+
              | pick a version       | Add   (Remove = out of library, files stay)
              +----------+-----------+
                         v
  2              +---------------+
                 |   LIBRARY     |  what is yours, not what exists
                 |  library.db   |  source, version, installed?
                 +-------+-------+
                         | Install
                         v
  3   +--------------------------------------------+
      | IA item  or  the GitHub release's binary   |  adopt if already on disk
      +-------+------------------------------------+
              |
  4           v
      +--------------+     Add to Steam
      |    PLAY      |--------------------->  shortcuts.vdf
      +-------+------+
              | next launch
  5           v
      +--------------------------------------------+
      | KEEP CURRENT                               |
      | catalog review: new / changed / removed    |--> back to 1 or 2
      | port: "newer release" badge (never auto)   |
      +--------------------------------------------+
```

## The five verbs

1. **Browse.** The wall is the default: everything the curated uploaders posted, scrollable. Shelves
   are the ports, by original console. Both are discovery; neither is yours yet.
2. **Add.** One click moves a thing into the library. The library is the only list the app manages
   for you.
3. **Install.** One button, whatever the source. A port installs its release binary only; game
   data is the user's job. If something is already on disk, it is adopted, not re-downloaded.
4. **Play.** Launch, or push to Steam and launch from there.
5. **Keep current.** The app tells you what changed in the feeds and which ports have a newer
   release; you decide. Nothing updates itself.

## Why this shape

The launcher today ingests one uploader account and shows it. That is a query, not a feed: nobody
curates it, nothing versions it, and if the account dies the wall goes blank.

Quiver's answer is that the feed is a JSON file in a Git repo that clients subscribe to, and adding
is a human step. Curation (someone decided this belongs) and subscription (the user decided it
belongs to them) are the two things the raw wall was missing.

Steps 1 and 5 are files that change by pull request. Step 2 is the user's decision. The app never
invents a list.
