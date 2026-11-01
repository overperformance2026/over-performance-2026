// Plan B: the spreadsheet backup. The canonical Google Sheet has four extra columns that someone
// fills in by hand if Politico's feed fails:
//   backup_votes_dem | backup_votes_rep | backup_pct_reporting | backup_time_updated
// one row per race, keyed by "AP contest ID". This module turns those rows into the same
// {summaries, asOf} shape as Plan A and Plan C. No DOM; fetch is injected.

export const BACKUP_COLUMNS = {
  contest: "AP contest ID",
  dem: "backup_votes_dem",
  rep: "backup_votes_rep",
  pct: "backup_pct_reporting",
  time: "backup_time_updated",
};
export const BACKUP_TTL_MS = 15_000; // offices that fail together share one sheet download
export const BACKUP_TIMEOUT_MS = 15_000;

/** Google's CSV export of one tab of a link-shared sheet (answers CORS for our site). */
export const sheetCsvUrl = (sheetId, gid = 0) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

/** Small RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(field), (field = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** CSV text -> array of {header: value} objects. */
export function csvObjects(text) {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const names = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? "").trim()])));
}

/** "12,345" -> 12345. Blank, negative, fractional or text -> null. */
export function parseVotes(v) {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** "85%", "85", "0.85" or 0.85 -> 0.85. Blank or nonsense -> null. */
export function parsePct(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/%$/, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const frac = s.endsWith("%") || n > 1 ? n / 100 : n;
  return frac <= 1 ? frac : null;
}

/** Sheet time text -> epoch ms, or null if it cannot be read. */
export function parseTime(v) {
  const t = Date.parse(String(v ?? "").trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Rows of the sheet + this office's races (races.json entries) -> {summaries, asOf} or null.
 * A race counts only if both vote cells are whole numbers; rows without them are left out (the
 * page shows those races as having no numbers yet). asOf is the OLDEST update time among the rows
 * used, so the "data as of" line is never newer than the stalest race; null if none can be read.
 * Returns null when no race has votes, so the caller falls through to the next plan.
 */
export function backupSummaries(rows, officeRaces) {
  const byContest = new Map(rows.map((r) => [r[BACKUP_COLUMNS.contest], r]));
  const contests = [];
  const times = [];
  for (const race of officeRaces) {
    const row = byContest.get(race.contestId);
    if (!row) continue;
    const dem = parseVotes(row[BACKUP_COLUMNS.dem]);
    const rep = parseVotes(row[BACKUP_COLUMNS.rep]);
    if (dem === null || rep === null) continue;
    contests.push({
      id: race.contestId,
      results: [{ id: race.demId, votes: dem }, { id: race.repId, votes: rep }],
      progress: { pct: parsePct(row[BACKUP_COLUMNS.pct]) },
    });
    times.push(parseTime(row[BACKUP_COLUMNS.time]));
  }
  if (!contests.length) return null;
  const known = times.filter((t) => t !== null);
  return { summaries: { contests }, asOf: known.length === times.length ? Math.min(...known) : null };
}

/**
 * The Plan B source for plans.js: async (office) => {summaries, asOf} | null. Downloads the sheet
 * (shared for BACKUP_TTL_MS so three offices failing together cost one request; a failed download
 * is not cached), aborts after BACKUP_TIMEOUT_MS, and throws on a bad response so the caller
 * moves on to the next plan.
 */
export function backupSource({
  sheetUrl,
  races,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
}) {
  let cached = null; // {at, promise}
  const load = () => {
    if (cached && now() - cached.at < BACKUP_TTL_MS) return cached.promise;
    const ctl = new AbortController();
    const timer = setTimer(() => ctl.abort(), BACKUP_TIMEOUT_MS);
    const promise = (async () => {
      try {
        const res = await fetchImpl(sheetUrl, { signal: ctl.signal });
        if (!res.ok) throw new Error(`backup sheet: HTTP ${res.status}`);
        const rows = csvObjects(await res.text());
        if (!rows.length || !(BACKUP_COLUMNS.contest in rows[0]) || !(BACKUP_COLUMNS.dem in rows[0])) {
          throw new Error("backup sheet: expected columns not found");
        }
        return rows;
      } finally {
        clearTimer(timer);
      }
    })();
    cached = { at: now(), promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
    return promise;
  };
  return async (office) => backupSummaries(await load(), races.filter((r) => r.office === office));
}
