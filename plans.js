// Data-source plans and the public "which plan / data as of" line. No DOM, no fetch.
//
//   A = live Politico (poller.js)    B = spreadsheet backup (not built yet)    C = committed snapshot
//
// Order is A -> B -> C. A source is `async (office) => {summaries, asOf} | null`; a plan with no
// source is skipped, so B slots in later by adding sources.B and nothing else.

export const PLAN_ORDER = ["A", "B", "C"];
export const PLAN_LABELS = { A: "Live results (Politico)", B: "Spreadsheet backup", C: "Committed snapshot" };

/** A page for election `date` may only read data/<year of date>/, never another year's data. */
export function assertDataDir(dir, date) {
  const year = String(date).slice(0, 4);
  if (!new RegExp(`(^|/)data/${year}$`).test(dir)) throw new Error(`data dir ${dir} does not match election year ${year}`);
}

/** True if any contest has a candidate with votes. {contests: []} (2026 today) has none. */
export function hasResults(summaries) {
  const contests = Array.isArray(summaries?.contests) ? summaries.contests : [];
  return contests.some((c) => Array.isArray(c?.results) && c.results.some((r) => Number.isFinite(r?.votes) && r.votes > 0));
}

/**
 * Try the plans after `after` in order and return the first usable result, or null.
 * A source that returns null or throws is skipped. `newerThan` (ms): ignore results with an older
 * asOf, so a fallback never replaces fresher data we already hold.
 */
export async function fallBack({ office, after, sources, newerThan = -Infinity }) {
  for (const plan of PLAN_ORDER.slice(PLAN_ORDER.indexOf(after) + 1)) {
    if (!sources[plan]) continue;
    try {
      const got = await sources[plan](office);
      if (!got) continue;
      if (Number.isFinite(got.asOf) && got.asOf < newerThan) continue;
      return { plan, summaries: got.summaries, asOf: got.asOf ?? null };
    } catch {
      /* try the next plan */
    }
  }
  return null;
}

/** Remembers, per office, which plan its data came from and when it is as of. */
export function createPlanTracker(offices) {
  const state = new Map(offices.map((o) => [o, null]));
  return {
    set: (office, plan, asOf) => state.set(office, { plan, asOf: Number.isFinite(asOf) ? asOf : null }),
    get: (office) => state.get(office),
    /** Worst plan in use (C over B over A) and the oldest known asOf; null before any data. */
    summary() {
      const have = [...state.values()].filter(Boolean);
      if (!have.length) return null;
      const plan = PLAN_ORDER[Math.max(...have.map((s) => PLAN_ORDER.indexOf(s.plan)))];
      const times = have.map((s) => s.asOf).filter((t) => t !== null);
      return { plan, asOf: times.length ? Math.min(...times) : null, mixed: new Set(have.map((s) => s.plan)).size > 1 };
    },
  };
}

/**
 * The public status line. summary: tracker.summary(); live: page polls Politico (else it is a static
 * snapshot page); anyResults: some office has votes; formatTime: ms -> string.
 */
export function describeSource({ summary, live, anyResults, formatTime, stale = false }) {
  if (!anyResults) return "No results yet. This page updates when votes are counted.";
  // A live page has not heard back from any plan yet: don't call anything a backup before the
  // first live attempt has actually failed.
  if (!summary) return "Loading live results…";
  const when = summary.asOf === null ? "unknown" : formatTime(summary.asOf);
  const label = PLAN_LABELS[summary.plan];
  let text;
  if (!live) text = `Source: ${label}. Data as of ${when}.`;
  else if (summary.plan === "A") text = `Source: ${label}. Data as of ${when}.`;
  else text = `Source: ${label}, because the live feed is unavailable. Data as of ${when}.`;
  if (live && summary.mixed) text += " Some races are from an older source.";
  if (stale) text += " Warning: results may be out of date.";
  return text;
}
