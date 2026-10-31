"""Run: uv run python -m unittest discover -s scripts"""

import unittest

from build_races import apply_categories, build_races

META = {
    "senate": [
        {
            "contestId": "c1",
            "candidates": {
                "1": {"id": "1", "fullName": "Dana Dem", "party": "dem"},
                "2": {"id": "2", "fullName": "Rex Rep", "party": "gop"},
            },
        }
    ],
    "governor": [],
    "house": [],
}


def row(**over):
    base = {
        "Office": "Senate",
        "State/District": "AZ",
        "Special Election": "",
        "Harris 2-p": "47.2%",
        "Politico contest ID": "c1",
        "Politico Dem ID": "1",
        "Politico Rep ID": "2",
    }
    return {**base, **over}


class BuildRaces(unittest.TestCase):
    def test_good_row_carries_ids_and_politico_names(self):
        (race,) = build_races([row()], META)
        self.assertEqual(race["demName"], "Dana Dem")
        self.assertEqual(race["repName"], "Rex Rep")
        self.assertEqual(race["harris2p"], 0.472)
        self.assertEqual(race["attrs"], [])

    def test_bad_dem_id_fails_loudly(self):
        with self.assertRaises(SystemExit) as ctx:
            build_races([row(**{"Politico Dem ID": "99"})], META)
        self.assertIn("Dem ID 99 not in contest c1", str(ctx.exception))

    def test_unknown_contest_and_bad_harris_fail(self):
        with self.assertRaises(SystemExit):
            build_races([row(**{"Politico contest ID": "nope"})], META)
        with self.assertRaises(SystemExit):
            build_races([row(**{"Harris 2-p": "n/a"})], META)

    def test_attribute_columns(self):
        (race,) = build_races([row(**{"Sanders": "TRUE", "Other": "FALSE"})], META)
        self.assertEqual(race["attrs"], ["Sanders"])
        with self.assertRaises(SystemExit):
            build_races([row(**{"Sanders": "TURE"})], META)


CATS = [{"category": "Sanders Endorsed", "office": "Senate", "state/district": "AZ",
         "candidate": "Dana Dem", "check": "1"}]


class ApplyCategories(unittest.TestCase):
    def races(self):
        return build_races([row()], META)

    def test_adds_category_to_matching_race(self):
        races = apply_categories(self.races(), CATS)
        self.assertEqual(races[0]["attrs"], ["Sanders Endorsed"])

    def test_unmatched_row_and_name_mismatch_fail_loudly(self):
        with self.assertRaises(SystemExit) as ctx:
            apply_categories(self.races(), [{**CATS[0], "state/district": "TX"}])
        self.assertIn("matches no race", str(ctx.exception))
        with self.assertRaises(SystemExit) as ctx:
            apply_categories(self.races(), [{**CATS[0], "candidate": "Someone Else"}])
        self.assertIn("Someone Else", str(ctx.exception))

    def test_check_is_ignored_and_no_row_is_skipped(self):
        for check in ("1", "TRUE", "0", "FALSE", "", "yes"):
            races = apply_categories(self.races(), [{**CATS[0], "check": check}])
            self.assertEqual(races[0]["attrs"], ["Sanders Endorsed"], check)

    def test_unchecked_name_mismatch_fails_not_skips(self):
        with self.assertRaises(SystemExit) as ctx:
            apply_categories(self.races(), [{**CATS[0], "candidate": "D. Dem", "check": "0"}])
        self.assertIn("D. Dem", str(ctx.exception))

    def test_duplicate_office_label_fails(self):
        races = self.races() * 2
        with self.assertRaises(SystemExit) as ctx:
            apply_categories(races, CATS)
        self.assertIn("duplicate", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
