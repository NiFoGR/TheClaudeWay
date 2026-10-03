// Map Rank page: LeadSnap-style heatmap of where businesses rank on Google Maps across a town.
import { ago, api, esc, icon, kpi, pageHead, state, view } from "./lib.js";
import { tradeList } from "./scraper.js";

const GRIDS = [3, 5, 7, 9, 11, 13];
const SPACINGS = [[400, "¼ mile"], [800, "½ mile"], [1600, "1 mile"], [3200, "2 miles"]];
const SCANS_SHOWN = 5;
const spacingLabel = (m) => (SPACINGS.find(([v]) => v === m) || [m, `${m} m`])[1];
const rankClass = (r) => (!r ? "r-out" : r <= 3 ? "r-top" : r <= 10 ? "r-mid" : "r-low");
const scanInProgress = (s) => (s.status === "queued" || s.status === "running") && Date.now() - Date.parse(s.created_at) < 30 * 60000;

function mapRankPage() {
  const scan = state.scan && state.scan.scan.id === state.scanId ? state.scan : null;
  const scans = state.showAllScans ? state.scans : state.scans.slice(0, SCANS_SHOWN);
  view.innerHTML = `
    ${pageHead("Map Rank", "Where businesses show up on Google Maps across a town. Free to run. Every lead search makes a 5×5 one automatically.")}
    <form class="card search-form five" id="scan-form">
      <div><label for="kw">Keyword customers search</label><input id="kw" list="trades" placeholder="roofer" required minlength="2" maxlength="60" value="${esc(state.scanDraft?.keyword || "")}"></div>
      <div><label for="stown">Town</label><input id="stown" placeholder="Warrington" required minlength="2" maxlength="60" value="${esc(state.scanDraft?.town || "")}"></div>
      <div><label for="grid">Grid</label><select id="grid">${GRIDS.map((g) => `<option value="${g}" ${g === 7 ? "selected" : ""}>${g} × ${g} (${g * g} points)</option>`).join("")}</select></div>
      <div><label for="spacing">Distance apart</label><select id="spacing">${SPACINGS.map(([v, t]) => `<option value="${v}" ${v === 1600 ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <button class="btn" type="submit" id="scan-go">${icon("grid")} Run scan</button>
      ${tradeList()}
    </form>
    <p class="error" id="scan-error" hidden></p>
    <div id="scan-view">${scan ? scanView(scan) : state.scanId ? scanStatusCard() : ""}</div>
    ${state.scans.length ? `
      <div class="section-title"><h2>Your scans</h2>${state.scans.length > SCANS_SHOWN ? `<button class="btn ghost sm" id="all-scans">${state.showAllScans ? "Show fewer" : `Show all ${state.scans.length}`}</button>` : ""}</div>
      <div class="runs">${scans.map(scanRow).join("")}</div>`
      : `<div class="card" style="margin-top:16px"><div class="card-head"><h2>No scans yet</h2></div><p class="muted" style="margin:0">Run one above, or find leads on the Lead Scraper page: each search makes a heatmap automatically.</p></div>`}`;
  view.querySelector("#scan-form").onsubmit = startScan;
  view.querySelectorAll(".run[data-scan]").forEach((r) => r.onclick = () => { location.hash = `#/maprank?scan=${encodeURIComponent(r.dataset.scan)}`; });
  const all = view.querySelector("#all-scans");
  if (all) all.onclick = () => { state.showAllScans = !state.showAllScans; mapRankPage(); };
  if (scan) bindScanView(scan);
}

function scanRow(s) {
  const [cls, label] = scanInProgress(s) ? ["warn", "Scanning"] : s.status === "done" ? ["good", "Done"] : s.status === "failed" ? ["bad", "Failed"] : ["bad", "Stuck"];
  return `<div class="run ${s.id === state.scanId ? "active" : ""}" data-scan="${esc(s.id)}">
    <div><b>${esc(s.keyword)}</b> <span class="muted">in</span> <b>${esc(s.town)}</b>
      <div class="meta">${esc(s.grid)}×${esc(s.grid)} grid · ${esc(spacingLabel(s.spacing_m))} apart${s.source === "scrape" ? " · made by a lead search" : ""}${s.status === "failed" ? ` · ${esc(s.error || "")}` : ""}</div></div>
    <span class="meta">${esc(ago(s.created_at))}</span><span class="badge ${cls}">${label}</span></div>`;
}

function scanStatusCard() {
  const s = state.scans.find((x) => x.id === state.scanId);
  if (!s) return "";
  if (s.status === "failed") return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>That scan failed</h2></div><p class="error" style="margin:0">${esc(s.error || "Unknown error")}</p></div>`;
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2 class="cap">${esc(s.keyword)} in ${esc(s.town)}</h2><span class="badge warn">Scanning</span></div>
    <p class="muted" style="margin:0">Searching ${s.grid * s.grid} points across town… usually under a minute. Updates by itself.</p></div>`;
}

function scanView(data) {
  const { scan, businesses } = data;
  const biz = businesses.find((b) => b.place_id === state.biz) || businesses[0];
  if (!biz) return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>No businesses found for that search</h2></div></div>`;
  state.biz = biz.place_id;
  const position = businesses.indexOf(biz) + 1;
  const tiles = [
    kpi("Average rank", biz.found_pct === 0 ? "20+" : `#${Number(biz.avg_rank).toFixed(1)}`, "across the grid", "accent"),
    kpi("In the top 3", `${biz.top3_pct}%`, "of town"),
    kpi("In the top 20", `${biz.found_pct}%`, "of town"),
    kpi("Position", `${position} of ${businesses.length}`, "among competitors"),
  ].join("");
  const options = businesses.map((b, i) => `<option value="${esc(b.place_id)}" ${b === biz ? "selected" : ""}>${i + 1}. ${esc(b.name || "Unnamed business")}</option>`).join("");
  return `
    <div class="scan-head">
      <div><h2 class="cap">${esc(scan.keyword)} in ${esc(scan.town)}</h2>
        <div class="meta">${esc(scan.grid)}×${esc(scan.grid)} grid · ${esc(spacingLabel(scan.spacing_m))} apart · ${esc(new Date(scan.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</div></div>
      <div class="grow-select"><label for="biz">Showing heatmap for</label><select id="biz">${options}</select></div>
    </div>
    <div class="kpis">${tiles}</div>
    <div class="scan-body">
      <div class="card map-card"><div id="heatmap"></div>
        <div class="map-legend"><span class="dot-r r-top">1–3</span><span class="dot-r r-mid">4–10</span><span class="dot-r r-low">11–20</span><span class="dot-r r-out">20+</span><span class="small faint">Each circle = their position if you searched “${esc(scan.keyword)}” standing there.</span></div>
      </div>
      <div class="card comp-card"><div class="card-head"><h2>Competitors</h2><span class="muted">${businesses.length} seen</span></div>
        <div class="table-wrap"><table class="comp"><thead><tr><th>#</th><th>Business</th><th>Avg</th><th>Top 3</th><th>Reviews</th></tr></thead><tbody>
        ${businesses.map((b, i) => `<tr class="click ${b === biz ? "sel" : ""}" data-biz="${esc(b.place_id)}">
          <td class="faint">${i + 1}</td>
          <td><div class="biz">${esc(b.name || "Unnamed business")}</div>${b.lead ? `<div class="sub-line">Your lead · score ${esc(b.lead.quality_score)} · ${esc(b.lead.status)}</div>` : ""}</td>
          <td><span class="pill ${rankClass(b.found_pct ? Math.round(b.avg_rank) : null)}">${b.found_pct ? Number(b.avg_rank).toFixed(1) : "20+"}</span></td>
          <td class="num">${esc(b.top3_pct)}%</td>
          <td class="rating">${b.rating ? `${esc(b.rating)}★ ` : ""}<span class="faint">${esc(b.review_count || 0)}</span></td></tr>`).join("")}
        </tbody></table></div></div>
    </div>`;
}

function bindScanView(data) {
  const sel = view.querySelector("#biz");
  if (sel) sel.onchange = () => selectBiz(data, sel.value);
  view.querySelectorAll("tr[data-biz]").forEach((tr) => tr.onclick = () => selectBiz(data, tr.dataset.biz));
  drawHeatmap(data);
}

function selectBiz(data, placeId) {
  state.biz = placeId;
  history.replaceState(null, "", `#/maprank?scan=${encodeURIComponent(data.scan.id)}&biz=${encodeURIComponent(placeId)}`);
  view.querySelector("#scan-view").innerHTML = scanView(data);
  bindScanView(data);
}

function drawHeatmap(data) {
  const el = view.querySelector("#heatmap");
  if (!el) return;
  const ranks = data.points.map((p) => (p.ranking.indexOf(state.biz) + 1) || null);
  if (!window.L) { // map library blocked or offline: draw the same grid without the street map
    el.classList.add("plain-grid");
    el.style.gridTemplateColumns = `repeat(${data.scan.grid}, 1fr)`;
    el.innerHTML = ranks.map((r) => `<span class="dot-r ${rankClass(r)}">${r || "20+"}</span>`).join("");
    return;
  }
  if (state.map) state.map.remove();
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const bounds = [];
  data.points.forEach((p, i) => {
    const r = ranks[i];
    L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<span class="dot-r ${rankClass(r)}">${r || "20+"}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
    bounds.push([p.lat, p.lng]);
  });
  map.fitBounds(bounds, { padding: [24, 24] });
  state.map = map;
}

async function startScan(e) {
  e.preventDefault();
  const btn = view.querySelector("#scan-go");
  const err = view.querySelector("#scan-error");
  btn.disabled = true;
  err.hidden = true;
  const body = {
    keyword: view.querySelector("#kw").value.trim(), town: view.querySelector("#stown").value.trim(),
    grid: Number(view.querySelector("#grid").value), spacing: Number(view.querySelector("#spacing").value),
  };
  state.scanDraft = body;
  try {
    const { scan, error } = await api("/api/scans", { method: "POST", body: JSON.stringify(body) });
    if (!scan) throw new Error(error || "Couldn't start the scan");
    state.scans = [scan, ...state.scans];
    location.hash = `#/maprank?scan=${encodeURIComponent(scan.id)}`;
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
  }
}

async function openScan(id) {
  state.scanId = id;
  const s = state.scans.find((x) => x.id === id);
  if (s && s.status === "done") state.scan = await api(`/api/scans/${encodeURIComponent(id)}`);
  mapRankPage();
}

function pollScans() {
  clearTimeout(state.scanPoll);
  if (!state.scans.some(scanInProgress)) return;
  state.scanPoll = setTimeout(async () => {
    if (!location.hash.startsWith("#/maprank")) return;
    const before = state.scans.find((x) => x.id === state.scanId)?.status;
    state.scans = (await api("/api/scans")).scans;
    const after = state.scans.find((x) => x.id === state.scanId)?.status;
    if (before !== after && state.scanId) await openScan(state.scanId);
    else if (!view.querySelector("input:focus, select:focus")) mapRankPage();
    pollScans();
  }, 4000);
}

export async function mapRankRoute(params) {
  state.scans = (await api("/api/scans")).scans;
  state.biz = params.get("biz") || state.biz;
  const id = params.get("scan") || state.scans.find((x) => x.status === "done")?.id || null;
  if (id) await openScan(id);
  else mapRankPage();
  pollScans();
}
