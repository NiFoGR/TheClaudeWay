// Lead Scraper page: start a search, watch it live, see the results.
import { bindTable, leadsTable, NO_SITE } from "./leads.js";
import { ago, api, esc, icon, kpi, modal, pageHead, state, toast, view } from "./lib.js";

export const TRADES = ["roofer", "plumber", "electrician", "heating engineer", "builder", "landscaper", "painter and decorator",
  "locksmith", "pest control", "removals", "mechanic", "car dealer", "driving school", "martial arts gym",
  "cleaner", "carpet cleaner", "plasterer", "fencing contractor", "tree surgeon", "window cleaner"];
const QUICK_SIZES = [20, 60, 100, 200, 300];
const RUNS_SHOWN = 5;
// stages, with where each sits on the overall progress bar (start %, end %)
const STAGES = {
  scouting: ["Scouting businesses on Google Maps", 0, 20],
  checking: ["Checking every website", 20, 75],
  directors: ["Checking Companies House", 75, 85],
  maps: ["Mapping Google Maps rankings across town", 85, 95],
  saving: ["Saving to your Control Room", 95, 100],
};

// Queued or running, as the server says: the tick's stale_jobs step fails a run with no progress for 45 minutes, so
// the page never guesses that a run is stuck.
export const inProgress = (j) => j.status === "queued" || j.status === "running";
export const tradeList = () => `<datalist id="trades">${TRADES.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`;

export function scraperPage() {
  const job = state.jobs.find((j) => j.id === state.jobId);
  const runs = state.showAllRuns ? state.jobs : state.jobs.slice(0, RUNS_SHOWN);
  view.innerHTML = `
    ${pageHead("Lead Scraper", "Pick a niche and a town. It searches Google Maps, checks every website, finds emails and owners' names, and ranks who needs us most.")}
    <form class="card search-form" id="scrape">
      <div><label for="trade">Niche</label><input id="trade" list="trades" placeholder="roofer" required minlength="2" maxlength="60" value="${esc(state.scrapeDraft?.trade || "")}"></div>
      <div><label for="town">Town</label><input id="town" placeholder="Leeds" required minlength="2" maxlength="60" value="${esc(state.scrapeDraft?.town || "")}"></div>
      <div><label for="max">How many leads</label><input id="max" type="number" min="10" max="300" step="1" value="${esc(state.lastMax || 60)}" required>
        <div class="quick">${QUICK_SIZES.map((n) => `<button type="button" class="chip" data-size="${n}">${n}</button>`).join("")}</div></div>
      <button class="btn" type="submit" id="go">${icon("search")} Find leads</button>
      ${tradeList()}
    </form>
    <p class="error" id="scrape-error" hidden></p>
    <div id="automatic"></div>
    ${job ? jobResults(job) : ""}
    ${state.jobs.length ? `
      <div class="section-title"><h2>Your searches</h2>${state.jobs.length > RUNS_SHOWN ? `<button class="btn ghost sm" id="all-runs">${state.showAllRuns ? "Show fewer" : `Show all ${state.jobs.length}`}</button>` : ""}</div>
      <div class="runs">${runs.map(runRow).join("")}</div>` : howItWorks()}`;

  view.querySelector("#scrape").onsubmit = startScrape;
  view.querySelectorAll("[data-size]").forEach((b) => b.onclick = () => { view.querySelector("#max").value = b.dataset.size; });
  view.querySelectorAll(".run").forEach((r) => r.onclick = () => openJob(r.dataset.id));
  const all = view.querySelector("#all-runs");
  if (all) all.onclick = () => { state.showAllRuns = !state.showAllRuns; scraperPage(); };
  if (job && job.status === "done") bindTable(scraperPage);
  automaticCard();
}

// The card is redrawn from the last /api/territory answer whenever the page redraws (every 3 s while a search runs),
// so it doesn't blink. It asks again when you open the page, after a save, when a search starts, finishes or fails,
// and otherwise at most once a minute: each answer costs several database reads. `shown` is the newest answer drawn,
// so a slow older answer never replaces it.
const AUTOMATIC_REFRESH_MS = 60000;
const automatic = { data: null, at: 0, runs: "", ask: 0, shown: 0 };
const runsSeen = () => state.jobs.map((j) => `${j.id}:${j.status}`).join(",");

/** The automatic search: from 6am each morning the tick searches the next town on your list when the pipeline is low
 *  (_lib/find.js, tick step daily_find). The card says what it did today and what it will do next. */
async function automaticCard(force = false) {
  if (!view.querySelector("#automatic")) return;
  if (automatic.data) renderAutomatic(automatic.data);
  const runs = runsSeen();
  if (!force && automatic.data && automatic.runs === runs && Date.now() - automatic.at < AUTOMATIC_REFRESH_MS) return;
  const ask = ++automatic.ask;
  Object.assign(automatic, { runs, at: Date.now() });
  let data;
  try {
    data = await api("/api/territory");
  } catch (err) {
    if (ask < automatic.shown) return;
    automatic.at = 0; // ask again on the next redraw
    if (!automatic.data) renderAutomatic({ error: err.message });
    return;
  }
  if (ask < automatic.shown) return;
  Object.assign(automatic, { data, shown: ask });
  renderAutomatic(data);
}

function renderAutomatic(a) {
  const el = view.querySelector("#automatic");
  if (!el) return;
  el.innerHTML = automaticHtml(a);
  const edit = el.querySelector("#auto-edit");
  if (edit) edit.onclick = () => editAutomatic(a.territory);
}

/** The card for a GET /api/territory answer {territory, upcoming, today}, or {error} when it couldn't be read.
 *  Part A's exact copy; every value is escaped (today's line can quote GitHub's own words). */
export function automaticHtml(a) {
  const head = `${icon("spark")} Automatic search`;
  // The text column may shrink and break a long word (a URL in GitHub's error), so a phone never scrolls sideways.
  const text = '<div style="min-width:0;overflow-wrap:anywhere">';
  if (!a?.territory) {
    if (!a?.error) return "";
    const why = String(a.error).replace(/[\s.]+$/, "");
    return `<div class="card autopilot">${text}<b>${head}</b>
      <div class="small error" style="margin-top:4px">Couldn't load the automatic search: ${esc(why)}. Reload the page to try again.</div></div></div>`;
  }
  const t = a.territory;
  const rule = t.on
    ? `Every morning from 6am it searches ${esc(t.trade)} in the next town on your list, when fewer than 30 good leads are waiting and Claude has fewer than 40 to research. Next town: <b>${esc(a.upcoming)}</b>.`
    : "Switched off: nothing is searched automatically.";
  return `<div class="card autopilot">${text}<b>${head} ${t.on ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}</b>
      <div class="small"><b>Today:</b> ${esc(a.today)}</div>
      <div class="muted small">${rule}</div></div>
    <button class="btn secondary sm" id="auto-edit">Edit</button></div>`;
}

/** The Edit dialog for the territory {on, trade, towns, max}. `novalidate`: the server's plain-English errors show
 *  ("Type the niche to search, e.g. landscaper", …), not the browser's own. */
export function automaticFormHtml(t) {
  const towns = Array.isArray(t?.towns) ? t.towns : [];
  return `<div class="modal-head"><h2>Automatic search</h2><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
    <form class="modal-body" id="auto-form" novalidate>
      <label class="check"><input type="checkbox" name="on" ${t?.on ? "checked" : ""}> Search one town every morning</label>
      <label for="auto-trade">Niche</label><input id="auto-trade" name="trade" list="trades" value="${esc(t?.trade)}" required>
      <label for="auto-towns">Towns, in order (one per line). A town searched in the last 30 days is skipped.</label>
      <textarea id="auto-towns" name="towns" rows="10">${esc(towns.join("\n"))}</textarea>
      <label for="auto-max">Leads per search</label><input id="auto-max" name="max" type="number" min="10" max="300" value="${esc(t?.max)}">
      <p class="error" id="auto-error" hidden></p>
      <button class="btn" type="submit">Save</button>${tradeList()}
    </form>`;
}

function editAutomatic(t) {
  const m = modal(automaticFormHtml(t));
  m.querySelector("#auto-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const saved = await api("/api/territory", { method: "PUT", body: JSON.stringify({ on: f.on.checked, trade: f.trade.value, towns: f.towns.value, max: Number(f.max.value) }) });
      m.close();
      toast("Saved.");
      if (automatic.data && saved?.territory) automatic.data = { ...automatic.data, territory: saved.territory };
      automaticCard(true);
    } catch (err) {
      const box = m.querySelector("#auto-error");
      box.textContent = err.message;
      box.hidden = false;
    }
  };
}

function howItWorks() {
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>How it works</h2></div><ol class="steps">
    <li><b>Type a niche and a town</b>, choose how many leads, press <b>Find leads</b>.</li>
    <li>It scouts Google Maps, checks every website against the SEO playbook, finds emails and owners' names, maps where they rank, and skips chains. 2–8 minutes; you can leave the page.</li>
    <li><b>Your leads appear here</b>, best first. Use the tabs to see who to email and who to call.</li>
  </ol><p class="hint">First time? Check <a href="#/setup">Setup</a> shows everything connected.</p></div>`;
}

export function runRow(j) {
  const badge = { queued: ["warn", "Starting"], running: ["warn", "Working"], done: ["good", "Done"], failed: ["bad", "Failed"] }[j.status] || ["", j.status];
  const meta = j.status === "done" ? `${esc(j.pitchable)} worth pitching of ${esc(j.found)} found`
    : j.status === "failed" ? esc(j.error || "")
    : progressText(j);
  return `<div class="run ${j.id === state.jobId ? "active" : ""}" data-id="${esc(j.id)}">
    <div style="min-width:0;overflow-wrap:anywhere"><b>${esc(j.trade)}</b> <span class="muted">in</span> <b>${esc(j.town)}</b><div class="meta">${meta}</div></div>
    <span class="meta">${esc(ago(j.created_at))}</span>
    <span class="badge ${badge[0]}">${esc(badge[1])}</span>
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
  if (j.progress_stage === "directors") parts.push(`Companies House: ${j.progress_done} / ${j.progress_total}`);
  if (j.progress_stage === "maps") parts.push("Mapping rankings…");
  if (j.progress_stage === "saving") parts.push("Saving…");
  return parts.join(" · ");
}

function jobResults(job) {
  const title = `<div class="section-title"><h2 class="cap">${esc(job.trade)} in ${esc(job.town)}</h2><span class="muted small">${esc(ago(job.created_at))}</span></div>`;
  if (inProgress(job)) {
    const stage = STAGES[job.progress_stage];
    const pct = progressPct(job);
    const scouted = (job.progress_stage === "scouting" ? job.progress_done : job.progress_scouted) ?? 0;
    const later = (s) => ["directors", "maps", "saving"].includes(s);
    return `${title}<div class="card">
      <div class="progress-head"><b>${esc(stage ? stage[0] : "Starting up…")}</b><span class="num">${pct}%</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="counters">
        <div><b>${esc(scouted)}</b><span>Scouted (of ${esc(job.max_results)})</span></div>
        <div><b>${job.progress_stage === "checking" ? `${esc(job.progress_done)}/${esc(job.progress_total)}` : later(job.progress_stage) ? "✓" : "–"}</b><span>Websites checked</span></div>
        <div><b>${job.progress_stage === "maps" ? "…" : job.progress_stage === "saving" ? "✓" : "–"}</b><span>Maps heatmap</span></div>
      </div>
      <p class="hint">Updates by itself. You can leave and come back.</p></div>`;
  }
  if (job.status === "failed") {
    return `${title}<div class="card"><p class="error" style="margin:0;overflow-wrap:anywhere">${esc(job.error || "Unknown error")}</p><p class="hint">Check <a href="#/setup">Setup</a>, fix anything red, then press Find leads again.</p></div>`;
  }
  const pitch = state.leads.filter((l) => !l.excluded);
  const tiles = [
    kpi("Worth pitching", pitch.length, `of ${state.leads.length} found`, "accent"),
    kpi("No working website", pitch.filter((l) => l.findings.some((f) => NO_SITE.includes(f))).length, "easiest sells"),
    kpi("With an email", pitch.filter((l) => l.email).length, `${pitch.filter((l) => l.audit?.email_source === "guessed").length} guessed`),
    kpi("Call list", pitch.filter((l) => !l.email).length, "no email found"),
  ].join("");
  return `${title}<div class="kpis" style="margin-bottom:16px">${tiles}</div>${leadsTable()}`;
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
    state.scrapeDraft = body;
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

export async function openJob(id) {
  state.jobId = id;
  state.leads = [];
  const job = state.jobs.find((j) => j.id === id);
  if (job && job.status === "done") state.leads = (await api(`/api/leads?job=${encodeURIComponent(id)}`)).leads;
  scraperPage();
}

// refresh every 3 s while a search is running (live progress bar); open the results when it finishes
export function poll() {
  clearTimeout(state.poll);
  if (!state.jobs.some(inProgress)) return;
  state.poll = setTimeout(async () => {
    if (!location.hash.startsWith("#/scraper")) return;
    const before = state.jobs.find((j) => j.id === state.jobId)?.status;
    state.jobs = (await api("/api/jobs")).jobs;
    const after = state.jobs.find((j) => j.id === state.jobId)?.status;
    if (before !== "done" && after === "done") await openJob(state.jobId);
    else if (!view.querySelector("input:focus, select:focus, textarea:focus")) scraperPage();
    poll();
  }, 3000);
}

export async function scraperRoute() {
  Object.assign(automatic, { data: null, at: 0 }); // never show an earlier visit's "Today:" line
  state.jobs = (await api("/api/jobs")).jobs;
  if (state.jobId) await openJob(state.jobId);
  else scraperPage();
  poll();
}
