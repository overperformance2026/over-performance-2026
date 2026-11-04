import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeVotes, politicoLayer, buildRows, backupIndex, backupLayers, keepBestBackups, PRIORITY } from "./merge.js";
import { parseBundle } from "./sheet.js";
import { incumbencyEffect, averageOverUnder } from "./compute.js";

const L = (demVotes, repVotes, pct = 0.5, asOf = 1) => ({ demVotes, repVotes, pct, asOf });

test("mergeVotes: the layer with the highest Dem + Rep total wins, whichever it is", () => {
  assert.equal(mergeVotes({ politico: L(10, 10), sheet: L(30, 5), committed: L(1, 1) }).source, "sheet");
  assert.equal(mergeVotes({ politico: L(50, 50), sheet: L(30, 5), committed: L(1, 1) }).source, "politico");
  assert.equal(mergeVotes({ politico: L(1, 1), sheet: L(2, 2), committed: L(40, 10) }).source, "committed");
});

test("mergeVotes: a tie goes to Politico, then the Sheet, then the committed copy", () => {
  assert.deepEqual(PRIORITY, ["politico", "sheet", "committed"]);
  assert.equal(mergeVotes({ politico: L(5, 5), sheet: L(6, 4), committed: L(7, 3) }).source, "politico");
  assert.equal(mergeVotes({ sheet: L(6, 4), committed: L(7, 3) }).source, "sheet");
  assert.equal(mergeVotes({ committed: L(7, 3) }).source, "committed");
  assert.equal(mergeVotes({ politico: L(1, 1), sheet: L(6, 4), committed: L(7, 3) }).source, "sheet");
});

test("mergeVotes: Dem votes, Rep votes and % reporting all come from the winner; never mixed", () => {
  const m = mergeVotes({ politico: L(100, 90, 0.4, 111), sheet: L(300, 200, 0.9, 222), committed: L(10, 10, 0.99, 333) });
  assert.deepEqual(m, { demVotes: 300, repVotes: 200, pct: 0.9, asOf: 222, source: "sheet" });
  // the winner's missing pct stays missing: it is NOT borrowed from another layer
  assert.equal(mergeVotes({ politico: L(1, 1, 0.99), sheet: L(9, 9, null) }).pct, null);
  assert.equal(mergeVotes({ sheet: { demVotes: 9, repVotes: 9 } }).asOf, null);
});

test("mergeVotes: blank, malformed, zero-vote and missing layers do not count", () => {
  assert.equal(mergeVotes({}), null);
  assert.equal(mergeVotes({ politico: null, sheet: undefined, committed: null }), null);
  assert.equal(mergeVotes({ politico: L(0, 0), sheet: L(NaN, 5), committed: { demVotes: "5", repVotes: 5 } }), null);
  assert.equal(mergeVotes({ politico: L(0, 0), sheet: L(3, 1) }).source, "sheet", "a 0-vote Politico entry loses to a real backup");
  assert.equal(mergeVotes({ politico: L(0, 0) }), null, "all zero is no results yet");
});

test("politicoLayer: reads the race's two candidates; missing contest or candidate is null", () => {
  const race = { contestId: "c1", demId: "1", repId: "2" };
  const payload = { asOf: 77, summaries: { contests: [{ id: "c1", results: [{ id: "1", votes: 10 }, { id: "2", votes: 4 }, { id: "9", votes: 99 }], progress: { pct: 0.3 } }, { id: "c2", results: [{ id: "1", votes: 5 }] }] } };
  assert.deepEqual(politicoLayer(race, payload), { demVotes: 10, repVotes: 4, pct: 0.3, asOf: 77 });
  assert.equal(politicoLayer({ ...race, contestId: "c2" }, payload), null, "Rep votes missing");
  assert.equal(politicoLayer({ ...race, contestId: "zz" }, payload), null);
  assert.equal(politicoLayer(race, { asOf: 1, summaries: { contests: [] } }), null, "empty summaries file");
  assert.equal(politicoLayer(race, { asOf: 1, summaries: null }), null);
});

// ---- buildRows -------------------------------------------------------------------------------------

const race = (o = {}) => ({ contestId: "c1", office: "senate", label: "AZ", harris2p: 0.5, demId: "1", repId: "2", demName: "Dana Dem", repName: "Rex Rep", incumbent: "open", attrs: [], backup: null, ...o });
const payload = (contests, asOf = 5) => ({ asOf, summaries: { contests } });
const contest = (id, d, r, pct = 0.6, dId = "1", rId = "2") => ({ id, results: [{ id: dId, votes: d }, { id: rId, votes: r }], progress: { pct } });

test("buildRows: names, Harris and incumbent come from the Sheet's race; votes from the winning layer", () => {
  const rows = buildRows({
    races: [race()],
    committed: new Map([["c1", L(100, 100, 0.5, 10)]]),
    sheet: new Map([["c1", L(300, 100, 0.8, 20)]]),
    politico: { senate: payload([contest("c1", 200, 100, 0.7)], 30) },
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.dem.name, r.rep.name, r.incumbent, r.harris2p, r.problem], ["Dana Dem", "Rex Rep", "open", 0.5, null]);
  assert.deepEqual([r.demVotes, r.repVotes, r.pctReporting, r.votesSource, r.votesAsOf], [300, 100, 0.8, "sheet", 20]);
  assert.ok(Math.abs(r.overUnder - (0.75 - 0.5)) < 1e-12);
});

test("buildRows: Politico ahead of the backups wins; behind them it loses (the sheet can lead)", () => {
  const sheet = new Map([["c1", L(300, 100, 0.8, 20)]]);
  const ahead = buildRows({ races: [race()], sheet, politico: { senate: payload([contest("c1", 900, 100)], 30) } })[0];
  assert.deepEqual([ahead.votesSource, ahead.demVotes], ["politico", 900]);
  const behind = buildRows({ races: [race()], sheet, politico: { senate: payload([contest("c1", 50, 50)], 30) } })[0];
  assert.deepEqual([behind.votesSource, behind.demVotes], ["sheet", 300]);
});

test("buildRows: no votes anywhere -> a row with no numbers and no source; Politico missing is fine", () => {
  const r = buildRows({ races: [race()] })[0];
  assert.deepEqual([r.dem2p, r.overUnder, r.pctReporting, r.votesSource, r.votesAsOf, r.problem], [null, null, null, null, null, null]);
  const onlyOtherOffice = buildRows({ races: [race()], politico: { house: payload([]) } })[0];
  assert.equal(onlyOtherOffice.votesSource, null);
  const emptyFile = buildRows({ races: [race()], politico: { senate: payload([]) } })[0];
  assert.equal(emptyFile.votesSource, null, "{contests: []} is no results yet");
});

test("buildRows: a race with a problem keeps its row, shows the problem and gets no numbers even if votes exist", () => {
  const bad = race({ problem: "Incumbent \"x\" is not Democrat/Republican/Neither", incumbent: null });
  const [r] = buildRows({ races: [bad], sheet: new Map([["c1", L(9, 1)]]), politico: { senate: payload([contest("c1", 9, 1)]) } });
  assert.match(r.problem, /Incumbent/);
  assert.deepEqual([r.dem2p, r.overUnder, r.votesSource], [null, null, null]);
  assert.equal(r.dem.name, "Dana Dem", "names still shown");
});

test("buildRows: never drops a race; a duplicate contest ID cannot break the good race", () => {
  const races = [race(), race({ label: "TX", problem: "duplicate contest ID", demId: "7", repId: "8" }), race({ label: "NM", contestId: "c3", demId: "3", repId: "4" })];
  const rows = buildRows({ races, politico: { senate: payload([contest("c1", 6, 4), contest("c3", 1, 9, 0.5, "3", "4")]) } });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].problem, null);
  assert.equal(rows[0].demVotes, 6);
  assert.match(rows[1].problem, /duplicate/);
  assert.equal(rows[2].repVotes, 9);
});

test("buildRows: politico layer is per office; the same contest ID in another office's file is ignored", () => {
  const [r] = buildRows({ races: [race({ office: "house" })], politico: { senate: payload([contest("c1", 9, 9)]) } });
  assert.equal(r.votesSource, null);
});

test("buildRows: % reporting comes from the winner (so the reporting filter and incumbency use it)", () => {
  const [r] = buildRows({ races: [race()], committed: new Map([["c1", L(50, 50, 0.99)]]), politico: { senate: payload([contest("c1", 80, 30, 0.2)]) } });
  assert.deepEqual([r.votesSource, r.pctReporting], ["politico", 0.2]);
});

test("backupLayers: the committed backups stand in only until the published Sheet has loaded", () => {
  const withBackup = (v) => ({ races: [race({ backup: v })] });
  const committed = withBackup({ demVotes: 9, repVotes: 90000, pct: 0.9, asOf: 1 }); // a committed typo (R 9000 -> 90000)
  const live = withBackup({ demVotes: 9, repVotes: 9000, pct: 0.9, asOf: 2 }); // fixed in the Sheet
  const before = backupLayers(committed, null);
  assert.equal(before.committed.size, 1);
  assert.equal(before.sheet.size, 0);
  const after = backupLayers(committed, live);
  assert.equal(after.committed.size, 0, "committed backups are dropped once the Sheet loaded");
  assert.equal(after.sheet.size, 1);
  // end to end: the typo wins before the Sheet loads, and is gone after the Sheet corrects it
  const rowsBefore = buildRows({ races: [race()], ...before });
  assert.deepEqual([rowsBefore[0].votesSource, rowsBefore[0].repVotes], ["committed", 90000]);
  const rowsAfter = buildRows({ races: [race()], ...after });
  assert.deepEqual([rowsAfter[0].votesSource, rowsAfter[0].repVotes], ["sheet", 9000]);
  // a Sheet that cleared the backup entirely also wipes the committed typo: no votes, no source
  const cleared = backupLayers(committed, { races: [race({ backup: null })] });
  assert.equal(buildRows({ races: [race()], ...cleared })[0].votesSource, null);
  assert.equal(backupLayers(null, null).committed.size, 0);
});

test("keepBestBackups: a blank or older snapshot of the published Sheet never takes votes away", () => {
  const B = (d, r, pct = 0.5) => ({ demVotes: d, repVotes: r, pct, asOf: 1 });
  const read = (...bs) => ({ races: bs.map((b, i) => ({ contestId: `c${i}`, backup: b })), warnings: [] });
  const best = new Map();
  const good = keepBestBackups(read(B(10, 5), B(20, 20), null), best);
  assert.deepEqual(good.races.map((r) => r.backup && r.backup.demVotes), [10, 20, null]);
  // a snapshot caught mid-update: every vote cell blank / zero
  const blank = keepBestBackups(read(B(0, 0, 0), null, B(0, 0, 0)), best);
  assert.deepEqual(blank.races.map((r) => r.backup && r.backup.demVotes), [10, 20, 0], "earlier good votes kept; a race never seen stays as read");
  // an older snapshot: fewer votes for one race, more for another
  const mixed = keepBestBackups(read(B(8, 5), B(30, 25), B(4, 4)), best);
  assert.deepEqual(mixed.races.map((r) => r.backup.demVotes), [10, 30, 4], "per race, the larger total wins");
  assert.equal(best.get("c1").demVotes, 30, "and is remembered");
  // the input is untouched; other fields pass through; problem races and blank IDs are left alone
  const input = { races: [{ contestId: "c0", backup: B(1, 1), label: "X" }, { contestId: "", backup: B(1, 1) }, { contestId: "p", problem: "bad", backup: null }], warnings: ["w"] };
  const out = keepBestBackups(input, best);
  assert.equal(out.races[0].backup.demVotes, 10);
  assert.equal(out.races[0].label, "X");
  assert.equal(input.races[0].backup.demVotes, 1, "not mutated");
  assert.deepEqual(out.warnings, ["w"]);
  assert.equal(out.races[1].backup.demVotes, 1);
  assert.equal(best.has(""), false);
});

// ---- real 2024 data ----------------------------------------------------------------------------------

const committed = (f) => readFileSync(new URL(`./data/2024/${f}`, import.meta.url), "utf8");

test("2024 from the committed Sheet copy alone: 441 rows, all from the committed backup", () => {
  const { races } = parseBundle(committed("sheet.csv"), committed("categories.csv"));
  const rows = buildRows({ races, committed: backupIndex(races) });
  assert.equal(rows.length, 441);
  assert.ok(rows.every((r) => r.votesSource === "committed" && r.problem === null && r.overUnder !== null));
  const e = incumbencyEffect(rows, 0.5);
  assert.deepEqual(e.n, { dem: 186, rep: 186, open: 69 });
  assert.equal((e.dem * 100).toFixed(1), "2.0");
  assert.equal((e.rep * 100).toFixed(1), "-1.5");
  assert.ok(Math.abs(averageOverUnder(rows).mean * 100 - -0.1) < 0.05);
  const gallego = rows.find((r) => r.dem.name === "Ruben Gallego");
  assert.ok(Math.abs(gallego.overUnder - (1676335 / (1676335 + 1595761) - 0.472)) < 1e-9);
});

// (The raw-Politico comparisons of the old 438-race Sheet were retired: the 2024 Sheet now holds the certified
// results, which differ from Politico's election-night files, and the 2024 page no longer reads Politico.)

// ---- real 2026 data -----------------------------------------------------------------------------------

test("2026 from the committed Sheet copy: 482 rows, no votes yet, so no numbers and no source", () => {
  const { races } = parseBundle(readFileSync(new URL("./data/2026/sheet.csv", import.meta.url), "utf8"), null);
  const rows = buildRows({ races, committed: backupIndex(races) });
  assert.equal(rows.length, 482);
  assert.ok(rows.every((r) => r.overUnder === null && r.votesSource === null && r.problem === null));
  assert.equal(incumbencyEffect(rows, 0.5).enabled, false);
});
