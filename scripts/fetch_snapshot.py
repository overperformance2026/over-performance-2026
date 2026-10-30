"""Politico 2024 files -> raw (git-ignored) -> slim files committed to the repo.

Usage: uv run scripts/fetch_snapshot.py [--no-fetch]

Fetches the six files one at a time, 30 seconds apart (Politico rate limit; never lower it).
Raw files land in data/raw/2024/ and are NOT committed. The slim files in data/2024/ keep the
same shapes the page reads, but only the contests in races.json and, for each, only the chosen
Dem/Rep candidates: names, party, votes and % reporting.
--no-fetch re-slims whatever is already in data/raw/2024/.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

DATE = "2024-11-05"
OFFICES = ["senate", "governor", "house"]
GAP_SECONDS = 30
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "2024"
OUT = ROOT / "data" / "2024"
BASE = "https://www.politico.com/election-data"


def url(kind: str, office: str) -> str:
    if kind == "meta":
        return f"{BASE}/metadata__{DATE}__collections__{DATE}-collection-{office}__combined/data.json"
    return f"{BASE}/results__{DATE}__collections__{DATE}-collection-{office}__summaries/data.json"


def fetch_all() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    jobs = [(k, o) for o in OFFICES for k in ("meta", "sum")]
    for i, (kind, office) in enumerate(jobs):
        if i:
            print(f"waiting {GAP_SECONDS}s", flush=True)
            time.sleep(GAP_SECONDS)
        dest = RAW / f"{kind}-{office}.json"
        print(f"fetching {url(kind, office)}", flush=True)
        # uv's Python has no ssl module, so shell out to curl. No retries: a 429 means stop.
        subprocess.run(["curl", "-fsS", "-o", str(dest), url(kind, office)], check=True)
        json.loads(dest.read_text(encoding="utf-8"))  # fail loudly on a non-JSON body


def slim(races: list[dict], meta: list[dict], sums: dict) -> tuple[list[dict], dict]:
    """Keep only the races' contests and, in each, only the chosen Dem/Rep candidates."""
    picks = {r["contestId"]: {str(r["demId"]), str(r["repId"])} for r in races}
    slim_meta = []
    for entry in meta:
        keep = picks.get(entry["contestId"])
        if keep is None:
            continue
        cands = {
            cid: {"id": c["id"], "fullName": c["fullName"], "party": c["party"]}
            for cid, c in entry["candidates"].items()
            if c["id"] in keep
        }
        slim_meta.append({"contestId": entry["contestId"], "candidates": cands})
    slim_sums = []
    for c in sums["contests"]:
        keep = picks.get(c["id"])
        if keep is None:
            continue
        results = [{"id": r["id"], "votes": r["votes"]} for r in c["results"] if r["id"] in keep]
        slim_sums.append({"id": c["id"], "results": results, "progress": {"pct": c["progress"]["pct"]}})
    return slim_meta, {"contests": slim_sums}


def main() -> None:
    if "--no-fetch" not in sys.argv:
        fetch_all()
    races = json.loads((OUT / "races.json").read_text(encoding="utf-8"))
    for office in OFFICES:
        part = [r for r in races if r["office"] == office]
        meta = json.loads((RAW / f"meta-{office}.json").read_text(encoding="utf-8"))
        sums = json.loads((RAW / f"sum-{office}.json").read_text(encoding="utf-8"))
        slim_meta, slim_sums = slim(part, meta, sums)
        (OUT / f"meta-{office}.json").write_text(json.dumps(slim_meta, separators=(",", ":")))
        (OUT / f"sum-{office}.json").write_text(json.dumps(slim_sums, separators=(",", ":")))
        print(f"{office}: {len(slim_meta)} contests slimmed")


if __name__ == "__main__":
    main()
