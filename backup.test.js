import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv, csvObjects, parseVotes, parsePct, parseTime, backupSummaries, backupSource, sheetCsvUrl, BACKUP_TTL_MS,
} from "./backup.js";
import { hasResults, fallBack } from "./plans.js";

const HEAD = "Office,AP contest ID,AP Dem ID,AP Rep ID,backup_votes_dem,backup_votes_rep,backup_pct_reporting,backup_time_updated";
const csv = (...lines) => [HEAD, ...lines].join("\n");
const RACES = [
  { office: "senate", contestId: "s1", demId: "10", repId: "11" },
  { office: "senate", contestId: "s2", demId: "20", repId: "21" },
  { office: "house", contestId: "h1", demId: "30", repId: "31" },
];

test("parseCsv: quotes, commas and newlines inside quotes, CRLF, BOM, blank lines", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n"multi\nline",2,3\r\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["multi\nline", "2", "3"]]);
  assert.deepEqual(csvObjects("a,b\n1,2\n3"), [{ a: "1", b: "2" }, { a: "3", b: "" }]);
  assert.deepEqual(csvObjects(""), []);
});

test("parseVotes: whole numbers only, thousands separators ok", () => {
  assert.equal(parseVotes("12,345"), 12345);
  assert.equal(parseVotes(" 7 "), 7);
  assert.equal(parseVotes("0"), 0);
  for (const bad of ["", "abc", "-5", "1.5", "12k", null, undefined]) assert.equal(parseVotes(bad), null, String(bad));
});

test("parsePct: 85%, 85, 0.85 and 0.85 all mean 85 percent; nonsense is null", () => {
  for (const ok of ["85%", "85", "0.85", " 85% "]) assert.ok(Math.abs(parsePct(ok) - 0.85) < 1e-12, ok);
  assert.equal(parsePct("100%"), 1);
  assert.equal(parsePct("100"), 1);
  for (const bad of ["", "abc", "-1", "150%", "250", null]) assert.equal(parsePct(bad), null, String(bad));
});

test("parseTime: readable times become epoch ms, others null", () => {
  assert.equal(parseTime("2026-11-03T21:15:00Z"), Date.UTC(2026, 10, 3, 21, 15));
  assert.ok(Number.isFinite(parseTime("11/3/2026 21:15:00")));
  // the 2024 sheet's format (month/day/year, no zone: read as the viewer's local time)
  assert.equal(parseTime("10/1/2025 8:01:18"), new Date(2025, 9, 1, 8, 1, 18).getTime());
  assert.equal(parseTime(""), null);
  assert.equal(parseTime("soon"), null);
});

test("backupSummaries: shapes rows like Plan A, only for this office, skipping races without votes", () => {
  const rows = csvObjects(csv(
    "Senate,s1,10,11,\"1,000\",900,85%,2026-11-03T21:00:00Z",
    "Senate,s2,20,21,,,,",
    "House,h1,30,31,5,4,50%,2026-11-03T22:00:00Z",
  ));
  const out = backupSummaries(rows, RACES.filter((r) => r.office === "senate"));
  assert.deepEqual(out.summaries, {
    contests: [{ id: "s1", results: [{ id: "10", votes: 1000 }, { id: "11", votes: 900 }], progress: { pct: 0.85 } }],
  });
  assert.equal(out.asOf, Date.UTC(2026, 10, 3, 21));
  assert.equal(hasResults(out.summaries), true);
});

test("backupSummaries: nothing filled in -> null so the caller falls through; half-filled race is skipped", () => {
  const empty = csvObjects(csv("Senate,s1,10,11,,,,", "Senate,s2,20,21,,,,"));
  assert.equal(backupSummaries(empty, RACES), null);
  const half = csvObjects(csv("Senate,s1,10,11,500,,,", "Senate,s2,20,21,3,2,,"));
  assert.deepEqual(backupSummaries(half, RACES).summaries.contests.map((c) => c.id), ["s2"]);
  assert.equal(backupSummaries(csvObjects(csv("Senate,zz,1,2,3,4,,")), RACES), null, "unknown contest ids are ignored");
});

test("backupSummaries: asOf is the OLDEST time, and null if any used row has no readable time", () => {
  const two = csvObjects(csv(
    "Senate,s1,10,11,1,1,50%,2026-11-03T21:30:00Z",
    "Senate,s2,20,21,1,1,50%,2026-11-03T21:00:00Z",
  ));
  assert.equal(backupSummaries(two, RACES).asOf, Date.UTC(2026, 10, 3, 21));
  const unread = csvObjects(csv("Senate,s1,10,11,1,1,50%,2026-11-03T21:30:00Z", "Senate,s2,20,21,1,1,50%,"));
  assert.equal(backupSummaries(unread, RACES).asOf, null);
  const noPct = csvObjects(csv("Senate,s1,10,11,1,1,,2026-11-03T21:30:00Z"));
  assert.equal(backupSummaries(noPct, RACES).summaries.contests[0].progress.pct, null);
});

function fakeFetch(bodyFn, calls) {
  return async (url, opts) => {
    calls.push([url, opts]);
    const body = await bodyFn(calls.length, opts);
    return body instanceof Error ? (() => { throw body; })() : body;
  };
}
const res = (text, status = 200) => ({ ok: status < 400, status, text: async () => text });

test("backupSource: one download is shared by offices that ask together, and refreshed after the TTL", async () => {
  let t = 1000;
  const calls = [];
  const sheet = csv("Senate,s1,10,11,5,4,50%,2026-11-03T21:00:00Z", "House,h1,30,31,7,6,50%,2026-11-03T21:00:00Z");
  const src = backupSource({
    sheetUrl: sheetCsvUrl("ID"), races: RACES, now: () => t,
    fetchImpl: fakeFetch(async () => res(sheet), calls),
  });
  const [sen, hou] = await Promise.all([src("senate"), src("house")]);
  assert.equal(calls.length, 1);
  assert.equal(sen.summaries.contests[0].id, "s1");
  assert.equal(hou.summaries.contests[0].id, "h1");
  assert.match(calls[0][0], /^https:\/\/docs\.google\.com\/spreadsheets\/d\/ID\/export\?format=csv&gid=0$/);
  t += BACKUP_TTL_MS + 1;
  await src("senate");
  assert.equal(calls.length, 2);
});

test("backupSource: HTTP errors and a sheet without the backup columns throw; failures are not cached", async () => {
  const calls = [];
  const bodies = [res("nope", 500), res("a,b\n1,2"), res(csv("Senate,s1,10,11,5,4,,"))];
  const src = backupSource({ sheetUrl: "u", races: RACES, fetchImpl: fakeFetch(async (n) => bodies[n - 1], calls) });
  await assert.rejects(src("senate"), /HTTP 500/);
  await assert.rejects(src("senate"), /expected columns/);
  assert.equal((await src("senate")).summaries.contests.length, 1);
  assert.equal(calls.length, 3);
});

test("backupSource: a hung download is aborted at the timeout", async () => {
  let fire;
  const src = backupSource({
    sheetUrl: "u", races: RACES,
    setTimer: (fn, ms) => ((fire = fn), assert.equal(ms, 15000), 1),
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  const p = src("senate");
  fire();
  await assert.rejects(p, /aborted/);
});

test("waterfall A -> B -> C: B (filled sheet) beats C; an empty sheet falls through to C", async () => {
  const C = async () => ({ summaries: { contests: [] }, asOf: 50 });
  const filled = backupSource({ sheetUrl: "u", races: RACES, fetchImpl: async () => res(csv("Senate,s1,10,11,5,4,50%,2026-11-03T21:00:00Z")) });
  assert.equal((await fallBack({ office: "senate", after: "A", sources: { B: filled, C } })).plan, "B");
  const blank = backupSource({ sheetUrl: "u", races: RACES, fetchImpl: async () => res(csv("Senate,s1,10,11,,,,")) });
  assert.equal((await fallBack({ office: "senate", after: "A", sources: { B: blank, C } })).plan, "C");
  const down = backupSource({ sheetUrl: "u", races: RACES, fetchImpl: async () => res("x", 503) });
  assert.equal((await fallBack({ office: "senate", after: "A", sources: { B: down, C } })).plan, "C");
});
