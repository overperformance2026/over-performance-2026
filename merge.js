// Pure core: races from the Sheet + three layers of votes -> the rows the page shows.
// No DOM, no fetch. The layers per race:
//   committed  the backup_* cells of the committed copy of the Sheet
//   sheet      the backup_* cells of the published Sheet (re-read every few minutes)
//   politico   the latest summaries payload per office
// Of the layers that have votes, the one with the HIGHEST Dem + Rep total wins, and its Dem votes,
// Rep votes and % reporting are all used: never mixed within a race. A tie goes to Politico, then
// the Sheet, then the committed copy.

import { computeRows } from "./compute.js";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
export const PRIORITY = ["politico", "sheet", "committed"]; // tie-break order

/**
 * @param {{committed?: object|null, sheet?: object|null, politico?: object|null}} layers
 *   each layer: {demVotes, repVotes, pct, asOf, totVotes?} or null/undefined
 * @returns {{demVotes: number, repVotes: number, pct: number|null, asOf: number|null, totVotes: number|null, source: string}|null}
 *   null when no layer has votes (a layer with no votes at all does not count).
 */
export function mergeVotes(layers) {
  let best = null;
  for (const source of PRIORITY) {
    const l = layers[source];
    if (!l || !isNum(l.demVotes) || !isNum(l.repVotes)) continue;
    const total = l.demVotes + l.repVotes;
    if (total <= 0) continue;
    if (best === null || total > best.total) best = { total, source, l }; // strict >: earlier priority keeps ties
  }
  if (best === null) return null;
  const { l, source } = best;
  // totVotes (every candidate's votes) comes from the same layer as the Dem and Rep votes, for the margin view
  return {
    demVotes: l.demVotes, repVotes: l.repVotes, pct: isNum(l.pct) ? l.pct : null, asOf: isNum(l.asOf) ? l.asOf : null,
    totVotes: isNum(l.totVotes) && l.totVotes >= l.demVotes + l.repVotes ? l.totVotes : null, source,
  };
}

/** One race's Politico layer from an office payload {summaries, asOf}, or null. */
export function politicoLayer(race, payload, index = indexPayload(payload)) {
  const c = index.get(race.contestId);
  if (!c || !Array.isArray(c.results)) return null;
  const votes = (id) => c.results.find((r) => r?.id === id)?.votes;
  const demVotes = votes(race.demId);
  const repVotes = votes(race.repId);
  if (!isNum(demVotes) || !isNum(repVotes)) return null;
  // every candidate listed counts toward the total (third parties, write-ins)
  const totVotes = c.results.reduce((sum, r) => sum + (isNum(r?.votes) ? r.votes : 0), 0);
  return { demVotes, repVotes, totVotes, pct: isNum(c.progress?.pct) ? c.progress.pct : null, asOf: payload.asOf ?? null };
}

function indexPayload(payload) {
  const contests = Array.isArray(payload?.summaries?.contests) ? payload.summaries.contests : [];
  return new Map(contests.map((c) => [c?.id, c]));
}

/**
 * @param {object} input
 * @param {object[]} input.races        what to show (Sheet's race list if it loaded, else the committed one)
 * @param {Map<string, object>} [input.committed]  contestId -> backup layer, from the committed copy
 * @param {Map<string, object>} [input.sheet]      contestId -> backup layer, from the published Sheet
 * @param {Object<string, {summaries: object, asOf: number}>} [input.politico]  office -> latest payload
 * @returns rows for the page: computeRows rows plus votesSource ("politico"|"sheet"|"committed"|null)
 *   and votesAsOf (ms or null). Never drops a race.
 */
export function buildRows({ races, committed = new Map(), sheet = new Map(), politico = {} }) {
  const indexes = new Map(Object.entries(politico).map(([office, p]) => [office, indexPayload(p)]));
  const merged = races.map((race) =>
    race.problem
      ? null
      : mergeVotes({
          committed: committed.get(race.contestId),
          sheet: sheet.get(race.contestId),
          politico: politico[race.office] ? politicoLayer(race, politico[race.office], indexes.get(race.office)) : null,
        }));

  // computeRows resolves candidates through "metadata" and reads votes from "summaries": build both
  // from the Sheet so there is one rows pipeline for every source.
  // (Problem races get no entry: computeRows reports their problem first, and a duplicate contest
  // ID must not overwrite the good race's candidates.)
  const metadata = races
    .filter((r) => !r.problem)
    .map((r) => ({
      contestId: r.contestId,
      candidates: {
        [r.demId]: { id: r.demId, fullName: r.demName, party: "dem" },
        [r.repId]: { id: r.repId, fullName: r.repName, party: "gop" },
      },
    }));
  const contests = [];
  races.forEach((r, i) => {
    const m = merged[i];
    if (m) contests.push({ id: r.contestId, results: [{ id: r.demId, votes: m.demVotes }, { id: r.repId, votes: m.repVotes }], progress: { pct: m.pct } });
  });
  const rows = computeRows({ metadata, summaries: { contests }, races });
  return rows.map((row, i) => {
    // The margin view: (Dem - Rep) / all votes, against Harris's margin from the Sheet. Null unless both are known.
    const tot = merged[i]?.totVotes ?? null;
    const harrisMargin = isNum(races[i].harrisMargin) ? races[i].harrisMargin : null;
    const demMargin = tot > 0 && isNum(row.demVotes) && isNum(row.repVotes) ? (row.demVotes - row.repVotes) / tot : null;
    return {
      ...row, votesSource: merged[i]?.source ?? null, votesAsOf: merged[i]?.asOf ?? null,
      totVotes: tot, demMargin, harrisMargin,
      rawMarginOverUnder: demMargin !== null && harrisMargin !== null ? demMargin - harrisMargin : null,
    };
  });
}

/** Index a parsed race list's backups by contest ID, for buildRows. */
export const backupIndex = (races) => new Map(races.filter((r) => r.backup).map((r) => [r.contestId, r.backup]));

/**
 * Google's published CSV is served from several copies that can be out of step: one read may be an
 * older snapshot, or caught mid-update with every vote cell blank. Counted votes only grow, so keep
 * the highest-total backup seen for each race this session and let a read that is behind or blank
 * not take it away. `best` (contest ID -> backup) is updated in place; returns the parsed Sheet
 * with each race's backup replaced where the new read was behind.
 * (A typo in the Sheet is therefore not undone by the page's own 5-minute re-read: reload the page.)
 */
export function keepBestBackups(parsed, best) {
  const total = (b) => (b ? b.demVotes + b.repVotes : -1);
  const races = parsed.races.map((r) => {
    if (!r.contestId || r.problem) return r;
    const prev = best.get(r.contestId);
    if (total(prev) > total(r.backup)) return { ...r, backup: prev };
    if (r.backup) best.set(r.contestId, r.backup);
    return r;
  });
  return { ...parsed, races };
}

/**
 * The backup layers for buildRows. The committed copy is only a STAND-IN for the published Sheet: once
 * the Sheet has loaded it replaces the committed backups entirely, so a typo that was committed can be
 * undone by clearing it in the Sheet (otherwise its higher total would keep winning). Before the Sheet
 * has loaded, the committed backups are all there is.
 * @param {{races: object[]}|null} committed  parsed committed copy
 * @param {{races: object[]}|null} live       parsed published Sheet, or null if it has not loaded
 */
export function backupLayers(committed, live) {
  return live
    ? { committed: new Map(), sheet: backupIndex(live.races) }
    : { committed: backupIndex(committed?.races ?? []), sheet: new Map() };
}
