"""Canonical Google Sheet CSV + Politico metadata -> races.json.

Usage: uv run scripts/build_races.py data/2024/sheet.csv data/2024 races.json

Fails loudly (exit 1) on any row whose Politico IDs are missing or not in the metadata.
"""

import csv
import json
import sys
from pathlib import Path

REQUIRED = [
    "Office",
    "State/District",
    "Special Election",
    "Harris 2-p",
    "Politico contest ID",
    "Politico Dem ID",
    "Politico Rep ID",
]

# Every other column is an attribute (e.g. "Endorsed by Bernie Sanders"): TRUE, FALSE or blank.
KNOWN = set(REQUIRED) | {
    "District number",
    "Democrat (or non-R indie)",
    "Republican",
    "Incumbent",
    "Politico Dem name",
    "Politico Dem party",
    "Politico Rep name",
    "Match check",
}


def build_races(rows: list[dict], metadata: dict[str, list[dict]]) -> list[dict]:
    """rows: sheet rows; metadata: office -> Politico metadata list. Returns races.json entries."""
    errors: list[str] = []
    attr_cols = [c for c in (rows[0] if rows else {}) if c not in KNOWN and c.strip()]
    races: list[dict] = []
    seen: set[str] = set()
    for i, row in enumerate(rows, start=2):  # sheet line number
        where = f"line {i} ({row.get('Office')} {row.get('State/District')})"
        missing = [c for c in REQUIRED if c not in row]
        if missing:
            raise SystemExit(f"sheet is missing columns: {missing}")
        office = row["Office"].strip().lower()
        cid = row["Politico contest ID"].strip()
        dem, rep = row["Politico Dem ID"].strip(), row["Politico Rep ID"].strip()
        if not (cid and dem and rep):
            errors.append(f"{where}: missing contest/Dem/Rep ID")
            continue
        entry = next((e for e in metadata.get(office, []) if e["contestId"] == cid), None)
        if entry is None:
            errors.append(f"{where}: contest {cid} not in Politico {office} metadata")
            continue
        for who, cand_id in (("Dem", dem), ("Rep", rep)):
            if cand_id not in entry["candidates"]:
                errors.append(f"{where}: {who} ID {cand_id} not in contest {cid}")
        if cid in seen:
            errors.append(f"{where}: duplicate contest {cid}")
        seen.add(cid)
        harris = row["Harris 2-p"].strip()
        if not harris.endswith("%"):
            errors.append(f"{where}: Harris 2-p {harris!r} is not a percentage")
            continue
        label = row["State/District"].strip()
        if row["Special Election"].strip().lower() == "yes":
            label += " (special)"
        attrs = []
        for col in attr_cols:
            value = (row[col] or "").strip().upper()
            if value not in ("", "TRUE", "FALSE"):
                errors.append(f"{where}: attribute column {col!r} has {row[col]!r}, not TRUE/FALSE")
            elif value == "TRUE":
                attrs.append(col.strip())
        races.append(
            {
                "contestId": cid,
                "office": office,
                "label": label,
                "harris2p": round(float(harris[:-1]) / 100, 6),
                "demId": dem,
                "repId": rep,
                # Politico's spelling, used when live metadata can't resolve the candidate.
                "demName": entry["candidates"].get(dem, {}).get("fullName"),
                "repName": entry["candidates"].get(rep, {}).get("fullName"),
                "attrs": attrs,
            }
        )
    if errors:
        raise SystemExit("build_races failed:\n  " + "\n  ".join(errors))
    return races


def main(sheet: str, data_dir: str, out: str) -> None:
    rows = list(csv.DictReader(Path(sheet).open(encoding="utf-8")))
    metadata = {
        o: json.loads((Path(data_dir) / f"meta-{o}.json").read_text(encoding="utf-8"))
        for o in ("senate", "governor", "house")
    }
    races = build_races(rows, metadata)
    Path(out).write_text(json.dumps(races, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(races)} races")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
