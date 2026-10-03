// The lead table (Lead Scraper results and All Leads) and the lead details drawer.
import { ago, api, esc, icon, pageHead, ring, safeUrl, state, view } from "./lib.js";

export const STATUSES = ["new", "contacted", "replied", "call booked", "won", "lost", "not interested"];
export const NO_SITE = ["no_website", "profile_only", "site_down", "site_broken", "bad_certificate"];
const PARTS = [["website", "Website", 45], ["seo", "Local SEO", 30], ["maps", "Google Maps", 25]];

export const FILTERS = {
  pitch: { label: "Worth pitching", test: (l) => !l.excluded },
  email: { label: "Has email", test: (l) => !l.excluded && l.email },
  call: { label: "Call list", test: (l) => !l.excluded && !l.email },
  nosite: { label: "No working site", test: (l) => !l.excluded && l.findings.some((f) => NO_SITE.includes(f)) },
  excluded: { label: "Excluded", test: (l) => l.excluded },
};

const guessed = (l) => l.audit?.email_source === "guessed";
const tel = (phone) => `tel:${esc(String(phone).replace(/\s/g, ""))}`;

export function visibleLeads() {
  const q = state.search.toLowerCase();
  return state.leads.filter(FILTERS[state.filter].test).filter((l) =>
    !q || [l.name, l.town, l.email, l.phone, l.trade, l.director_name].some((v) => String(v || "").toLowerCase().includes(q)));
}

// ---------------------------------------------------------------- table

export function leadsTable() {
  const rows = visibleLeads();
  const tabs = Object.entries(FILTERS).map(([key, f]) =>
    `<button class="${state.filter === key ? "active" : ""}" data-filter="${key}">${esc(f.label)}<span class="n">${state.leads.filter(f.test).length}</span></button>`).join("");
  return `
    <div class="toolbar">
      <div class="seg">${tabs}</div>
      <div class="search-box">${icon("search")}<input id="search" placeholder="Search name, town, email…" value="${esc(state.search)}"></div>
      <button class="btn secondary" id="csv">${icon("download")} CSV</button>
    </div>
    <p class="hint" style="margin:0 0 12px"><b>Score</b> = how much we can help them, out of 100. Best first. <a href="#" id="score-help">${state.showScoreHelp ? "Hide" : "How it's worked out"}</a></p>
    ${state.showScoreHelp ? scoreHelp() : ""}
    <div class="table-card"><div class="table-wrap"><table class="leads-table">
      <thead><tr><th>Score</th><th>Business</th><th>Biggest problem</th><th>Contact</th><th>Google</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(leadRow).join("") : `<tr><td colspan="6" class="empty">No leads here.</td></tr>`}</tbody>
    </table></div></div>`;
}

function leadRow(l) {
  const problems = l.excluded ? [l.exclude_reason] : l.issues;
  const status = STATUSES.map((s) => `<option ${s === l.status ? "selected" : ""}>${esc(s)}</option>`).join("");
  return `<tr class="click ${state.drawer === l.place_id ? "sel" : ""}" data-id="${esc(l.place_id)}">
    <td class="c-score">${ring(l.excluded ? null : l.quality_score)}</td>
    <td class="c-biz"><div class="biz">${esc(l.name)}</div><div class="sub-line">${esc([l.director_name && `Director: ${l.director_name}`, l.town].filter(Boolean).join(" · "))}</div></td>
    <td class="c-problem"><div class="problem">${esc(problems[0] || "Nothing major found")}</div>${problems.length > 1 ? `<div class="sub-line">+${problems.length - 1} more</div>` : ""}</td>
    <td class="c-contact">${l.phone ? `<a href="${tel(l.phone)}" class="num">${esc(l.phone)}</a>` : `<span class="faint">No phone</span>`}
      <div class="sub-line">${l.email ? `${esc(l.email)}${guessed(l) ? ' <span class="tag">guessed</span>' : ""}` : "No email found"}</div></td>
    <td class="c-google"><span class="rating">${l.rating ? `${icon("star")} ${esc(l.rating)}` : "–"} <span class="faint">(${esc(l.review_count || 0)})</span></span>${mapsLine(l)}</td>
    <td class="c-status"><select class="status-select" data-status="${esc(l.place_id)}" aria-label="Status">${status}</select></td>
  </tr>`;
}

function mapsLine(l) {
  const m = l.map_rank || {};
  if (m.avg_rank === undefined) return l.rank ? `<div class="sub-line">#${esc(l.rank)} in search</div>` : "";
  return `<div class="sub-line">Maps: ${m.found_pct === 0 ? "not in top 20" : `avg #${Math.round(m.avg_rank)}`}</div>`;
}

function scoreHelp() {
  return `<div class="card" style="margin-bottom:12px">
    <div class="help-grid">
      <div><h3>Website · 45</h3><p>Not mobile-friendly 14 · "Not secure" 8 · Outdated 6 · Old technology 5 · Slow 4–6 · No contact form 4 · Phone not tap-to-call 2</p></div>
      <div><h3>Local SEO · 30</h3><p>Trade and town in the page title 6+5 · Main heading 2–4 · Business info for Google (schema) 4 · Phone and address on site 3+2 · Google map 2 · Fewer than 30 pages 2–4 · Google description 2</p></div>
      <div><h3>Google Maps · 25</h3><p>From the heatmap: invisible 22 · rarely in top 20 18 · never top 3 12 · top 3 in under half of town 6 · far fewer reviews than the top 3 +3</p></div>
    </div>
    <p class="hint">No website or a broken one maxes Website + Local SEO (75). A site that blocks our checker scores 0 there: look at it yourself.</p>
  </div>`;
}

export function bindTable(rerender) {
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
  view.querySelectorAll("tr.click").forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest("a, select")) return;
    const lead = state.leads.find((l) => l.place_id === tr.dataset.id);
    if (lead) openDrawer(lead, rerender);
  });
  view.querySelectorAll("[data-status]").forEach((sel) => sel.onchange = () => saveLead(sel.dataset.status, { status: sel.value }));
}

export async function saveLead(id, patch) {
  try {
    const { lead } = await api(`/api/leads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    state.leads = state.leads.map((l) => (l.place_id === id ? { ...l, ...lead } : l));
    return lead;
  } catch (err) {
    alert(err.message);
    return null;
  }
}

function downloadCsv() {
  const cols = [["Score", (l) => l.quality_score], ["Website /45", (l) => l.score_parts.website], ["Local SEO /30", (l) => l.score_parts.seo],
    ["Google Maps /25", (l) => l.score_parts.maps], ["Maps avg rank", (l) => l.map_rank.avg_rank], ["Maps top-3 %", (l) => l.map_rank.top3_pct],
    ["Business", (l) => l.name], ["Director", (l) => l.director_name], ["Phone", (l) => l.phone], ["Email", (l) => l.email],
    ["Email found", (l) => l.audit?.email_source || ""], ["Website", (l) => l.website], ["Problems", (l) => l.issues.join("; ")],
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
  a.download = `aetos-leads-${state.filter}.csv`;
  a.click();
}

// ---------------------------------------------------------------- drawer

const root = () => document.getElementById("drawer-root");

export function closeDrawer() {
  state.drawer = null;
  root().innerHTML = "";
  document.querySelectorAll("tr.sel").forEach((tr) => tr.classList.remove("sel"));
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.drawer && !document.querySelector("dialog[open]")) closeDrawer(); });

/** Full details for one lead in a side panel. onChange re-renders the page behind it after a save. */
export function openDrawer(lead, onChange = () => {}) {
  state.drawer = lead.place_id;
  document.querySelectorAll("tr.click").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === lead.place_id));
  const l = lead;
  const site = safeUrl(l.website);
  const maps = safeUrl(l.maps_url);
  const status = STATUSES.map((s) => `<option ${s === l.status ? "selected" : ""}>${esc(s)}</option>`).join("");
  const problems = (l.excluded ? [l.exclude_reason] : l.issues).map((p) => `<li>${esc(p)}</li>`).join("") || `<li>Nothing major found</li>`;
  const p = l.score_parts || {};
  const parts = p.total === undefined ? "" : `<h3>Score breakdown</h3><div class="parts">${PARTS.map(([k, label, max]) => `
    <div class="part"><span>${label}</span><div class="bar"><i style="width:${Math.round(100 * (p[k] || 0) / max)}%"></i></div><b>${esc(p[k] || 0)}/${max}</b></div>`).join("")}</div>`;
  const emails = (l.emails || []).length
    ? `<div class="email-list">${l.emails.map((e) => `<div><a href="mailto:${esc(e)}">${esc(e)}</a>${guessed(l) ? ' <span class="tag">guessed</span>' : ""}</div>`).join("")}</div>
       ${guessed(l) ? `<p class="hint">Not on their website. Their domain receives email, so these are the usual addresses. Check before a big send.</p>`
         : l.audit?.pages_checked ? `<p class="hint">Found on their website (${esc(l.audit.pages_checked)} page${l.audit.pages_checked === 1 ? "" : "s"} checked).</p>` : ""}`
    : `<p class="muted" style="margin:0">No email found${l.audit?.pages_checked ? ` after checking ${esc(l.audit.pages_checked)} pages` : ""}. Call them, or check their socials.</p>`;
  const socials = Object.entries(l.socials || {}).filter(([, u]) => safeUrl(u))
    .map(([k, u]) => `<a class="btn secondary sm cap" href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(k)} ${icon("external")}</a>`).join("");
  const m = l.map_rank || {};
  const mapsFacts = m.avg_rank === undefined ? "" : `<dt>Google Maps</dt><dd>${m.found_pct === 0 ? "Not in the top 20 anywhere in town" : `Average #${Math.round(m.avg_rank)} · top 3 in ${esc(m.top3_pct)}% of town`}</dd>`;

  root().innerHTML = `
    <div class="scrim" data-x></div>
    <aside class="drawer" role="dialog" aria-label="${esc(l.name)}">
      <div class="drawer-head">${ring(l.excluded ? null : l.quality_score, true)}
        <div class="grow"><h2>${esc(l.name)}</h2><div class="sub-line cap">${esc([l.trade, l.town].filter(Boolean).join(" · "))}</div></div>
        <button class="icon-btn" data-x aria-label="Close">${icon("x")}</button></div>
      <div class="drawer-actions">
        ${l.phone ? `<a class="btn sm" href="${tel(l.phone)}">${icon("phone")} Call</a>` : ""}
        ${l.email ? `<a class="btn ${l.phone ? "secondary" : ""} sm" href="mailto:${esc(l.email)}">${icon("mail")} Email</a>` : ""}
        ${site ? `<a class="btn secondary sm" href="${esc(site)}" target="_blank" rel="noopener noreferrer">${icon("globe")} Website</a>` : ""}
        ${maps ? `<a class="btn secondary sm" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">${icon("pin")} Google</a>` : ""}
        ${l.map_scan_id ? `<a class="btn secondary sm" href="#/maprank?scan=${encodeURIComponent(l.map_scan_id)}&biz=${encodeURIComponent(l.place_id)}">${icon("grid")} Heatmap</a>` : ""}
      </div>
      <div class="drawer-body">
        <h3>Status</h3>
        <select id="d-status" class="status-select" style="width:100%;border-radius:8px;padding:8px 12px;font-size:14px">${status}</select>
        ${l.excluded ? "" : parts}
        <h3>${l.excluded ? "Why it's excluded" : "What's wrong online"}</h3><ul class="issues">${problems}</ul>
        <h3>Email</h3>${emails}
        ${socials ? `<h3>Socials</h3><div class="actions">${socials}</div>` : ""}
        <h3>Details</h3>
        <dl class="kv">
          ${l.phone ? `<dt>Phone</dt><dd><a href="${tel(l.phone)}">${esc(l.phone)}</a></dd>` : ""}
          ${l.director_name ? `<dt>Director</dt><dd>${esc(l.director_name)}${l.company_number ? ` <span class="faint">(company ${esc(l.company_number)})</span>` : ""}</dd>` : ""}
          ${l.address ? `<dt>Address</dt><dd>${esc(l.address)}</dd>` : ""}
          <dt>Rating</dt><dd>${l.rating ? `${esc(l.rating)}★ from ${esc(l.review_count || 0)} reviews` : "No Google reviews"}</dd>
          ${mapsFacts}
          <dt>Found</dt><dd>Searching “${esc(l.trade)}” in ${esc(l.search_town)}, ${esc(ago(l.first_seen_at))}</dd>
        </dl>
        <h3>Notes</h3>
        <textarea id="d-notes" rows="4" placeholder="Called, said call back Friday…">${esc(l.notes)}</textarea>
        <p class="hint" id="d-saved">Saves when you click away.</p>
      </div>
    </aside>`;
  root().querySelectorAll("[data-x]").forEach((el) => el.onclick = closeDrawer);
  root().querySelector("#d-status").onchange = async (e) => {
    const saved = await saveLead(l.place_id, { status: e.target.value });
    if (saved) { l.status = saved.status; onChange(); }
  };
  root().querySelector("#d-notes").onchange = async (e) => {
    const saved = await saveLead(l.place_id, { notes: e.target.value });
    if (saved) { l.notes = saved.notes; root().querySelector("#d-saved").textContent = "Saved."; }
  };
}

// ---------------------------------------------------------------- All Leads page

export async function leadsPage(fresh = true) {
  if (fresh) {
    state.jobId = null;
    state.leads = (await api("/api/leads")).leads;
  }
  view.innerHTML = pageHead("Leads", "Every business from every search, best first. Click one for everything we know about it.") + leadsTable();
  bindTable(() => leadsPage(false));
}
