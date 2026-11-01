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
        "Incumbent": "Democrat",
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

    def test_2026_sheet_column_names_work(self):
        r = row()
        for old, new in (("Politico contest ID", "AP contest ID"), ("Politico Dem ID", "AP Dem ID"),
                         ("Politico Rep ID", "AP Rep ID"), ("Harris 2-p", "Harris 2-p %")):
            r[new] = r.pop(old)
        r["AP Dem name"] = "Dana Dem"
        (race,) = build_races([r], META)
        self.assertEqual((race["contestId"], race["demId"], race["harris2p"], race["attrs"]), ("c1", "1", 0.472, []))

    def test_bad_dem_id_fails_loudly(self):
        with self.assertRaises(SystemExit) as ctx:
            build_races([row(**{"Politico Dem ID": "99"})], META)
        self.assertIn("Dem ID 99 not in contest c1", str(ctx.exception))

    def test_unknown_contest_and_bad_harris_fail(self):
        with self.assertRaises(SystemExit):
            build_races([row(**{"Politico contest ID": "nope"})], META)
        with self.assertRaises(SystemExit):
            build_races([row(**{"Harris 2-p": "n/a"})], META)

    def test_incumbent_is_carried_as_dem_rep_open(self):
        for sheet, want in (("Democrat", "dem"), ("Republican", "rep"), ("Neither", "open"), (" democrat ", "dem")):
            (race,) = build_races([row(Incumbent=sheet)], META)
            self.assertEqual(race["incumbent"], want, sheet)

    def test_bad_or_blank_incumbent_fails_loudly(self):
        for bad in ("", "Dem", "Both", "TRUE"):
            with self.assertRaises(SystemExit) as ctx:
                build_races([row(Incumbent=bad)], META)
            self.assertIn("Incumbent", str(ctx.exception), bad)
            self.assertIn("line 2", str(ctx.exception), bad)

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

    def test_check_zero_false_or_blank_skips_the_row(self):
        for check in ("0", "FALSE", "false", " 0 ", "", "  "):
            races = apply_categories(self.races(), [{**CATS[0], "check": check}])
            self.assertEqual(races[0]["attrs"], [], check)

    def test_any_other_check_applies_the_row(self):
        for check in ("1", "TRUE", "yes"):
            races = apply_categories(self.races(), [{**CATS[0], "check": check}])
            self.assertEqual(races[0]["attrs"], ["Sanders Endorsed"], check)

    def test_applied_row_with_wrong_name_still_fails(self):
        with self.assertRaises(SystemExit) as ctx:
            apply_categories(self.races(), [{**CATS[0], "candidate": "D. Dem", "check": "1"}])
        self.assertIn("D. Dem", str(ctx.exception))

    def test_duplicate_office_label_fails(self):
        races = self.races() * 2
        with self.assertRaises(SystemExit) as ctx:
            apply_categories(races, CATS)
        self.assertIn("duplicate", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
