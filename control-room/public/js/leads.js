// The Leads page and the lead panel (stage 3, docs/rebuild/04-shortlist.md): the wiring only. The HTML is leadview.js
// (pure, tested in tests/leadview.test.mjs); this file fetches GET /api/leads and GET /api/leads/:id, puts that HTML on
// the page and binds its data-* hooks: filters, paging, the panel's buttons (Write first email, Not a fit, Preview,
// notes), stage 2's research card (Copy, Research is wrong), stage 4's Demo site card (demo.js demoCardHtml, from
// GET /api/demo/lead/:id, in the panel's #d-demo slot; Copy link) and stage 6's email slot (compose.js mountEmail in
// #d-email: the composer, or the thread once a first email exists).
// The URL is the page's state: #/leads?<leadsQueryString> (kept in step as filters change, without a reload) and
// #/lead/<place_id> (app.js opens the page, then the panel). Loading this file only adds a keydown listener.
import { bindCopyLinks, demoCardErrorHtml, demoCardHtml } from "./demo.js";
import { api, esc, icon, modal, pageHead, safeUrl, state, toast, view } from "./lib.js";
import {
  drawerHtml, leadsBodyHtml, leadsErrorHtml, leadsQueryString, notAFitHtml, notAFitReason, parseLeadsQuery,
} from "./leadview.js";
import { RECHECK_OFFLINE, recheckAnswer, recheckedResearch, researchCard } from "./researchcard.js";

const SEARCH_WAIT_MS = 300; // the search box waits this long after the last key
const NO_COMPOSER = "Writing emails arrives with the next stage."; // a compose.js with no mountEmail

let listAsk = 0; // the newest list request: an older answer is never drawn over a newer one
let drawerAsk = 0; // the same for the panel (also bumped when it closes)
let searchTimer = 0;
let counts = null; // page 1's chip counts and facets, kept for pages 2+ of the same filters (the API sends them once)

const body = () => document.getElementById("leads-body");
const root = () => document.getElementById("drawer-root");
const hashFor = (query) => {
  const qs = leadsQueryString(query);
  return `#/leads${qs ? `?${qs}` : ""}`;
};

// ---------------------------------------------------------------- the list

/** The Leads page for the route's params (#/leads?view=…&job=…): title, then the list as the URL asks for it. */
export async function leadsPage(params) {
  clearTimeout(searchTimer);
  state.leadsQuery = parseLeadsQuery(params);
  view.innerHTML = `${pageHead("Leads", "Pick today's first emails. Best first.")}<div id="leads-body"><p class="muted">Loading your leads…</p></div>`;
  await loadList();
}

async function loadList() {
  const ask = ++listAsk;
  const query = state.leadsQuery;
  const qs = leadsQueryString(query);
  let data;
  try {
    data = await api(`/api/leads${qs ? `?${qs}` : ""}`);
  } catch (err) {
    if (ask === listAsk && body()) body().innerHTML = leadsErrorHtml(err.message);
    return;
  }
  if (ask !== listAsk || !body()) return; // a newer request, or Nik has moved to another page
  state.capacity = data.capacity ?? null;
  renderList(withCounts(query, data));
}

// Pages 2+ come without chip counts or facets: reuse page 1's while the filters are the same.
function withCounts(query, data) {
  const key = leadsQueryString({ ...query, page: 1 });
  if (data.grade_counts) {
    counts = { key, grade_counts: data.grade_counts, view_counts: data.view_counts, facets: data.facets };
    return data;
  }
  return counts?.key === key ? { ...data, grade_counts: counts.grade_counts, view_counts: counts.view_counts, facets: counts.facets } : data;
}

function renderList(data) {
  const el = body();
  // Keep what's being typed in the search box (and where), even if this answer is for fewer letters.
  const typing = document.activeElement?.id === "f-search" ? document.activeElement : null;
  const typed = typing && { value: typing.value, start: typing.selectionStart, end: typing.selectionEnd };
  el.innerHTML = leadsBodyHtml(state.leadsQuery, data, { selected: state.drawer });
  bindList(el);
  if (typed) {
    const box = el.querySelector("#f-search");
    if (box) {
      box.value = typed.value;
      box.focus();
      try { box.setSelectionRange(typed.start, typed.end); } catch { /* not a text box any more */ }
    }
  }
}

/** New filters: the URL follows (no reload, so the panel and the page stay put), then the list. */
function setQuery(next) {
  clearTimeout(searchTimer);
  state.leadsQuery = next;
  history.replaceState(null, "", hashFor(next));
  return loadList();
}

// Any filter change starts again at page 1.
const change = (patch) => setQuery({ ...state.leadsQuery, ...patch, page: 1 });

function toggle(list, value) {
  const now = Array.isArray(list) ? list : [];
  const next = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
  return next.length ? next : null;
}

// Ready shows only the A+, A and B chips and none of All's stage, email, researched or excluded filters, so moving to
// Ready drops those; moving to All keeps everything.
function switchView(viewName) {
  const q = state.leadsQuery;
  if (viewName === q.view) return;
  if (viewName === "all") return change({ view: "all" });
  const grades = (q.grades || []).filter((g) => g === "A+" || g === "A" || g === "B");
  return change({ view: "ready", grades: grades.length ? grades : null, stages: null, email: null, researched: null, excluded: false });
}

const flagOf = (v) => (v === "1" ? true : v === "0" ? false : null);

function bindList(el) {
  el.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => switchView(b.dataset.view === "all" ? "all" : "ready"));
  el.querySelectorAll("[data-grade]").forEach((b) => b.onclick = () => change({ grades: toggle(state.leadsQuery.grades, b.dataset.grade) }));
  el.querySelectorAll("[data-stage]").forEach((b) => b.onclick = () => change({ stages: toggle(state.leadsQuery.stages, b.dataset.stage) }));
  const on = (sel, fn) => { const input = el.querySelector(sel); if (input) input.onchange = () => fn(input); };
  on("#f-trade", (s) => change({ trade: s.value || null }));
  on("#f-town", (s) => change({ town: s.value || null }));
  on("#f-email", (s) => change({ email: flagOf(s.value) }));
  on("#f-researched", (s) => change({ researched: flagOf(s.value) }));
  on("#f-excluded", (c) => change({ excluded: c.checked }));
  const search = el.querySelector("#f-search");
  if (search) {
    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = parseLeadsQuery(new URLSearchParams({ q: search.value })).q; // trimmed and cut as the server does
        if (q !== state.leadsQuery.q) change({ q });
      }, SEARCH_WAIT_MS);
    };
  }
  const job = el.querySelector("[data-clear-job]");
  if (job) job.onclick = () => change({ job: null });
  const clear = el.querySelector("[data-clear-filters]");
  if (clear) clear.onclick = () => setQuery({ ...parseLeadsQuery(""), view: state.leadsQuery.view });
  el.querySelectorAll("[data-page]").forEach((b) => b.onclick = async () => {
    await setQuery({ ...state.leadsQuery, page: Math.max(1, Number(b.dataset.page) || 1) });
    window.scrollTo(0, 0);
  });
  el.querySelectorAll("tr.click[data-id]").forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest("a, button, input, select, textarea")) return;
    openLeadDrawer(tr.dataset.id);
  });
}

// ---------------------------------------------------------------- the lead panel

const markRows = (id) => document.querySelectorAll("tr.click[data-id]").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === id));

/** Close the panel (app.js calls this on every route change, so it never touches the URL). */
export function closeDrawer() {
  state.drawer = null;
  drawerAsk++;
  const r = root();
  if (r) r.innerHTML = "";
  markRows(null);
}

// Nik closing it (×, the dim background, Escape): a #/lead/<id> link becomes the list's own link again.
function dismissDrawer() {
  closeDrawer();
  if (/^#\/?lead\//.test(location.hash)) history.replaceState(null, "", hashFor(state.leadsQuery ?? parseLeadsQuery("")));
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.drawer && !document.querySelector("dialog[open]")) dismissDrawer();
});

// The panel's frame while it loads, or with an error in place of its content.
function shellHtml(inner) {
  return `<div class="scrim" data-x></div>
    <aside class="drawer" role="dialog" aria-label="Lead">
      <div class="drawer-head"><div class="grow"></div><button class="icon-btn" data-x aria-label="Close">${icon("x")}</button></div>
      <div class="drawer-body">${inner}</div>
    </aside>`;
}

/**
 * Open the lead panel for one place_id: GET /api/leads/:id (one request), then everything Part A lists. Its answer
 * carries today's room for first emails when the lead is ready, so Write first email is right however the panel was
 * opened (a row, Home, a #/lead/<id> link) and however long ago the list loaded.
 */
export async function openLeadDrawer(placeId) {
  const id = typeof placeId === "string" ? placeId : String(placeId ?? "");
  const r = root();
  if (!id || !r) return;
  const ask = ++drawerAsk;
  state.drawer = id;
  markRows(id);
  // Reopening the same lead (after Not a fit) keeps the panel on screen until the new one is ready.
  if (r.querySelector(".drawer")?.dataset.id !== id) {
    r.innerHTML = shellHtml(`<p class="muted">Loading…</p>`);
    r.querySelectorAll("[data-x]").forEach((el) => el.onclick = dismissDrawer);
  }
  let detail;
  let capacity;
  try {
    ({ detail, capacity } = await api(`/api/leads/${encodeURIComponent(id)}`));
  } catch (err) {
    if (ask !== drawerAsk) return;
    r.innerHTML = shellHtml(`<p class="error" style="margin:0">${esc(err.message)}</p>`);
    r.querySelectorAll("[data-x]").forEach((el) => el.onclick = dismissDrawer);
    return;
  }
  if (ask !== drawerAsk) return; // closed, or another lead opened meanwhile
  if (capacity) state.capacity = capacity; // the newest room, for anything else that reads it
  showDrawer(r, id, detail, capacity, ask);
}

function showDrawer(r, id, detail, capacity, ask) {
  r.innerHTML = drawerHtml(detail, { capacity: capacity ?? null, sender: "Nik", origin: location.origin, now: new Date() });
  r.querySelectorAll("[data-x]").forEach((el) => el.onclick = dismissDrawer);
  bindWriteEmail(r, id, ask);
  if (hasFirstEmail(detail.messages)) showEmail(r, id, ask);
  const fit = r.querySelector("[data-not-a-fit]");
  if (fit) fit.onclick = () => notAFit(id, detail.lead?.name);
  bindPreview(r);
  bindNotes(r, id);
  const slot = r.querySelector("#d-research");
  if (slot) wireResearch(slot, id, { research: detail.research ?? null, waiting: detail.research_waiting });
  loadDemoCard(r, id, ask);
  loadCallBox(r, id, ask);
}

// Stage 8's call box in the #d-call slot (call.js renderCallBox: Booked + Cancel, or Book a call), loaded on first
// use and drawn only if this panel is still the one open. renderCallBox shows its own request's errors.
function loadCallBox(r, id, ask) {
  import("./call.js")
    .then((m) => {
      const slot = r.querySelector("#d-call");
      if (ask === drawerAsk && slot?.isConnected) return m.renderCallBox(slot, id);
    })
    .catch((err) => {
      if (ask === drawerAsk) toast(`Couldn't load the call box (${reasonOf(err)}). Close this lead and open it again.`);
    });
}

// Stage 4's Demo site card in the #d-demo slot: its own request (GET /api/demo/lead/:id: the link, views, expiry, or
// why there's no demo), drawn only if this panel is still the one open (not closed, another lead, or redrawn).
async function loadDemoCard(r, id, ask) {
  const slot = r.querySelector("#d-demo");
  if (!slot) return;
  let info;
  try {
    info = await api(`/api/demo/lead/${encodeURIComponent(id)}`);
  } catch (err) {
    if (ask === drawerAsk && slot.isConnected) slot.innerHTML = demoCardErrorHtml(err.message);
    return;
  }
  if (ask !== drawerAsk || !slot.isConnected) return;
  slot.innerHTML = demoCardHtml(info);
  bindCopyLinks(slot, toast);
}

// Stage 6's email slot: public/js/compose.js's mountEmail draws the composer or the thread in #d-email (loaded on
// first use). Write first email opens it and scrolls to it; a lead whose first email is queued, sending, sent or failed
// gets it as the panel opens, so the thread shows without a click (stage 3's read-only Conversation, right after the
// slot, steps aside once the slot has content: style.css). If it can't load, the slot stays empty, the Conversation
// shows, and a toast says why.
const FIRST_SHOWN = new Set(["queued", "sending", "sent", "failed"]);
const hasFirstEmail = (messages) => Array.isArray(messages)
  && messages.some((m) => m !== null && typeof m === "object" && m.kind === "first" && FIRST_SHOWN.has(m.status));
const reasonOf = (err) => String(err?.message || err).replace(/[.\s]+$/, "");

/** compose.js mounted in this panel's #d-email → the slot, or null when the panel has moved on meanwhile. Throws when it can't load. */
async function mountEmailSlot(r, id, ask) {
  const compose = await import("./compose.js");
  const slot = r.querySelector("#d-email");
  if (ask !== drawerAsk || !slot?.isConnected) return null;
  if (typeof compose.mountEmail !== "function") {
    toast(NO_COMPOSER);
    return null;
  }
  await compose.mountEmail(slot, id);
  return ask === drawerAsk && slot.isConnected ? slot : null;
}

function bindWriteEmail(r, id, ask) {
  const btn = r.querySelector("[data-write-email]");
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const slot = await mountEmailSlot(r, id, ask);
      if (slot) slot.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (ask === drawerAsk) toast(`Couldn't open the email writer (${reasonOf(err)}). Close this lead and open it again.`);
    } finally {
      btn.disabled = false;
    }
  };
}

function showEmail(r, id, ask) {
  mountEmailSlot(r, id, ask).catch((err) => {
    if (ask === drawerAsk) toast(`Couldn't load the email thread (${reasonOf(err)}). Close this lead and open it again.`);
  });
}

// Preview: the frame waits in an inert <template> until pressed (leadview.js), then shows and hides.
function bindPreview(r) {
  const btn = r.querySelector("[data-preview-toggle]");
  const box = r.querySelector("[data-preview-box]");
  if (!btn || !box) return;
  btn.onclick = () => {
    const frame = r.querySelector("template[data-preview-frame]");
    if (!box.firstElementChild && frame) box.append(frame.content.cloneNode(true));
    box.hidden = !box.hidden;
    btn.setAttribute("aria-expanded", String(!box.hidden));
  };
}

// Notes save when you click away (PATCH {notes}).
function bindNotes(r, id) {
  const notes = r.querySelector("#d-notes");
  const saved = r.querySelector("#d-saved");
  if (!notes || !saved) return;
  notes.onchange = async () => {
    try {
      await api(`/api/leads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ notes: notes.value }) });
      saved.textContent = "Saved.";
      saved.classList.remove("error");
    } catch (err) {
      saved.textContent = `Not saved. ${err.message}`;
      saved.classList.add("error");
    }
  };
}

// After Not a fit or Research is wrong the lead leaves Ready to email: redraw the list when it's on screen.
const refreshList = () => { if (body()) loadList(); };

/** Not a fit: "Why isn't it a fit?" → POST /api/leads/:id/not-a-fit {reason}; a refusal shows in the dialog. */
function notAFit(id, name) {
  const d = modal(notAFitHtml(name));
  const form = d.querySelector("#fit-form");
  const send = d.querySelector("[data-fit-send]");
  const error = d.querySelector("[data-fit-error]");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const reason = notAFitReason(form.querySelector("input[name=fit]:checked")?.value ?? "", d.querySelector("#fit-text").value);
    send.disabled = true;
    error.hidden = true;
    try {
      await api(`/api/leads/${encodeURIComponent(id)}/not-a-fit`, { method: "POST", body: JSON.stringify({ reason }) });
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      send.disabled = false;
      return;
    }
    d.close();
    toast("Marked not a fit. It won't show in Ready to email.");
    refreshList();
    if (state.drawer === id) openLeadDrawer(id);
  };
}

// ---------------------------------------------------------------- Claude's research card (stage 2's researchcard.js)

/** Draw the card again (after Research is wrong) and wire it. */
function showResearch(slot, id, data) {
  slot.innerHTML = researchCard(data, { esc, safeUrl });
  wireResearch(slot, id, data);
}

/** Wire the card's buttons: Copy the opener, and Research is wrong → note box → Re-check / Cancel. */
function wireResearch(slot, id, data) {
  const opener = data.research?.opener || "";
  const copy = slot.querySelector("[data-copy-opener]");
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(opener); toast("Opener copied."); } catch { prompt("Copy the opener:", opener); }
  };
  const open = slot.querySelector("[data-recheck-open]");
  if (!open) return;
  const box = slot.querySelector("[data-recheck-box]");
  const note = slot.querySelector("[data-recheck-note]");
  const send = slot.querySelector("[data-recheck-send]");
  const error = slot.querySelector("[data-recheck-error]");
  const showError = (message) => { error.textContent = message; error.hidden = !message; };
  open.onclick = () => { open.hidden = true; box.hidden = false; note.focus(); };
  slot.querySelector("[data-recheck-cancel]").onclick = () => { box.hidden = true; open.hidden = false; showError(""); };
  send.onclick = async () => {
    send.disabled = true;
    showError("");
    const out = await postRecheck(id, note.value);
    if (!slot.isConnected) return;
    if (out.error) {
      showError(out.error);
      send.disabled = false;
      return;
    }
    toast(out.message);
    showResearch(slot, id, { ...data, research: recheckedResearch(data.research, note.value) });
    refreshList();
  };
}

/**
 * POST the note to "Research is wrong" → {message} (the route's toast) or {error} in plain English for under the box
 * (researchcard.js recheckAnswer). Its own fetch, not lib.js api(), so a dropped connection gets Part A's own words.
 */
async function postRecheck(id, note) {
  let resp;
  try {
    resp = await fetch(`/api/research/${encodeURIComponent(id)}/wrong`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }),
    });
  } catch {
    return { error: RECHECK_OFFLINE };
  }
  if (resp.status === 401) {
    location.href = "/login";
    return { error: "You've been logged out. Log in again, then press Re-check." };
  }
  return recheckAnswer(resp.status, await resp.json().catch(() => null));
}
