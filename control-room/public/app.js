// GoldBar Control Room. Plain JS, no build step. Every value from scraped websites goes through esc()/safeUrl().

const STATUSES = ["new", "contacted", "replied", "call booked", "won", "lost", "not interested"];
const TRADES = ["roofer", "plumber", "electrician", "heating engineer", "builder", "landscaper", "painter and decorator",
  "locksmith", "pest control", "removals", "mechanic", "car dealer", "driving school", "martial arts gym",
  "cleaner", "carpet cleaner", "plasterer", "fencing contractor", "tree surgeon", "window cleaner"];
const SIZES = [20, 40, 60, 100, 150, 200, 300];

const view = document.getElementById("view");
const state = { jobs: [], jobId: null, leads: [], filter: "pitch", search: "", open: null, poll: null };

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
  if (!resp.ok && !data.job) throw new Error(data.error || `Request failed (${resp.status})`);
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
  nosite: { label: "No working website", test: (l) => !l.excluded && l.quality_score >= 90 },
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
    <p class="hint" style="margin:0 0 10px"><b>Score</b> = how much we can help them: 100 means no website at all, 0 means their site is already fine. Best leads are at the top. Click a lead for full details and notes.</p>
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
      <td data-label="Score"><span class="score ${scoreClass(l.quality_score)}">${l.excluded ? "–" : esc(l.quality_score)}</span></td>
      <td data-label="Business"><div class="name">${esc(l.name)}</div><div class="small">${esc(l.director_name ? `Director: ${l.director_name}` : l.town)}</div></td>
      <td data-label="Contact">${l.phone ? `<a href="tel:${esc(l.phone.replace(/\s/g, ""))}">${esc(l.phone)}</a>` : ""}
          <div class="small">${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : "no email found"}</div></td>
      <td data-label="Problems"><ul class="problems">${shown}${more}</ul></td>
      <td data-label="Google">${l.rating ? `${esc(l.rating)}★` : "–"}<div class="small">${esc(l.review_count || 0)} reviews${l.rank ? ` · #${esc(l.rank)} on Google` : ""}</div></td>
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
        <p class="small">Trade: ${esc(l.trade)} · searched in ${esc(l.search_town)} · first seen ${esc(ago(l.first_seen_at))}</p>
      </div>
    </div></td></tr>`;
}

function bindTable(rerender) {
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
  const cols = [["Score", (l) => l.quality_score], ["Business", (l) => l.name], ["Director", (l) => l.director_name],
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
      <div><label for="max">Number of leads</label><select id="max">${SIZES.map((n) => `<option ${n === 60 ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <button class="btn" type="submit" id="go">Find leads</button>
      <datalist id="trades">${TRADES.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    </form>
    <p class="error" id="scrape-error" hidden></p>
    ${state.jobs.length ? `<div class="card"><h2>Your runs</h2><p class="hint" style="margin:-6px 0 12px">Click a run to see its leads.</p><div class="runs">${state.jobs.map(runRow).join("")}</div></div>` : howItWorks()}
    ${job ? jobResults(job) : ""}`;

  view.querySelector("#scrape").onsubmit = startScrape;
  view.querySelectorAll(".run").forEach((r) => r.onclick = () => openJob(r.dataset.id));
  if (job && job.status === "done") bindTable(scraperPage);
}

const STUCK_MINUTES = 40;
const isStuck = (j) => (j.status === "queued" || j.status === "running") && Date.now() - Date.parse(j.created_at) > STUCK_MINUTES * 60000;
const inProgress = (j) => (j.status === "queued" || j.status === "running") && !isStuck(j);

function howItWorks() {
  return `<div class="card"><h2>How it works</h2><ol class="steps">
    <li><b>Type a niche and a town</b>, choose how many leads, press <b>Find leads</b>.</li>
    <li>It searches Google Maps, checks every business's website, finds their email and director's name, and skips chains and franchises. Takes 2–6 minutes; you can leave the page.</li>
    <li><b>Your leads appear here</b>, best first: the businesses whose online presence needs us most. Use the tabs to see who to email and who to call.</li>
  </ol><p class="hint">First time? Check <a href="#/setup">Setup</a> shows everything connected.</p></div>`;
}

function runRow(j) {
  const stuck = isStuck(j);
  const label = stuck ? "stuck" : { queued: "starting…", running: "working…", done: "done", failed: "failed" }[j.status] || j.status;
  const counts = j.status === "done" ? `${j.pitchable} worth pitching of ${j.found}`
    : j.status === "failed" ? esc(j.error || "")
    : stuck ? "No word from GitHub for 40+ min. Check the Actions tab, then try again."
    : `up to ${j.max_results} leads`;
  return `<div class="run ${j.id === state.jobId ? "active" : ""}" data-id="${esc(j.id)}">
    <div><b>${esc(j.trade)}</b> in <b>${esc(j.town)}</b><div class="meta">${counts}</div></div>
    <span class="meta">${esc(ago(j.created_at))}</span>
    <span class="badge ${stuck ? "failed" : esc(j.status)}">${esc(label)}</span></div>`;
}

function jobResults(job) {
  if (isStuck(job)) {
    return `<div class="card"><h2>That run looks stuck</h2><p class="error">Open GitHub → Actions → Scrape leads to see what happened, then start it again.</p></div>`;
  }
  if (inProgress(job)) {
    return `<div class="card"><h2 class="cap">${esc(job.trade)} in ${esc(job.town)}</h2><p class="sub" style="margin:0">Working on it. This usually takes 2–6 minutes; the page updates by itself.</p></div>`;
  }
  if (job.status === "failed") {
    return `<div class="card"><h2>That run failed</h2><p class="error">${esc(job.error || "Unknown error")}</p><p class="hint">Check <a href="#/setup">Setup</a>, fix anything red, then press Find leads again.</p></div>`;
  }
  const pitch = state.leads.filter((l) => !l.excluded);
  const tiles = [
    [state.leads.length, "businesses found"],
    [pitch.length, "worth pitching"],
    [pitch.filter((l) => l.quality_score >= 90).length, "no working website"],
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
    const body = { trade: view.querySelector("#trade").value.trim(), town: view.querySelector("#town").value.trim(), max: Number(view.querySelector("#max").value) };
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

// refresh runs every 5 s while one is in progress; open the results when it finishes
function poll() {
  clearTimeout(state.poll);
  const busy = () => state.jobs.some(inProgress);
  if (!busy()) return;
  state.poll = setTimeout(async () => {
    if (location.hash !== "#/scraper" && location.hash !== "") return;
    const before = state.jobs.find((j) => j.id === state.jobId)?.status;
    state.jobs = (await api("/api/jobs")).jobs;
    const after = state.jobs.find((j) => j.id === state.jobId)?.status;
    if (before !== "done" && after === "done") await openJob(state.jobId);
    else if (!view.querySelector("input:focus, select:focus, textarea:focus")) scraperPage();
    poll();
  }, 5000);
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

// ---------------------------------------------------------------- router

async function route() {
  const page = { "#/leads": "leads", "#/setup": "setup" }[location.hash] || "scraper";
  document.querySelectorAll(".nav a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === page));
  state.open = null;
  try {
    if (page === "setup") {
      await setupPage();
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
