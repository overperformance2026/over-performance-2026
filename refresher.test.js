import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefresher, REREAD_MS } from "./refresher.js";

// Manual clock like poller.test.js: advance(ms) runs due timers in order and lets promises settle.
function harness({ failOn = () => false, slow = false } = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  let hidden = false;
  let visibilityCb = () => {};
  const loads = [];
  const errors = [];
  let release = null;
  const r = createRefresher({
    load: async () => {
      loads.push(t);
      if (slow) await new Promise((res) => (release = res));
      if (failOn(loads.length)) throw new Error("sheet down");
    },
    onError: (e) => errors.push(e.message),
    isHidden: () => hidden,
    onVisibilityChange: (cb) => (visibilityCb = cb),
    setTimer: (fn, ms) => (timers.set(nextId, { at: t + ms, fn }), nextId++),
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
      await new Promise((res) => setImmediate(res));
    }
    t = end;
    await new Promise((res) => setImmediate(res));
  }
  return { r, advance, loads, errors, setHidden: (h) => ((hidden = h), visibilityCb()), release: () => release?.(), now: () => t };
}

test("re-reads every 5 minutes, the first one 5 minutes after start", async () => {
  assert.equal(REREAD_MS, 300_000);
  const h = harness();
  h.r.start();
  await h.advance(REREAD_MS - 1);
  assert.deepEqual(h.loads, []);
  await h.advance(1);
  assert.deepEqual(h.loads, [300_000]);
  await h.advance(REREAD_MS * 2);
  assert.deepEqual(h.loads, [300_000, 600_000, 900_000]);
});

test("paused while hidden; on becoming visible it re-reads at once if due, else waits out the rest", async () => {
  const h = harness();
  h.r.start();
  await h.advance(100_000);
  h.setHidden(true);
  await h.advance(REREAD_MS * 3);
  assert.deepEqual(h.loads, [], "no loads while hidden");
  h.setHidden(false); // 400 s since the last read: due
  await h.advance(0);
  assert.deepEqual(h.loads, [h.now()]);
  const resumedAt = h.loads[0];
  await h.advance(REREAD_MS);
  assert.deepEqual(h.loads, [resumedAt, resumedAt + REREAD_MS]);
});

test("a quick hide/show does not trigger an early re-read", async () => {
  const h = harness();
  h.r.start();
  await h.advance(60_000);
  h.setHidden(true);
  h.setHidden(false);
  await h.advance(0);
  assert.deepEqual(h.loads, []);
  await h.advance(REREAD_MS - 60_000);
  assert.deepEqual(h.loads, [REREAD_MS]);
});

test("a failed load is reported and the cycle keeps going (the caller keeps its last good data)", async () => {
  const h = harness({ failOn: (n) => n === 1 });
  h.r.start();
  await h.advance(REREAD_MS * 2);
  assert.deepEqual(h.errors, ["sheet down"]);
  assert.equal(h.loads.length, 2);
});

test("never two loads at once", async () => {
  const h = harness({ slow: true });
  h.r.start();
  await h.advance(REREAD_MS);
  assert.equal(h.loads.length, 1);
  h.setHidden(true);
  h.setHidden(false);
  await h.advance(0);
  assert.equal(h.loads.length, 1, "visibility change during a running load starts nothing");
  h.release();
  await h.advance(0);
  await h.advance(REREAD_MS);
  assert.equal(h.loads.length, 2);
});

test("starting while hidden waits for the tab to show; double start is harmless", async () => {
  const h = harness();
  h.setHidden(true);
  h.r.start();
  h.r.start();
  await h.advance(REREAD_MS * 2);
  assert.deepEqual(h.loads, []);
  h.setHidden(false);
  await h.advance(0);
  assert.equal(h.loads.length, 1);
});
