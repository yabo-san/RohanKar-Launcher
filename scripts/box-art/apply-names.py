#!/usr/bin/env python3
"""Write K's display names from a CSV into overrides.json as title.

  python3 scripts/box-art/apply-names.py pstriple-art.csv [--overrides overrides.json]

Reads the identifier and name_override columns. A non-blank name_override sets
that item's title; a blank one leaves overrides.json as it is. Art is untouched.
"""
import argparse, csv, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("csv", type=Path)
ap.add_argument("--overrides", type=Path, default=ROOT / "overrides.json")
args = ap.parse_args()

overrides = json.loads(args.overrides.read_text(encoding="utf-8"))
changed = []
with args.csv.open(newline="", encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        ident, name = (row.get("identifier") or "").strip(), (row.get("name_override") or "").strip()
        if not ident or not name:
            continue
        entry = overrides.setdefault(ident, {})
        if entry.get("title") != name:
            entry["title"] = name
            changed.append((ident, name))
args.overrides.write_text(json.dumps(overrides, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
for ident, name in changed:
    print(f"{ident}: {name}")
print(f"{len(changed)} title(s) set in {args.overrides.name}.")
