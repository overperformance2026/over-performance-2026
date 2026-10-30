import { computeRows, filterRows, attributeNames } from "./compute.js";

const DATA = "data/2024";
const OFFICES = [["senate", "Senate"], ["governor", "Governor"], ["house", "House"]];
const LOW_REPORTING = 0.5; // grey out rows below this share of expected vote counted

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
      if (r.pctReporting !== null && r.pctReporting < LOW_REPORTING) tr.className = "low";
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

async function main() {
  const root = document.getElementById("sections");
  const races = await getJson(`${DATA}/races.json`);
  const sections = [];
  for (const [office, title] of OFFICES) {
    const [metadata, summaries] = await Promise.all([
      getJson(`${DATA}/meta-${office}.json`),
      getJson(`${DATA}/sum-${office}.json`),
    ]);
    const rows = computeRows({ metadata, summaries, races: races.filter((r) => r.office === office) });
    const h2 = document.createElement("h2");
    const table = renderTable(rows);
    root.append(h2, table.el);
    sections.push({ title, rows, h2, table });
  }

  // One filter drives all three sections. Attributes are Sheet TRUE/FALSE columns.
  const allRows = sections.flatMap((s) => s.rows);
  const apply = (attr) => {
    for (const s of sections) {
      const shown = filterRows(s.rows, attr);
      s.h2.textContent = `${s.title} (${shown.length} race${shown.length === 1 ? "" : "s"})`;
      s.table.setRows(shown);
    }
  };
  const names = attributeNames(allRows);
  if (names.length) {
    const select = document.getElementById("filter");
    select.append(new Option("All races", ""), ...names.map((n) => new Option(n, n)));
    select.addEventListener("change", () => apply(select.value));
    document.getElementById("filter-box").hidden = false;
  }
  apply("");
}

main().catch((e) => {
  const p = document.createElement("p");
  p.className = "err";
  p.textContent = `Could not load data: ${e.message}`;
  document.getElementById("sections").appendChild(p);
});
