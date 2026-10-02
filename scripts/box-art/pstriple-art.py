#!/usr/bin/env python3
"""Box art for pstriple's Internet Archive collection (frankiemiqueli1, handles
hailstormttv and tirednonfire). None of these items have art yet.

Rules (K):
- Portrait 600x900 covers only, pinned grid URLs, only from the curated
  artists in yabo-launcher's favorite-artists.json, in priority order,
  no_logo preferred.
- archive.org: at most one request per second, honour Retry-After.
- Every response is cached to disk, so a re-run does not re-fetch.
- SteamGridDB key comes from the STEAMGRIDDB_API_KEY environment secret only.
- Approved rows (a curated-artist cover) go straight into overrides.json as
  artUrl, plus hero where a curated 1920x620 exists. Entries that already have
  art keep it. Never touches apps.json. Also writes a CSV report and batch.md
  (cover previews for the PR body).
- Items with no curated cover get their top three portrait candidates by any
  artist (no_logo first, then votes) in candidates.csv for K to pick from;
  items with none at all are marked "needs art". Candidates are never written.
- The CSV report has a name_override column: the title already in
  overrides.json, else the name of the SteamGridDB game the item matched (the
  display title is the SGDB game's name). apply-names.py writes non-blank
  values into overrides.json as title.
- catalog/art.json keeps every portrait grid and hero SteamGridDB has for each
  item (grid id, CDN URL, artist, style, votes), so picks and lookups read
  the repo instead of the API.

Usage: python3 pstriple-art.py [--artists catalog/favorite-artists.json] [--overrides overrides.json]
"""
import argparse, csv, json, sys, urllib.parse
from pathlib import Path

from sgdb import ALIASES, HERE, KEY, ROOT, art_entry, curated, find_game, game_name, get, load_artists, ranked, sgdb, steam64, votes

UPLOADER = "frankiemiqueli1@gmail.com"
if not KEY:
    sys.exit("STEAMGRIDDB_API_KEY is not set")

OUT = HERE / "pstriple-art.csv"
BATCH = HERE / "batch.md"
CANDIDATES = HERE / "candidates.csv"

ap = argparse.ArgumentParser()
ap.add_argument("--artists", type=Path, default=ROOT / "catalog" / "favorite-artists.json")
ap.add_argument("--overrides", type=Path, default=ROOT / "overrides.json")
ap.add_argument("--art", type=Path, default=ROOT / "catalog" / "art.json")
args = ap.parse_args()

RANK, NAME = load_artists(args.artists)


def items():
    q = urllib.parse.urlencode(
        {"q": f'uploader:"{UPLOADER}"', "fl[]": ["identifier", "title"], "rows": 500, "output": "json"},
        doseq=True,
    )
    res = get("https://archive.org/advancedsearch.php?" + q) or {}
    return res.get("response", {}).get("docs", [])


def cover(term):
    """(matched game, cover grid, hero, all portrait grids, all heroes) for a search term."""
    game = find_game(term)
    if not game:
        return None, None, None, [], []
    grids = (sgdb(f"/grids/game/{game['id']}?dimensions=600x900&types=static") or {}).get("data") or []
    heroes = (sgdb(f"/heroes/game/{game['id']}?dimensions=1920x620&types=static") or {}).get("data") or []
    g = curated(grids, RANK)
    return game, g, curated(heroes, RANK) if g else None, grids, heroes


def artist(asset):
    return NAME[steam64(asset)] if asset else ""


current = json.loads(args.overrides.read_text(encoding="utf-8"))
rows = []
candidates = []
art = {}
docs = items()
print(f"{len(docs)} items from pstriple", flush=True)
for d in docs:
    term = ALIASES.get(d["identifier"]) or game_name(d.get("title") or d["identifier"])
    game, g, h, grids, heroes = cover(term)
    matched = game and game["name"]
    art[d["identifier"]] = {
        "title": d.get("title", ""), "searched": term,
        "sgdb": {"id": game["id"], "name": game["name"]} if game else None,
        "grids": [art_entry(a, RANK) for a in ranked(grids, RANK)],
        "heroes": [art_entry(a, RANK) for a in ranked(heroes, RANK)],
    }
    if not g:
        # No curated art: top three portrait grids by anyone, no_logo first, then votes, for K to pick from.
        top = sorted(grids, key=lambda a: (a.get("style") != "no_logo", -votes(a)))[:3]
        for i, a in enumerate(top, 1):
            au = a.get("author") or {}
            candidates.append([d["identifier"], d.get("title", ""), matched or "", i, au.get("name") or "",
                               au.get("steam64") or "", a.get("style") or "", votes(a), a.get("url") or "", ""])
        if not top:
            candidates.append([d["identifier"], d.get("title", ""), matched or "", "", "", "", "", "", "", "needs art"])
    rows.append({
        "identifier": d["identifier"], "ia_title": d.get("title", ""), "searched": term,
        "sgdb_game": matched or "", "artist": artist(g), "style": (g or {}).get("style") or "",
        "cover_url": (g or {}).get("url") or "", "hero_artist": artist(h), "hero_url": (h or {}).get("url") or "",
        "name_override": (current.get(d["identifier"]) or {}).get("title") or matched or "",
    })

with OUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["identifier"])
    w.writeheader()
    w.writerows(rows)

# Candidates only feed K's picks; nothing from them is written anywhere else.
with CANDIDATES.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["identifier", "ia_title", "sgdb_game", "rank", "artist", "steam64", "style", "votes", "url", "pick"])
    w.writerows(candidates)

# The art catalog: everything found, curated or not, keyed by archive.org identifier.
# Home banners (the `banner` field, scripts/box-art/banners.py) carry over as they were.
old_art = json.loads(args.art.read_text(encoding="utf-8")) if args.art.exists() else {}
for key, entry in old_art.items():
    if isinstance(entry, dict) and entry.get("banner"):
        art.setdefault(key, {})["banner"] = entry["banner"]
args.art.write_text(json.dumps(dict(sorted(art.items())), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

# Approved rows into overrides.json; art already there (curated by hand or an earlier batch) wins.
overrides = json.loads(args.overrides.read_text(encoding="utf-8"))
added = []
for r in rows:
    if not r["cover_url"]:
        continue
    entry = overrides.setdefault(r["identifier"], {})
    new = {}
    if "artUrl" not in entry:
        new["artUrl"] = r["cover_url"]
    if r["hero_url"] and "hero" not in entry:
        new["hero"] = r["hero_url"]
    if new:
        entry.update(new)
        added.append((r, new))
    elif not entry:
        del overrides[r["identifier"]]
args.overrides.write_text(json.dumps(overrides, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

with BATCH.open("w", encoding="utf-8") as f:
    f.write(f"{len(added)} pstriple item(s) get curated SteamGridDB art in overrides.json.\n\n")
    f.write("| item | cover | hero |\n| --- | --- | --- |\n")
    for r, new in added:
        cov = f'<img src="{new["artUrl"]}" width="120"><br>{r["artist"]}' if "artUrl" in new else "kept"
        hero = f'<img src="{new["hero"]}" width="320"><br>{r["hero_artist"]}' if "hero" in new else ""
        f.write(f"| {r['ia_title']}<br>`{r['identifier']}`<br>matched: {r['sgdb_game']} | {cov} | {hero} |\n")

hit = sum(1 for r in rows if r["cover_url"])
print(f"{hit}/{len(rows)} have a curated-artist portrait cover; {len(added)} overrides entries added or extended.")
