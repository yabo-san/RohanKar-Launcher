"""SteamGridDB and archive.org helpers shared by the box-art scripts
(pstriple-art.py for covers, banners.py for the Home banners, grid-lookup.py
for pasted page links).

- Every JSON response is cached to scripts/box-art/cache, so a re-run does not
  re-fetch; archive.org is paced at one request per second and Retry-After is
  honoured.
- The SteamGridDB key comes from the STEAMGRIDDB_API_KEY environment secret only.
- Curated artists come from catalog/favorite-artists.json, in priority order.
"""
import hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

KEY = os.environ.get("STEAMGRIDDB_API_KEY", "")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / "cache"
API = "https://www.steamgriddb.com/api/v2"

# Minimum seconds between live requests, per host.
PACE = {"archive.org": 1.0, "www.steamgriddb.com": 0.25}
_last = {}


def get(url, headers=None):
    """JSON from url, cached on disk; None on a 404 or after five failed tries."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))

    host = urllib.parse.urlparse(url).hostname
    req = urllib.request.Request(url, headers={"User-Agent": "yabo", **(headers or {})})
    for _ in range(5):
        wait = PACE.get(host, 1.0) - (time.monotonic() - _last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.monotonic()
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
    return get(API + path, {"Authorization": "Bearer " + KEY})


def load_artists(path=ROOT / "catalog" / "favorite-artists.json"):
    """(rank, name): steam64 to priority index, and to display name."""
    favs = json.loads(Path(path).read_text(encoding="utf-8"))["artists"]
    return {str(a["steam64"]): i for i, a in enumerate(favs)}, {str(a["steam64"]): a["name"] for a in favs}


def steam64(asset):
    return str(((asset or {}).get("author") or {}).get("steam64") or "")


def votes(asset):
    return asset.get("score", (asset.get("upvotes") or 0) - (asset.get("downvotes") or 0))


def curated(assets, rank):
    """The best asset by a curated artist: artist priority first, then no_logo."""
    fav = [a for a in assets if steam64(a) in rank]
    fav.sort(key=lambda a: (rank[steam64(a)], a.get("style") != "no_logo"))
    return fav[0] if fav else None


def ranked(assets, rank):
    # Curated artists first (in priority order), then no_logo, then votes
    return sorted(assets, key=lambda a: (rank.get(steam64(a), len(rank)), a.get("style") != "no_logo", -votes(a)))


def art_entry(a, rank):
    au = a.get("author") or {}
    return {"id": a.get("id"), "url": a.get("url"), "artist": au.get("name"), "steam64": steam64(a),
            "style": a.get("style"), "votes": votes(a), "curated": steam64(a) in rank}


# Titles too abbreviated or misspelled for the search, by archive.org
# identifier or port owner/repo (lowercase).
ALIASES = {
    "SpidermanWOS": "Spider-Man: Web of Shadows",
    "ResistanceOnline": "Resistance: Fall of Man",
    "TOKYOJUNGLERPCS3": "Tokyo Jungle",
    "pcsx-2-sly-1": "Sly Cooper and the Thievius Raccoonus",
    "rpcs-3-latest-mod-nation-racers-online": "ModNation Racers",
    "INFAMOUS1RPCS3": "inFAMOUS",
    "IronMan2-RPCS3": "Iron Man 2",
    "shadps-4-gr-2-branch": "Gravity Rush 2",
    "GRFork": "Gravity Rush Remastered",  # GR2fork build tagged "gravity rush 1" on archive.org
    "BBLauncher": "Bloodborne",  # Bloodborne on shadPS4, per catalog/uploaders.json
    "Pokestadia": "Pokémon Stadium",  # the Pokémon Stadium recomp
    "gen-1-recomp-guide-dramatic-shape-mod": "Pokémon Red Version",  # gen 1 recomp, not "GEN 2.1"
    "dragon-ball-z-raging-blast-2-rpcs3": "Dragon Ball: Raging Blast 2",
    "rag-doll-kung-fu-fists-of-plastic-rpcs3": "Rag Doll Kung Fu: Fists of Plastic",
    "devil-may-cry-4_202603": "Devil May Cry 4",
    "out-run-2006-coast-2-coast.-7z": "OutRun 2006: Coast 2 Coast",
    "perfect-dark-pc-port/perfect_dark": "Perfect Dark",
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


def find_game(term):
    """The first SteamGridDB game for a search term, skipping emulator entries
    (which match any title that still mentions one); None if nothing matches."""
    s = sgdb("/search/autocomplete/" + urllib.parse.quote(term))
    games = [g for g in (s or {}).get("data") or [] if "(Emulator)" not in g["name"]]
    return games[0] if games else None


def fetch_text(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "yabo", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


# A page link pasted from the site: www.steamgriddb.com/grid/<id> or /hero/<id>
PLURAL = {"grid": "grids", "hero": "heroes"}
PAGE_LINK = re.compile(r"^https?://(?:www\.)?steamgriddb\.com/(grid|hero)/(\d+)")


def lookup(kind, aid):
    """A grid or hero id (from its page link) to its CDN URL and artist: the API
    first, then the public page."""
    if KEY:
        try:
            d = json.loads(fetch_text(f"{API}/{PLURAL[kind]}/{aid}", {"Authorization": "Bearer " + KEY}))
            a = d.get("data") if d.get("success") else None
            if isinstance(a, list):
                a = a[0] if a else None
            if a and a.get("url"):
                au = a.get("author") or {}
                return {"url": a["url"], "width": a.get("width"), "height": a.get("height"),
                        "style": a.get("style"), "artist": au.get("name"), "steam64": au.get("steam64")}
        except (urllib.error.URLError, ValueError) as e:
            print(f"api {kind} {aid}: {e}", file=sys.stderr)
    try:
        html = fetch_text(f"https://www.steamgriddb.com/{kind}/{aid}")
    except urllib.error.URLError as e:
        print(f"page {kind} {aid}: {e}", file=sys.stderr)
        return None
    url = re.search(r"https://cdn2\.steamgriddb\.com/" + kind + r"/[0-9a-f]{32}\.(?:png|jpe?g|webp)", html)
    who = re.search(r"/profile/(?:steam/)?(\d{17})", html)
    name = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', html)
    return {"url": url and url.group(0), "steam64": who and who.group(1), "title": name and name.group(1)}
