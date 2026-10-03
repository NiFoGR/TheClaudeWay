// GoldBar Control Room. Plain JS, no build step. Every value from scraped websites goes through esc()/safeUrl().

const STATUSES = ["new", "contacted", "replied", "call booked", "won", "lost", "not interested"];
const TRADES = ["roofer", "plumber", "electrician", "heating engineer", "builder", "landscaper", "painter and decorator",
  "locksmith", "pest control", "removals", "mechanic", "car dealer", "driving school", "martial arts gym",
  "cleaner", "carpet cleaner", "plasterer", "fencing contractor", "tree surgeon", "window cleaner"];
const QUICK_SIZES = [20, 60, 100, 200, 300];
const NO_SITE = ["no_website", "profile_only", "site_down", "site_broken", "bad_certificate"];
// Lead Scraper stages, with where each sits on the overall progress bar (start %, end %)
const STAGES = {
  scouting: ["Scouting businesses on Google Maps", 0, 20],
  checking: ["Checking every website", 20, 75],
  directors: ["Finding directors' names", 75, 85],
  maps: ["Mapping Google Maps rankings across town", 85, 95],
  saving: ["Saving to your Control Room", 95, 100],
};

const view = document.getElementById("view");
const state = {
  jobs: [], jobId: null, leads: [], filter: "pitch", search: "", open: null, poll: null, showScoreHelp: false,
  scans: [], scanId: null, scan: null, biz: null, scanPoll: null, map: null,
};

// ---------------------------------------------------------------- helpers

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

async function api(path, options = {}) {
  const resp = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (resp.status === 401) location.href = "/login";
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok && !data.job && !data.scan) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const scoreClass = (n) => (n >= 70 ? "hi" : n >= 35 ? "mid" : "lo");

const FILTERS = {
  pitch: { label: "Worth pitching", test: (l) => !l.excluded },
  email: { label: "Has email", test: (l) => !l.excluded && l.email },
  call: { label: "Call list (no email)", test: (l) => !l.excluded && !l.email },
  nosite: { label: "No working website", test: (l) => !l.excluded && l.findings.some((f) => NO_SITE.includes(f)) },
  excluded: { label: "Excluded", test: (l) => l.excluded },
};

function visibleLeads() {
  const q = state.search.toLowerCase();
  return state.leads.filter(FILTERS[state.filter].test).filter((l) =>
    !q || [l.name, l.town, l.email, l.phone, l.trade, l.director_name].some((v) => String(v || "").toLowerCase().includes(q)));
}

// ---------------------------------------------------------------- lead table (shared by both pages)

function leadsTable() {
  const rows = visibleLeads();
  const tabs = Object.entries(FILTERS).map(([key, f]) => {
    const n = state.leads.filter(f.test).length;
    return `<button class="tab ${state.filter === key ? "active" : ""}" data-filter="${key}">${esc(f.label)} · ${n}</button>`;
  }).join("");
  const body = rows.length ? rows.map(leadRow).join("") : `<tr><td colspan="7" class="empty">No leads here.</td></tr>`;
  return `
    <div class="toolbar">
      <div class="tabs">${tabs}</div>
      <input class="grow" id="search" placeholder="Search name, town, email…" value="${esc(state.search)}">
      <button class="btn ghost" id="csv">Download CSV</button>
    </div>
    <p class="hint" style="margin:0 0 10px"><b>Score</b> = how much we can help them (best leads first). <a href="#" id="score-help">${state.showScoreHelp ? "Hide" : "How the score works"}</a> · Click a lead for full details and notes.</p>
    ${state.showScoreHelp ? scoreHelp() : ""}
    <div class="table-wrap"><table>
      <thead><tr><th>Score</th><th>Business</th><th>Contact</th><th>What's wrong online</th><th>Google rating</th><th>Website</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function leadRow(l) {
  const site = safeUrl(l.website);
  const problems = l.excluded ? [l.exclude_reason] : l.issues;
  const shown = problems.slice(0, 2).map((p) => `<li>${esc(p)}</li>`).join("");
  const more = problems.length > 2 ? `<li class="small">+${problems.length - 2} more</li>` : "";
  const status = STATUSES.map((s) => `<option ${s === l.status ? "selected" : ""}>${esc(s)}</option>`).join("");
  const main = `
    <tr class="row" data-id="${esc(l.place_id)}">
      <td data-label="Score"><span class="score ${scoreClass(l.quality_score)}">${l.excluded ? "–" : esc(l.quality_score)}</span>${l.excluded ? "" : partsMini(l)}</td>
      <td data-label="Business"><div class="name">${esc(l.name)}</div><div class="small">${esc(l.director_name ? `Director: ${l.director_name}` : l.town)}</div></td>
      <td data-label="Contact">${l.phone ? `<a href="tel:${esc(l.phone.replace(/\s/g, ""))}">${esc(l.phone)}</a>` : ""}
          <div class="small">${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : "no email found"}</div></td>
      <td data-label="Problems"><ul class="problems">${shown}${more}</ul></td>
      <td data-label="Google">${l.rating ? `${esc(l.rating)}★` : "–"}<div class="small">${esc(l.review_count || 0)} reviews</div>${mapsLine(l)}</td>
      <td data-label="Website">${site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">open</a>` : `<span class="small">none</span>`}</td>
      <td data-label="Status"><select data-status="${esc(l.place_id)}">${status}</select></td>
    </tr>`;
  return main + (state.open === l.place_id ? detailRow(l) : "");
}

function detailRow(l) {
  const socials = Object.entries(l.socials || {}).filter(([, u]) => safeUrl(u))
    .map(([k, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(k)}</a>`).join(" · ");
  const maps = safeUrl(l.maps_url);
  const list = (l.excluded ? [l.exclude_reason] : l.issues).map((p) => `<li>${esc(p)}</li>`).join("") || "<li>Nothing major found</li>";
  return `
    <tr class="detail"><td colspan="7"><div class="detail-grid">
      <div>
        ${l.excluded ? "" : partsBars(l)}
        <h3>All problems</h3><ul class="problems">${list}</ul>
        <h3 style="margin-top:12px">Notes</h3>
        <textarea rows="3" data-notes="${esc(l.place_id)}" placeholder="Called, said call back Friday…">${esc(l.notes)}</textarea>
      </div>
      <div>
        <h3>Details</h3>
        <p>${esc(l.address)}</p>
        ${l.director_name ? `<p>Director: ${esc(l.director_name)} (company ${esc(l.company_number)})</p>` : ""}
        ${(l.emails || []).length > 1 ? `<p>Other emails: ${l.emails.slice(1).map(esc).join(", ")}</p>` : ""}
        ${socials ? `<p>Socials: ${socials}</p>` : ""}
        ${maps ? `<p><a href="${esc(maps)}" target="_blank" rel="noopener noreferrer">Google Maps listing</a></p>` : ""}
        ${l.map_scan_id ? `<p><a href="#/maprank?scan=${encodeURIComponent(l.map_scan_id)}&biz=${encodeURIComponent(l.place_id)}">View their Google Maps heatmap →</a></p>` : ""}
        <p class="small">Trade: ${esc(l.trade)} · searched in ${esc(l.search_town)} · first seen ${esc(ago(l.first_seen_at))}</p>
      </div>
    </div></td></tr>`;
}

const PARTS = [["website", "Website", 45], ["seo", "Local SEO", 30], ["maps", "Google Maps", 25]];

function partsMini(l) {
  const p = l.score_parts || {};
  if (p.total === undefined) return "";
  return `<div class="small parts-mini" title="Website · Local SEO · Google Maps">${esc(p.website)} · ${esc(p.seo)} · ${esc(p.maps)}</div>`;
}

function partsBars(l) {
  const p = l.score_parts || {};
  if (p.total === undefined) return "";
  return `<h3>Score ${esc(p.total)}/100</h3><div class="parts">${PARTS.map(([k, label, max]) => `
    <div class="part"><span>${label}</span><div class="bar"><i style="width:${Math.round(100 * (p[k] || 0) / max)}%"></i></div><b>${esc(p[k] || 0)}/${max}</b></div>`).join("")}
  </div>`;
}

function mapsLine(l) {
  const m = l.map_rank || {};
  if (m.avg_rank === undefined) return l.rank ? `<div class="small">#${esc(l.rank)} on Google</div>` : "";
  const avg = m.found_pct === 0 ? "not in top 20" : `avg #${Math.round(m.avg_rank)}`;
  return `<div class="small">Maps: ${avg} · top 3 in ${esc(m.top3_pct)}%</div>`;
}

function scoreHelp() {
  return `<div class="card score-help">
    <p style="margin-top:0"><b>Score = how much we can help this business, out of 100.</b> Every point comes from a problem we found, listed on the lead.</p>
    <div class="help-grid">
      <div><h3>Website · 45</h3><p>Not mobile-friendly 14 · "Not secure" 8 · Outdated 6 · Old technology 5 · Slow 4–6 · No contact form 4 · Phone not tap-to-call 2</p></div>
      <div><h3>Local SEO · 30</h3><p>From the SEO playbook: trade and town in the page title 6+5 · Main heading 2–4 · Business info for Google (schema) 4 · Phone and address on site matching Google 3+2 · Google map 2 · Fewer than 30 pages 2–4 · Google description 2</p></div>
      <div><h3>Google Maps · 25</h3><p>From the heatmap: invisible 22 · rarely in top 20 18 · never top 3 12 · top 3 in under half of town 6 · far fewer reviews than the top 3 +3</p></div>
    </div>
    <p class="hint" style="margin-bottom:0">No website, or a broken one, maxes Website + Local SEO (75). Add being invisible on Maps and it hits 100: the perfect lead. A site we couldn't check (it blocks checkers) scores 0 on those parts: look at it yourself.</p>
  </div>`;
}

function bindTable(rerender) {
  const help = view.querySelector("#score-help");
  if (help) help.onclick = (e) => { e.preventDefault(); state.showScoreHelp = !state.showScoreHelp; rerender(); };
  view.querySelectorAll("[data-filter]").forEach((b) => b.onclick = () => { state.filter = b.dataset.filter; rerender(); });
  const search = view.querySelector("#search");
  search.oninput = () => {
    state.search = search.value;
    const pos = search.selectionStart;
    rerender();
    const s = view.querySelector("#search");
    s.focus();
    s.setSelectionRange(pos, pos);
  };
  view.querySelector("#csv").onclick = downloadCsv;
  view.querySelectorAll("tr.row").forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest("a, select, textarea")) return;
    state.open = state.open === tr.dataset.id ? null : tr.dataset.id;
    rerender();
  });
  view.querySelectorAll("[data-status]").forEach((sel) => sel.onchange = () => saveLead(sel.dataset.status, { status: sel.value }));
  view.querySelectorAll("[data-notes]").forEach((ta) => ta.onchange = () => saveLead(ta.dataset.notes, { notes: ta.value }));
}

async function saveLead(id, patch) {
  try {
    const { lead } = await api(`/api/leads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    state.leads = state.leads.map((l) => (l.place_id === id ? lead : l));
  } catch (err) {
    alert(err.message);
  }
}

function downloadCsv() {
  const cols = [["Score", (l) => l.quality_score], ["Website /45", (l) => l.score_parts.website], ["Local SEO /30", (l) => l.score_parts.seo],
    ["Google Maps /25", (l) => l.score_parts.maps], ["Maps avg rank", (l) => l.map_rank.avg_rank], ["Maps top-3 %", (l) => l.map_rank.top3_pct],
    ["Business", (l) => l.name], ["Director", (l) => l.director_name],
    ["Phone", (l) => l.phone], ["Email", (l) => l.email], ["Website", (l) => l.website], ["Problems", (l) => l.issues.join("; ")],
    ["Rating", (l) => l.rating], ["Reviews", (l) => l.review_count], ["Google rank", (l) => l.rank], ["Town", (l) => l.town],
    ["Address", (l) => l.address], ["Status", (l) => l.status], ["Notes", (l) => l.notes], ["Excluded", (l) => l.exclude_reason]];
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection from scraped text
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.map(([h]) => cell(h)).join(","), ...visibleLeads().map((l) => cols.map(([, f]) => cell(f(l))).join(","))];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `goldbar-leads-${state.filter}.csv`;
  a.click();
}

// ---------------------------------------------------------------- Lead Scraper page

function scraperPage() {
  const job = state.jobs.find((j) => j.id === state.jobId);
  view.innerHTML = `
    <h1>Lead Scraper</h1>
    <p class="sub">Pick a niche and a town. It searches Google Maps, checks every website, finds emails and directors, and ranks who needs us most.</p>
    <form class="card form" id="scrape">
      <div><label for="trade">Niche</label><input id="trade" list="trades" placeholder="roofer" required minlength="2" maxlength="60"></div>
      <div><label for="town">Town</label><input id="town" placeholder="Leeds" required minlength="2" maxlength="60"></div>
      <div><label for="max">How many leads (10–300)</label><input id="max" type="number" min="10" max="300" step="1" value="${esc(state.lastMax || 60)}" required>
        <div class="quick">${QUICK_SIZES.map((n) => `<button type="button" class="chip" data-size="${n}">${n}</button>`).join("")}</div></div>
      <button class="btn" type="submit" id="go">Find leads</button>
      <datalist id="trades">${TRADES.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    </form>
    <p class="error" id="scrape-error" hidden></p>
    ${state.jobs.length ? `<div class="card"><h2>Your runs</h2><p class="hint" style="margin:-6px 0 12px">Click a run to see its leads.</p><div class="runs">${state.jobs.map(runRow).join("")}</div></div>` : howItWorks()}
    ${job ? jobResults(job) : ""}`;

  view.querySelector("#scrape").onsubmit = startScrape;
  view.querySelectorAll("[data-size]").forEach((b) => b.onclick = () => { view.querySelector("#max").value = b.dataset.size; });
  view.querySelectorAll(".run").forEach((r) => r.onclick = () => openJob(r.dataset.id));
  if (job && job.status === "done") bindTable(scraperPage);
}

const STUCK_MINUTES = 40;
const isStuck = (j) => (j.status === "queued" || j.status === "running") && Date.now() - Date.parse(j.created_at) > STUCK_MINUTES * 60000;
const inProgress = (j) => (j.status === "queued" || j.status === "running") && !isStuck(j);

function howItWorks() {
  return `<div class="card"><h2>How it works</h2><ol class="steps">
    <li><b>Type a niche and a town</b>, choose how many leads, press <b>Find leads</b>.</li>
    <li>It scouts Google Maps, checks every business's website against the SEO playbook, finds their email and director's name, maps where they rank across town, and skips chains and franchises. Takes 2–8 minutes; you can leave the page.</li>
    <li><b>Your leads appear here</b>, best first: the businesses whose online presence needs us most. Use the tabs to see who to email and who to call.</li>
  </ol><p class="hint">First time? Check <a href="#/setup">Setup</a> shows everything connected.</p></div>`;
}

function runRow(j) {
  const stuck = isStuck(j);
  const label = stuck ? "stuck" : { queued: "starting…", running: "working…", done: "done", failed: "failed" }[j.status] || j.status;
  const counts = j.status === "done" ? `${j.pitchable} worth pitching of ${j.found}`
    : j.status === "failed" ? esc(j.error || "")
    : stuck ? "No word from GitHub for 40+ min. Check the Actions tab, then try again."
    : progressText(j);
  return `<div class="run ${j.id === state.jobId ? "active" : ""}" data-id="${esc(j.id)}">
    <div><b>${esc(j.trade)}</b> in <b>${esc(j.town)}</b><div class="meta">${counts}</div></div>
    <span class="meta">${esc(ago(j.created_at))}</span>
    <span class="badge ${stuck ? "failed" : esc(j.status)}">${esc(label)}</span>
    ${inProgress(j) ? `<div class="progress slim"><i style="width:${progressPct(j)}%"></i></div>` : ""}</div>`;
}

function progressPct(j) {
  if (j.status === "done") return 100;
  const stage = STAGES[j.progress_stage];
  if (!stage) return 2;
  const [, start, end] = stage;
  const frac = j.progress_total ? Math.min(1, j.progress_done / j.progress_total) : 0;
  return Math.max(2, Math.round(start + (end - start) * frac));
}

function progressText(j) {
  if (!j.progress_stage) return j.status === "queued" ? "Starting up on GitHub…" : `Looking for up to ${j.max_results} leads`;
  const scouted = j.progress_stage === "scouting" ? j.progress_done : j.progress_scouted;
  const parts = [`Scouted: ${scouted ?? 0} / ${j.max_results}`];
  if (j.progress_stage === "checking") parts.push(`Websites checked: ${j.progress_done} / ${j.progress_total}`);
  if (j.progress_stage === "directors") parts.push(`Directors: ${j.progress_done} / ${j.progress_total}`);
  if (j.progress_stage === "maps") parts.push("Mapping rankings…");
  if (j.progress_stage === "saving") parts.push("Saving…");
  return parts.join(" · ");
}

function jobResults(job) {
  if (isStuck(job)) {
    return `<div class="card"><h2>That run looks stuck</h2><p class="error">Open GitHub → Actions → Scrape leads to see what happened, then start it again.</p></div>`;
  }
  if (inProgress(job)) {
    const stage = STAGES[job.progress_stage];
    const pct = progressPct(job);
    return `<div class="card"><h2 class="cap">${esc(job.trade)} in ${esc(job.town)}</h2>
      <div class="progress-head"><b>${esc(stage ? stage[0] : "Starting up…")}</b><span>${pct}%</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="counters">
        <div><b>${esc((job.progress_stage === "scouting" ? job.progress_done : job.progress_scouted) ?? 0)}</b><span>Scouted (of ${esc(job.max_results)})</span></div>
        <div><b>${job.progress_stage === "checking" ? `${esc(job.progress_done)}/${esc(job.progress_total)}` : ["directors", "maps", "saving"].includes(job.progress_stage) ? "✓" : "–"}</b><span>Websites checked</span></div>
        <div><b>${["maps"].includes(job.progress_stage) ? "…" : job.progress_stage === "saving" ? "✓" : "–"}</b><span>Maps heatmap</span></div>
      </div>
      <p class="hint" style="margin-bottom:0">The page updates by itself. You can leave and come back.</p></div>`;
  }
  if (job.status === "failed") {
    return `<div class="card"><h2>That run failed</h2><p class="error">${esc(job.error || "Unknown error")}</p><p class="hint">Check <a href="#/setup">Setup</a>, fix anything red, then press Find leads again.</p></div>`;
  }
  const pitch = state.leads.filter((l) => !l.excluded);
  const tiles = [
    [state.leads.length, "businesses found"],
    [pitch.length, "worth pitching"],
    [pitch.filter((l) => l.findings.some((f) => NO_SITE.includes(f))).length, "no working website"],
    [pitch.filter((l) => l.email).length, "with an email"],
    [pitch.filter((l) => !l.email).length, "for the call list"],
  ].map(([n, t]) => `<div class="tile"><b>${n}</b><span>${t}</span></div>`).join("");
  return `<h2 class="cap" style="margin:26px 0 12px">${esc(job.trade)} in ${esc(job.town)}</h2><div class="tiles">${tiles}</div>${leadsTable()}`;
}

async function startScrape(e) {
  e.preventDefault();
  const btn = view.querySelector("#go");
  const err = view.querySelector("#scrape-error");
  btn.disabled = true;
  err.hidden = true;
  try {
    const max = Math.round(Number(view.querySelector("#max").value));
    if (!(max >= 10 && max <= 300)) throw new Error("How many leads: pick a number from 10 to 300");
    state.lastMax = max;
    const body = { trade: view.querySelector("#trade").value.trim(), town: view.querySelector("#town").value.trim(), max };
    const { job } = await api("/api/scrape", { method: "POST", body: JSON.stringify(body) });
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    state.jobId = job.id;
    state.leads = [];
    scraperPage();
    poll();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
  }
}

async function openJob(id) {
  state.jobId = id;
  state.open = null;
  state.leads = [];
  const job = state.jobs.find((j) => j.id === id);
  if (job && job.status === "done") state.leads = (await api(`/api/leads?job=${encodeURIComponent(id)}`)).leads;
  scraperPage();
}

// refresh runs every 3 s while one is in progress (live progress bar); open the results when it finishes
function poll() {
  clearTimeout(state.poll);
  const busy = () => state.jobs.some(inProgress);
  if (!busy()) return;
  state.poll = setTimeout(async () => {
    if (currentPage() !== "scraper") return;
    const before = state.jobs.find((j) => j.id === state.jobId)?.status;
    state.jobs = (await api("/api/jobs")).jobs;
    const after = state.jobs.find((j) => j.id === state.jobId)?.status;
    if (before !== "done" && after === "done") await openJob(state.jobId);
    else if (!view.querySelector("input:focus, select:focus, textarea:focus")) scraperPage();
    poll();
  }, 3000);
}

// ---------------------------------------------------------------- All Leads page

function leadsPage() {
  view.innerHTML = `<h1>All Leads</h1><p class="sub">Every lead from every run, best first. Click a lead for details and notes.</p>${leadsTable()}`;
  bindTable(leadsPage);
}

// ---------------------------------------------------------------- Setup page

async function setupPage() {
  view.innerHTML = `<h1>Setup</h1><p class="sub">Checking what's connected…</p>`;
  const { checks, note } = await api("/api/setup");
  const allOk = checks.every((c) => c.ok);
  view.innerHTML = `
    <h1>Setup</h1>
    <p class="sub">${allOk ? "Everything is connected. You're ready to find leads." : "Fix anything marked red, then refresh this page."}</p>
    <div class="card checks">${checks.map((c) => `
      <div class="check"><span class="dot ${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✕"}</span>
        <div><b>${esc(c.name)}</b><div class="small">${esc(c.ok ? c.detail : c.fix)}</div></div></div>`).join("")}
    </div>
    <p class="hint">${esc(note)} Full step-by-step guide: <code>control-room/README.md</code> in the repo.</p>`;
}

// ---------------------------------------------------------------- Map Rank page (LeadSnap-style heatmap)

const GRIDS = [3, 5, 7, 9, 11, 13];
const SPACINGS = [[400, "¼ mile"], [800, "½ mile"], [1600, "1 mile"], [3200, "2 miles"]];
const spacingLabel = (m) => (SPACINGS.find(([v]) => v === m) || [m, `${m} m`])[1];
const rankClass = (r) => (!r ? "r-out" : r <= 3 ? "r-top" : r <= 10 ? "r-mid" : "r-low");
const scanInProgress = (s) => (s.status === "queued" || s.status === "running") && Date.now() - Date.parse(s.created_at) < 30 * 60000;

function mapRankPage() {
  const scan = state.scan && state.scan.scan.id === state.scanId ? state.scan : null;
  view.innerHTML = `
    <h1>Map Rank</h1>
    <p class="sub">Where businesses show up on Google Maps across a town, like LeadSnap's heatmap. Free to run. Every lead search also makes a 5×5 one automatically.</p>
    <form class="card form scan-form" id="scan-form">
      <div><label for="kw">Keyword (what customers search)</label><input id="kw" list="trades" placeholder="roofer" required minlength="2" maxlength="60" value="${esc(state.scanDraft?.keyword || "")}"></div>
      <div><label for="stown">Town</label><input id="stown" placeholder="Warrington" required minlength="2" maxlength="60" value="${esc(state.scanDraft?.town || "")}"></div>
      <div><label for="grid">Grid</label><select id="grid">${GRIDS.map((g) => `<option value="${g}" ${g === 7 ? "selected" : ""}>${g} × ${g} (${g * g} points)</option>`).join("")}</select></div>
      <div><label for="spacing">Distance between points</label><select id="spacing">${SPACINGS.map(([v, t]) => `<option value="${v}" ${v === 1600 ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <button class="btn" type="submit" id="scan-go">Run scan</button>
      <datalist id="trades">${TRADES.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    </form>
    <p class="error" id="scan-error" hidden></p>
    ${state.scans.length ? `<div class="card"><h2>Your scans</h2><div class="runs">${state.scans.map(scanRow).join("")}</div></div>`
      : `<div class="card"><h2>No scans yet</h2><p class="hint" style="margin:0">Run one above, or find leads on the Lead Scraper page: each search makes a heatmap automatically.</p></div>`}
    <div id="scan-view">${scan ? scanView(scan) : state.scanId ? scanStatusCard() : ""}</div>`;
  view.querySelector("#scan-form").onsubmit = startScan;
  view.querySelectorAll(".run[data-scan]").forEach((r) => r.onclick = () => { location.hash = `#/maprank?scan=${encodeURIComponent(r.dataset.scan)}`; });
  if (scan) bindScanView(scan);
}

function scanRow(s) {
  const label = scanInProgress(s) ? "scanning…" : s.status === "done" ? "done" : s.status === "failed" ? "failed" : "stuck";
  const badge = label === "scanning…" ? "running" : label === "done" ? "done" : "failed";
  return `<div class="run ${s.id === state.scanId ? "active" : ""}" data-scan="${esc(s.id)}">
    <div><b class="cap">${esc(s.keyword)}</b> in <b>${esc(s.town)}</b>
      <div class="meta">${esc(s.grid)}×${esc(s.grid)} grid · ${esc(spacingLabel(s.spacing_m))} apart${s.source === "scrape" ? " · made by a lead search" : ""}${s.status === "failed" ? ` · ${esc(s.error || "")}` : ""}</div></div>
    <span class="meta">${esc(ago(s.created_at))}</span><span class="badge ${badge}">${label}</span></div>`;
}

function scanStatusCard() {
  const s = state.scans.find((x) => x.id === state.scanId);
  if (!s) return "";
  if (s.status === "failed") return `<div class="card"><h2>That scan failed</h2><p class="error">${esc(s.error || "Unknown error")}</p></div>`;
  return `<div class="card"><h2 class="cap">${esc(s.keyword)} in ${esc(s.town)}</h2><p class="hint" style="margin:0">Scanning ${s.grid * s.grid} points across town… usually under a minute. The page updates by itself.</p></div>`;
}

function scanView(data) {
  const { scan, businesses } = data;
  const biz = businesses.find((b) => b.place_id === state.biz) || businesses[0];
  if (!biz) return `<div class="card"><h2>No businesses found for that search</h2></div>`;
  state.biz = biz.place_id;
  const position = businesses.indexOf(biz) + 1;
  const tiles = [
    [biz.found_pct === 0 ? "20+" : `#${Number(biz.avg_rank).toFixed(1)}`, "average rank"],
    [`${biz.top3_pct}%`, "of town in the top 3"],
    [`${biz.found_pct}%`, "of town in the top 20"],
    [`${position} of ${businesses.length}`, "among competitors"],
  ].map(([n, t]) => `<div class="tile"><b>${n}</b><span>${t}</span></div>`).join("");
  const options = businesses.map((b, i) => `<option value="${esc(b.place_id)}" ${b === biz ? "selected" : ""}>${i + 1}. ${esc(b.name || "Unnamed business")}</option>`).join("");
  return `
    <div class="scan-head">
      <div><h2 class="cap" style="margin:0">${esc(scan.keyword)} in ${esc(scan.town)}</h2>
        <div class="meta">${esc(scan.grid)}×${esc(scan.grid)} grid · ${esc(spacingLabel(scan.spacing_m))} apart · ${esc(new Date(scan.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</div></div>
      <div class="grow-select"><label for="biz">Showing heatmap for</label><select id="biz">${options}</select></div>
    </div>
    <div class="tiles four">${tiles}</div>
    <div class="scan-body">
      <div class="card map-card"><div id="heatmap"></div>
        <div class="legend"><span class="dot-r r-top">1–3</span><span class="dot-r r-mid">4–10</span><span class="dot-r r-low">11–20</span><span class="dot-r r-out">20+</span><span class="small">Each circle = their position if you searched “${esc(scan.keyword)}” standing there.</span></div>
      </div>
      <div class="card comp-card"><h2>Competitors</h2>
        <div class="table-wrap"><table class="comp"><thead><tr><th>#</th><th>Business</th><th>Avg</th><th>Top 3</th><th>Reviews</th></tr></thead><tbody>
        ${businesses.map((b, i) => `<tr class="crow ${b === biz ? "sel" : ""}" data-biz="${esc(b.place_id)}">
          <td>${i + 1}</td>
          <td><div class="name">${esc(b.name || "Unnamed business")}</div>${b.lead ? `<div class="small">Your lead · score ${esc(b.lead.quality_score)} · ${esc(b.lead.status)}</div>` : ""}</td>
          <td><span class="pill ${rankClass(b.found_pct ? Math.round(b.avg_rank) : null)}">${b.found_pct ? Number(b.avg_rank).toFixed(1) : "20+"}</span></td>
          <td>${esc(b.top3_pct)}%</td>
          <td>${b.rating ? `${esc(b.rating)}★ ` : ""}<span class="small">${esc(b.review_count || 0)}</span></td></tr>`).join("")}
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
    if (currentPage() !== "maprank") return;
    const before = state.scans.find((x) => x.id === state.scanId)?.status;
    state.scans = (await api("/api/scans")).scans;
    const after = state.scans.find((x) => x.id === state.scanId)?.status;
    if (before !== after && state.scanId) await openScan(state.scanId);
    else if (!view.querySelector("input:focus, select:focus")) mapRankPage();
    pollScans();
  }, 4000);
}

// ---------------------------------------------------------------- router

function currentPage() {
  const path = location.hash.split("?")[0];
  return { "#/leads": "leads", "#/setup": "setup", "#/maprank": "maprank" }[path] || "scraper";
}

function hashParams() {
  return new URLSearchParams(location.hash.split("?")[1] || "");
}

async function route() {
  const page = currentPage();
  document.querySelectorAll(".nav a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === page));
  state.open = null;
  if (state.map) { state.map.remove(); state.map = null; }
  try {
    if (page === "setup") {
      await setupPage();
    } else if (page === "maprank") {
      const params = hashParams();
      state.scans = (await api("/api/scans")).scans;
      state.biz = params.get("biz") || state.biz;
      const id = params.get("scan") || state.scans.find((x) => x.status === "done")?.id || null;
      if (id) await openScan(id);
      else mapRankPage();
      pollScans();
    } else if (page === "leads") {
      state.jobId = null;
      state.leads = (await api("/api/leads")).leads;
      leadsPage();
    } else {
      state.jobs = (await api("/api/jobs")).jobs;
      if (state.jobId) await openJob(state.jobId);
      else scraperPage();
      poll();
    }
  } catch (err) {
    view.innerHTML = `<h1>Something's not set up</h1><p class="error">${esc(err.message)}</p><p class="hint">Open <a href="#/setup">Setup</a> to see what's connected.</p>`;
  }
}

window.addEventListener("hashchange", route);
route();
