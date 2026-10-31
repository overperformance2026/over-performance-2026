import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPoller, summariesUrl, makeFetchOffice, isStale, HttpError, CYCLE_MS, INITIAL_GAP_MS, STALE_AFTER_MS,
} from "./poller.js";

const OFFICES = ["senate", "governor", "house"];

// A manual clock: advance(ms) runs due timers in time order, then lets promises settle.
function harness({ fail = () => false, throwInData = () => false } = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  let hidden = false;
  let visibilityCb = () => {};
  const calls = []; // [timeMs, office]
  const data = [];
  const errors = [];
  const rateLimited = [];
  const poller = createPoller({
    offices: OFFICES,
    fetchOffice: async (office) => {
      calls.push([t, office]);
      const f = fail(office, calls.length);
      if (f) throw Object.assign(new Error("boom"), f === 429 ? { status: 429 } : {});
      return { office };
    },
    onData: (office, d) => {
      if (throwInData(office)) throw new Error("render bug");
      data.push([office, d.office]);
    },
    onError: (office) => errors.push(office),
    onRateLimited: (office) => rateLimited.push(office),
    isHidden: () => hidden,
    onVisibilityChange: (cb) => (visibilityCb = cb),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => t,
  });
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    t = end;
    await new Promise((r) => setImmediate(r));
  }
  const setHidden = (h) => {
    hidden = h;
    visibilityCb();
  };
  return { poller, advance, setHidden, calls, data, errors, rateLimited, now: () => t };
}

test("first load: senate 0 s, governor 2 s, house 4 s, each rendered as it arrives", async () => {
  const h = harness();
  h.poller.start();
  await h.advance(0);
  assert.deepEqual(h.calls, [[0, "senate"]]);
  assert.deepEqual(h.data, [["senate", "senate"]]);
  await h.advance(INITIAL_GAP_MS);
  assert.deepEqual(h.calls.at(-1), [2000, "governor"]);
  await h.advance(INITIAL_GAP_MS);
  assert.deepEqual(h.calls.at(-1), [4000, "house"]);
  assert.deepEqual(h.data.map((d) => d[0]), ["senate", "governor", "house"]);
});

test("then one office every 20 s, round-robin, so each refreshes every 60 s", async () => {
  const h = harness();
  h.poller.start();
  await h.advance(4000 + 3 * CYCLE_MS);
  assert.deepEqual(h.calls.slice(3), [
    [24000, "senate"],
    [44000, "governor"],
    [64000, "house"],
  ]);
  await h.advance(CYCLE_MS);
  assert.deepEqual(h.calls.at(-1), [84000, "senate"]);
  // Never more than one request per 20 s after the first load.
  const after = h.calls.slice(2).map((c) => c[0]);
  for (let i = 1; i < after.length; i++) assert.ok(after[i] - after[i - 1] >= CYCLE_MS);
});

test("hidden tab stops the timer; visible again fetches immediately and resumes", async () => {
  const h = harness();
  h.poller.start();
  await h.advance(4000 + CYCLE_MS); // 4 fetches: s g h s(24 s)
  assert.equal(h.calls.length, 4);
  h.setHidden(true);
  await h.advance(10 * 60_000);
  assert.equal(h.calls.length, 4, "no requests while hidden");
  h.setHidden(false);
  await h.advance(0);
  assert.equal(h.calls.length, 5);
  assert.deepEqual(h.calls.at(-1), [24000 + 10 * 60_000 + 0, "governor"]);
  const resumedAt = h.calls.at(-1)[0];
  await h.advance(CYCLE_MS);
  assert.deepEqual(h.calls.at(-1), [resumedAt + CYCLE_MS, "house"]);
});

test("quick hide/show never sends two requests inside 20 s", async () => {
  const h = harness();
  h.poller.start();
  await h.advance(4000 + CYCLE_MS); // last fetch at 24 s
  await h.advance(5000);
  h.setHidden(true);
  h.setHidden(false);
  await h.advance(0);
  assert.equal(h.calls.length, 4, "still inside the 20 s gap");
  await h.advance(15000); // t = 44 s
  assert.deepEqual(h.calls.at(-1), [44000, "governor"]);
  assert.equal(h.calls.length, 5);
});

test("a failed fetch is reported and the cycle continues", async () => {
  const h = harness({ fail: (office) => office === "governor" });
  h.poller.start();
  await h.advance(4000 + CYCLE_MS);
  assert.deepEqual(h.errors, ["governor"]);
  assert.deepEqual(h.data.map((d) => d[0]), ["senate", "house", "senate"]);
});

test("starting while hidden waits for the tab to show", async () => {
  const h = harness();
  h.setHidden(true);
  h.poller.start();
  await h.advance(60_000);
  assert.equal(h.calls.length, 0);
  h.setHidden(false);
  await h.advance(0);
  assert.deepEqual(h.calls, [[60000, "senate"]]);
});

test("a 429 stops polling for good: onRateLimited once, no more requests, not even after hide/show", async () => {
  const h = harness({ fail: (office) => (office === "governor" ? 429 : false) });
  h.poller.start();
  await h.advance(2000);
  assert.deepEqual(h.rateLimited, ["governor"]);
  assert.deepEqual(h.errors, [], "a 429 is not an ordinary error");
  const n = h.calls.length;
  await h.advance(10 * 60_000);
  h.setHidden(true);
  h.setHidden(false);
  await h.advance(10 * 60_000);
  assert.equal(h.calls.length, n);
  assert.deepEqual(h.rateLimited, ["governor"]);
});

test("onData throwing reaches onError and the cycle continues", async () => {
  const h = harness({ throwInData: (office) => office === "senate" });
  h.poller.start();
  await h.advance(4000);
  assert.deepEqual(h.errors, ["senate"]);
  assert.equal(h.calls.length, 3);
});

// ---- makeFetchOffice ----------------------------------------------------

const okRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("makeFetchOffice: returns good data, requests a query-free URL with the default cache mode", async () => {
  const seen = [];
  const f = makeFetchOffice({
    date: "2026-11-03",
    fetchImpl: async (url, opts) => (seen.push([url, Object.keys(opts)]), okRes({ contests: [] })),
  });
  assert.deepEqual(await f("senate"), { contests: [] });
  assert.ok(!seen[0][0].includes("?"));
  assert.deepEqual(seen[0][1], ["signal"]); // no cache option set
});

test("makeFetchOffice: 429 and 500 throw HttpError with the status", async () => {
  for (const status of [429, 500]) {
    const f = makeFetchOffice({ date: "d", fetchImpl: async () => okRes({}, status) });
    await assert.rejects(f("house"), (e) => e instanceof HttpError && e.status === status);
  }
});

test("makeFetchOffice: malformed bodies throw; empty contests is valid", async () => {
  for (const body of [null, [], {}, { contests: {} }, { contests: [{ id: "x", results: {} }] }]) {
    await assert.rejects(makeFetchOffice({ date: "d", fetchImpl: async () => okRes(body) })("house"), /malformed/);
  }
  const ok = await makeFetchOffice({ date: "d", fetchImpl: async () => okRes({ contests: [{ id: "x" }] }) })("house");
  assert.equal(ok.contests.length, 1);
});

test("makeFetchOffice: a hung fetch is aborted at the timeout and rejects", async () => {
  let fire;
  let cleared = false;
  const f = makeFetchOffice({
    date: "d",
    timeoutMs: 15_000,
    setTimer: (fn, ms) => {
      assert.equal(ms, 15_000);
      fire = fn;
      return 1;
    },
    clearTimer: () => (cleared = true),
    fetchImpl: (url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  const p = f("senate");
  fire();
  await assert.rejects(p, /aborted/);
  assert.ok(cleared);
});

test("isStale is based on time since the last success", () => {
  assert.equal(isStale(null, 1000), true);
  assert.equal(isStale(1000, 1000 + STALE_AFTER_MS), false);
  assert.equal(isStale(1000, 1001 + STALE_AFTER_MS), true);
});

test("Politico URLs never carry a query string or fragment", () => {
  for (const o of OFFICES) {
    const u = summariesUrl("2026-11-03", o);
    assert.ok(!u.includes("?") && !u.includes("#"), u);
    assert.ok(u.endsWith("/data.json"));
    assert.ok(u.includes("2026-11-03"));
  }
});
