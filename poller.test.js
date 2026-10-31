import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoller, summariesUrl, CYCLE_MS, INITIAL_GAP_MS } from "./poller.js";

const OFFICES = ["senate", "governor", "house"];

// A manual clock: advance(ms) runs due timers in time order, then lets promises settle.
function harness({ fail = () => false } = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  let hidden = false;
  let visibilityCb = () => {};
  const calls = []; // [timeMs, office]
  const data = [];
  const errors = [];
  const poller = createPoller({
    offices: OFFICES,
    fetchOffice: async (office) => {
      calls.push([t, office]);
      if (fail(office, calls.length)) throw new Error("boom");
      return { office };
    },
    onData: (office, d) => data.push([office, d.office]),
    onError: (office) => errors.push(office),
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
  return { poller, advance, setHidden, calls, data, errors, now: () => t };
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

test("Politico URLs never carry a query string or fragment", () => {
  for (const o of OFFICES) {
    const u = summariesUrl("2026-11-03", o);
    assert.ok(!u.includes("?") && !u.includes("#"), u);
    assert.ok(u.endsWith("/data.json"));
    assert.ok(u.includes("2026-11-03"));
  }
});
