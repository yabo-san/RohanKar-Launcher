#!/usr/bin/env python3
"""Resolve SteamGridDB grid ids (from www.steamgriddb.com/grid/<id> links) to
their image URL and artist, so a pasted page link can be pinned in overrides.json.

  STEAMGRIDDB_API_KEY=... python3 scripts/box-art/grid-lookup.py 82619 [more ids]

Tries the API first, then the public grid page. Prints one JSON line per id.
"""
import json, sys

from sgdb import lookup

for gid in (a for a in sys.argv[1:] if a.isdigit()):
    print(json.dumps({"grid": gid, **(lookup("grid", gid) or {})}))
