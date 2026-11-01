"""Politico files -> raw (git-ignored) -> slim files committed to the repo.

Usage: uv run scripts/fetch_snapshot.py [--date YYYY-MM-DD] [--sums-only | --meta-only] [--no-fetch]

Fetches the files one at a time, 30 seconds apart (Politico rate limit; never lower it).
Raw files land in data/raw/<year>/ and are NOT committed. The slim files in data/<year>/ keep the
same shapes the page reads, but only the contests in races.json and, for each, only the chosen
Dem/Rep candidates: names, party, votes and % reporting. data/<year>/updated.json records when
the files were last fetched, for the page's "data as of" line.
--date       election date (default 2024-11-05); the year picks the data directories.
--sums-only  fetch only the three summaries files (3 calls, not 6): the metadata does not change
             on election night. Candidate names come from the slim meta files already committed.
--meta-only  fetch only the three metadata files into data/raw/<year>/ and stop (3 calls).
--no-fetch   re-slim whatever is already in data/raw/<year>/ (no calls, timestamp untouched).
"""

import argparse
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DATE = "2024-11-05"
OFFICES = ["senate", "governor", "house"]
GAP_SECONDS = 30
ROOT = Path(__file__).resolve().parent.parent
BASE = "https://www.politico.com/election-data"


def url(kind: str, office: str, date: str = DEFAULT_DATE) -> str:
    if kind == "meta":
        return f"{BASE}/metadata__{date}__collections__{date}-collection-{office}__combined/data.json"
    return f"{BASE}/results__{date}__collections__{date}-collection-{office}__summaries/data.json"


def jobs(sums_only: bool, meta_only: bool = False) -> list[tuple[str, str]]:
    kinds = ("sum",) if sums_only else ("meta",) if meta_only else ("meta", "sum")
    return [(k, o) for o in OFFICES for k in kinds]


def fetch_all(date: str, raw: Path, sums_only: bool, meta_only: bool = False) -> None:
    raw.mkdir(parents=True, exist_ok=True)
    for i, (kind, office) in enumerate(jobs(sums_only, meta_only)):
        if i:
            print(f"waiting {GAP_SECONDS}s", flush=True)
            time.sleep(GAP_SECONDS)
        dest = raw / f"{kind}-{office}.json"
        print(f"fetching {url(kind, office, date)}", flush=True)
        # uv's Python has no ssl module, so shell out to curl. No retries: a 429 means stop.
        subprocess.run(["curl", "-fsS", "-o", str(dest), url(kind, office, date)], check=True)
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
        results = [{"id": r["id"], "votes": r["votes"]} for r in c.get("results") or [] if r["id"] in keep]
        # A contest with no progress yet gets pct null; the page shows it as "—".
        pct = (c.get("progress") or {}).get("pct")
        slim_sums.append({"id": c["id"], "results": results, "progress": {"pct": pct}})
    return slim_meta, {"contests": slim_sums}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default=DEFAULT_DATE)
    ap.add_argument("--sums-only", action="store_true")
    ap.add_argument("--meta-only", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    args = ap.parse_args()
    year = args.date[:4]
    raw, out = ROOT / "data" / "raw" / year, ROOT / "data" / year

    if args.meta_only:  # just refresh the raw metadata (e.g. to list candidates); no slimming
        fetch_all(args.date, raw, sums_only=False, meta_only=True)
        return

    if not args.no_fetch:
        fetch_all(args.date, raw, args.sums_only)
        stamp = {"fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        (out / "updated.json").write_text(json.dumps(stamp), encoding="utf-8")
    races = json.loads((out / "races.json").read_text(encoding="utf-8"))
    for office in OFFICES:
        part = [r for r in races if r["office"] == office]
        # Re-slimming an already-slim meta file is a no-op, so --sums-only can reuse the committed one.
        # (the very first run for a new year has no committed meta yet, so it slims the raw one.)
        meta_src = out if args.sums_only and (out / f"meta-{office}.json").exists() else raw
        meta = json.loads((meta_src / f"meta-{office}.json").read_text(encoding="utf-8"))
        sums = json.loads((raw / f"sum-{office}.json").read_text(encoding="utf-8"))
        slim_meta, slim_sums = slim(part, meta, sums)
        if meta_src == raw:
            (out / f"meta-{office}.json").write_text(json.dumps(slim_meta, separators=(",", ":")))
        (out / f"sum-{office}.json").write_text(json.dumps(slim_sums, separators=(",", ":")))
        print(f"{office}: {len(slim_sums['contests'])} contests slimmed")


if __name__ == "__main__":
    main()
