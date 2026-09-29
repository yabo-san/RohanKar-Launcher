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
- Writes a CSV report; changes nothing in any repo.

Usage: python3 pstriple-art.py path/to/favorite-artists.json
"""
import csv, hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

UPLOADER = "frankiemiqueli1@gmail.com"
KEY = os.environ.get("STEAMGRIDDB_API_KEY")
if not KEY:
    sys.exit("STEAMGRIDDB_API_KEY is not set")

HERE = Path(__file__).resolve().parent
OUT = HERE / "pstriple-art.csv"
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)

favs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["artists"]
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


def game_name(title):
    # Bundle titles carry the emulator and extras; keep the game.
    t = re.sub(r"\[.*?\]|\(.*?\)", "", title)
    t = re.split(r"\s[-|:]\s|\+", t)[0]
    for junk in ["RPCS3", "shadPS4", "PCSX2", "Recompiled", "Preconfigured", "Bundle", "Online Revived"]:
        t = re.sub(r"\b" + re.escape(junk) + r"\b", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip(" -:")


def cover(term):
    s = sgdb("/search/autocomplete/" + urllib.parse.quote(term))
    if not s or not s.get("data"):
        return None, None, None, None
    game = s["data"][0]
    grids = (sgdb(f"/grids/game/{game['id']}?dimensions=600x900&types=static") or {}).get("data") or []
    fav = [g for g in grids if str((g.get("author") or {}).get("steam64") or "") in RANK]
    if not fav:
        return game["name"], None, None, None
    fav.sort(key=lambda g: (RANK[str(g["author"]["steam64"])], g.get("style") != "no_logo"))
    g = fav[0]
    return game["name"], g["url"], NAME[str(g["author"]["steam64"])], g.get("style")


rows = []
docs = items()
print(f"{len(docs)} items from pstriple", flush=True)
for d in docs:
    term = game_name(d.get("title") or d["identifier"])
    matched, url, artist, style = cover(term)
    rows.append([d["identifier"], d.get("title", ""), term, matched or "", artist or "", style or "", url or ""])

with OUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["identifier", "ia_title", "searched", "sgdb_game", "artist", "style", "cover_url"])
    w.writerows(rows)
hit = sum(1 for r in rows if r[6])
print(f"{hit}/{len(rows)} have a curated-artist portrait cover. Report: {OUT}")
