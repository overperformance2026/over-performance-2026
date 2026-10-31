from fetch_snapshot import slim

RACES = [{"contestId": "ap:04:1", "demId": "1", "repId": "2"}]
META = [
    {
        "contestId": "ap:04:1",
        "extra": "dropped",
        "candidates": {
            "1": {"id": "1", "fullName": "A D", "party": "dem", "bio": "x"},
            "2": {"id": "2", "fullName": "B R", "party": "gop"},
            "3": {"id": "3", "fullName": "C L", "party": "other-party"},
        },
    },
    {"contestId": "ap:04:9", "candidates": {}},
]
SUMS = {
    "contests": [
        {
            "id": "ap:04:1",
            "results": [{"id": "1", "votes": 10}, {"id": "2", "votes": 5}, {"id": "3", "votes": 1}],
            "progress": {"pct": 0.9},
            "calls": [1],
        },
        {"id": "ap:04:9", "results": [], "progress": {"pct": 0.1}},
    ]
}


def test_slim_keeps_only_chosen_candidates_and_contests():
    meta, sums = slim(RACES, META, SUMS)
    assert [e["contestId"] for e in meta] == ["ap:04:1"]
    assert set(meta[0]["candidates"]) == {"1", "2"}
    assert meta[0]["candidates"]["1"] == {"id": "1", "fullName": "A D", "party": "dem"}
    assert sums == {
        "contests": [
            {
                "id": "ap:04:1",
                "results": [{"id": "1", "votes": 10}, {"id": "2", "votes": 5}],
                "progress": {"pct": 0.9},
            }
        ]
    }


def test_slim_tolerates_contest_without_progress_or_results():
    sums = {"contests": [{"id": "ap:04:1"}, {"id": "ap:04:9", "results": None}]}
    _, out = slim(RACES, META, sums)
    assert out == {"contests": [{"id": "ap:04:1", "results": [], "progress": {"pct": None}}]}


def test_sums_only_makes_three_calls_and_date_sets_url():
    from fetch_snapshot import jobs, url

    assert jobs(sums_only=True) == [("sum", "senate"), ("sum", "governor"), ("sum", "house")]
    assert len(jobs(sums_only=False)) == 6
    assert "2026-11-03" in url("sum", "house", "2026-11-03")
