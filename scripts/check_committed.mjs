// Pre-commit check of the committed Sheet copies, using the SAME parser as the page (sheet.js).
//
//   node scripts/check_committed.mjs            checks data/2024 and data/2026
//   node scripts/check_committed.mjs 2026       checks one year
//
// Exits 1 if a copy cannot be parsed, or if any race row has a problem or any row/category produced
// a warning, so a bad copy is not committed. To refresh a copy, download the Sheet's published CSV
// (the /pub?...output=csv URLs in the page's <body data-sheet-url / data-categories-url>) to
// data/<year>/sheet.csv and data/<year>/categories.csv, then run this.

import { readFileSync } from "node:fs";
import { parseSheet, parseCategories, applyCategories } from "../sheet.js";

const root = new URL("../", import.meta.url);
const years = process.argv.slice(2).length ? process.argv.slice(2) : ["2024", "2026"];
let failed = false;

for (const year of years) {
  const read = (f) => readFileSync(new URL(`data/${year}/${f}`, root), "utf8");
  try {
    const sheet = parseSheet(read("sheet.csv"));
    const tagged = applyCategories(sheet.races, parseCategories(read("categories.csv")));
    const problems = sheet.races.filter((r) => r.problem);
    const warnings = [...sheet.warnings, ...tagged.warnings];
    const backups = sheet.races.filter((r) => r.backup).length;
    const counts = Object.fromEntries(["senate", "governor", "house"].map((o) => [o, sheet.races.filter((r) => r.office === o).length]));
    console.log(`${year}: ${sheet.races.length} races (${JSON.stringify(counts)}), ${backups} with backup votes, ${problems.length} with problems, ${warnings.length} warnings`);
    warnings.forEach((w) => console.log(`  warning: ${w}`));
    if (problems.length || warnings.length) failed = true;
  } catch (e) {
    console.log(`${year}: FAILED - ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
