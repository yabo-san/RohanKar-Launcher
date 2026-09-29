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

Usage: python3 pstriple-art.py [--artists catalog/favorite-artists.json] [--overrides overrides.json]
"""
import argparse, csv, hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

UPLOADER = "frankiemiqueli1@gmail.com"
KEY = os.environ.get("STEAMGRIDDB_API_KEY")
if not KEY:
    sys.exit("STEAMGRIDDB_API_KEY is not set")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = HERE / "pstriple-art.csv"
BATCH = HERE / "batch.md"
CANDIDATES = HERE / "candidates.csv"
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)

ap = argparse.ArgumentParser()
ap.add_argument("--artists", type=Path, default=ROOT / "catalog" / "favorite-artists.json")
ap.add_argument("--overrides", type=Path, default=ROOT / "overrides.json")
args = ap.parse_args()

favs = json.loads(args.artists.read_text(encoding="utf-8"))["artists"]
RANK = {str(a["steam64"]): i for i, a in enumerate(favs)}
NAME = {str(a["steam64"]): a["name"] for a in favs}

# Minimum seconds between live requests, per host.
PACE = {"archive.org": 1.0, "www.steamgriddb.com": 0.25}
last = {}


def get(url, headers=None):
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))

    host = urllib.parse.urlparse(url).hostname
    req = urllib.request.Request(url, headers={"User-Agent": "yabo", **(headers or {})})
    for _ in range(5):
        wait = PACE.get(host, 1.0) - (time.monotonic() - last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        last[host] = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            path.write_text(json.dumps(data), encoding="utf-8")
            return data
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                retry = e.headers.get("Retry-After")
                time.sleep(float(retry) if retry and retry.isdigit() else 30)
                continue
            if e.code == 404:
                path.write_text("null", encoding="utf-8")
            return None
        except Exception:
            time.sleep(5)
    return None


def sgdb(path):
    return get("https://www.steamgriddb.com/api/v2" + path, {"Authorization": "Bearer " + KEY})


def items():
    q = urllib.parse.urlencode(
        {"q": f'uploader:"{UPLOADER}"', "fl[]": ["identifier", "title"], "rows": 500, "output": "json"},
        doseq=True,
    )
    res = get("https://archive.org/advancedsearch.php?" + q) or {}
    return res.get("response", {}).get("docs", [])


# Titles too abbreviated or misspelled for the search, by archive.org identifier.
ALIASES = {
    "SpidermanWOS": "Spider-Man: Web of Shadows",
    "ResistanceOnline": "Resistance: Fall of Man",
    "TOKYOJUNGLERPCS3": "Tokyo Jungle",
    "pcsx-2-sly-1": "Sly Cooper and the Thievius Raccoonus",
    "rpcs-3-latest-mod-nation-racers-online": "ModNation Racers",
    "INFAMOUS1RPCS3": "inFAMOUS",
    "IronMan2-RPCS3": "Iron Man 2",
    "shadps-4-gr-2-branch": "Gravity Rush 2",
    "BBLauncher": "Bloodborne",  # Bloodborne on shadPS4, per catalog/uploaders.json
}

# Emulator names, build numbers and extras that bundle titles carry around the game.
JUNK = [
    r"R[PC]{2}S\s?3", r"PCSX\s?2", r"Shad\s?PS\s?4", r"Recompiled", r"Preconfigured", r"Bundle",
    r"Online Revived", r"Build[- ]?(\d[\d.]*(\s\d+)?)?", r"Latest", r"Patched", r"Multiplayer",
    r"Revived", r"DLC", r"ONLINE",
]


def game_name(title):
    t = re.sub(r"\[.*?\]|\(.*?\)", "", title)
    t = re.split(r"\s[-|:]\s|\+", t)[0]
    for junk in JUNK:
        t = re.sub(r"\b" + junk + r"\b", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip(" -:")


def curated(assets):
    """The best asset by a curated artist: artist priority first, then no_logo."""
    fav = [a for a in assets if str((a.get("author") or {}).get("steam64") or "") in RANK]
    fav.sort(key=lambda a: (RANK[str(a["author"]["steam64"])], a.get("style") != "no_logo"))
    return fav[0] if fav else None


def cover(term):
    """(matched game name, cover grid, hero, all portrait grids) for a search term."""
    s = sgdb("/search/autocomplete/" + urllib.parse.quote(term))
    # Skip emulator entries, which match any title that still mentions one.
    games = [g for g in (s or {}).get("data") or [] if "(Emulator)" not in g["name"]]
    if not games:
        return None, None, None, []
    game = games[0]
    grids = (sgdb(f"/grids/game/{game['id']}?dimensions=600x900&types=static") or {}).get("data") or []
    g = curated(grids)
    if not g:
        return game["name"], None, None, grids
    heroes = (sgdb(f"/heroes/game/{game['id']}?dimensions=1920x620&types=static") or {}).get("data") or []
    return game["name"], g, curated(heroes), grids


def artist(asset):
    return NAME[str(asset["author"]["steam64"])] if asset else ""


def votes(asset):
    return asset.get("score", (asset.get("upvotes") or 0) - (asset.get("downvotes") or 0))


rows = []
candidates = []
docs = items()
print(f"{len(docs)} items from pstriple", flush=True)
for d in docs:
    term = ALIASES.get(d["identifier"]) or game_name(d.get("title") or d["identifier"])
    matched, g, h, grids = cover(term)
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
