"""Canonical Google Sheet CSV + Politico metadata -> races.json.

Usage: uv run scripts/build_races.py data/2024/sheet.csv data/2024 data/2024/races.json \
    [data/2024/categories.csv]

The optional categories CSV is the Sheet's "categories" tab; each row tags a race's Dem with a
category that the page offers in its filter drop-down.

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


INCUMBENT = {"democrat": "dem", "republican": "rep", "neither": "open"}


def canonical_headers(row: dict) -> dict:
    """The 2026 Sheet says "AP ..." where the 2024 one says "Politico ...", and "Harris 2-p %"."""
    out = {}
    for key, value in row.items():
        name = key.strip() if isinstance(key, str) else key
        if isinstance(name, str):
            if name.startswith("AP "):
                name = "Politico " + name[3:]
            if name == "Harris 2-p %":
                name = "Harris 2-p"
        out[name] = value
    return out


def build_races(rows: list[dict], metadata: dict[str, list[dict]]) -> list[dict]:
    """rows: sheet rows; metadata: office -> Politico metadata list. Returns races.json entries."""
    rows = [canonical_headers(r) for r in rows]
    errors: list[str] = []
    attr_cols = [c for c in (rows[0] if rows else {}) if c not in KNOWN and c.strip()]
    races: list[dict] = []
    seen: set[str] = set()
    for i, row in enumerate(rows, start=2):  # sheet line number
        where = f"line {i} ({row.get('Office')} {row.get('State/District')})"
        missing = [c for c in REQUIRED + ["Incumbent"] if c not in row]
        if missing:
            raise SystemExit(f"sheet is missing columns: {missing}")
        incumbent = INCUMBENT.get((row["Incumbent"] or "").strip().lower())
        if incumbent is None:
            errors.append(f"{where}: Incumbent {row['Incumbent']!r} is not Democrat/Republican/Neither")
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
                "incumbent": incumbent,
                "attrs": attrs,
            }
        )
    if errors:
        raise SystemExit("build_races failed:\n  " + "\n  ".join(errors))
    return races


def apply_categories(races: list[dict], cat_rows: list[dict]) -> list[dict]:
    """Add each category-tab row's category to the matching race's attrs.

    cat_rows: category, office, state/district, candidate, check. Principal rule: check = 0, FALSE
    or blank skips the row; any other value applies it. Matches on office + label;
    the candidate must be exactly the race's Dem as Politico spells it, so an applied row that
    matches no race or names the wrong candidate fails the build. Skipped rows are listed in the
    output because each one leaves a candidate out of the category average.
    """
    errors: list[str] = []
    keys = [(r["office"], r["label"]) for r in races]
    for key in sorted({k for k in keys if keys.count(k) > 1}):
        errors.append(f"duplicate race {key[0]} {key[1]}")
    skipped: list[str] = []
    for i, c in enumerate(cat_rows, start=2):
        where = f"categories line {i} ({c['category']}: {c['office']} {c['state/district']})"
        if c["check"].strip().upper() in ("0", "FALSE", ""):
            skipped.append(f"{where} {c['candidate']}")
            continue
        race = next(
            (
                r
                for r in races
                if r["office"] == c["office"].strip().lower() and r["label"] == c["state/district"].strip()
            ),
            None,
        )
        if race is None:
            errors.append(f"{where}: matches no race")
        elif c["candidate"].strip() != race["demName"]:
            errors.append(f"{where}: candidate {c['candidate']!r} but the race's Dem is {race['demName']!r}")
        elif c["category"].strip() not in race["attrs"]:
            race["attrs"].append(c["category"].strip())
    if errors:
        raise SystemExit("apply_categories failed:\n  " + "\n  ".join(errors))
    print(f"categories: {len(cat_rows) - len(skipped)} rows applied, {len(skipped)} skipped (check = 0 or blank)")
    for s in skipped:
        print(f"  skipped: {s}")
    return races


def main(sheet: str, data_dir: str, out: str, categories: str | None = None) -> None:
    rows = list(csv.DictReader(Path(sheet).open(encoding="utf-8-sig")))
    metadata = {
        o: json.loads((Path(data_dir) / f"meta-{o}.json").read_text(encoding="utf-8"))
        for o in ("senate", "governor", "house")
    }
    races = build_races(rows, metadata)
    if categories:
        cat_rows = list(csv.DictReader(Path(categories).open(encoding="utf-8-sig")))
        races = apply_categories(races, cat_rows)
    Path(out).write_text(json.dumps(races, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(races)} races")


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
