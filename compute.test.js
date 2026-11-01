import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { computeRows, filterRows, attributeNames, averageOverUnder, filterByReporting, applyFilters, incumbencyEffect, applyIncumbency, MIN_GROUP } from "./compute.js";

// ---- synthetic fixtures -------------------------------------------------

const cand = (id, fullName, party) => ({ id, fullName, shortName: fullName, party });
const entry = (contestId, ...cs) => ({
  contestId,
  contest: { id: contestId },
  candidates: Object.fromEntries(cs.map((c) => [c.id, c])),
});
const summary = (id, votes, pct = 0.5) => ({
  id,
  results: Object.entries(votes).map(([cid, v]) => ({ id: cid, votes: v })),
  progress: { pct },
});
const race = (contestId, extra = {}) => ({
  contestId,
  office: "senate",
  label: "XX",
  harris2p: 0.5,
  ...extra,
});

const META = [entry("c1", cand("1", "Dana Dem", "dem"), cand("2", "Rex Rep", "gop"), cand("3", "Lee Lib", "other-party"))];
const SUMS = { contests: [summary("c1", { 1: 600, 2: 400, 3: 999 }, 0.8)] };

test("two-party share ignores third parties; over/under is vs Harris", () => {
  const [r] = computeRows({ metadata: META, summaries: SUMS, races: [race("c1", { harris2p: 0.55 })] });
  assert.equal(r.dem.name, "Dana Dem");
  assert.equal(r.rep.name, "Rex Rep");
  assert.equal(r.demVotes, 600);
  assert.equal(r.repVotes, 400);
  assert.ok(Math.abs(r.dem2p - 0.6) < 1e-12);
  assert.ok(Math.abs(r.overUnder - 0.05) < 1e-12);
  assert.equal(r.pctReporting, 0.8);
});

test("zero votes: row is kept with null numbers", () => {
  const sums = { contests: [summary("c1", { 1: 0, 2: 0 }, 0)] };
  const [r] = computeRows({ metadata: META, summaries: sums, races: [race("c1")] });
  assert.equal(r.dem.name, "Dana Dem");
  assert.equal(r.dem2p, null);
  assert.equal(r.overUnder, null);
});

test("contest missing from summaries: names shown, numbers null", () => {
  const [r] = computeRows({ metadata: META, summaries: { contests: [] }, races: [race("c1")] });
  assert.equal(r.rep.name, "Rex Rep");
  assert.equal(r.dem2p, null);
  assert.equal(r.pctReporting, null);
});

test("missing progress, missing votes field, null payloads do not throw", () => {
  const sums = { contests: [{ id: "c1", results: [{ id: "1", votes: 10 }, { id: "2" }] }] };
  const [r] = computeRows({ metadata: META, summaries: sums, races: [race("c1")] });
  assert.equal(r.pctReporting, null);
  assert.equal(r.dem2p, null); // rep votes unknown -> no number rather than a wrong one
});

test("a race is never dropped: metadata/summaries null -> one row per race, null numbers, names kept", () => {
  const races = [race("c1", { demName: "Dana Dem", repName: "Rex Rep" }), race("c2")];
  for (const bad of [null, undefined, "oops", {}]) {
    const rows = computeRows({ metadata: bad, summaries: null, races });
    assert.equal(rows.length, races.length);
    assert.ok(rows.every((r) => r.dem2p === null && r.overUnder === null && r.demVotes === null));
    assert.equal(rows[0].dem.name, "Dana Dem");
    assert.equal(rows[0].rep.name, "Rex Rep");
    assert.equal(rows[1].dem.name, null);
    assert.equal(rows[0].problem, "metadata unavailable");
  }
});

test("healthy race has problem null", () => {
  const [r] = computeRows({ metadata: META, summaries: SUMS, races: [race("c1")] });
  assert.equal(r.problem, null);
});

test("summary results that is not an array does not throw", () => {
  const [r] = computeRows({ metadata: META, summaries: { contests: [{ id: "c1", results: "x" }] }, races: [race("c1")] });
  assert.equal(r.dem2p, null);
});

test("race without both a Dem and a Rep, or absent from metadata: row kept with a problem", () => {
  const meta = [
    entry("noD", cand("1", "A", "gop"), cand("2", "B", "other-party")),
    entry("noR", cand("3", "C", "dem")),
  ];
  const rows = computeRows({ metadata: meta, summaries: { contests: [] }, races: [race("noD"), race("noR"), race("absent")] });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.problem), ["Dem not found", "Rep not found", "contest not in metadata"]);
  assert.equal(rows[0].rep.name, "A"); // what we did find is still shown
  assert.ok(rows.every((r) => r.dem2p === null));
});

test("two Democrats without an override: row kept with a problem (ambiguous)", () => {
  const meta = [entry("dd", cand("1", "A", "dem"), cand("2", "B", "dem"), cand("3", "R", "gop"))];
  const [r] = computeRows({ metadata: meta, summaries: { contests: [summary("dd", { 1: 1, 2: 1, 3: 1 })] }, races: [race("dd")] });
  assert.equal(r.problem, "Dem not found");
  assert.equal(r.dem2p, null);
});

test("demName override picks an independent the Dems back, matched by full name", () => {
  const meta = [entry("ne", cand("1", "Deb Fischer", "gop"), cand("2", "Dan Osborn", "other-party"))];
  const sums = { contests: [summary("ne", { 1: 60, 2: 40 })] };
  const [r] = computeRows({ metadata: meta, summaries: sums, races: [race("ne", { demName: "Dan Osborn" })] });
  assert.equal(r.dem.name, "Dan Osborn");
  assert.ok(Math.abs(r.dem2p - 0.4) < 1e-12);
});

test("override naming a candidate who is not on the ballot: row kept with a problem", () => {
  const rows = computeRows({ metadata: META, summaries: SUMS, races: [race("c1", { demName: "Nobody" })] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].problem, "Dem not found");
  assert.equal(rows[0].dem2p, null);
});

test("demId/repId from the sheet pick candidates regardless of party", () => {
  const meta = [entry("x", cand("1", "A", "dem"), cand("2", "B", "dem"), cand("3", "R", "gop"), cand("4", "S", "gop"))];
  const sums = { contests: [summary("x", { 1: 10, 2: 90, 3: 60, 4: 40 })] };
  const [r] = computeRows({ metadata: meta, summaries: sums, races: [race("x", { demId: "2", repId: "4" })] });
  assert.equal(r.dem.name, "B");
  assert.equal(r.rep.name, "S");
  assert.ok(Math.abs(r.dem2p - 90 / 130) < 1e-12);
});

test("demId not in the contest: row kept with a problem, no numbers", () => {
  const rows = computeRows({ metadata: META, summaries: SUMS, races: [race("c1", { demId: "999", demName: "Sheet Name" })] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].problem, "Dem not found");
  assert.equal(rows[0].dem.name, "Sheet Name"); // falls back to the build-time name
  assert.equal(rows[0].dem2p, null);
});

test("race attrs pass through to rows; absent attrs become []", () => {
  const [a] = computeRows({ metadata: META, summaries: SUMS, races: [race("c1", { attrs: ["Sanders endorsed"] })] });
  const [b] = computeRows({ metadata: META, summaries: SUMS, races: [race("c1")] });
  assert.deepEqual(a.attrs, ["Sanders endorsed"]);
  assert.deepEqual(b.attrs, []);
});

test("filterRows keeps rows with the attribute; null/empty means all; attributeNames lists them sorted", () => {
  const rows = [{ id: 1, attrs: ["Sanders", "Incumbent"] }, { id: 2, attrs: ["Incumbent"] }, { id: 3, attrs: [] }];
  assert.deepEqual(filterRows(rows, "Sanders").map((r) => r.id), [1]);
  assert.deepEqual(filterRows(rows, "Incumbent").map((r) => r.id), [1, 2]);
  assert.deepEqual(filterRows(rows, "Nope"), []);
  assert.equal(filterRows(rows, null), rows);
  assert.equal(filterRows(rows, ""), rows);
  assert.deepEqual(attributeNames(rows), ["Incumbent", "Sanders"]);
  assert.deepEqual(attributeNames([]), []);
});

test("filterByReporting keeps rows at or above the minimum; unknown % reporting is kept", () => {
  const rows = [{ id: 1, pctReporting: 0.9 }, { id: 2, pctReporting: 0.49 }, { id: 3, pctReporting: 0.5 }, { id: 4, pctReporting: null }];
  assert.deepEqual(filterByReporting(rows, 0.5).map((r) => r.id), [1, 3, 4]);
  assert.deepEqual(filterByReporting(rows, 0.95).map((r) => r.id), [4]);
  assert.deepEqual(filterByReporting(rows, 0).map((r) => r.id), [1, 2, 3, 4]);
});

test("applyFilters: category then reporting; hidden counts what the reporting filter removed", () => {
  const rows = [
    { id: 1, attrs: ["A"], pctReporting: 0.9 },
    { id: 2, attrs: ["A"], pctReporting: 0.3 },
    { id: 3, attrs: [], pctReporting: 0.99 },
    { id: 4, attrs: ["A"], pctReporting: null },
  ];
  const a = applyFilters(rows, "A", 0.5);
  assert.deepEqual(a.inCategory.map((r) => r.id), [1, 2, 4]);
  assert.deepEqual(a.shown.map((r) => r.id), [1, 4]);
  assert.equal(a.hidden, 1);
  const all = applyFilters(rows, "", 0.95);
  assert.deepEqual(all.shown.map((r) => r.id), [3, 4]);
  assert.equal(all.hidden, 2);
  assert.deepEqual(applyFilters([], "A", 0.5), { inCategory: [], shown: [], hidden: 0 });
});

test("averageOverUnder: simple mean over rows that have a number; counts both", () => {
  const rows = [{ overUnder: 0.04 }, { overUnder: -0.02 }, { overUnder: null }, { overUnder: 0.01 }];
  const { mean, counted, total } = averageOverUnder(rows);
  assert.ok(Math.abs(mean - 0.01) < 1e-12);
  assert.equal(counted, 3);
  assert.equal(total, 4);
  assert.deepEqual(averageOverUnder([{ overUnder: null }]), { mean: null, counted: 0, total: 1 });
  assert.deepEqual(averageOverUnder([]), { mean: null, counted: 0, total: 0 });
});

// ---- incumbency effect ---------------------------------------------------

const ir = (incumbent, raw, pct = 0.9, extra = {}) => ({ incumbent, rawOverUnder: raw, overUnder: raw, pctReporting: pct, attrs: [], ...extra });
const many = (incumbent, raws, pct) => raws.map((x) => ir(incumbent, x, pct));
// 5 / 5 / 5: dem mean .03, rep mean -.02, open mean .01 -> dem +.02, rep -.03
const SAMPLE = [
  ...many("dem", [0.01, 0.02, 0.03, 0.04, 0.05]),
  ...many("rep", [-0.04, -0.03, -0.02, -0.01, 0.0]),
  ...many("open", [0.0, 0.005, 0.01, 0.015, 0.02]),
];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);

test("incumbencyEffect: boosts are group means minus the open-seat mean (slope fixed at 1)", () => {
  const e = incumbencyEffect(SAMPLE, 0);
  assert.equal(e.enabled, true);
  assert.deepEqual(e.n, { dem: 5, rep: 5, open: 5 });
  near(e.dem, 0.02);
  near(e.rep, -0.03);
});

test("incumbencyEffect: disabled below MIN_GROUP in any one group, with the counts to show", () => {
  const four = [...SAMPLE.slice(0, 4), ...SAMPLE.slice(5)]; // 4 dem
  const e = incumbencyEffect(four, 0);
  assert.equal(MIN_GROUP, 5);
  assert.equal(e.enabled, false);
  assert.deepEqual(e.n, { dem: 4, rep: 5, open: 5 });
  assert.equal(e.dem, null);
  assert.equal(e.rep, null);
  assert.equal(incumbencyEffect([], 0).enabled, false);
});

test("incumbencyEffect: excludes rows below the threshold, null over/under and unknown incumbent", () => {
  const extra = [
    ir("dem", 0.5, 0.3), // below threshold
    ir("dem", null, 0.9), // no number
    ir(null, 0.5, 0.9), // unknown group
    ir("rep", 0.5, 0.2),
  ];
  const e = incumbencyEffect([...SAMPLE, ...extra], 0.5);
  assert.deepEqual(e.n, { dem: 5, rep: 5, open: 5 });
  near(e.dem, 0.02);
  // Raising the threshold removes rows: only the 0.9-reporting ones remain at 0.85; at 0.95 none.
  assert.equal(incumbencyEffect(SAMPLE, 0.85).enabled, true);
  assert.equal(incumbencyEffect(SAMPLE, 0.95).enabled, false);
  // Unknown % reporting can't meet a threshold: excluded whenever minPct > 0, counted at 0.
  const unknown = [...SAMPLE, ir("dem", 0.1, null)];
  assert.equal(incumbencyEffect(unknown, 0.5).n.dem, 5);
  assert.equal(incumbencyEffect(unknown, 0.0001).n.dem, 5);
  assert.equal(incumbencyEffect(unknown, 0.95).n.dem, 0);
  assert.equal(incumbencyEffect(unknown, 0).n.dem, 6);
  // ...while the table filter still keeps such a row.
  assert.equal(filterByReporting([ir("dem", 0.1, null)], 0.5).length, 1);
});

test("incumbencyEffect ignores the category: it takes rows, not a filter", () => {
  const tagged = SAMPLE.map((r, i) => ({ ...r, attrs: i % 2 ? ["Sanders"] : [] }));
  assert.deepEqual(incumbencyEffect(tagged, 0), incumbencyEffect(SAMPLE, 0));
  assert.equal(incumbencyEffect.length, 2);
});

test("applyIncumbency: over/under = raw - boost, open rows boost 0, raw untouched, no mutation", () => {
  const e = incumbencyEffect(SAMPLE, 0);
  const out = applyIncumbency(SAMPLE, e);
  near(out[0].overUnder, 0.01 - 0.02);
  near(out[0].incumbencyBoost, 0.02);
  near(out[5].overUnder, -0.04 + 0.03);
  const open = out.find((r) => r.incumbent === "open");
  assert.equal(open.incumbencyBoost, 0);
  near(open.overUnder, open.rawOverUnder);
  assert.ok(out.every((r, i) => r.rawOverUnder === SAMPLE[i].rawOverUnder));
  assert.equal(SAMPLE[0].overUnder, 0.01, "input rows are not mutated");
  // The adjusted group means line up: dem rows now average the open-seat mean.
  near(averageOverUnder(out.filter((r) => r.incumbent === "dem")).mean, averageOverUnder(out.filter((r) => r.incumbent === "open")).mean);
});

test("applyIncumbency: disabled effect or null effect returns the rows unchanged", () => {
  const off = incumbencyEffect(SAMPLE.slice(0, 6), 0);
  assert.equal(applyIncumbency(SAMPLE, off), SAMPLE);
  assert.equal(applyIncumbency(SAMPLE, null), SAMPLE);
  const e = incumbencyEffect(SAMPLE, 0);
  const odd = applyIncumbency([ir(null, 0.07), ir("dem", null)], e);
  assert.equal(odd[0].overUnder, 0.07);
  assert.equal(odd[0].incumbencyBoost, null);
  assert.equal(odd[1].overUnder, null);
});

test("computeRows carries incumbent and rawOverUnder; unknown incumbent is null, not open", () => {
  const rows = computeRows({
    metadata: META,
    summaries: SUMS,
    races: [race("c1", { incumbent: "dem", harris2p: 0.55 }), race("c1", { incumbent: "weird" }), race("c1")],
  });
  assert.deepEqual(rows.map((r) => r.incumbent), ["dem", null, null]);
  assert.equal(rows[0].rawOverUnder, rows[0].overUnder);
  assert.equal(rows[0].incumbencyBoost, null);
});

// ---- real 2024 data -----------------------------------------------------

// The full-universe tests below need the raw Politico 2024 files (git-ignored, kept locally in
// data/raw/2024). They skip on a fresh clone; merge.test.js covers the committed Sheet copies.
const RAW = new URL("./data/raw/2024/", import.meta.url);
const hasRaw = existsSync(RAW);
const loadRaw = (f) => JSON.parse(readFileSync(new URL(f, RAW), "utf8"));
const OVERRIDES = { // independents Democrats backed: contestId -> name (found in the 2024 metadata)
  senateNE: "Dan Osborn",
  senateVT: "Bernie Sanders",
  senateME: "Angus King",
};

function racesFor(meta, office, overrides = {}) {
  return meta.map((e) => race(e.contestId, { office, demName: overrides[e.contestId] }));
}

test("2024 Senate: every race shows once overrides cover NE/VT/ME; Gallego 51.23%", { skip: !hasRaw }, () => {
  const metadata = loadRaw("meta-senate.json");
  const summaries = loadRaw("sum-senate.json");
  const byState = (fips) => metadata.filter((e) => e.contest.stateFips === fips && !e.contest.isSpecial);
  const overrides = {
    [byState("31")[0].contestId]: OVERRIDES.senateNE,
    [byState("50")[0].contestId]: OVERRIDES.senateVT,
    [byState("23")[0].contestId]: OVERRIDES.senateME,
  };
  const rows = computeRows({ metadata, summaries, races: racesFor(metadata, "senate", overrides) });
  assert.equal(rows.length, 35);
  assert.ok(rows.every((r) => r.problem === null));
  const noOverride = computeRows({ metadata, summaries, races: racesFor(metadata, "senate") });
  assert.equal(noOverride.length, 35, "never dropped");
  // NE/VT have no party=dem at all, so they are flagged (not hidden). ME silently pairs Costello
  // via the party fallback, which is why production must use the Sheet's IDs.
  assert.equal(noOverride.filter((r) => r.problem).length, 2);
  const az =rows.find((r) => r.dem.name === "Ruben Gallego");
  assert.ok(Math.abs(az.dem2p - 1676335 / (1676335 + 1595761)) < 1e-12);
  assert.ok(az.pctReporting > 0.9);
});

test("2024 Governor: 11 races, all with numbers", { skip: !hasRaw }, () => {
  const metadata = loadRaw("meta-governor.json");
  const rows = computeRows({ metadata, summaries: loadRaw("sum-governor.json"), races: racesFor(metadata, "governor") });
  assert.equal(rows.length, 11);
  assert.ok(rows.every((r) => r.dem2p > 0 && r.dem2p < 1));
});

test("2024 House: all 437 contests kept, 393 clean; PA-8 Cartwright ~49.19%", { skip: !hasRaw }, () => {
  const metadata = loadRaw("meta-house.json");
  const rows = computeRows({ metadata, summaries: loadRaw("sum-house.json"), races: racesFor(metadata, "house") });
  assert.equal(rows.length, 437);
  assert.equal(rows.filter((r) => r.problem === null).length, 393);
  const pa8 = rows.find((r) => r.dem.name === "Matt Cartwright");
  assert.ok(Math.abs(pa8.dem2p - 0.4919) < 1e-4);
});
