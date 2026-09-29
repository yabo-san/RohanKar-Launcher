#!/usr/bin/env python3
"""Resolve SteamGridDB grid ids (from www.steamgriddb.com/grid/<id> links) to
their image URL and artist, so a pasted page link can be pinned in overrides.json.

  STEAMGRIDDB_API_KEY=... python3 scripts/box-art/grid-lookup.py 82619 [more ids]

Tries the API first, then the public grid page. Prints one JSON line per id.
"""
import json, os, re, sys, urllib.error, urllib.request

KEY = os.environ.get("STEAMGRIDDB_API_KEY", "")


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "yabo", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def from_api(gid):
    if not KEY:
        return None
    try:
        d = json.loads(fetch(f"https://www.steamgriddb.com/api/v2/grids/{gid}", {"Authorization": "Bearer " + KEY}))
    except (urllib.error.HTTPError, ValueError) as e:
        print(f"api {gid}: {e}", file=sys.stderr)
        return None
    g = d.get("data") if d.get("success") else None
    if isinstance(g, list):
        g = g[0] if g else None
    if not g or not g.get("url"):
        return None
    a = g.get("author") or {}
    return {"url": g["url"], "width": g.get("width"), "height": g.get("height"),
            "style": g.get("style"), "artist": a.get("name"), "steam64": a.get("steam64")}


def from_page(gid):
    html = fetch(f"https://www.steamgriddb.com/grid/{gid}")
    url = re.search(r'https://cdn2\.steamgriddb\.com/grid/[0-9a-f]{32}\.(?:png|jpe?g|webp)', html)
    who = re.search(r'/profile/(?:steam/)?(\d{17})', html)
    name = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', html)
    return {"url": url and url.group(0), "steam64": who and who.group(1), "title": name and name.group(1)}


for gid in (a for a in sys.argv[1:] if a.isdigit()):
    info = from_api(gid) or from_page(gid)
    print(json.dumps({"grid": gid, **info}))
