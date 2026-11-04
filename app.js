import { attributeNames, averageOverUnder, applyFilters, incumbencyEffect, applyIncumbency } from "./compute.js";
import { createPoller, makeFetchOffice } from "./poller.js";
import { createRefresher } from "./refresher.js";
import { parseSheet, parseCategories, applyCategories, fetchSheetText } from "./sheet.js";
import { buildRows, backupLayers, keepBestBackups } from "./merge.js";
import { assertDataDir, summarizeSources, liveIsStale, describeSource } from "./status.js";

// One code path for every year. Each page says what it shows, e.g.
//   <body data-dir="data/2026" data-date="2026-11-03" data-poll="true"
//         data-sheet-url="...pub?gid=0&single=true&output=csv" data-categories-url="...">
// poll=true polls Politico and merges it with the Sheet's backup votes; poll=false (a finished
// election) uses the Sheet alone and never contacts Politico.
const CONFIG = {
  dir: document.body.dataset.dir ?? "data/2024",
  date: document.body.dataset.date ?? "2024-11-05",
  poll: document.body.dataset.poll === "true",
  sheetUrl: document.body.dataset.sheetUrl ?? null,
  categoriesUrl: document.body.dataset.categoriesUrl ?? null,
};
// Minimum share of expected vote counted for a race to show (and to count in the average).
const REPORTING_OPTIONS = [[0, "≥0%"], [0.1, "≥10%"], [0.5, "≥50%"], [0.75, "≥75%"], [0.9, "≥90%"], [0.95, "≥95%"]];
// The page picks its default: <body data-default-reporting="0.1"> starts at ≥10% (2026); omitted = ≥50%.
const DEFAULT_REPORTING = Number(document.body.dataset.defaultReporting ?? 0.5);
const OFFICES = [["senate", "Senate"], ["governor", "Governor"], ["house", "House"]];

const COLUMNS = [
  { key: "label", title: "State / district", text: (r) => r.label },
  { key: "dem", title: "Dem (or anti-Rep Indep.)", text: (r) => r.dem.name ?? "—" },
  { key: "overUnder", title: "Over/under", num: true, text: (r) => signed(r.overUnder), cls: (r) => sign(r.overUnder) },
  { key: "rep", title: "Republican", hideSm: true, text: (r) => r.rep.name ?? "—" },
  { key: "dem2p", title: "Dem 2-p %", num: true, text: (r) => pct(r.dem2p) },
  { key: "harris2p", title: "Harris 2-p %", num: true, hideSm: true, text: (r) => pct(r.harris2p) },
  // Shown only while the incumbency box is checked (CSS: main.show-incumbency .inc-col).
  { key: "incumbencyBoost", title: "Incumb. eff.", num: true, optional: true, text: (r) => (hasBoost(r) ? signed(r.incumbencyBoost) : "—") },
  { key: "pctReporting", title: "% reporting", num: true, reportingCol: true, text: (r) => pct(r.pctReporting, 0) },
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
        td.className = [col.num ? "num" : "", col.hideSm ? "hide-sm" : "", col.optional ? "inc-col" : "", col.reportingCol ? "reporting-col" : "", col.cls?.(r) ?? ""].join(" ").trim();
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
    th.className = [col.num ? "num" : "", col.hideSm ? "hide-sm" : "", col.optional ? "inc-col" : "", col.reportingCol ? "reporting-col" : ""].join(" ").trim();
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

// Headline for the selected category (or all races): simple average over/under across its races.
// rows: the races that pass the % reporting filter; total: all races in the category.
function showAverage(attr, rows, total, minLabel, anyResults) {
  const el = document.getElementById("avg");
  el.hidden = false;
  if (!anyResults) {
    el.textContent = "No results yet"; // not "All races: —"
    return;
  }
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

// Always US Eastern, with the zone named ("Nov 3, 2026, 7:04 PM EST"), whatever the viewer's own zone.
const formatTime = (ms) => new Date(ms).toLocaleString("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const committedUrl = (file) => `${CONFIG.dir}/${file}`;

async function main() {
  assertDataDir(CONFIG.dir, CONFIG.date); // a page only ever reads its own year's folder
  const root = document.getElementById("sections");
  const startedAt = Date.now();

  // ---- the three layers of data -------------------------------------------------------------
  // committed: the Sheet as last committed (race list, categories, backup votes)
  // live:      the published Sheet, read on load and every 5 minutes; null until it has loaded
  // politico:  the latest summaries payload per office
  const state = {
    committed: null, committedCats: null,
    live: null, liveCats: null,
    liveFailure: null, sheetTried: false, bestBackups: new Map(),
    politico: {}, lastSuccess: Object.fromEntries(OFFICES.map(([o]) => [o, null])),
    rateLimited: false, warnings: [],
  };

  const readCommitted = async () => {
    const [sheetText, catText] = await Promise.allSettled([fetchSheetText(committedUrl("sheet.csv")), fetchSheetText(committedUrl("categories.csv"))]);
    if (sheetText.status === "fulfilled") state.committed = parseSheet(sheetText.value);
    else state.warnings.push(`Committed race list unavailable: ${sheetText.reason.message}`);
    if (catText.status === "fulfilled") state.committedCats = parseCategories(catText.value);
  };
  await readCommitted().catch((e) => state.warnings.push(`Committed copy unusable: ${e.message}`));

  // The published Sheet. Each tab succeeds or fails on its own; on failure the last good data stays.
  const readLive = async () => {
    if (!CONFIG.sheetUrl) return;
    const failures = [];
    const [sheet, cats] = await Promise.allSettled([
      fetchSheetText(CONFIG.sheetUrl, { cache: "reload" }), // never the browser's 5-minute-old copy
      CONFIG.categoriesUrl ? fetchSheetText(CONFIG.categoriesUrl, { cache: "reload" }) : Promise.resolve(null),
    ]);
    if (sheet.status === "fulfilled") {
      try {
        state.live = keepBestBackups(parseSheet(sheet.value), state.bestBackups); // see merge.js: the published copies can disagree
      } catch (e) {
        failures.push(`race list: ${e.message}`);
      }
    } else failures.push(`race list: ${sheet.reason.message}`);
    if (cats.status === "fulfilled" && cats.value !== null) {
      try {
        state.liveCats = parseCategories(cats.value);
      } catch (e) {
        failures.push(`categories: ${e.message}`);
      }
    } else if (cats.status === "rejected") failures.push(`categories: ${cats.reason.message}`);
    state.liveFailure = failures.length ? failures.join("; ") : null;
    state.sheetTried = true;
  };

  if (!state.committed && !CONFIG.sheetUrl) throw new Error("no race list available");

  // ---- rows ---------------------------------------------------------------------------------
  const sections = OFFICES.map(([office, title]) => {
    const h2 = document.createElement("h2");
    const table = renderTable([]);
    root.append(h2, table.el);
    return { office, title, h2, table, rows: [] };
  });
  const allRows = () => sections.flatMap((s) => s.rows);

  const recompute = () => {
    const base = state.live ?? state.committed;
    if (!base) return;
    const tagged = applyCategories(base.races, state.liveCats ?? state.committedCats ?? []);
    const rows = buildRows({ races: tagged.races, ...backupLayers(state.committed, state.live), politico: state.politico });
    for (const s of sections) s.rows = rows.filter((r) => r.office === s.office);
    state.warnings = [
      ...base.warnings,
      ...tagged.warnings,
      ...(state.liveFailure ? [`Published Sheet not updated (${state.liveFailure}); showing ${state.live ? "the last good read" : "the committed copy"}.`] : []),
    ];
  };

  // ---- controls -----------------------------------------------------------------------------
  const select = document.getElementById("filter");
  const reporting = document.getElementById("reporting");
  reporting.append(...REPORTING_OPTIONS.map(([min, label]) => new Option(label, min)));
  reporting.value = String(DEFAULT_REPORTING);
  if (reporting.selectedIndex < 0) reporting.value = "0.5"; // an unknown data-default-reporting falls back to ≥50%
  const note = document.getElementById("hidden-note");
  const warnEl = document.getElementById("load-warn");

  // The category drop-down follows the Sheet: rebuilt when a re-read changes the category names.
  const refreshCategories = () => {
    const names = attributeNames(allRows());
    const have = [...select.options].slice(1).map((o) => o.value);
    if (names.join("|") !== have.join("|") || (names.length && !select.options.length)) {
      const keep = names.includes(select.value) ? select.value : "";
      select.replaceChildren(new Option("All races", ""), ...names.map((n) => new Option(n, n)));
      select.value = keep;
    }
    document.getElementById("filter-box").hidden = names.length === 0;
  };

  let loggedWarnings = "";
  const renderWarnings = () => {
    const w = state.warnings;
    warnEl.hidden = w.length === 0;
    warnEl.textContent = w.length ? `${w.slice(0, 3).join(" · ")}${w.length > 3 ? ` · and ${w.length - 3} more (see the browser console)` : ""}` : "";
    if (w.join("\n") !== loggedWarnings) w.forEach((x) => console.warn("[data]", x)); // log changes only, not every refresh
    loggedWarnings = w.join("\n");
  };

  // The public status line: where the votes come from and when they are as of.
  const renderSource = () => {
    const stale = CONFIG.poll && !state.rateLimited && liveIsStale(state.lastSuccess, startedAt, Date.now());
    document.getElementById("source").textContent = describeSource({
      summary: summarizeSources(allRows()), polling: CONFIG.poll, stale, rateLimited: state.rateLimited,
      sheetLoaded: !CONFIG.sheetUrl || !state.sheetTried || Boolean(state.live), formatTime,
    });
  };

  // Incumbency effect: coefficients come from ALL races passing the % reporting threshold
  // (not the category), and are recomputed on every apply(), so data refreshes update them too.
  const incBox = document.getElementById("incumbency");
  const incInfo = document.getElementById("incumbency-info");
  // The box is on whenever there is enough data, unless the user switched it off. Their choice is
  // remembered, so it survives the box being forced off (and greyed out) for a while.
  let wantsIncumbency = true;
  const renderIncumbency = (effect) => {
    incBox.checked = effect.enabled && wantsIncumbency; // too few races: raw over/under, box greyed out
    incBox.disabled = !effect.enabled;
    incBox.closest("label").classList.toggle("off", !effect.enabled); // greyed out
    incInfo.textContent = effect.enabled
      ? `(Dem. incumbents ${signed(effect.dem)}, Rep. incumbents ${signed(effect.rep)})`
      : "(Not enough results reporting to calculate incumbency effects)";
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
    showAverage(attr, all.shown, all.inCategory.length, label, summarizeSources(allRows()).anyResults);
    // Early on, most races are below the cutoff; say so rather than show empty tables unexplained.
    note.hidden = all.hidden === 0;
    note.textContent = `${all.hidden} race${all.hidden === 1 ? "" : "s"} hidden: under ${Math.round(min * 100)}% of the vote reporting.`;
    renderSource();
    renderWarnings();
  };

  /** Everything that changed (data, not controls): rebuild rows, categories, then redraw. */
  const refresh = () => {
    recompute();
    refreshCategories();
    apply();
  };
  reporting.addEventListener("change", apply);
  incBox.addEventListener("change", () => {
    wantsIncumbency = incBox.checked;
    apply();
  });
  select.addEventListener("change", apply);

  refresh(); // first paint from the committed copy (and any warnings)
  if (!state.committed && !state.live) {
    const p = document.createElement("p");
    p.className = "err";
    p.textContent = "Could not load the race list.";
    root.append(p);
  }

  // ---- the published Sheet: read now, then every 5 minutes -----------------------------------
  // A read with no votes at all may be a blank snapshot (see keepBestBackups): look again every 30 s, for
  // up to five minutes, rather than show nothing until the next 5-minute read. (Before the polls close
  // it is simply true, and costs ten extra reads per viewer.)
  let blankRetries = 0;
  const hasVotes = () => state.live?.races.some((r) => r.backup && r.backup.demVotes + r.backup.repVotes > 0) ?? false;
  const reloadSheet = async () => {
    await readLive();
    refresh();
    if (CONFIG.sheetUrl && !hasVotes() && blankRetries++ < 10) setTimeout(reloadSheet, 30_000);
  };
  reloadSheet();
  createRefresher({
    load: reloadSheet,
    onError: (err) => console.warn(`[sheet] re-read failed: ${err.message}`),
    isHidden: () => document.hidden,
    onVisibilityChange: (cb) => document.addEventListener("visibilitychange", cb),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    now: () => Date.now(),
  }).start();

  // ---- Politico (live pages only): the 0 / 2 / 4 s first load, then one office every 20 s ---
  // A finished election (poll=false) is the Sheet alone: Politico is never contacted.
  if (CONFIG.poll) createPoller({
    offices: OFFICES.map(([o]) => o),
    fetchOffice: makeFetchOffice({ date: CONFIG.date }),
    onData: (office, summaries) => {
      state.politico[office] = { summaries, asOf: Date.now() };
      refresh();
      state.lastSuccess[office] = Date.now(); // only after the page rendered it: a render bug must still raise the stale warning
    },
    onError: (office, err) => console.warn(`[politico] ${office}: ${err.message}`),
    onRateLimited: () => {
      state.rateLimited = true;
      renderSource();
    },
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
