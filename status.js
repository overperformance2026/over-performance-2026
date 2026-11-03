// The public status line and small guards. No DOM, no fetch.

const SOURCES = ["politico", "sheet", "committed"]; // same order as merge.js's tie-break

/** A page for election `date` may only read data/<year of date>/, never another year's data. */
export function assertDataDir(dir, date) {
  const year = String(date).slice(0, 4);
  if (!new RegExp(`(^|/)data/${year}$`).test(dir)) throw new Error(`data dir ${dir} does not match election year ${year}`);
}

/**
 * What the rows are showing: how many races take their votes from each source, the oldest known
 * "as of" time among them, and whether any race has votes at all.
 */
export function summarizeSources(rows) {
  const counts = { politico: 0, sheet: 0, committed: 0 };
  const times = [];
  let unknown = 0;
  for (const r of rows) {
    if (!r.votesSource) continue;
    counts[r.votesSource]++;
    if (Number.isFinite(r.votesAsOf)) times.push(r.votesAsOf);
    else unknown++;
  }
  const anyResults = SOURCES.some((s) => counts[s] > 0);
  // an unreadable time on any shown race means the true oldest time is unknown
  return { counts, anyResults, asOf: unknown || !times.length ? null : Math.min(...times) };
}

/**
 * True when polling is on and some office has had no successful Politico fetch for maxAgeMs
 * (counted from page start for an office that never answered). lastSuccess: office -> ms | null.
 */
export function liveIsStale(lastSuccess, startedAt, nowMs, maxAgeMs = 150_000) {
  return Object.values(lastSuccess).some((t) => nowMs - (t ?? startedAt) > maxAgeMs);
}

/**
 * The footer's first line. It never names the live feed's provider (it may change): "Live results".
 * @param {object} o
 * @param {ReturnType<typeof summarizeSources>} o.summary
 * @param {boolean} o.polling       the page follows live results (false: a finished election, "Final results.")
 * @param {boolean} [o.stale]       liveIsStale(...)
 * @param {boolean} [o.rateLimited] the live feed answered 429; polling stopped until reload
 * @param {boolean} [o.sheetLoaded] the published Sheet has been read at least once
 * @param {(ms: number) => string} o.formatTime
 */
export function describeSource({ summary, polling, stale = false, rateLimited = false, sheetLoaded = true, formatTime }) {
  if (!polling) return "Results: Final results.";
  const names = { politico: "Live results", sheet: "the backup sheet", committed: "the committed backup" };
  const used = SOURCES.filter((s) => summary.counts[s] > 0);
  let text;
  if (!summary.anyResults) {
    text = "Results: No results yet. This page updates when votes are counted.";
  } else {
    const where =
      used.length === 1
        ? names[used[0]]
        : used.map((s) => `${names[s]} for ${summary.counts[s]} race${summary.counts[s] === 1 ? "" : "s"}`).join(", ");
    const when = summary.asOf === null ? "unknown" : formatTime(summary.asOf);
    text = `Results: ${where}. Data as of ${when}${used.length > 1 ? " (oldest)" : ""}.`;
  }
  if (stale) text += " Warning: live results may be out of date.";
  if (rateLimited) text += " Live feed paused (the results provider asked us to slow down); reload to retry.";
  if (!sheetLoaded) text += " Race list: backup copy (the Sheet could not be read).";
  return text;
}
