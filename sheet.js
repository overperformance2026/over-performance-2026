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
const SPECIAL = " (special)"; // appended to the label of a special election
const INCUMBENT ={ democrat: "dem", republican: "rep", neither: "open" };

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

/**
 * % reporting cell -> fraction 0-1, or null. "45%" is 45 percent; a decimal up to 1 ("0.45", "1.0")
 * is a fraction; a bare whole number is percent points ("45" -> 0.45, "1" -> 1%, "100" -> 100%).
 * Blank, negative, over 100 or non-numeric -> null.
 */
export function parsePct(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/\s*%$/, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const isFraction = !s.endsWith("%") && s.includes(".") && n <= 1;
  const frac = isFraction ? n : n / 100;
  return frac <= 1 ? frac : null;
}

const EASTERN = "America/New_York";

/** Offset of US Eastern from UTC, in ms, at the instant `ms` (negative: -4 h in summer, -5 h in winter). */
function easternOffset(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time read as US Eastern (election-night convention) -> epoch ms, or null if impossible. */
function easternToEpoch(y, mo, d, h, mi, s) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null; // 2/30, 25:00
  let t = wall - easternOffset(wall);
  t = wall - easternOffset(t); // second pass lands on the right side of a daylight-saving change
  return t;
}

/**
 * Sheet time text -> epoch ms, or null if it cannot be read. Accepts "M/D/YYYY H:MM[:SS] [AM|PM]"
 * and ISO ("2026-11-03T21:15:00Z", with an offset, or without a zone), reading anything without a
 * zone as US Eastern so every viewer sees the same time. Anything else is null.
 */
export function parseTime(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (m) {
    let h = Number(m[4]);
    if (m[7]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
    }
    return easternToEpoch(Number(m[3]), Number(m[1]), Number(m[2]), h, Number(m[5]), Number(m[6] ?? 0));
  }
  // seconds may carry a fraction ("00:00:00.595Z", as the NBC import writes them)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    if (m[8]) {
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}${m[8].toUpperCase()}`.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      return Number.isFinite(t) ? t : null;
    }
    return easternToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  }
  return null;
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
    const label = row["State/District"] + (row["Special Election"].toLowerCase() === "yes" ? SPECIAL : "");
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
    // A plain "FL" covers both the regular and the special race; "FL (special)" only the special.
    // The candidate then picks the race, so a state with two races needs no extra column.
    const inState = races.filter((r) => r.office === c.office && (r.label === c.label || r.label === `${c.label}${SPECIAL}`));
    if (!inState.length) return warnings.push(`${where}: matches no race; row skipped`);
    const race = inState.find((r) => r.demName === c.candidate);
    if (!race) {
      const names = inState.map((r) => JSON.stringify(r.demName)).join(" / ");
      return warnings.push(`${where}: candidate ${JSON.stringify(c.candidate)} is not the race's AP Dem name ${names}; row skipped`);
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
 * `cache: "reload"` skips the BROWSER's copy (Google sends max-age=300, so a blank snapshot read once
 * would otherwise be served again for five minutes); the URL itself is never changed.
 */
export async function fetchSheetText(url, {
  cache = undefined,
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = SHEET_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const ctl = new AbortController();
  const timer = setTimer(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, cache ? { signal: ctl.signal, cache } : { signal: ctl.signal });
    if (!res.ok) throw new SheetError(`HTTP ${res.status}`);
    const type = res.headers?.get?.("content-type") ?? "";
    const text = await res.text();
    if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) throw new SheetError("got an HTML page, not CSV");
    return text;
  } finally {
    clearTimer(timer);
  }
}
