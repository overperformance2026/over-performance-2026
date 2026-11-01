import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCsv, csvTable, parseVotes, parsePct, parseTime, parseHarris, parseSheet, parseCategories,
  applyCategories, parseBundle, fetchSheetText, SheetError, SHEET_TIMEOUT_MS,
} from "./sheet.js";

const HEAD = "Office,State/District,District number,Special Election,Democrat (or non-R indie),Republican,Incumbent,Harris 2-p %,AP contest ID,AP Dem ID,AP Dem name,AP Dem party,AP Rep ID,AP Rep name,Match check,backup_votes_dem,backup_votes_rep,backup_pct_reporting,backup_time_updated";
const row = (o = {}) => {
  const base = {
    Office: "Senate", "State/District": "AZ", "District number": "", "Special Election": "", "Democrat (or non-R indie)": "typed",
    Republican: "typed", Incumbent: "Neither", "Harris 2-p %": "47.2%", "AP contest ID": "c1", "AP Dem ID": "1", "AP Dem name": "Dana Dem",
    "AP Dem party": "dem", "AP Rep ID": "2", "AP Rep name": "Rex Rep", "Match check": "OK",
    backup_votes_dem: "", backup_votes_rep: "", backup_pct_reporting: "", backup_time_updated: "", ...o,
  };
  return HEAD.split(",").map((h) => (/[",\n]/.test(base[h]) ? `"${base[h].replace(/"/g, '""')}"` : base[h])).join(",");
};
const sheet = (...rows) => [HEAD, ...rows].join("\n");

test("parseCsv: quotes, commas and newlines inside quotes, CRLF, BOM, blank lines", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n"multi\nline",2,3\r\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["multi\nline", "2", "3"]]);
  assert.deepEqual(csvTable("a,b\n1,2\n3").rows, [{ a: "1", b: "2" }, { a: "3", b: "" }]);
  assert.deepEqual(csvTable("").rows, []);
});

test("cell parsers", () => {
  assert.equal(parseVotes("12,345"), 12345);
  for (const bad of ["", "abc", "-5", "1.5", "12k", null]) assert.equal(parseVotes(bad), null, String(bad));
  for (const ok of ["85%", "85", "0.85", " 85% "]) assert.ok(Math.abs(parsePct(ok) - 0.85) < 1e-12, ok);
  assert.equal(parsePct("100"), 1);
  for (const bad of ["", "abc", "-1", "150%", "250"]) assert.equal(parsePct(bad), null, bad);
  assert.equal(parseTime("10/1/2025 8:01:18"), new Date(2025, 9, 1, 8, 1, 18).getTime());
  assert.equal(parseTime("soon"), null);
  assert.equal(parseHarris("47.2%"), 0.472);
  assert.equal(parseHarris("34.65%"), 0.3465);
  for (const bad of ["47.2", "", "n/a", "-3%", "1,5%"]) assert.equal(parseHarris(bad), null, bad);
});

test("parseSheet: a good row, with the backup cells read", () => {
  const { races, warnings } = parseSheet(sheet(row({ backup_votes_dem: "1,000", backup_votes_rep: "900", backup_pct_reporting: "85%", backup_time_updated: "2026-11-03T21:00:00Z" })));
  assert.deepEqual(warnings, []);
  assert.equal(races.length, 1);
  const r = races[0];
  assert.deepEqual([r.contestId, r.office, r.label, r.harris2p, r.demId, r.repId, r.demName, r.repName, r.incumbent],
    ["c1", "senate", "AZ", 0.472, "1", "2", "Dana Dem", "Rex Rep", "open"]);
  assert.deepEqual(r.backup, { demVotes: 1000, repVotes: 900, pct: 0.85, asOf: Date.UTC(2026, 10, 3, 21), asOfText: "2026-11-03T21:00:00Z" });
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.attrs, []);
});

test("parseSheet: display names are the AP columns, not the typed ones; extra columns are ignored", () => {
  const extra = HEAD + ",mystery col\n" + row({ "Democrat (or non-R indie)": "Typo Name" }) + ",whatever";
  const { races, warnings } = parseSheet(extra);
  assert.equal(races[0].demName, "Dana Dem");
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(races[0]).sort(), ["attrs", "backup", "contestId", "demId", "demName", "harris2p", "incumbent", "label", "office", "repId", "repName"]);
});

test("parseSheet: old column names (Politico ..., Harris 2-p) still work", () => {
  const old = "Office,State/District,Special Election,Incumbent,Harris 2-p,Politico contest ID,Politico Dem ID,Politico Dem name,Politico Rep ID,Politico Rep name\nSenate,AZ,,Democrat,47.2%,c1,1,Dana,2,Rex";
  const { races } = parseSheet(old);
  assert.deepEqual([races[0].contestId, races[0].demName, races[0].incumbent, races[0].harris2p], ["c1", "Dana", "dem", 0.472]);
});

test("parseSheet: special elections get a label suffix; at-large AL is preserved", () => {
  const { races } = parseSheet(sheet(row({ "State/District": "CA", "Special Election": "Yes", "AP contest ID": "c2" }), row({ Office: "House", "State/District": "AK-AL", "AP contest ID": "c3" })));
  assert.deepEqual(races.map((r) => r.label), ["CA (special)", "AK-AL"]);
  assert.equal(races[1].office, "house");
});

test("parseSheet: a missing required column, an empty sheet or an HTML page fails the whole sheet", () => {
  assert.throws(() => parseSheet(sheet(row()).replace("AP Dem name", "Dem name")), (e) => e instanceof SheetError && /AP Dem name/.test(e.message));
  assert.throws(() => parseSheet(HEAD), /no data rows/);
  assert.throws(() => parseSheet(""), SheetError);
  assert.throws(() => parseSheet("<!DOCTYPE html><html><body>sign in</body></html>"), SheetError);
});

test("parseSheet: one problem per field is flagged on that race only, never a crash", () => {
  const cases = [
    [row({ Incumbent: "Both" }), /Incumbent "Both"/],
    [row({ Incumbent: "" }), /Incumbent ""/],
    [row({ "Harris 2-p %": "47.2" }), /Harris 2-p "47.2"/],
    [row({ "Harris 2-p %": "n/a" }), /Harris/],
    [row({ "AP Dem ID": "" }), /missing contest\/Dem\/Rep ID/],
    [row({ "AP contest ID": "" }), /missing contest\/Dem\/Rep ID/],
    [row({ "AP Rep ID": "1" }), /same/],
  ];
  for (const [r, want] of cases) {
    const { races, warnings } = parseSheet(sheet(row({ "State/District": "OK", "AP contest ID": "good", "AP Dem ID": "7", "AP Rep ID": "8" }), r.replace("AZ", "TX")));
    assert.equal(races.length, 2, r);
    assert.equal(races[0].problem, undefined);
    assert.match(races[1].problem, want, r);
    assert.equal(warnings.length, 1);
  }
});

test("parseSheet: duplicate (office, label) and duplicate contest ID flag the later row", () => {
  const dup = parseSheet(sheet(row(), row({ "AP contest ID": "c9" })));
  assert.equal(dup.races[0].problem, undefined);
  assert.match(dup.races[1].problem, /duplicate race/);
  const dupId = parseSheet(sheet(row(), row({ "State/District": "TX" })));
  assert.match(dupId.races[1].problem, /duplicate contest ID/);
});

test("parseSheet: unknown office or blank State/District skips the row with a warning", () => {
  const { races, warnings } = parseSheet(sheet(row({ Office: "President" }), row({ "State/District": "" }), row({ "State/District": "TX", "AP contest ID": "c5" })));
  assert.equal(races.length, 1);
  assert.equal(warnings.length, 2);
});

test("parseSheet: backup cells: blank is no backup; malformed ignores that race's backup with a warning", () => {
  const { races, warnings } = parseSheet(sheet(
    row({ "State/District": "A1", "AP contest ID": "a1" }),
    row({ "State/District": "A2", "AP contest ID": "a2", backup_votes_dem: "12", backup_votes_rep: "x" }),
    row({ "State/District": "A3", "AP contest ID": "a3", backup_votes_dem: "12", backup_votes_rep: "3", backup_pct_reporting: "lots" }),
    row({ "State/District": "A4", "AP contest ID": "a4", backup_votes_dem: "12", backup_votes_rep: "3" }),
    row({ "State/District": "A5", "AP contest ID": "a5", backup_pct_reporting: "40%" }),
  ));
  assert.deepEqual(races.map((r) => r.backup === null), [true, true, true, false, true]);
  assert.equal(races[3].backup.pct, null);
  assert.equal(races[3].backup.asOf, null);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /backup ignored/);
  assert.equal(races.every((r) => r.problem === undefined), true, "a bad backup is not a race problem");
});

const CATS = "category,office,state/district,candidate,check\nThe Squad,House,NY-14,Alexandria Ocasio-Cortez,1\nThe Squad,House,MA-07,Ayanna Pressley,0\nThe Squad,House,TX-37,Greg Casar,\nThe Squad,House,XX-01,Nobody,1\nThe Squad,House,NY-14,Wrong Name,1\nOther,House,NY-14,Alexandria Ocasio-Cortez,TRUE";
const HOUSE = sheet(row({ Office: "House", "State/District": "NY-14", "AP Dem name": "Alexandria Ocasio-Cortez", "AP contest ID": "n14" }),
  row({ Office: "House", "State/District": "MA-07", "AP Dem name": "Ayanna Pressley", "AP contest ID": "m7" }),
  row({ Office: "House", "State/District": "TX-37", "AP Dem name": "Greg Casar", "AP contest ID": "t37" }));

test("categories: check rule (0 / FALSE / blank skip), name must equal AP Dem name, bad rows warn", () => {
  const { races, warnings } = parseBundle(HOUSE, CATS);
  assert.deepEqual(races.map((r) => r.attrs), [["The Squad", "Other"], [], []]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /matches no race/.test(w)));
  assert.ok(warnings.some((w) => /Wrong Name/.test(w)));
});

test("categories: pure (inputs untouched); missing column throws; no categories text = no tags", () => {
  const { races } = parseSheet(HOUSE);
  const out = applyCategories(races, parseCategories(CATS));
  assert.deepEqual(races[0].attrs, [], "input not mutated");
  assert.notEqual(out.races[0], races[0]);
  assert.throws(() => parseCategories("category,office\nx,y"), SheetError);
  assert.deepEqual(parseBundle(HOUSE, null).races.map((r) => r.attrs), [[], [], []]);
});

// ---- fetchSheetText ----------------------------------------------------------------------------

const res = (text, { status = 200, type = "text/csv; charset=utf-8" } = {}) => ({
  ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === "content-type" ? type : null) }, text: async () => text,
});

test("fetchSheetText: returns the CSV; sends no cache-busting query and a 5 s abort timer", async () => {
  let timerMs, seen;
  const out = await fetchSheetText("https://x/pub?gid=0&single=true&output=csv", {
    fetchImpl: async (url, opts) => ((seen = [url, Object.keys(opts)]), res("a,b\n1,2")),
    setTimer: (fn, ms) => ((timerMs = ms), 1),
  });
  assert.equal(out, "a,b\n1,2");
  assert.equal(timerMs, SHEET_TIMEOUT_MS);
  assert.equal(SHEET_TIMEOUT_MS, 5000);
  assert.deepEqual(seen, ["https://x/pub?gid=0&single=true&output=csv", ["signal"]]);
});

test("fetchSheetText: non-200, 401/HTML pages and timeouts throw", async () => {
  await assert.rejects(fetchSheetText("u", { fetchImpl: async () => res("nope", { status: 500 }) }), /HTTP 500/);
  await assert.rejects(fetchSheetText("u", { fetchImpl: async () => res("x", { status: 401 }) }), /HTTP 401/);
  await assert.rejects(fetchSheetText("u", { fetchImpl: async () => res("<!DOCTYPE html><html>sign in</html>", { type: "text/html" }) }), /HTML/);
  await assert.rejects(fetchSheetText("u", { fetchImpl: async () => res("<html>x", { type: "text/csv" }) }), /HTML/, "HTML body even with a CSV header");
  let fire;
  const hung = fetchSheetText("u", {
    setTimer: (fn) => ((fire = fn), 1),
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  fire();
  await assert.rejects(hung, /aborted/);
});

// ---- the committed copies ------------------------------------------------------------------------

const committed = (year, f) => readFileSync(new URL(`./data/${year}/${f}`, import.meta.url), "utf8");

test("the committed 2026 copy parses to 481 clean races", () => {
  const { races, warnings } = parseBundle(committed(2026, "sheet.csv"), committed(2026, "categories.csv"));
  assert.equal(races.length, 481);
  assert.deepEqual(warnings.filter((w) => !/Pressley/.test(w)), [], "no warnings (the skipped Pressley row has check 0 and makes none)");
  assert.ok(races.every((r) => r.problem === undefined));
  assert.deepEqual(races.reduce((n, r) => ((n[r.incumbent] = (n[r.incumbent] ?? 0) + 1), n), {}), { dem: 185, rep: 193, open: 103 });
  assert.equal(races.filter((r) => r.attrs.includes("The Squad")).length, 6);
  assert.ok(races.some((r) => r.label === "AK-AL" && r.office === "house"), "at-large AL kept");
  assert.equal(races.filter((r) => r.office === "senate").length, 35);
  assert.equal(races.filter((r) => r.office === "governor").length, 36);
  assert.equal(races.filter((r) => r.office === "house").length, 410);
  // (commit afdcc10 also compared these 481 races field by field with the old pipeline's races.json: identical)
});

test("the committed 2024 copy parses to 438 clean races, every one with a backup", () => {
  const { races, warnings } = parseBundle(committed(2024, "sheet.csv"), committed(2024, "categories.csv"));
  assert.equal(races.length, 438);
  assert.deepEqual(warnings, []);
  assert.ok(races.every((r) => r.problem === undefined));
  assert.equal(races.filter((r) => r.backup).length, 438);
  assert.deepEqual(races.reduce((n, r) => ((n[r.incumbent] = (n[r.incumbent] ?? 0) + 1), n), {}), { dem: 185, rep: 185, open: 68 });
});
