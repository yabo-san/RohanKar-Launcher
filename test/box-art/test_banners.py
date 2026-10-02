"""The Home banner picks in scripts/box-art/banners.py, on fixture data (no network).
Run by test/box-art.test.js, or: python3 -m unittest discover -s test/box-art"""
import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "box-art"))
from banners import choose_hero, pick_key, plan  # noqa: E402

CDN = "https://cdn2.steamgriddb.com/hero/{}.png"
# favorite-artists.json order: Mania (0), then Julia (1)
RANK = {"111": 0, "222": 1}
NAMES = {"111": "Mr. Mania", "222": "Julia"}


def hero(hid, who, votes=0, style="alternate"):
    return {"id": hid, "url": CDN.format(f"h{hid}"), "style": style, "score": votes,
            "author": {"name": f"user{who}", "steam64": who}}


HEROES = {
    "a": [hero(1, "999", votes=50), hero(2, "222"), hero(3, "111"), hero(4, "111", style="no_logo")],
    "b": [hero(5, "999", votes=3), hero(6, "888", votes=9), hero(7, "777", votes=9)],
    "owner/port": [],
}
GAMES = {"a": {"id": 10, "name": "Game A"}, "b": {"id": 11, "name": "Game B"},
         "owner/port": {"id": 12, "name": "Game C"}}


def heroes_for(pick, key):
    return GAMES.get(key), HEROES.get(key, [])


def resolve(hid):
    return {"url": CDN.format(f"page{hid}"), "artist": "Pinner"} if hid != "404" else None


class ChooseHero(unittest.TestCase):
    def test_favorite_artists_in_priority_order_then_no_logo(self):
        h, fav = choose_hero(HEROES["a"], RANK)
        self.assertEqual((h["id"], fav), (4, True))  # Mania beats Julia and the top-voted hero; no_logo first

    def test_lower_priority_artist_when_the_first_has_none(self):
        h, fav = choose_hero([hero(1, "999", votes=50), hero(2, "222")], RANK)
        self.assertEqual((h["id"], fav), (2, True))

    def test_top_voted_fallback_first_on_a_tie(self):
        h, fav = choose_hero(HEROES["b"], RANK)
        self.assertEqual((h["id"], fav), (6, False))

    def test_none(self):
        self.assertEqual(choose_hero([], RANK), (None, False))
        self.assertEqual(choose_hero([{"id": 1, "url": ""}], RANK), (None, False))


class Plan(unittest.TestCase):
    def test_auto_entries(self):
        picks = [{"identifier": "a"}, {"identifier": "b"}, {"repository": "Owner/Port"}, {"identifier": "zzz"}]
        out, report = plan(picks, {"_comment": "x", "owner/port": {"url": CDN.format("old"), "source": "auto"}},
                           heroes_for, resolve, RANK, NAMES)
        self.assertEqual(out["a"], {"url": CDN.format("h4"), "source": "auto", "hero": 4, "artist": "Mr. Mania",
                                    "steam64": "111", "favorite": True, "sgdb": {"id": 10, "name": "Game A"}})
        self.assertEqual((out["b"]["hero"], out["b"]["favorite"], out["b"]["artist"]), (6, False, "user888"))
        self.assertNotIn("owner/port", out)  # no hero any more: dropped, the launcher shows a plain banner
        self.assertNotIn("zzz", out)  # no SteamGridDB game
        self.assertEqual(out["_comment"], "x")
        self.assertEqual([r[1] for r in report], ["favorite artist", "top voted (no favorite artist)", "no hero yet", "no SteamGridDB game"])

    def test_pins_win_and_are_never_overwritten(self):
        pinned = {"url": CDN.format("mine"), "source": "pinned", "note": "K's pick"}
        picks = [{"identifier": "a"}, {"identifier": "b", "banner": CDN.format("featured")}]
        out, _ = plan(picks, {"a": pinned, "b": {"url": CDN.format("h6"), "source": "auto"}}, heroes_for, resolve, RANK, NAMES)
        self.assertEqual(out["a"], pinned)  # banners.json pin untouched, favourite artist or not
        self.assertEqual(out["b"], {"url": CDN.format("featured"), "source": "pinned"})  # featured.json pin beats auto

    def test_pinned_page_links_resolve_to_cdn(self):
        picks = [{"identifier": "a", "banner": "https://www.steamgriddb.com/hero/42"}, {"identifier": "b"}, {"identifier": "c"}]
        banners = {"b": {"url": "https://www.steamgriddb.com/hero/43", "source": "pinned"},
                   "c": {"url": "https://www.steamgriddb.com/hero/404", "source": "pinned"}}
        out, report = plan(picks, banners, heroes_for, resolve, RANK, NAMES)
        self.assertEqual(out["a"], {"url": CDN.format("page42"), "source": "pinned", "hero": 42, "artist": "Pinner"})
        self.assertEqual(out["b"], {"url": CDN.format("page43"), "source": "pinned", "hero": 43, "artist": "Pinner"})
        self.assertEqual(out["c"], banners["c"])  # unresolved: left alone, never replaced by an auto pick
        self.assertIn("not resolved", report[2][1])

    def test_keys(self):
        self.assertEqual(pick_key({"identifier": " x "}), "x")
        self.assertEqual(pick_key({"repository": "A/B"}), "a/b")
        self.assertIsNone(pick_key({}))


if __name__ == "__main__":
    unittest.main()
