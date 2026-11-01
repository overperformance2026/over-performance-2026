import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDataDir, hasResults, fallBack, shouldAdopt, createPlanTracker, describeSource, PLAN_LABELS } from "./plans.js";

const fmt = (t) => `T${t}`;
const sum = (votes) => ({ contests: [{ id: "c", results: [{ id: "1", votes }] }] });

test("a 2026 page may only read data/2026", () => {
  assertDataDir("data/2026", "2026-11-03");
  for (const bad of ["data/2024", "data/2026/old", "other/2026", "data/2025"]) {
    assert.throws(() => assertDataDir(bad, "2026-11-03"), /does not match/, bad);
  }
});

test("hasResults: empty, missing and zero-vote data have none", () => {
  assert.equal(hasResults({ contests: [] }), false);
  assert.equal(hasResults(null), false);
  assert.equal(hasResults({}), false);
  assert.equal(hasResults(sum(0)), false);
  assert.equal(hasResults({ contests: [{ results: {} }] }), false);
  assert.equal(hasResults(sum(5)), true);
});

test("fallBack walks A -> B -> C in order and skips plans with no source", async () => {
  const asked = [];
  const sources = {
    C: async (o) => (asked.push(["C", o]), { summaries: sum(1), asOf: 100 }),
  };
  const got = await fallBack({ office: "senate", after: "A", sources });
  assert.deepEqual(asked, [["C", "senate"]]);
  assert.deepEqual(got, { plan: "C", summaries: sum(1), asOf: 100 });
});

test("fallBack: B slots in later, before C, with no other change", async () => {
  const sources = {
    B: async () => ({ summaries: sum(2), asOf: 50 }),
    C: async () => ({ summaries: sum(1), asOf: 100 }),
  };
  assert.equal((await fallBack({ office: "house", after: "A", sources })).plan, "B");
  assert.equal((await fallBack({ office: "house", after: "B", sources })).plan, "C");
});

test("fallBack skips a source that returns null or throws; returns null when none work", async () => {
  const sources = { B: async () => { throw new Error("sheet down"); }, C: async () => null };
  assert.equal(await fallBack({ office: "house", after: "A", sources }), null);
  assert.equal(await fallBack({ office: "house", after: "C", sources: { C: async () => ({}) } }), null);
});

test("fallBack never replaces fresher data with an older snapshot", async () => {
  const sources = { C: async () => ({ summaries: sum(1), asOf: 100 }) };
  assert.equal(await fallBack({ office: "senate", after: "A", sources, newerThan: 200 }), null);
  assert.equal((await fallBack({ office: "senate", after: "A", sources, newerThan: 100 })).plan, "C");
});

test("fallBack: a backup with an unknown time cannot replace live data, but can fill an empty office", async () => {
  const sources = { B: async () => ({ summaries: sum(1), asOf: null }) };
  assert.equal(await fallBack({ office: "house", after: "A", sources, newerThan: 100 }), null);
  const got = await fallBack({ office: "house", after: "A", sources });
  assert.deepEqual([got.plan, got.asOf], ["B", null]);
});

test("shouldAdopt: first data wins, live is replaced by newer, a backup is never downgraded", () => {
  const got = (plan, asOf) => ({ plan, asOf, summaries: {} });
  assert.equal(shouldAdopt(null, got("C", 5)), true);
  assert.equal(shouldAdopt(undefined, got("B", null)), true);
  assert.equal(shouldAdopt({ plan: "A", asOf: 1 }, got("B", 9)), true); // newer than the live data
  assert.equal(shouldAdopt({ plan: "A", asOf: 10 }, got("B", 9)), false); // a live fetch landed meanwhile
  assert.equal(shouldAdopt({ plan: "A", asOf: 10 }, got("C", null)), false); // unknown time can't beat live
  assert.equal(shouldAdopt({ plan: "C", asOf: 5 }, got("B", 1)), true); // B beats C even if older
  assert.equal(shouldAdopt({ plan: "B", asOf: 5 }, got("C", 99)), false); // never downgrade
  assert.equal(shouldAdopt({ plan: "B", asOf: 5 }, got("B", 6)), true); // same plan, newer sheet
  assert.equal(shouldAdopt({ plan: "B", asOf: 5 }, got("B", 5)), false);
  assert.equal(shouldAdopt({ plan: "B", asOf: 5 }, got("B", null)), false);
  assert.equal(shouldAdopt({ plan: "C", asOf: 5 }, got("C", 5)), false);
  assert.equal(shouldAdopt({ plan: "C", asOf: null }, got("C", 5)), true);
  assert.equal(shouldAdopt({ plan: "C", asOf: 5 }, null), false);
});

test("tracker: worst plan wins, oldest asOf, mixed flag", () => {
  const t = createPlanTracker(["senate", "governor", "house"]);
  assert.equal(t.summary(), null);
  t.set("senate", "A", 300);
  assert.deepEqual(t.summary(), { plan: "A", asOf: 300, mixed: false });
  t.set("governor", "C", 100);
  t.set("house", "A", 400);
  assert.deepEqual(t.summary(), { plan: "C", asOf: 100, mixed: true });
  t.set("governor", "A", 500); // switched back to A
  assert.deepEqual(t.summary(), { plan: "A", asOf: 300, mixed: false });
  t.set("house", "C", undefined);
  assert.equal(t.summary().asOf, 300);
});

test("describeSource: no results yet is never blank", () => {
  const base = { live: true, formatTime: fmt };
  assert.match(describeSource({ ...base, summary: null, anyResults: false }), /No results yet/);
  assert.match(describeSource({ ...base, summary: { plan: "C", asOf: 1, mixed: false }, anyResults: false }), /No results yet/);
});

test("describeSource: a live page with snapshot results but no live answer yet says loading, not backup", () => {
  const text = describeSource({ live: true, formatTime: fmt, anyResults: true, summary: null });
  assert.match(text, /Loading live results/);
  assert.ok(!text.includes("unavailable") && !text.includes("Committed snapshot"));
});

test("describeSource: shows the active plan and the data-as-of time", () => {
  const live = describeSource({ live: true, formatTime: fmt, anyResults: true, summary: { plan: "A", asOf: 7, mixed: false } });
  assert.ok(live.includes(PLAN_LABELS.A) && live.includes("Data as of T7") && !live.includes("unavailable"));
  const fb = describeSource({ live: true, formatTime: fmt, anyResults: true, summary: { plan: "C", asOf: 9, mixed: true } });
  assert.ok(fb.includes(PLAN_LABELS.C) && fb.includes("live feed is unavailable") && fb.includes("Data as of T9"));
  assert.ok(fb.includes("older source"));
  const stat = describeSource({ live: false, formatTime: fmt, anyResults: true, summary: { plan: "C", asOf: 9, mixed: false } });
  assert.ok(stat.includes("Committed snapshot") && !stat.includes("unavailable"));
  assert.match(describeSource({ live: true, formatTime: fmt, anyResults: true, stale: true, summary: { plan: "A", asOf: 1, mixed: false } }), /out of date/);
  assert.match(describeSource({ live: false, formatTime: fmt, anyResults: true, summary: { plan: "C", asOf: null, mixed: false } }), /Data as of unknown/);
});
