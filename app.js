import { computeRows, attributeNames, averageOverUnder, applyFilters } from "./compute.js";

const DATA = "data/2024";
// Minimum share of expected vote counted for a race to show (and to count in the average).
const REPORTING_OPTIONS = [[0.5, "≥50%"], [0.75, "≥75%"], [0.9, "≥90%"], [0.95, "≥95%"]];
const OFFICES = [["senate", "Senate"], ["governor", "Governor"], ["house", "House"]];

const COLUMNS = [
  { key: "label", title: "State / district", text: (r) => r.label },
  { key: "dem", title: "Democrat", text: (r) => r.dem.name ?? "—" },
  { key: "overUnder", title: "Over / under", num: true, text: (r) => signed(r.overUnder), cls: (r) => sign(r.overUnder) },
  { key: "rep", title: "Republican", hideSm: true, text: (r) => r.rep.name ?? "—" },
  { key: "dem2p", title: "Dem 2-party %", num: true, text: (r) => pct(r.dem2p) },
  { key: "harris2p", title: "Harris 2-party %", num: true, hideSm: true, text: (r) => pct(r.harris2p) },
  { key: "pctReporting", title: "% reporting", num: true, text: (r) => pct(r.pctReporting, 0) },
];

const pct = (x, digits = 1) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`);
const signed = (x) => (x === null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}`);
const sign = (x) => (x === null ? "" : x >= 0 ? "pos" : "neg");

// Sort value per column; nulls always sort last.
const sortValue = (r, key) => (key === "dem" || key === "rep" ? r[key].name : r[key]);

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
        td.className = [col.num ? "num" : "", col.hideSm ? "hide-sm" : "", col.cls?.(r) ?? ""].join(" ").trim();
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
    th.className = [col.num ? "num" : "", col.hideSm ? "hide-sm" : ""].join(" ").trim();
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

// One office's files failing to load must not blank the whole page: computeRows turns null
// metadata or summaries into rows with a problem and no numbers.
const getJsonOrNull = (path, failures, what) =>
  getJson(path).catch(() => {
    failures.push(what);
    return null;
  });

// "Data as of" line from data/<year>/updated.json (written by the fetch script). Optional.
async function showUpdated() {
  try {
    const { fetchedAt } = await getJson(`${DATA}/updated.json`);
    const when = new Date(fetchedAt);
    if (Number.isNaN(when.getTime())) return;
    document.getElementById("updated").textContent =
      `Data as of ${when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
  } catch {
    /* no timestamp: leave the line empty */
  }
}

async function main() {
  const root = document.getElementById("sections");
  const races = await getJson(`${DATA}/races.json`);
  showUpdated();
  const sections = [];
  const failures = [];
  for (const [office, title] of OFFICES) {
    const [metadata, summaries] = await Promise.all([
      getJsonOrNull(`${DATA}/meta-${office}.json`, failures, `${title} candidates`),
      getJsonOrNull(`${DATA}/sum-${office}.json`, failures, `${title} results`),
    ]);
    const rows = computeRows({ metadata, summaries, races: races.filter((r) => r.office === office) });
    const h2 = document.createElement("h2");
    const table = renderTable(rows);
    root.append(h2, table.el);
    sections.push({ title, rows, h2, table });
  }

  // Two filters drive all three sections: category (Sheet TRUE/FALSE columns) and % reporting.
  const allRows = sections.flatMap((s) => s.rows);
  const select = document.getElementById("filter");
  const reporting = document.getElementById("reporting");
  reporting.append(...REPORTING_OPTIONS.map(([min, label]) => new Option(label, min)));
  const note = document.getElementById("hidden-note");
  if (failures.length) {
    const warn = document.getElementById("load-warn");
    warn.textContent = `Could not load: ${failures.join(", ")}. Affected races show no numbers.`;
    warn.hidden = false;
  }
  const apply = () => {
    const attr = select.value;
    const min = Number(reporting.value);
    for (const s of sections) {
      const { shown } = applyFilters(s.rows, attr, min);
      s.h2.textContent = `${s.title} (${shown.length} race${shown.length === 1 ? "" : "s"})`;
      s.table.setRows(shown);
      // With a category selected, a section with no races is just noise.
      s.h2.hidden = s.table.el.hidden = Boolean(attr) && shown.length === 0;
    }
    const all = applyFilters(allRows, attr, min);
    const label = reporting.selectedOptions[0].textContent;
    showAverage(attr, all.shown, all.inCategory.length, label);
    // Early on, most races are below the cutoff; say so rather than show empty tables unexplained.
    note.hidden = all.hidden === 0;
    note.textContent = `${all.hidden} race${all.hidden === 1 ? "" : "s"} hidden: under ${Math.round(min * 100)}% of the vote reporting.`;
  };
  reporting.addEventListener("change", apply);
  const names = attributeNames(allRows);
  if (names.length) {
    select.append(new Option("All races", ""), ...names.map((n) => new Option(n, n)));
    select.addEventListener("change", apply);
    document.getElementById("filter-box").hidden = false;
  }
  apply();
}

main().catch((e) => {
  const p = document.createElement("p");
  p.className = "err";
  p.textContent = `Could not load data: ${e.message}`;
  document.getElementById("sections").appendChild(p);
});
