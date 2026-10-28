// The Todo page (#/ and #/todo, stage 11, docs/rebuild/11-todo-kpis.md Part A "Todo page"): the health lights, Today
// (Overdue, today, Coming up), the pipeline and the clients, all from one GET /api/todo, refreshed every 60 s while the
// page is open. The HTML comes from todoview.js (pure, tested in tests/todoview.test.mjs); this file wires it up:
//
// - Done / Dismiss: PATCH /api/todo/:id {status}. The row goes at once; if the call fails it comes back with a toast
//   "Couldn't update it: <error>".
// - Send: POST /api/todo/:id/send {body} with Claude's draft, or Nik's edit of it. The row goes at once; on success the
//   toast says "Sent. It's in the email thread.", on failure the row comes back and the toast shows stage 7's words.
// - Edit: the draft box becomes a <textarea> and Send becomes "Send edited". What he types survives the refresh, and
//   the refresh waits while he's typing.
// - The pipeline's columns are <details>: on a phone (640 px or less) they stack and Nik opens and closes them; wider,
//   they sit side by side, always open.
//
// The router calls stopTodoPoll() on every route change. After each load and each Done/Dismiss/Send the page fires
// "aetos:todo-counts" on window with {due, red} (overdue + today's items, red lights), for the nav badge.
import { api, esc, pageHead, toast, view } from "./lib.js";
import { clientsHtml, lightsHtml, pipelineHtml, todoListHtml } from "./todoview.js";

const POLL_MS = 60000;
const SENT = "Sent. It's in the email thread.";
const WIDE = matchMedia("(min-width: 641px)");

let poll = null;
let ask = 0; // the newest load: a slow answer never replaces a newer one
let visit = 0; // the newest todoPage(): an older one whose first load ends late never starts a second timer
let openedHash = "";
const page = {
  board: null,
  hidden: new Set(), // ids Nik has ticked, dismissed or sent: never shown again on this visit
  edits: new Map(), // id → the words in an open Edit box
  open: new Map(), // data-key → open, for the <details> Nik has opened or closed himself
};

/** True for the hashes that are the Todo page: "", "#", "#/", "#/todo" (with or without a ?query). */
export function isTodoHash(hash) {
  const h = String(hash ?? "").replace(/^\/?#?\/?/, "").split("?")[0];
  return h === "" || h === "todo";
}

/** Stops the 60 s refresh (the router calls it on every route change; todoPage starts it again). */
export function stopTodoPoll() {
  if (poll !== null) clearInterval(poll);
  poll = null;
}

const body = () => document.getElementById("todo-body");

// An error's words without our own prefix, so "Couldn't update it: <error>" reads once. `trim` also drops a trailing
// full stop, for a sentence that goes on after it ("…: <error>. Refresh the page").
function reason(err, prefix = "", trim = false) {
  if (err instanceof TypeError) return "the Control Room didn't answer (check your internet connection)";
  let text = String(err?.message ?? err ?? "").trim();
  if (prefix && text.toLowerCase().startsWith(prefix.toLowerCase())) text = text.slice(prefix.length).trim();
  if (trim) text = text.replace(/[.\s]+$/, "");
  return text || "unknown error";
}

/** The Todo page: everything from one GET /api/todo, then a refresh every 60 s while the page is open. */
export async function todoPage() {
  stopTodoPoll();
  const mine = ++visit;
  openedHash = location.hash;
  page.board = null;
  page.hidden.clear();
  page.edits.clear();
  page.open.clear();
  view.innerHTML = `${pageHead("Todo")}<div id="todo-body"><p class="muted">Loading your Todo list…</p></div>`;
  bind(body());
  await load(false);
  if (mine !== visit || !body()) return; // Nik left, or opened Todo again, while it loaded
  stopTodoPoll();
  poll = setInterval(refresh, POLL_MS);
}

// While the Todo page is the one open. Hidden tabs and a draft being typed wait for the next round.
function refresh() {
  if (!body() || !(isTodoHash(location.hash) || location.hash === openedHash)) {
    stopTodoPoll();
    return;
  }
  if (document.hidden) return;
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA" && body().contains(active)) return;
  load(true);
}

async function load(quiet) {
  const mine = ++ask;
  let board;
  try {
    board = await api("/api/todo");
  } catch (err) {
    const el = body();
    // A failed refresh keeps the board that's showing; the next round tries again.
    if (mine !== ask || !el || (quiet && page.board)) return;
    el.innerHTML = `<p class="error">${esc(`Couldn't load your Todo list: ${reason(err, "Couldn't load your Todo list:", true)}. Refresh the page; if it keeps happening, open`)} <a href="/#/setup">Setup</a>.</p>`;
    return;
  }
  if (mine !== ask || !body()) return;
  page.board = board;
  render();
}

// ---------------------------------------------------------------- drawing

const groupsOf = (b) => (b && typeof b.today === "object" && b.today) || {};
const shown = (list) => (Array.isArray(list) ? list.filter((t) => t && !page.hidden.has(String(t.id))) : []);

function visibleToday() {
  const g = groupsOf(page.board);
  return { overdue: shown(g.overdue), today: shown(g.today), later: shown(g.later) };
}

function findItem(id) {
  const g = groupsOf(page.board);
  return [...(g.overdue || []), ...(g.today || []), ...(g.later || [])].find((t) => t && String(t.id) === id) || null;
}

function render() {
  const el = body();
  const b = page.board;
  if (!el || !b) return;
  // The 60 s refresh redraws everything: keep where Nik had scrolled the board sideways.
  const scrolled = el.querySelector(".board")?.scrollLeft ?? 0;
  el.innerHTML = `${lightsHtml(b.health, b.health_error)}
    <div class="section-title"><h2>Today</h2></div>
    <div id="todo-today">${todoListHtml(visibleToday())}</div>
    <div class="section-title"><h2>Pipeline</h2></div>
    <div id="todo-pipeline">${pipelineHtml(b.pipeline)}</div>
    <div class="section-title"><h2>Clients</h2></div>
    <div id="todo-clients">${clientsHtml(b.clients)}</div>`;
  restore(el);
  const board = el.querySelector(".board");
  if (board && scrolled) board.scrollLeft = scrolled;
  sendCounts();
}

function renderToday() {
  const el = document.getElementById("todo-today");
  if (!el) return;
  el.innerHTML = todoListHtml(visibleToday());
  restore(el);
  sendCounts();
}

// Puts back what Nik opened, closed or was typing, and keeps the columns open on a wide screen.
function restore(root) {
  root.querySelectorAll("details[data-key]").forEach((d) => {
    if (page.open.has(d.dataset.key)) d.open = page.open.get(d.dataset.key);
  });
  if (WIDE.matches) openColumns(root);
  for (const [id, text] of page.edits) {
    const row = [...root.querySelectorAll(".todo-item[data-todo]")].find((r) => r.dataset.todo === id);
    if (row) startEdit(row, text, false);
  }
}

function openColumns(root = body()) {
  root?.querySelectorAll(".board details.col").forEach((d) => { d.open = true; });
}
WIDE.addEventListener("change", () => { if (WIDE.matches) openColumns(); });

function sendCounts() {
  const today = visibleToday();
  const lights = Array.isArray(page.board?.health) ? page.board.health : [];
  const detail = { due: today.overdue.length + today.today.length, red: lights.filter((l) => l?.level === "red").length };
  window.dispatchEvent(new CustomEvent("aetos:todo-counts", { detail }));
}

// ---------------------------------------------------------------- buttons

function bind(el) {
  if (!el) return;
  el.addEventListener("click", (e) => {
    const summary = e.target.closest("summary");
    if (summary && el.contains(summary)) {
      const d = summary.parentElement;
      // Wide screens: the columns sit side by side and stay open.
      if (WIDE.matches && d.matches(".board details.col")) { e.preventDefault(); return; }
      if (d.dataset.key) page.open.set(d.dataset.key, !d.open);
      return;
    }
    const row = e.target.closest(".todo-item[data-todo]");
    if (!row) return;
    const status = e.target.closest("[data-status]");
    if (status) { setStatus(row, status.dataset.status); return; }
    if (e.target.closest("[data-send]")) { send(row); return; }
    if (e.target.closest("[data-edit]")) startEdit(row, null, true);
  });
  el.addEventListener("input", (e) => {
    if (!e.target.matches("textarea[data-draft-edit]")) return;
    const row = e.target.closest(".todo-item[data-todo]");
    if (row) page.edits.set(row.dataset.todo, e.target.value);
  });
}

// The draft box becomes a <textarea> (Claude's draft, or what Nik had typed) and Send becomes "Send edited".
function startEdit(row, text, focus) {
  const box = row.querySelector("[data-draft]");
  if (!box) return;
  const id = row.dataset.todo;
  const area = document.createElement("textarea");
  area.className = "draft-edit";
  area.dataset.draftEdit = "";
  area.rows = 7;
  area.setAttribute("aria-label", "Your reply");
  area.value = text ?? findItem(id)?.draft ?? box.textContent;
  box.replaceWith(area);
  row.querySelector("[data-edit]")?.remove();
  const sendBtn = row.querySelector("[data-send]");
  if (sendBtn) sendBtn.textContent = "Send edited";
  page.edits.set(id, area.value);
  if (focus) area.focus();
}

function forget(id) {
  const g = groupsOf(page.board);
  for (const key of ["overdue", "today", "later"]) {
    if (Array.isArray(g[key])) g[key] = g[key].filter((t) => !t || String(t.id) !== id);
  }
  page.edits.delete(id);
}

async function setStatus(row, status) {
  const id = row.dataset.todo;
  if (page.hidden.has(id)) return;
  page.hidden.add(id);
  renderToday();
  try {
    await api(`/api/todo/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
    forget(id);
  } catch (err) {
    page.hidden.delete(id);
    renderToday();
    toast(`Couldn't update it: ${reason(err, "Couldn't update it:")}`);
  }
}

async function send(row) {
  const id = row.dataset.todo;
  if (page.hidden.has(id)) return;
  const text = page.edits.has(id) ? page.edits.get(id) : (findItem(id)?.draft ?? "");
  page.hidden.add(id);
  renderToday();
  try {
    await api(`/api/todo/${encodeURIComponent(id)}/send`, { method: "POST", body: JSON.stringify({ body: text }) });
    forget(id);
    toast(SENT);
  } catch (err) {
    page.hidden.delete(id);
    renderToday();
    // Stage 7's plain-English error, as it comes ("Couldn't send: …", "Write something first", no mailbox, …).
    toast(err instanceof TypeError ? `Couldn't send: ${reason(err)}.` : String(err?.message || "Couldn't send. Try again."));
  }
}
