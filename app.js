import { computeRows, attributeNames, averageOverUnder, applyFilters, incumbencyEffect, applyIncumbency } from "./compute.js";
import { createPoller, makeFetchOffice, isStale } from "./poller.js";
import { assertDataDir, hasResults, fallBack, createPlanTracker, describeSource } from "./plans.js";

// Each page says what it shows: <body data-dir="data/2024" data-date="2024-11-05" data-live="false">.
// live pages poll Politico (Plan A) and fall back to the committed snapshot (Plan C).
const CONFIG = {
  dir: document.body.dataset.dir ?? "data/2024",
  date: document.body.dataset.date ?? "2024-11-05",
  live: document.body.dataset.live === "true",
};
const DATA = CONFIG.dir;
// Minimum share of expected vote counted for a race to show (and to count in the average).
const REPORTING_OPTIONS = [[0.5, "≥50%"], [0.75, "≥75%"], [0.9, "≥90%"], [0.95, "≥95%"]];
const OFFICES = [["senate", "Senate"], ["governor", "Governor"], ["house", "House"]];

const COLUMNS = [
  { key: "label", title: "State / district", text: (r) => r.label },
  { key: "dem", title: "Dem (or anti-Rep Indep.)", text: (r) => r.dem.name ?? "—" },
  { key: "overUnder", title: "Over / under", num: true, text: (r) => signed(r.overUnder), cls: (r) => sign(r.overUnder) },
  { key: "rep", title: "Republican", hideSm: true, text: (r) => r.rep.name ?? "—" },
  { key: "dem2p", title: "Dem 2-p %", num: true, text: (r) => pct(r.dem2p) },
  { key: "harris2p", title: "Harris 2-p %", num: true, hideSm: true, text: (r) => pct(r.harris2p) },
  // Shown only while the incumbency box is checked (CSS: main.show-incumbency .inc-col).
  { key: "incumbencyBoost", title: "Incumb. eff.", num: true, optional: true, text: (r) => (hasBoost(r) ? signed(r.incumbencyBoost) : "—") },
  { key: "pctReporting", title: "% reporting", num: true, text: (r) => pct(r.pctReporting, 0) },
];

const pct = (x, digits = 1) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`);
const signed = (x) => (x === null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}`);
const sign = (x) => (x === null ? "" : x >= 0 ? "pos" : "neg");

// Sort value per column; nulls always sort last.
// Open seats show "—" in the incumbency column, so they sort as empty, not as 0.
const hasBoost = (r) => r.incumbent !== "open" && r.incumbencyBoost !== null;
const sortValue = (r, key) =>
  key === "dem" || key === "rep" ? r[key].name : key === "incumbencyBoost" ? (hasBoost(r) ? r.incumbencyBoost : null) : r[key];

function compareBy(key, dir) {
  return (a, b) => {
    const [x, y] = [sortValue(a, key), sortValue(b, key)];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === "string" ? x.localeCompare(y, undefined, { numeric: true }) : x - y) * dir;
  };
}

// Returns {el, setRows}: setRows redraws with new rows but keeps the current sort.
function renderTable(initialRows) {
  let rows = initialRows;
  const state = { key: null, dir: 1 };
  const table = document.createElement("table");
  const thead = table.createTHead().insertRow();
  const tbody = table.createTBody();

  const draw = () => {
    const sorted = state.key ? [...rows].sort(compareBy(state.key, state.dir)) : rows;
    tbody.replaceChildren(...sorted.map((r) => {
      const tr = document.createElement("tr");
      if (r.problem) tr.title = `Data problem: ${r.problem}`;
      for (const col of COLUMNS) {
        const td = tr.insertCell();
        td.textContent = col.text(r);
        td.className = [col.num ? "num" : "", col.hideSm ? "hide-sm" : "", col.optional ? "inc-col" : "", col.cls?.(r) ?? ""].join(" ").trim();
      }
      return tr;
    }));
    thead.querySelectorAll("th").forEach((th) => {
      th.setAttribute("aria-sort", th.dataset.key !== state.key ? "none" : state.dir > 0 ? "ascending" : "descending");
    });
  };

  for (const col of COLUMNS) {
    const th = document.createElement("th");
    th.textContent = col.title;
    th.dataset.key = col.key;
    th.className = [col.num ? "num" : "", col.hideSm ? "hide-sm" : "", col.optional ? "inc-col" : ""].join(" ").trim();
    th.addEventListener("click", () => {
      state.dir = state.key === col.key ? -state.dir : col.num ? -1 : 1; // numbers start high-to-low
      state.key = col.key;
      draw();
    });
    thead.appendChild(th);
  }
  draw();
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.appendChild(table);
  return {
    el: wrap,
    setRows: (next) => {
      rows = next;
      draw();
    },
  };
}

const getJson = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

// Headline for the selected category (or all races): simple average over/under across its races.
// rows: the races that pass the % reporting filter; total: all races in the category.
function showAverage(attr, rows, total, minLabel) {
  const el = document.getElementById("avg");
  el.hidden = false;
  const { mean, counted } = averageOverUnder(rows);
  const sub = `${counted} of ${total} race${total === 1 ? "" : "s"} with ${minLabel} reporting; simple average, not vote-weighted`;
  el.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = `${attr || "All races"}: ${mean === null ? "—" : `${signed(mean)} points`}`;
  strong.className = sign(mean);
  const small = document.createElement("span");
  small.textContent = ` (${sub})`;
  el.append(strong, small);
}

// One office's candidate file failing to load must not blank the whole page: computeRows turns
// null metadata or summaries into rows with a problem and no numbers.
const getJsonOrNull = (path, failures, what) =>
  getJson(path).catch(() => {
    failures.push(what);
    return null;
  });

const formatTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function main() {
  assertDataDir(DATA, CONFIG.date); // a page only ever reads its own year's folder
  const root = document.getElementById("sections");
  let races;
  try {
    races = await getJson(`${DATA}/races.json`);
  } catch (e) {
    if (!CONFIG.live) throw e;
    races = []; // live page before its data exists: shows "No results yet", never blank
  }

  // Plan C (committed snapshot) is also the first thing drawn, so the page is never empty.
  const snapshotAsOf = await getJson(`${DATA}/updated.json`).then((j) => Date.parse(j.fetchedAt)).catch(() => NaN);
  const sources = {
    C: async (office) => ({ summaries: await getJson(`${DATA}/sum-${office}.json`), asOf: Number.isFinite(snapshotAsOf) ? snapshotAsOf : null }),
    // B (spreadsheet backup) plugs in here later: sources.B = async (office) => ({summaries, asOf}).
  };
  const tracker = createPlanTracker(OFFICES.map(([office]) => office));
  const failures = [];

  const sections = [];
  const setOffice = (s, summaries, plan, asOf) => {
    s.rows = computeRows({ metadata: s.metadata, summaries, races: s.races });
    s.hasResults = hasResults(summaries);
    tracker.set(s.office, plan, asOf);
  };
  for (const [office, title] of OFFICES) {
    const [metadata, snap] = await Promise.all([
      getJsonOrNull(`${DATA}/meta-${office}.json`, failures, `${title} candidates`),
      sources.C(office).catch(() => (failures.push(`${title} results`), null)),
    ]);
    const h2 = document.createElement("h2");
    const s = { office, title, metadata, races: races.filter((r) => r.office === office), h2, rows: [], hasResults: false };
    s.table = renderTable([]);
    setOffice(s, snap?.summaries ?? null, "C", snap?.asOf ?? null);
    s.table.setRows(s.rows);
    root.append(h2, s.table.el);
    sections.push(s);
  }

  // Two filters drive all three sections: category (Sheet TRUE/FALSE columns) and % reporting.
  const allRows = () => sections.flatMap((s) => s.rows);
  const select = document.getElementById("filter");
  const reporting = document.getElementById("reporting");
  reporting.append(...REPORTING_OPTIONS.map(([min, label]) => new Option(label, min)));
  const note = document.getElementById("hidden-note");
  if (failures.length) {
    const warn = document.getElementById("load-warn");
    warn.textContent = `Could not load: ${failures.join(", ")}. Affected races show no numbers.`;
    warn.hidden = false;
  }

  // The public status line: which plan is active and when the data is as of.
  const renderSource = () => {
    const summary = tracker.summary();
    const stale = CONFIG.live && summary?.plan === "A" && isStale(summary.asOf, Date.now());
    document.getElementById("source").textContent = describeSource({
      summary, live: CONFIG.live, anyResults: sections.some((s) => s.hasResults), formatTime, stale,
    });
  };

  // Incumbency effect: coefficients come from ALL races passing the % reporting threshold
  // (not the category), and are recomputed on every apply(), so data refreshes update them too.
  const incBox = document.getElementById("incumbency");
  const incInfo = document.getElementById("incumbency-info");
  const renderIncumbency = (effect) => {
    if (!effect.enabled) incBox.checked = false; // too few races now: revert to raw over/under
    incBox.disabled = !effect.enabled;
    incBox.closest("label").classList.toggle("off", !effect.enabled); // greyed out
    incInfo.textContent = effect.enabled
      ? `(Dem. incumbents ${signed(effect.dem)}, Rep. incumbents ${signed(effect.rep)})`
      : "Not enough results reporting to calculate incumbency effects";
    document.getElementById("sections").classList.toggle("show-incumbency", incBox.checked);
  };

  const apply = () => {
    const attr = select.value;
    const min = Number(reporting.value);
    const effect = incumbencyEffect(allRows(), min);
    renderIncumbency(effect);
    const adjust = (rows) => applyIncumbency(rows, incBox.checked ? effect : null);
    for (const s of sections) {
      const { shown } = applyFilters(adjust(s.rows), attr, min);
      s.h2.textContent = `${s.title} (${shown.length} race${shown.length === 1 ? "" : "s"})`;
      s.table.setRows(shown);
      // With a category selected, a section with no races is just noise.
      s.h2.hidden = s.table.el.hidden = Boolean(attr) && shown.length === 0;
    }
    const all = applyFilters(adjust(allRows()), attr, min);
    const label = reporting.selectedOptions[0].textContent;
    showAverage(attr, all.shown, all.inCategory.length, label);
    // Early on, most races are below the cutoff; say so rather than show empty tables unexplained.
    note.hidden = all.hidden === 0;
    note.textContent = `${all.hidden} race${all.hidden === 1 ? "" : "s"} hidden: under ${Math.round(min * 100)}% of the vote reporting.`;
    renderSource();
  };
  reporting.addEventListener("change", apply);
  incBox.addEventListener("change", apply);
  const names = attributeNames(allRows());
  if (names.length) {
    select.append(new Option("All races", ""), ...names.map((n) => new Option(n, n)));
    select.addEventListener("change", apply);
    document.getElementById("filter-box").hidden = false;
  }
  apply();

  if (CONFIG.live && races.length) startLive({ sections, tracker, sources, setOffice, apply, renderSource });
}

// Plan A: poll Politico (poller.js). A failure falls back to the next plan in order (B, then C),
// but never replaces newer live data with an older snapshot. A later success switches back to A.
// A 429 stops polling for this viewer (a page reload tries again).
function startLive({ sections, tracker, sources, setOffice, apply, renderSource }) {
  const byOffice = new Map(sections.map((s) => [s.office, s]));
  const fallBackFor = async (office) => {
    const cur = tracker.get(office);
    if (cur && cur.plan !== "A") return renderSource(); // already on a backup
    const got = await fallBack({ office, after: "A", sources, newerThan: cur?.asOf ?? -Infinity });
    if (got) {
      setOffice(byOffice.get(office), got.summaries, got.plan, got.asOf);
      apply();
    } else {
      renderSource(); // kept the last live data; the status line shows the stale warning
    }
  };
  createPoller({
    offices: sections.map((s) => s.office),
    fetchOffice: makeFetchOffice({ date: CONFIG.date }),
    onData: (office, summaries) => {
      setOffice(byOffice.get(office), summaries, "A", Date.now());
      apply();
    },
    onError: fallBackFor,
    onRateLimited: () => Promise.all(sections.map((s) => fallBackFor(s.office))),
    isHidden: () => document.hidden,
    onVisibilityChange: (cb) => document.addEventListener("visibilitychange", cb),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    now: () => Date.now(),
  }).start();
  setInterval(renderSource, 15_000); // let the stale warning appear without waiting for a fetch
}

main().catch((e) => {
  const p = document.createElement("p");
  p.className = "err";
  p.textContent = `Could not load data: ${e.message}`;
  document.getElementById("sections").appendChild(p);
});

