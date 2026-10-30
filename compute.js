// Pure core: (Politico metadata + summaries + our races list) -> table rows.
// No DOM, no fetch. Tolerates any missing field; a row that can't be computed gets null numbers.

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * @param {{metadata: object[], summaries: {contests: object[]}, races: object[]}} input
 *   races: [{contestId, office, label, harris2p, attrs?, demId?, repId?, demName?, repName?}]. attrs is a
 *   list of attribute names that are TRUE for this race. demId/repId (from
 *   the Sheet) pick candidates exactly. Else demName picks "the Dem" by full name (independents
 *   Democrats back, D-vs-D races), else the sole party=dem / party=gop candidate.
 *   demName/repName (Politico spellings, written by build_races.py) are the fallback display names
 *   when the candidate can't be resolved from live metadata.
 * @returns exactly one row per race, in `races` order. Never drops a race: if it can't be
 *   resolved, `problem` says why and the numbers are null. Hiding a race is a Sheet decision
 *   (no row there), made at build time.
 */
export function computeRows({ metadata, summaries, races }) {
  const metaOk = Array.isArray(metadata);
  const metaById = new Map((metaOk ? metadata : []).map((e) => [e?.contestId, e]));
  const contests = Array.isArray(summaries?.contests) ? summaries.contests : [];
  const sumById = new Map(contests.map((c) => [c?.id, c]));

  return races.map((race) => {
    const entry = metaById.get(race.contestId);
    const cands = Object.values(entry?.candidates ?? {});
    const dem = !entry ? null : race.demId ? byId(cands, race.demId) : pickDem(cands, race.demName);
    const rep = !entry ? null : race.repId ? byId(cands, race.repId) : single(cands.filter((c) => c.party === "gop"));
    const problem = !metaOk
      ? "metadata unavailable"
      : !entry
        ? "contest not in metadata"
        : !dem
          ? "Dem not found"
          : !rep
            ? "Rep not found"
            : null;

    const summary = sumById.get(race.contestId);
    const results = Array.isArray(summary?.results) ? summary.results : [];
    const votesFor = (c) => results.find((r) => r?.id === c.id)?.votes;
    const demVotes = problem ? undefined : votesFor(dem);
    const repVotes = problem ? undefined : votesFor(rep);
    const total = isNum(demVotes) && isNum(repVotes) ? demVotes + repVotes : 0;
    const dem2p = total > 0 ? demVotes / total : null;

    return {
      contestId: race.contestId,
      office: race.office,
      label: race.label,
      dem: { id: dem?.id ?? race.demId ?? null, name: dem?.fullName ?? race.demName ?? null },
      rep: { id: rep?.id ?? race.repId ?? null, name: rep?.fullName ?? race.repName ?? null },
      demVotes: isNum(demVotes) ? demVotes : null,
      repVotes: isNum(repVotes) ? repVotes : null,
      dem2p,
      harris2p: race.harris2p,
      overUnder: dem2p !== null && isNum(race.harris2p) ? dem2p - race.harris2p : null,
      pctReporting: !problem && isNum(summary?.progress?.pct) ? summary.progress.pct : null,
      problem,
      attrs: Array.isArray(race.attrs) ? race.attrs : [],
    };
  });
}

/** Rows tagged with `attr` (a Sheet TRUE/FALSE column name). Empty/null attr means no filter. */
export function filterRows(rows, attr) {
  return attr ? rows.filter((r) => r.attrs.includes(attr)) : rows;
}

/** Sorted distinct attribute names across rows, for building the filter drop-down. */
export function attributeNames(rows) {
  return [...new Set(rows.flatMap((r) => r.attrs))].sort();
}

/** Rows with at least `min` (0-1) of the expected vote counted. Unknown % reporting is kept. */
export function filterByReporting(rows, min) {
  return rows.filter((r) => r.pctReporting === null || r.pctReporting >= min);
}

/** Simple (unweighted) mean over/under across rows that have a number. mean is null if none do. */
export function averageOverUnder(rows) {
  const vals = rows.map((r) => r.overUnder).filter(isNum);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  return { mean, counted: vals.length, total: rows.length };
}

const single = (list) => (list.length === 1 ? list[0] : null);
const byId = (cands, id) => cands.find((c) => c.id === String(id)) ?? null;

function pickDem(cands, demName) {
  if (demName) return single(cands.filter((c) => c.fullName === demName));
  return single(cands.filter((c) => c.party === "dem"));
}
