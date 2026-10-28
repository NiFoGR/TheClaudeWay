// The call page (#/call/<id>) and the call box (the lead drawer's #d-call slot and the thread view's #thread-call),
// stage 8 (docs/rebuild/07-replies-calls.md Part A "Call page" and "Lead drawer", Part B Task 16).
//
// Call page: "Call Mark · Diamond Kickboxing", "Tuesday 20 October at 11am", the phone as a tap-to-call link, "Open the
// email thread", then the call script (stage 3's callScript, fed the call day's offer from GET /api/calls/<id>: the
// weekend deal on a Saturday call). Before the call: Cancel call (with an optional message box). After the slot time:
// How did it go? with Done (note box), No answer, They're ordering: send the order link (editable message), Not for
// them: each is POST /api/calls/<id> {action, note?, message?}.
// Call box: "Booked: Tuesday 20 October at 11am" + Cancel, or "Book a call:" the next 3 free slots, "or another time"
// (a UK date and time), phone, Book (GET /api/calls?place_id= and POST /api/calls {place_id, at, phone}).
//
// Lead names, labels and phones come from scraped data and inbound mail: every value goes through esc(), every link
// through safeUrl() or a fixed in-app form. The renderers are pure and this file imports nothing that reads the page
// when it loads (html.js, callscript.js, replies.js), so tests/call-page.test.mjs runs them in node; the entry points
// load lib.js (it reads the page) when first called.
import { callScript, shortName } from "./callscript.js";
import { esc, icon, safeUrl } from "./html.js";
import { threadIdFrom, ukInputToIso } from "./replies.js";

const NO_CALL = "That call isn't in the database.";
const PICK_TIME = "Couldn't book: pick a day and a time first.";
const NO_ORDER_LINK = "No order link yet: they don't have a demo site. Make their demo from their lead panel, then come back here.";
const NO_SLOTS = "No free call slots in the next 8 weeks.";
const NO_PHONE = "No phone number yet.";
const ORDER_INTRO = "Great speaking to you. Here's the link to get started:";
const CLOSED = {
  done: "This call is done.",
  no_show: "This call is marked as no answer.",
  cancelled: "This call was cancelled.",
};
const DONE_TOAST = {
  cancel: "Call cancelled.",
  done: "Saved: call done.",
  no_show: "Saved: no answer.",
  ordering: "Saved. The order link is on its way to them.",
  lost: "Saved: not for them.",
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());
// A first name as given; an all-capitals or all-lower-case one in title case (as callScript says it).
const firstName = (v) => {
  const s = str(v);
  return s && (s === s.toUpperCase() || s === s.toLowerCase()) ? titleCase(s) : s;
};
// "tel:07700900123": digits only (a leading + kept), or "" when there are none.
const telOf = (phone) => {
  const digits = String(phone ?? "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /\d/.test(digits) ? `tel:${digits}` : "";
};
const threadHref = (placeId) => `/#/replies/${encodeURIComponent(placeId)}`;
// The API's thread link when it's the app's own (/#/replies/<id>), else one built from the place_id, else "".
function threadLink(given, placeId) {
  const link = str(given);
  if (/^\/#\/replies\/[^\s"'<>`]+$/.test(link)) return link;
  return placeId ? threadHref(placeId) : "";
}
const textareaHtml = (attrs, value) => `<textarea ${attrs}>\n${esc(value)}</textarea>`;

/** #/call/<id> → the id (decoded), or null. */
export const callIdFrom = (hash) => threadIdFrom(hash);

/** Nik's message when they're ordering: the order link under a line of thanks (Part A's default, editable). */
export function orderMessage(orderLink) {
  const link = safeUrl(orderLink);
  return link ? `${ORDER_INTRO}\n\n${link}` : "";
}

// ---------------------------------------------------------------- the call page (pure)

function scriptHtml(data) {
  const lead = isObj(data.lead) ? data.lead : {};
  const call = isObj(data.call) ? data.call : {};
  const offer = isObj(data.offer) ? data.offer : null;
  const day = new Date(str(call.slot_at));
  let sections;
  try {
    sections = callScript(lead, {
      sender: str(data.sender) || "Nik",
      offer,
      guarantee: offer?.guarantee,
      today: Number.isNaN(day.getTime()) ? undefined : day,
    });
  } catch (err) {
    return `<div class="card"><h2>Call script</h2><p class="error">${esc(`Couldn't fill in the call script (${err?.message ?? err}). Refresh the page to try again.`)}</p></div>`;
  }
  const block = (s) => `<div class="script-sec"><h4>${esc(s.title)}</h4><ul>${s.lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  return `<details class="script" open><summary>${icon("phone")} Call script</summary>
      ${sections.filter((s) => !s.objection).map(block).join("")}
      <details class="script-obj"><summary>Objections and answers</summary>${sections.filter((s) => s.objection).map(block).join("")}</details>
    </details>`;
}

function beforeHtml(call) {
  return `<div class="card" data-call-actions>
    <div class="card-head"><h2>Before the call</h2></div>
    ${call.status === "offered" ? `<p class="muted">${esc("Offered to them, not confirmed yet.")}</p>` : ""}
    <div><label for="call-cancel-msg">${esc("A message to them (optional: leave it empty and they aren't told)")}</label>${textareaHtml('id="call-cancel-msg" rows="3" data-cancel-message', "")}</div>
    <div class="actions"><button class="btn danger" data-action="cancel">Cancel call</button></div>
    <p class="error" data-error hidden></p>
  </div>`;
}

function afterHtml(links) {
  const message = orderMessage(links?.order);
  const ordering = message
    ? `<div><label for="call-order-msg">${esc("Your message with the order link (edit it if you like)")}</label>${textareaHtml('id="call-order-msg" rows="4" data-order-message', message)}</div>
      <div class="actions"><button class="btn" data-action="ordering">They're ordering: send the order link</button></div>`
    : `<div class="actions"><button class="btn" disabled>They're ordering: send the order link</button></div>
      <p class="hint">${esc(NO_ORDER_LINK)}</p>`;
  return `<div class="card" data-call-actions>
    <div class="card-head"><h2>How did it go?</h2></div>
    <div><label for="call-note">${esc("Notes: what was said and agreed (optional)")}</label>${textareaHtml('id="call-note" rows="3" data-note', "")}</div>
    <div class="actions"><button class="btn" data-action="done">Done</button><button class="btn secondary" data-action="no_show">No answer</button><button class="btn danger" data-action="lost">Not for them</button></div>
    ${ordering}
    <p class="error" data-error hidden></p>
  </div>`;
}

function actionsHtml(call, afterSlot, links) {
  const status = str(call.status);
  if (Object.hasOwn(CLOSED, status)) {
    const note = str(call.note);
    return `<div class="card"><p>${esc(CLOSED[status])}</p>${note ? `<p class="muted">${esc(note)}</p>` : ""}</div>`;
  }
  if (status === "offered") {
    if (afterSlot) return `<div class="card"><p>${esc("This time was offered to them but never confirmed.")}</p></div>`;
    return beforeHtml(call);
  }
  if (status !== "confirmed") return "";
  return afterSlot ? afterHtml(links) : beforeHtml(call);
}

/**
 * The call page from GET /api/calls/<id> {call, label, lead, links, offer, thread_link, after_slot}: who and when,
 * tap to call, the email thread, the call script at the call day's prices, then Cancel call (before the slot) or
 * How did it go? (after it). Pure: every value through esc(), links only in safe forms.
 */
export function callPageHtml(data) {
  const d = isObj(data) ? data : {};
  const call = isObj(d.call) ? d.call : {};
  const lead = isObj(d.lead) ? d.lead : {};
  const business = shortName(lead.name);
  const first = firstName(lead.owner_first);
  const title = `Call ${[first, business].filter(Boolean).join(" · ") || "them"}`;
  const phone = str(call.phone) || str(lead.phone);
  const tel = telOf(phone);
  const thread = threadLink(d.thread_link, str(call.place_id) || str(lead.place_id));
  const facts = `<div class="card" data-call-facts>
      <p><b>${esc(str(d.label))}</b></p>
      <div class="actions">
        ${tel ? `<a class="btn" href="${esc(tel)}">${icon("phone")} ${esc(phone)}</a>` : `<span class="muted">${esc(NO_PHONE)}</span>`}
        ${thread ? `<a class="btn secondary" href="${esc(thread)}">Open the email thread</a>` : ""}
      </div>
    </div>`;
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(str(d.label))}</p></div></div>
    <div class="grid-main">
      <div class="stack">${facts}${scriptHtml(d)}</div>
      <div class="stack">${actionsHtml(call, d.after_slot === true, isObj(d.links) ? d.links : {})}</div>
    </div>`;
}

// ---------------------------------------------------------------- the call box (pure)

/**
 * The call box from GET /api/calls?place_id= {calls, free_slots, phone}: "Booked: <label>" + Cancel (and the call
 * page) when a call is confirmed, else "Book a call:" the next free slots, "or another time", phone, Book. A time
 * Claude has offered and they haven't confirmed shows above the booking form. `card` wraps it as a card. From the
 * booked call's time on (`now`), the box links to the call page's "How did it go?" instead of offering Cancel.
 */
export function callBoxHtml(data, placeId, { card = false, now = new Date() } = {}) {
  const d = isObj(data) ? data : {};
  const calls = listOf(d.calls);
  const booked = calls.find((c) => c.status === "confirmed");
  const head = `<h3>Call</h3>`;
  const wrap = (inner) => `<div class="${card ? "card " : ""}call-box" data-call-box data-place="${esc(str(placeId))}">${head}${inner}<p class="error" data-error hidden></p></div>`;
  if (booked) {
    const id = str(booked.id);
    const page = `#/call/${esc(encodeURIComponent(id))}`;
    // Once its time has come the call happened (or didn't): its outcome goes on the call page, never a Cancel here.
    const slot = new Date(str(booked.slot_at)).getTime();
    const at = now instanceof Date ? now.getTime() : NaN;
    if (Number.isFinite(slot) && Number.isFinite(at) && at >= slot) {
      return wrap(`<p>${esc(`Booked: ${str(booked.label)}`)}</p>
      <div class="actions"><a class="btn sm" href="${page}">How did it go? Open the call page</a></div>`);
    }
    return wrap(`<p>${esc(`Booked: ${str(booked.label)}`)}</p>
      <div class="actions"><a class="btn secondary sm" href="${page}">Open the call page</a><button type="button" class="btn danger sm" data-cancel="${esc(id)}" data-label="${esc(str(booked.label))}">Cancel</button></div>`);
  }
  const offered = calls.find((c) => c.status === "offered");
  const free = listOf(d.free_slots).filter((s) => str(s.slot_at));
  const slots = free.length
    ? `<label for="cb-slot">Book a call:</label><select id="cb-slot" data-slot>${free.map((s) => `<option value="${esc(str(s.slot_at))}">${esc(str(s.label) || str(s.slot_at))}</option>`).join("")}</select>`
    : `<p class="muted">Book a call: ${esc(NO_SLOTS)}</p>`;
  return wrap(`${offered ? `<p class="muted">${esc(`Offered: ${str(offered.label)} (waiting for them to confirm)`)}</p>` : ""}
    <form data-book-call>
      ${slots}
      <div class="field-row">
        <div><label for="cb-date">or another time</label><input id="cb-date" type="date" data-date></div>
        <div><label for="cb-time">Time (UK)</label><input id="cb-time" type="time" data-time></div>
        <div><label for="cb-phone">Their phone</label><input id="cb-phone" type="tel" data-phone value="${esc(str(d.phone))}"></div>
      </div>
      <div class="actions"><button class="btn sm" type="submit">Book</button></div>
    </form>`);
}

// ---------------------------------------------------------------- the page and the box (need a browser)

let lib = null; // ./lib.js, loaded on first use (it reads the page)
let pageAsk = 0; // the newest call page load: a slow answer never draws over the next page

function showError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

const post = (path, body) => lib.api(path, { method: "POST", body: JSON.stringify(body) });

/** #/call/<id>: the call page. */
export async function callPage(id) {
  lib ??= await import("./lib.js");
  const ask = ++pageAsk;
  const callId = str(id);
  lib.view.innerHTML = `${lib.pageHead("Call")}<div id="call-body"><p class="muted">Loading the call…</p></div>`;
  let data;
  try {
    if (!callId) throw new Error(NO_CALL);
    data = await lib.api(`/api/calls/${encodeURIComponent(callId)}`);
  } catch (err) {
    const el = document.getElementById("call-body");
    if (ask === pageAsk && el) el.innerHTML = `<p class="error">${esc(err.message)}</p><p class="hint"><a href="/#/">Back to Todo</a></p>`;
    return;
  }
  if (ask !== pageAsk || !document.getElementById("call-body")) return; // a newer load, or Nik has gone elsewhere
  lib.view.innerHTML = callPageHtml(data);
  bindActions(callId, ask);
}

function bindActions(callId, ask) {
  const box = lib.view.querySelector("[data-call-actions]");
  if (!box) return;
  const error = box.querySelector("[data-error]");
  const value = (sel) => box.querySelector(sel)?.value ?? "";
  const body = {
    cancel: () => ({ action: "cancel", message: value("[data-cancel-message]") }),
    done: () => ({ action: "done", note: value("[data-note]") }),
    no_show: () => ({ action: "no_show", note: value("[data-note]") }),
    ordering: () => ({ action: "ordering", note: value("[data-note]"), message: value("[data-order-message]") }),
    lost: () => ({ action: "lost", note: value("[data-note]") }),
  };
  box.querySelectorAll("[data-action]").forEach((button) => {
    const action = button.dataset.action;
    if (!Object.hasOwn(body, action)) return;
    button.onclick = async () => {
      if (error) error.hidden = true;
      if (action === "ordering" && !value("[data-order-message]").trim()) return showError(error, "Couldn't save: write something first.");
      const buttons = box.querySelectorAll("button[data-action]");
      buttons.forEach((b) => { b.disabled = true; });
      try {
        await post(`/api/calls/${encodeURIComponent(callId)}`, body[action]());
      } catch (err) {
        buttons.forEach((b) => { b.disabled = false; });
        showError(error, err.message);
        return;
      }
      lib.toast(DONE_TOAST[action]);
      if (ask === pageAsk && box.isConnected) callPage(callId);
    };
  });
}

/** The call box for one lead, drawn into `el` (the drawer's #d-call, the thread view's #thread-call). */
export async function renderCallBox(el, place_id) {
  if (!el) return;
  lib ??= await import("./lib.js");
  const placeId = str(place_id);
  if (!placeId) return;
  const card = !el.closest?.(".drawer");
  el.innerHTML = `<p class="muted">Loading calls…</p>`;
  let data;
  try {
    data = await lib.api(`/api/calls?place_id=${encodeURIComponent(placeId)}`);
  } catch (err) {
    if (el.isConnected) el.innerHTML = `<div class="${card ? "card " : ""}call-box"><h3>Call</h3><p class="error">${esc(err.message)}</p></div>`;
    return;
  }
  if (!el.isConnected) return;
  el.innerHTML = callBoxHtml(data, placeId, { card });
  bindBox(el, placeId);
}

function bindBox(el, placeId) {
  const error = el.querySelector("[data-error]");
  const again = () => { if (el.isConnected) renderCallBox(el, placeId); };

  const cancel = el.querySelector("[data-cancel]");
  if (cancel) cancel.onclick = async () => {
    const when = cancel.dataset.label || "this call";
    if (!confirm(`Cancel the call on ${when}? They aren't told: to send them a message, cancel it on the call page.`)) return;
    if (error) error.hidden = true;
    cancel.disabled = true;
    try {
      await post(`/api/calls/${encodeURIComponent(cancel.dataset.cancel)}`, { action: "cancel" });
    } catch (err) {
      cancel.disabled = false;
      showError(error, err.message);
      return;
    }
    lib.toast(DONE_TOAST.cancel);
    again();
  };

  const form = el.querySelector("form[data-book-call]");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (error) error.hidden = true;
    const date = form.querySelector("[data-date]")?.value ?? "";
    const time = form.querySelector("[data-time]")?.value ?? "";
    // Another time, when either box is filled in; else the slot picked in the list.
    const at = date || time ? ukInputToIso(date, time) : form.querySelector("[data-slot]")?.value || null;
    if (!at) return showError(error, PICK_TIME);
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    let out;
    try {
      out = await post("/api/calls", { place_id: placeId, at, phone: form.querySelector("[data-phone]")?.value ?? "" });
    } catch (err) {
      button.disabled = false;
      showError(error, err.message);
      return;
    }
    lib.toast([`Booked: ${str(out?.label) || "the call"}.`, str(out?.warning)].filter(Boolean).join(" "));
    again();
  };
}
