# The user loop

```
                 FEEDS (files, pulled at launch, cached)
     +------------------+   +------------------+   +----------------------+
     | uploaders.json   |   | Quiver catalogs  |   | collisions.json      |
     | (curated IA)     |   | Nintendo/PS/Xbox |   | repo -> IA item::path|
     +--------+---------+   +--------+---------+   |        + sha1        |
              | archive.org search   | apps.json    +----------+-----------+
              v                      v                         | join on repository
     +------------------+   +------------------+               |
  1  |  GAME WALL       |   |  PORT SHELVES    |<--------------+
     |  (default view)  |   |  browse / review |   "data available" badge
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
      | binary: IA item  or  GitHub/GitLab release |
      | data:   IA item::path -> stage -> bps -> sha1 |  adopt if already on disk
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
      | data: re-hash; refetch only on mismatch    |
      +--------------------------------------------+
```

## The five verbs

1. **Browse.** The wall is the default: everything the curated uploaders posted, scrollable. Shelves
   are the ports, by original console. Both are discovery; neither is yours yet.
2. **Add.** One click moves a thing into the library. The library is the only list the app manages
   for you.
3. **Install.** One button, whatever the source. If the entry has a collision, the data comes down
   with the binary and is hashed after staging. If something is already on disk, it is adopted, not
   re-downloaded.
4. **Play.** Launch, or push to Steam and launch from there.
5. **Keep current.** The app tells you what changed in the feeds and which ports have a newer
   release; you decide. Nothing updates itself, and data is only refetched when it fails its hash.

## Why this shape

The launcher today ingests one uploader account and shows it. That is a query, not a feed: nobody
curates it, nothing versions it, and if the account dies the wall goes blank.

Quiver's answer is that the feed is a JSON file in a Git repo that clients subscribe to, and adding
is a human step. Curation (someone decided this belongs) and subscription (the user decided it
belongs to them) are the two things the raw wall was missing. The collision catalog is the same
mechanism one level deeper: a file in Git that says which data goes with which port.

Steps 1 and 5 are files that change by pull request. Step 2 is the user's decision. The app never
invents a list.
