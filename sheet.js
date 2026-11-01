// The canonical Google Sheet, parsed in the browser. One code path for the published Sheet and the
// committed copy (data/<year>/sheet.csv + categories.csv). No DOM; fetch and timers are injected.
//
// Reads an explicit list of known columns and ignores everything else (Match check, District
// number, the typed name columns, ...). A bad row never crashes the page: it is kept with a
// `problem` and no numbers, or skipped with a warning. A required column missing means the whole
// Sheet failed, so the caller uses the other copy.

export const OFFICES = ["senate", "governor", "house"];
export const SHEET_TIMEOUT_MS = 5_000;

const REQUIRED = [
  "Office", "State/District", "Special Election", "Incumbent", "Harris 2-p",
  "AP contest ID", "AP Dem ID", "AP Dem name", "AP Rep ID", "AP Rep name",
];
const BACKUP = { dem: "backup_votes_dem", rep: "backup_votes_rep", pct: "backup_pct_reporting", time: "backup_time_updated" };
const CATEGORY_COLUMNS = ["category", "office", "state/district", "candidate", "check"];
const INCUMBENT = { democrat: "dem", republican: "rep", neither: "open" };

export class SheetError extends Error {}

// ---- CSV ---------------------------------------------------------------------------------------

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

/** CSV text -> {headers, rows: [{header: value}]}. Header names are trimmed; values are trimmed. */
export function csvTable(text, canonical = (h) => h) {
  const [head, ...body] = parseCsv(text);
  if (!head) return { headers: [], rows: [] };
  const headers = head.map((h) => canonical(h.trim()));
  return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

/** The 2026 Sheet says "AP ..." where the old one said "Politico ...", and "Harris 2-p %". */
const canonicalHeader = (h) => (h.startsWith("Politico ") ? "AP " + h.slice(9) : h === "Harris 2-p %" ? "Harris 2-p" : h);

// ---- cell parsers ------------------------------------------------------------------------------

/** "12,345" -> 12345. Blank, negative, fractional or text -> null. */
export function parseVotes(v) {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** "85%", "85", "0.85" or 0.85 -> 0.85. Blank or nonsense -> null. A bare number up to 1 is a fraction. */
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

/** "47.2%" -> 0.472 (6 places, like the old build). Anything else -> null. */
export function parseHarris(v) {
  const s = String(v ?? "").trim();
  return /^\d{1,3}(\.\d+)?%$/.test(s) ? Math.round(parseFloat(s) * 1e4) / 1e6 : null;
}

/** The backup_* cells of one row -> {backup, warning}. Blank = no backup; malformed = ignored + warning. */
function parseBackup(row, where) {
  const cells = [row[BACKUP.dem], row[BACKUP.rep], row[BACKUP.pct], row[BACKUP.time]];
  if (cells.every((c) => !c)) return { backup: null, warning: null };
  const ignore = (why) => ({ backup: null, warning: `${where}: backup ignored (${why})` });
  const demVotes = parseVotes(row[BACKUP.dem]);
  const repVotes = parseVotes(row[BACKUP.rep]);
  if (!row[BACKUP.dem] && !row[BACKUP.rep]) return { backup: null, warning: null }; // only pct/time filled: nothing to use
  if (demVotes === null || repVotes === null) return ignore(`votes ${JSON.stringify(row[BACKUP.dem])} / ${JSON.stringify(row[BACKUP.rep])} are not whole numbers`);
  const pct = parsePct(row[BACKUP.pct]);
  if (row[BACKUP.pct] && pct === null) return ignore(`% reporting ${JSON.stringify(row[BACKUP.pct])} is not a percentage`);
  return { backup: { demVotes, repVotes, pct, asOf: parseTime(row[BACKUP.time]), asOfText: row[BACKUP.time] }, warning: null };
}

// ---- the metadata tab ---------------------------------------------------------------------------

/**
 * Metadata tab CSV -> {races, warnings}. Throws SheetError if it is not a usable sheet (empty, a
 * required column missing, no data rows), so the caller falls back to the other copy.
 * Each race: {contestId, office, label, harris2p, demId, repId, demName, repName, incumbent, attrs: [],
 * backup: {demVotes, repVotes, pct, asOf, asOfText} | null, problem?: string}.
 */
export function parseSheet(text) {
  const { headers, rows } = csvTable(text, canonicalHeader);
  const missing = REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length) throw new SheetError(`sheet is missing columns: ${missing.join(", ")}`);
  if (!rows.length) throw new SheetError("sheet has no data rows");
  const races = [];
  const warnings = [];
  const seenLabel = new Set();
  const seenContest = new Set();
  rows.forEach((row, i) => {
    const line = i + 2; // sheet line number
    const office = row.Office.toLowerCase();
    const base = `line ${line} (${row.Office} ${row["State/District"]})`;
    if (!OFFICES.includes(office)) return warnings.push(`${base}: Office is not Senate/Governor/House; row skipped`);
    if (!row["State/District"]) return warnings.push(`line ${line}: State/District is blank; row skipped`);
    const label = row["State/District"] + (row["Special Election"].toLowerCase() === "yes" ? " (special)" : "");
    const problems = [];
    const incumbent = INCUMBENT[row.Incumbent.toLowerCase()] ?? null;
    if (incumbent === null) problems.push(`Incumbent ${JSON.stringify(row.Incumbent)} is not Democrat/Republican/Neither`);
    const harris2p = parseHarris(row["Harris 2-p"]);
    if (harris2p === null) problems.push(`Harris 2-p ${JSON.stringify(row["Harris 2-p"])} is not a percentage`);
    if (!row["AP contest ID"] || !row["AP Dem ID"] || !row["AP Rep ID"]) problems.push("missing contest/Dem/Rep ID");
    if (row["AP Dem ID"] && row["AP Dem ID"] === row["AP Rep ID"]) problems.push("Dem and Rep ID are the same");
    if (seenLabel.has(`${office}|${label}`)) problems.push("duplicate race (same office and State/District)");
    if (row["AP contest ID"] && seenContest.has(row["AP contest ID"])) problems.push("duplicate contest ID");
    seenLabel.add(`${office}|${label}`);
    seenContest.add(row["AP contest ID"]);
    const { backup, warning } = parseBackup(row, base);
    if (warning) warnings.push(warning);
    const race = {
      contestId: row["AP contest ID"], office, label, harris2p,
      demId: row["AP Dem ID"], repId: row["AP Rep ID"],
      demName: row["AP Dem name"] || null, repName: row["AP Rep name"] || null,
      incumbent, attrs: [], backup,
    };
    if (problems.length) {
      race.problem = problems.join("; ");
      warnings.push(`${base}: ${race.problem}`);
    }
    races.push(race);
  });
  return { races, warnings };
}

// ---- the categories tab ------------------------------------------------------------------------

/** Categories tab CSV -> [{category, office, label, candidate, check}]. Throws SheetError if a column is missing. */
export function parseCategories(text) {
  const { headers, rows } = csvTable(text);
  const lower = headers.map((h) => h.toLowerCase());
  const missing = CATEGORY_COLUMNS.filter((c) => !lower.includes(c));
  if (missing.length) throw new SheetError(`categories tab is missing columns: ${missing.join(", ")}`);
  const pick = (r, name) => r[headers[lower.indexOf(name)]];
  return rows.map((r) => ({
    category: pick(r, "category"), office: pick(r, "office").toLowerCase(), label: pick(r, "state/district"),
    candidate: pick(r, "candidate"), check: pick(r, "check"),
  }));
}

/**
 * Tag races with their categories. A row whose check is 0, FALSE or blank is skipped; a row that
 * matches no race, or whose candidate is not that race's "AP Dem name", is skipped with a warning.
 * Pure: returns new race objects.
 */
export function applyCategories(races, categoryRows) {
  const warnings = [];
  const attrs = new Map(races.map((r) => [r, []]));
  categoryRows.forEach((c, i) => {
    const where = `categories line ${i + 2} (${c.category}: ${c.office} ${c.label})`;
    if (["0", "FALSE", ""].includes(c.check.trim().toUpperCase())) return;
    if (!c.category) return warnings.push(`${where}: no category name; row skipped`);
    const race = races.find((r) => r.office === c.office && r.label === c.label);
    if (!race) return warnings.push(`${where}: matches no race; row skipped`);
    if (c.candidate !== race.demName) {
      return warnings.push(`${where}: candidate ${JSON.stringify(c.candidate)} is not the race's AP Dem name ${JSON.stringify(race.demName)}; row skipped`);
    }
    if (!attrs.get(race).includes(c.category)) attrs.get(race).push(c.category);
  });
  return { races: races.map((r) => ({ ...r, attrs: attrs.get(r) })), warnings };
}

/** Both tabs' CSV text -> tagged races + all warnings. Categories text may be null (no categories). */
export function parseBundle(sheetText, categoriesText) {
  const sheet = parseSheet(sheetText);
  if (categoriesText === null || categoriesText === undefined) return { ...sheet };
  const tagged = applyCategories(sheet.races, parseCategories(categoriesText));
  return { races: tagged.races, warnings: [...sheet.warnings, ...tagged.warnings] };
}

// ---- fetching -----------------------------------------------------------------------------------

/**
 * GET a published-Sheet CSV. 5 s timeout, no query changes, throws on a non-200 or on an HTML
 * body (a sign-in page or an error page is not a sheet). Returns the CSV text.
 */
export async function fetchSheetText(url, {
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = SHEET_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const ctl = new AbortController();
  const timer = setTimer(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) throw new SheetError(`HTTP ${res.status}`);
    const type = res.headers?.get?.("content-type") ?? "";
    const text = await res.text();
    if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) throw new SheetError("got an HTML page, not CSV");
    return text;
  } finally {
    clearTimer(timer);
  }
}
