#!/usr/bin/env python3
"""Home banners: one SteamGridDB hero per pick in catalog/featured.json,
written as the `banner` field of the pick's entry in catalog/art.json (keyed
by archive.org identifier, or lowercase owner/repo for a port), for every
source alike: archive.org uploads and GitHub ports.

Rules (K):
- Pins win and are never overwritten: a `banner` on a featured.json pick, or
  a `banner` in art.json with "source": "pinned". A pinned SteamGridDB page
  link (www.steamgriddb.com/hero/<id>) is resolved to its CDN URL here; the
  launcher only uses CDN URLs.
- Otherwise ("source": "auto"): the pick's game on SteamGridDB (matched as
  pstriple-art.py matches covers: the art.json game when it has one, else
  ALIASES or the cleaned title, through the autocomplete search), then its
  static heroes (1920x620 or 3840x1240). The first hero by an artist in
  catalog/favorite-artists.json, in that file's priority order (no_logo first
  within an artist), wins, marked "favorite": true. With none, the top-voted
  hero, marked "favorite": false. With no hero at all the banner is dropped
  and the launcher shows a plain banner until one exists. The rest of the
  art.json entry (covers) is never touched.
- Never a port's square icon or a portrait cover.
- Also writes banners.md (previews, for the PR body and the job summary).

Usage: STEAMGRIDDB_API_KEY=... python3 banners.py [--featured ...] [--art ...]
"""
import argparse, json, re, sys, urllib.parse
from pathlib import Path

CDN = re.compile(r"^https://cdn\d*\.steamgriddb\.com/hero/")
HERO_PAGE = re.compile(r"^https?://(?:www\.)?steamgriddb\.com/hero/(\d+)")


def pick_key(pick):
    ident = (pick.get("identifier") or "").strip()
    return ident or (pick.get("repository") or "").strip().lower() or None


def _steam64(asset):
    return str(((asset or {}).get("author") or {}).get("steam64") or "")


def _votes(asset):
    return asset.get("score", (asset.get("upvotes") or 0) - (asset.get("downvotes") or 0))


def choose_hero(heroes, rank):
    """(hero, favorite): the first hero by a favourite artist in priority order
    (no_logo first within an artist), else the top-voted one (the first on a
    tie), else (None, False)."""
    heroes = [h for h in heroes or [] if h.get("url")]
    fav = [h for h in heroes if _steam64(h) in rank]
    if fav:
        fav.sort(key=lambda h: (rank[_steam64(h)], h.get("style") != "no_logo"))
        return fav[0], True
    if heroes:
        return sorted(heroes, key=lambda h: -_votes(h))[0], False
    return None, False


def _pinned_from_link(link, resolve, old):
    """A pinned entry for a pinned URL: kept as is for a CDN URL, resolved for
    a hero page link. None when it can't be used."""
    if CDN.match(link):
        keep = {k: v for k, v in (old or {}).items() if k in ("artist", "hero")} if (old or {}).get("url") == link else {}
        return {"url": link, "source": "pinned", **keep}
    m = HERO_PAGE.match(link)
    if not m:
        return None
    info = resolve(m.group(1)) or {}
    if not info.get("url") or not CDN.match(info["url"]):
        return None
    entry = {"url": info["url"], "source": "pinned", "hero": int(m.group(1))}
    if info.get("artist"):
        entry["artist"] = info["artist"]
    return entry


def _set_banner(art, key, entry):
    """art with key's banner set to entry (None drops it, and an entry left
    with nothing else goes too). The rest of the entry stays as it was."""
    item = {k: v for k, v in (art.get(key) or {}).items() if k != "banner"} if isinstance(art.get(key), dict) else {}
    if entry:
        item["banner"] = entry
    if item:
        art[key] = item
    else:
        art.pop(key, None)


def plan(picks, art, heroes_for, resolve, rank, names=None):
    """The new art.json (banners set) and a report row per pick.

    picks: featured.json's picks; art: the current art.json;
    heroes_for(pick, key) -> (sgdb game or None, [hero, ...]);
    resolve(hero_id) -> {url, artist} or None; rank: steam64 -> priority.
    """
    names = names or {}
    out = dict(art)
    report = []
    for pick in picks:
        key = pick_key(pick)
        if not key:
            continue
        old = (art.get(key) or {}).get("banner") if isinstance(art.get(key), dict) else None
        old = old if isinstance(old, dict) else None
        pin = (pick.get("banner") or "").strip()
        if not pin and (old or {}).get("source") == "pinned" and CDN.match(old.get("url") or ""):
            report.append((key, "pinned", old))  # untouched
            continue
        if pin or (old or {}).get("source") == "pinned":
            link = pin or (old.get("url") or "").strip()
            entry = _pinned_from_link(link, resolve, old)
            if entry:
                _set_banner(out, key, entry)
                report.append((key, "pinned", entry))
            else:
                # An unusable pin still wins: leave whatever is there alone
                report.append((key, f"pinned link not resolved: {link}", old))
            continue
        game, heroes = heroes_for(pick, key)
        hero, favorite = choose_hero(heroes, rank)
        if not hero:
            _set_banner(out, key, None)
            report.append((key, "no hero yet" if game else "no SteamGridDB game", None))
            continue
        au = hero.get("author") or {}
        entry = {"url": hero["url"], "source": "auto", "hero": hero.get("id"),
                 "artist": names.get(_steam64(hero)) or au.get("name"), "steam64": _steam64(hero),
                 "favorite": favorite}
        if game:
            entry["sgdb"] = {"id": game["id"], "name": game["name"]}
        _set_banner(out, key, entry)
        report.append((key, "favorite artist" if favorite else "top voted (no favorite artist)", entry))
    return out, report


def _sorted(art):
    comments = {k: v for k, v in art.items() if k.startswith("_")}
    return {**comments, **dict(sorted((k, v) for k, v in art.items() if not k.startswith("_")))}


def main():
    import sgdb

    ap = argparse.ArgumentParser()
    ap.add_argument("--featured", type=Path, default=sgdb.ROOT / "catalog" / "featured.json")
    ap.add_argument("--art", type=Path, default=sgdb.ROOT / "catalog" / "art.json")
    ap.add_argument("--catalog", type=Path, default=sgdb.ROOT / "catalog" / "catalog.json")
    ap.add_argument("--artists", type=Path, default=sgdb.ROOT / "catalog" / "favorite-artists.json")
    ap.add_argument("--report", type=Path, default=sgdb.HERE / "banners.md")
    args = ap.parse_args()
    if not sgdb.KEY:
        sys.exit("STEAMGRIDDB_API_KEY is not set")

    rank, names = sgdb.load_artists(args.artists)
    picks = json.loads(args.featured.read_text(encoding="utf-8"))["picks"]
    art = json.loads(args.art.read_text(encoding="utf-8")) if args.art.exists() else {}
    ports = {str(a.get("repository", "")).lower(): a["name"]
             for a in json.loads(args.catalog.read_text(encoding="utf-8")).get("apps", []) if a.get("repository")}

    def term_for(pick, key):
        if key in sgdb.ALIASES:
            return sgdb.ALIASES[key]
        if pick.get("identifier"):
            meta = sgdb.get(f"https://archive.org/metadata/{urllib.parse.quote(key)}/metadata") or {}
            title = (meta.get("result") or {}).get("title") or key
            return sgdb.game_name(title if isinstance(title, str) else title[0])
        return sgdb.game_name(ports.get(key) or key.split("/")[-1].replace("_", " ").replace("-", " "))

    def heroes_for(pick, key):
        # The game art.json already matched for this item, else a search
        known = (art.get(key) or {}).get("sgdb")
        game = known or sgdb.find_game(term_for(pick, key))
        if not game:
            return None, []
        res = sgdb.sgdb(f"/heroes/game/{game['id']}?dimensions=1920x620,3840x1240&types=static") or {}
        return game, res.get("data") or []

    new, report = plan(picks, art, heroes_for, lambda hid: sgdb.lookup("hero", hid), rank, names)
    args.art.write_text(json.dumps(_sorted(new), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    with args.report.open("w", encoding="utf-8") as f:
        f.write("## Home banners (catalog/art.json)\n\n| pick | banner | how |\n| --- | --- | --- |\n")
        for key, how, entry in report:
            img = f'<img src="{entry["url"]}" width="320"><br>{entry.get("artist") or ""}' if entry else ""
            f.write(f"| `{key}` | {img} | {how} |\n")
    for key, how, _ in report:
        print(f"{key}: {how}")


if __name__ == "__main__":
    main()
