// Live-polling scheduler for Politico's summaries files. No DOM, no global fetch/timers: the
// caller injects them, so the timing rules are testable with a fake clock.
//
// Rules (principal, 2026-10-31):
//  1. After first load fetch ONE office every 20 s, round-robin senate -> governor -> house, so
//     each office refreshes every ~60 s and a viewer never sends more than one request per 20 s.
//  2. Stop while the tab is hidden; when visible again fetch immediately (but never sooner than
//     20 s after the last request) and resume the cycle.
//  3. Never add query params to Politico URLs (their 15 s CDN cache absorbs the traffic).
//  4. First load: senate at 0 s, governor at 2 s, house at 4 s, each rendered as it arrives,
//     then the 20 s cycle.
// A failed fetch is reported through onError and does not stop the cycle; the caller keeps the
// office's last good data.

export const CYCLE_MS = 20_000;
export const INITIAL_GAP_MS = 2_000;

const BASE = "https://www.politico.com/election-data";

/** Politico summaries URL for an election date and office. Never carries a query string. */
export function summariesUrl(date, office) {
  return `${BASE}/results__${date}__collections__${date}-collection-${office}__summaries/data.json`;
}

export const FETCH_TIMEOUT_MS = 15_000;
/** A office's data older than this (since its last SUCCESS) gets the stale warning. */
export const STALE_AFTER_MS = 150_000;

/** A non-2xx response. status 429 means Politico is rate-limiting this viewer. */
export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Stale = no successful fetch within maxAgeMs (or none yet). Not based on an error count. */
export function isStale(lastSuccessAt, nowMs, maxAgeMs = STALE_AFTER_MS) {
  return lastSuccessAt === null || lastSuccessAt === undefined || nowMs - lastSuccessAt > maxAgeMs;
}

/** A summaries payload we can use: {contests: [...]} with array `results` where present. */
function validSummaries(d) {
  return (
    d !== null &&
    typeof d === "object" &&
    Array.isArray(d.contests) &&
    d.contests.every((c) => c !== null && typeof c === "object" && (c.results === undefined || Array.isArray(c.results)))
  );
}

/**
 * Builds the fetchOffice for createPoller: GET the summaries file (no query string, default cache
 * mode), abort after timeoutMs, throw HttpError on non-2xx (fetch resolves normally on 429/500)
 * and throw on a malformed body, so every failure reaches onError.
 */
export function makeFetchOffice({
  date,
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = FETCH_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
}) {
  return async (office) => {
    const ctl = new AbortController();
    const timer = setTimer(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(summariesUrl(date, office), { signal: ctl.signal });
      if (!res.ok) throw new HttpError(res.status);
      const data = await res.json();
      if (!validSummaries(data)) throw new Error(`${office}: malformed summaries`);
      return data;
    } finally {
      clearTimer(timer);
    }
  };
}

/**
 * @param {object} o
 * @param {string[]} o.offices       round-robin order, e.g. ["senate", "governor", "house"]
 * @param {(office: string) => Promise<any>} o.fetchOffice
 * @param {(office: string, data: any) => void} o.onData
 * @param {(office: string, err: unknown) => void} [o.onError]
 * @param {() => boolean} o.isHidden
 * @param {(cb: () => void) => void} o.onVisibilityChange  registers the visibilitychange listener
 * @param {(fn: () => void, ms: number) => any} o.setTimer
 * @param {(handle: any) => void} o.clearTimer
 * @param {() => number} o.now
 */
export function createPoller(o) {
  const { offices, fetchOffice, onData, onError = () => {}, isHidden, setTimer, clearTimer, now } = o;
  let next = 0; // index into offices of the next fetch
  let fetched = 0; // fetches started so far; < offices.length means still in the first load
  let timer = null;
  let lastAt = -Infinity;
  let started = false;

  const gap = () => (fetched < offices.length ? INITIAL_GAP_MS : CYCLE_MS);

  function schedule(ms) {
    clearTimer(timer);
    timer = setTimer(step, ms);
  }

  function step() {
    timer = null;
    if (isHidden()) return; // resumed by the visibility handler
    const office = offices[next];
    next = (next + 1) % offices.length;
    fetched += 1;
    lastAt = now();
    schedule(gap()); // schedule before awaiting: a slow or failed fetch never stalls the cycle
    // One .catch after both steps: a throw from fetchOffice OR from onData (a render bug) is an error.
    Promise.resolve()
      .then(() => fetchOffice(office))
      .then((data) => onData(office, data))
      .catch((err) => onError(office, err))
      .catch(() => {}); // onError itself threw: nothing left to do, but never an unhandled rejection
  }

  function onVisibility() {
    if (!started) return;
    if (isHidden()) {
      clearTimer(timer);
      timer = null;
    } else if (timer === null) {
      // Fetch now, unless a request went out less than a gap ago.
      schedule(Math.max(0, lastAt + gap() - now()));
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      o.onVisibilityChange(onVisibility);
      if (!isHidden()) step();
    },
  };
}
