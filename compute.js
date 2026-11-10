// Pure core: (Politico metadata + summaries + our races list) -> table rows.
// No DOM, no fetch. Tolerates any missing field; a row that can't be computed gets null numbers.

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** Smallest number of races required in EACH incumbency group for the effect to be estimated. */
export const MIN_GROUP = 5;
const INCUMBENT_GROUPS = ["dem", "rep", "open"];

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
    const problem = race.problem // a problem found while reading the Sheet wins: no numbers for that race
      ? race.problem
      : !metaOk
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
      // rawOverUnder never changes; overUnder is replaced by applyIncumbency when the box is checked.
      rawOverUnder: dem2p !== null && isNum(race.harris2p) ? dem2p - race.harris2p : null,
      incumbent: INCUMBENT_GROUPS.includes(race.incumbent) ? race.incumbent : null,
      incumbencyBoost: null,
      pctReporting: !problem && isNum(summary?.progress?.pct) ? summary.progress.pct : null,
      problem,
      attrs: Array.isArray(race.attrs) ? race.attrs : [],
    };
  });
}

/**
 * The margin view of the rows: the same rows with the fields the page reads (dem2p, harris2p, overUnder,
 * rawOverUnder) swapped for the margin versions, (Dem - Rep) / all votes against Harris's margin, so
 * the incumbency effect, the average, the filters and the table all work on margins unchanged.
 * A row without a margin (no total votes, no Harris margin) gets null numbers.
 */
export function marginView(rows) {
  return rows.map((r) => ({
    ...r,
    dem2p: isNum(r.demMargin) ? r.demMargin : null,
    harris2p: isNum(r.harrisMargin) ? r.harrisMargin : null,
    overUnder: isNum(r.rawMarginOverUnder) ? r.rawMarginOverUnder : null,
    rawOverUnder: isNum(r.rawMarginOverUnder) ? r.rawMarginOverUnder : null,
    incumbencyBoost: null,
  }));
}

/** Rows tagged with `attr` (a Sheet TRUE/FALSE column name). Empty/null attr means no filter. */
export function filterRows(rows, attr) {
  return attr ? rows.filter((r) => r.attrs.includes(attr)) : rows;
}

/** Sorted distinct attribute names across rows, for building the filter drop-down. */
export function attributeNames(rows) {
  return [...new Set(rows.flatMap((r) => r.attrs))].sort();
}

/**
 * Rows with at least `min` (0-1) of the expected vote counted. A race with no % reporting yet (no
 * results) can't meet a threshold, so it shows only at 0 ("≥0%"), the same rule the incumbency sample uses.
 */
export function filterByReporting(rows, min) {
  return rows.filter((r) => (r.pctReporting === null ? min <= 0 : r.pctReporting >= min));
}

/**
 * Both page filters at once. inCategory: rows in the chosen category (all rows if attr is empty);
 * shown: those also at least `min` reported; hidden: how many the reporting filter removed.
 */
export function applyFilters(rows, attr, min) {
  const inCategory = filterRows(rows, attr);
  const shown = filterByReporting(inCategory, min);
  return { inCategory, shown, hidden: inCategory.length - shown.length };
}

/**
 * Least squares of y on the columns of X (rows of numbers) by the normal equations, or null if the
 * columns are collinear (so there is no single answer). Small and dependency-free: k is 4 here.
 */
function leastSquares(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => X.reduce((s, x) => s + x[a] * x[b], 0)));
  const b = Array.from({ length: k }, (_, a) => X.reduce((s, x, i) => s + x[a] * y[i], 0));
  const scale = Math.max(...A.flat().map(Math.abs));
  for (let c = 0; c < k; c++) { // Gauss-Jordan with partial pivoting, on [A | b]
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < scale * 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/**
 * Incumbency effect, pooled across offices: the coefficients on DemInc and RepInc in
 *   dem2p = a + slope * harris2p + dem * DemInc + rep * RepInc   (open seats are the baseline),
 * fitted by least squares with the Harris slope ESTIMATED, not fixed at 1. (A slope under 1 is
 * regression to the mean; forcing it to 1 loads that onto the groups sitting at the extremes, and
 * Dem incumbents, mostly in Dem-leaning seats, got a spurious negative effect.) Fitted on the raw
 * over/under (dem2p - harris2p), which gives the same incumbency coefficients with slope - 1.
 * Sample: races with a numeric raw over/under and Harris number, at least `minPct` reporting
 * (unknown % reporting counts only when minPct is 0, as in the table filter, filterByReporting) and
 * a known incumbent group. The category filter plays no part.
 * enabled needs MIN_GROUP races in each of dem / rep / open and a fit that is not degenerate.
 * dem, rep and slope are null when disabled.
 * @returns {{dem: number|null, rep: number|null, slope: number|null, n: {dem: number, rep: number, open: number}, enabled: boolean}}
 */
export function incumbencyEffect(rows, minPct) {
  const sample = [];
  for (const r of rows) {
    if (!isNum(r.rawOverUnder) || !isNum(r.harris2p) || !INCUMBENT_GROUPS.includes(r.incumbent)) continue;
    // Unknown % reporting can't be shown to meet a threshold, so it only counts when there is none.
    if (r.pctReporting === null ? minPct > 0 : r.pctReporting < minPct) continue;
    sample.push(r);
  }
  const count = (g) => sample.filter((r) => r.incumbent === g).length;
  const n = { dem: count("dem"), rep: count("rep"), open: count("open") };
  const fit = INCUMBENT_GROUPS.every((g) => n[g] >= MIN_GROUP)
    ? leastSquares(sample.map((r) => [1, r.harris2p, r.incumbent === "dem" ? 1 : 0, r.incumbent === "rep" ? 1 : 0]), sample.map((r) => r.rawOverUnder))
    : null;
  return {
    dem: fit ? fit[2] : null,
    rep: fit ? fit[3] : null,
    slope: fit ? 1 + fit[1] : null,
    n,
    enabled: fit !== null,
  };
}

/**
 * Rows with the incumbency boost taken out: overUnder = raw - boost (0 for open seats), and
 * incumbencyBoost set for the column. Returns the rows unchanged when the effect is not enabled.
 * Rows with no known incumbent group keep their raw over/under and get no boost.
 */
export function applyIncumbency(rows, effect) {
  if (!effect?.enabled) return rows;
  const boosts = { dem: effect.dem, rep: effect.rep, open: 0 };
  return rows.map((r) => {
    const boost = boosts[r.incumbent] ?? null;
    return {
      ...r,
      incumbencyBoost: boost,
      overUnder: boost !== null && isNum(r.rawOverUnder) ? r.rawOverUnder - boost : r.overUnder,
    };
  });
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
