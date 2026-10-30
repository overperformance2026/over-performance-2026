"""Run: uv run python -m unittest discover -s scripts"""

import unittest

from build_races import build_races

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


if __name__ == "__main__":
    unittest.main()
