import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDataDir, summarizeSources, liveIsStale, describeSource } from "./status.js";

const fmt = (t) => `T${t}`;
const row = (votesSource, votesAsOf = null) => ({ votesSource, votesAsOf });

test("a 2026 page may only read data/2026", () => {
  assertDataDir("data/2026", "2026-11-03");
  for (const bad of ["data/2024", "data/2026/old", "other/2026", "data/2025"]) assert.throws(() => assertDataDir(bad, "2026-11-03"), /does not match/, bad);
});

test("summarizeSources: counts per source, oldest known time, and whether anything has votes", () => {
  const s = summarizeSources([row("politico", 30), row("politico", 20), row("sheet", 10), row(null), row("committed", 40)]);
  assert.deepEqual(s, { counts: { politico: 2, sheet: 1, committed: 1 }, anyResults: true, asOf: 10 });
  assert.deepEqual(summarizeSources([row(null), row(null)]), { counts: { politico: 0, sheet: 0, committed: 0 }, anyResults: false, asOf: null });
  assert.deepEqual(summarizeSources([]).anyResults, false);
});

test("summarizeSources: one unreadable time makes the oldest time unknown, not newer than it is", () => {
  assert.equal(summarizeSources([row("politico", 30), row("sheet", null)]).asOf, null);
});

test("liveIsStale: some office with no successful fetch for 150 s", () => {
  assert.equal(liveIsStale({ senate: 1000, governor: 1000, house: 1000 }, 0, 1000 + 150_000), false);
  assert.equal(liveIsStale({ senate: 1000, governor: 1000, house: 1000 }, 0, 1001 + 150_000), true);
  assert.equal(liveIsStale({ senate: 100_000, governor: 100_000, house: null }, 0, 100_000), false, "house never answered but the page is young");
  assert.equal(liveIsStale({ senate: 100_000, governor: 100_000, house: null }, 0, 150_001), true, "house never answered for 150 s");
  assert.equal(liveIsStale({}, 0, 1e9), false);
});

test("describeSource: no results yet is never blank, and says nothing about a source", () => {
  const text = describeSource({ summary: summarizeSources([]), polling: true, formatTime: fmt });
  assert.match(text, /No results yet/);
  assert.ok(!/Source:/.test(text));
});

test("describeSource: one source, with the data-as-of time", () => {
  const live = describeSource({ summary: { counts: { politico: 5, sheet: 0, committed: 0 }, anyResults: true, asOf: 7 }, polling: true, formatTime: fmt });
  assert.equal(live, "Source: Live results (Politico). Data as of T7.");
  const final = describeSource({ summary: { counts: { politico: 5, sheet: 0, committed: 0 }, anyResults: true, asOf: 7 }, polling: false, formatTime: fmt });
  assert.equal(final, "Source: Politico. Data as of T7.");
  const sheet = describeSource({ summary: { counts: { politico: 0, sheet: 3, committed: 0 }, anyResults: true, asOf: null }, polling: true, formatTime: fmt });
  assert.equal(sheet, "Source: the backup sheet. Data as of unknown.");
});

test("describeSource: mixed sources say how many races come from each, and that the time is the oldest", () => {
  const text = describeSource({ summary: { counts: { politico: 400, sheet: 1, committed: 2 }, anyResults: true, asOf: 9 }, polling: true, formatTime: fmt });
  assert.equal(text, "Source: Live results (Politico) for 400 races, the backup sheet for 1 race, the committed backup for 2 races. Data as of T9 (oldest).");
});

test("describeSource: stale, rate-limited and race-list-backup notes", () => {
  const base = { summary: { counts: { politico: 1, sheet: 0, committed: 0 }, anyResults: true, asOf: 1 }, polling: true, formatTime: fmt };
  assert.match(describeSource({ ...base, stale: true }), /out of date/);
  assert.match(describeSource({ ...base, rateLimited: true }), /paused.*reload to retry/);
  assert.match(describeSource({ ...base, sheetLoaded: false }), /Race list: backup copy/);
  assert.ok(!/out of date|paused|Race list/.test(describeSource(base)));
  assert.match(describeSource({ summary: { counts: { politico: 0, sheet: 0, committed: 0 }, anyResults: false, asOf: null }, polling: true, rateLimited: true, formatTime: fmt }), /No results yet.*paused/);
});
