// Re-reads the published Sheet every few minutes while the page is open. No DOM, no fetch: the
// caller supplies `load` (does the fetch, parse and state update, and decides what "last good data"
// means) and the timers, so the rules are testable with a fake clock.
//
// Rules: first re-read INTERVAL after start (the caller already did the first load); paused while the
// tab is hidden; on becoming visible, re-read at once if it is due, else wait out the rest; a failed
// load is reported through onError and never stops the cycle (the caller keeps its last good data);
// never two loads at once.

export const REREAD_MS = 5 * 60_000;

/**
 * @param {object} o
 * @param {() => Promise<void>} o.load
 * @param {(err: unknown) => void} [o.onError]
 * @param {() => boolean} o.isHidden
 * @param {(cb: () => void) => void} o.onVisibilityChange
 * @param {(fn: () => void, ms: number) => any} o.setTimer
 * @param {(handle: any) => void} o.clearTimer
 * @param {() => number} o.now
 * @param {number} [o.intervalMs]
 */
export function createRefresher({ load, onError = () => {}, isHidden, onVisibilityChange, setTimer, clearTimer, now, intervalMs = REREAD_MS }) {
  let timer = null;
  let lastAt = now(); // the caller's initial load counts as the last read
  let started = false;
  let inFlight = false;

  function schedule(ms) {
    clearTimer(timer);
    timer = setTimer(tick, ms);
  }

  async function tick() {
    timer = null;
    if (isHidden() || inFlight) return; // resumed by the visibility handler / the running load
    inFlight = true;
    lastAt = now();
    try {
      await load();
    } catch (err) {
      try {
        onError(err);
      } catch {
        /* a throwing error handler must not stop the cycle */
      }
    } finally {
      inFlight = false;
      if (!isHidden()) schedule(intervalMs);
    }
  }

  function onVisibility() {
    if (!started) return;
    if (isHidden()) {
      clearTimer(timer);
      timer = null;
    } else if (timer === null && !inFlight) {
      schedule(Math.max(0, lastAt + intervalMs - now()));
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      lastAt = now();
      onVisibilityChange(onVisibility);
      if (!isHidden()) schedule(intervalMs);
    },
  };
}
