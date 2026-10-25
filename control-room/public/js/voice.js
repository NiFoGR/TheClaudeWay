// The Voice page (#/voice, nav "Voice") (stage 5–6, docs/rebuild/06-email-followups.md Part A §A7, Task 14).
//
// Follow-up emails (top): the banner (paused until all 9 are approved, green once they are), then one card per step:
// "Follow-up 3 · day 4", Draft / Approved 19 Oct, the wording in a box with its live word count ("38 / 60 words"),
// the checks of the saved wording in plain English, what a lead gets (the newest prospect with a demo, else the
// sample), Save (PUT /api/voice/followups/:step: any save makes it a Draft again) and Approve (POST …/approve with the
// text the card showed; off while the checks fail, while the box has changes that aren't saved, and once approved).
// Follow-ups use the wording at the moment each one is queued.
//
// Your style (below), read by the reply Routine (stage 7): the "How much is it?" card until Nik has written his own
// price answer (decision D-3, GET /api/voice's has_price_reply), the add form (Type: Example reply / Rule, When with
// suggestions, Text; POST /api/voice/examples), his examples and rules with Delete, then, collapsed, the first emails
// he has sent (each deletable: a deleted one stops being used as an example). DELETE /api/voice/examples/:id.
//
// The word count is the server's (functions/_lib/followups.js checkFollowup with mail/rules.js wordCount), done here
// too because the browser can't load functions/_lib: the words after the {greeting} line (every word when the first
// line isn't {greeting}), whitespace-separated, so {business} and {demo_link} are one each. tests/voice-ui.test.mjs
// checks the two agree, and that FOLLOWUP_DAYS still matches the server's.
//
// Every string from the server (the wording, its checks, the preview's business name, Nik's examples and the first
// emails he sent) goes through esc(). The renderers are pure and this file imports nothing that reads the page when it
// loads (html.js only), so tests/voice-ui.test.mjs runs them in node; voicePage() loads lib.js (api, pageHead, toast,
// view: it reads the page) the first time it's called.
import { esc } from "./html.js";

/** The days after the first email each follow-up goes (functions/_lib/followups.js FOLLOWUP_DAYS, copied as data). */
export const FOLLOWUP_DAYS = Object.freeze([1, 2, 4, 7, 10, 17, 24, 30, 60]);
/** The most words a follow-up may have after its {greeting} line (checkFollowup's limit). */
export const MAX_WORDS = 60;
const STEPS = FOLLOWUP_DAYS.length;

/** Save's toast (Part A §A7). */
export const SAVED = "Saved as a draft. Approve it to switch follow-ups back on.";
/** The "When" suggestions on the add form (Part A §A7). */
export const SUGGESTIONS = Object.freeze(["they ask the price", "send me more info", "can we have a call", "they say they're busy"]);
/** The situation of Nik's own price answer (decision D-3): what "Write it" fills in. */
export const PRICE_SITUATION = "they ask the price";
/** Nik has no examples or rules of his own yet. */
export const EMPTY = "No examples yet. Add how you'd answer the questions you get most.";

const ALL_ON = `All ${STEPS} approved. Follow-ups are on.`;
const TITLE = "Voice";
const SUB = "The 9 follow-ups that go after your first email, and your own replies and rules for Claude.";
const PRICE_ASK = "How much is it?";
const PRICE_LINE = "Claude answers from your price list until you add your own reply here.";
const STYLE_LINE = "Claude reads these before it writes a reply for you: it follows your rules, and copies your example replies closely when the situation matches.";
const FOOTER_LINE = 'Your name, "Aetos Websites" and the "no thanks" line go under it, as on your first email.';
const UNSAVED = "Changed, not saved yet. Save it to check it, then approve it.";
const PASSES = "Passes every check.";
const NO_PREVIEW = "No preview: fix the checks above.";
const SENT_LINE = "Claude reads these to write like you. Delete any you don't want copied.";
const KIND_LABELS = Object.freeze({ example: "Example reply", rule: "Rule" });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const textOf = (v) => (typeof v === "string" ? v : "");
const lf = (text) => textOf(text).replace(/\r\n?/g, "\n");
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const stepOf = (t) => (Number.isSafeInteger(t?.step) && t.step >= 1 && t.step <= STEPS ? t.step : null);

// ---------------------------------------------------------------- UK dates

const UK = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric" });

function ukDate(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    const p = Object.fromEntries(UK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
  } catch {
    return null; // outside the dates a Date can hold
  }
}

/** "19 Oct" (UK), with the year when it isn't this one ("19 Oct 2025"); "" when it can't be read. */
function ukDay(iso, now) {
  const p = ukDate(typeof iso === "string" && iso ? Date.parse(iso) : NaN);
  if (!p) return "";
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return `${p.d} ${MONTHS[p.m - 1]}${p.y === ukDate(at.getTime())?.y ? "" : ` ${p.y}`}`;
}

// ---------------------------------------------------------------- pure helpers (tested)

/**
 * A follow-up's words as checkFollowup counts them: after the first line when it's {greeting} (spaces after it are
 * fine), else every word; whitespace-separated, so {business} and {demo_link} are one each. Not text → 0.
 */
export function followupWords(body) {
  const text = lf(body);
  const firstBreak = text.indexOf("\n");
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const rest = /^\{greeting\}[^\S\n]*$/.test(firstLine) ? text.slice(firstLine.length) : text;
  const s = rest.trim();
  return s ? s.split(/\s+/).length : 0;
}

/** The live word count under a follow-up's box: "38 / 60 words". */
export const wordsLabel = (body) => `${followupWords(body)} / ${MAX_WORDS} words`;

/** How many of the templates are approved (at most 9). */
export function approvedCount(templates) {
  const list = Array.isArray(templates) ? templates.filter(isObj) : [];
  return Math.min(STEPS, list.filter((t) => t.status === "approved").length);
}

/**
 * The banner over the follow-ups: "Follow-ups are paused until you approve all 9 (6 of 9 approved)." while any is a
 * draft, "All 9 approved. Follow-ups are on." once they all are.
 */
export function voiceBanner(templates) {
  const n = approvedCount(templates);
  return n >= STEPS ? ALL_ON
    : `Follow-ups are paused until you approve all ${STEPS} (${n} of ${STEPS} approved).`;
}

/** The banner as the page shows it: yellow while follow-ups are paused, green once they're on. Hook: [data-voice-banner]. */
export function voiceBannerHtml(templates) {
  const on = approvedCount(templates) >= STEPS;
  return `<p class="banner ${on ? "ok" : "warn"}" data-voice-banner>${esc(voiceBanner(templates))}</p>`;
}

// ---------------------------------------------------------------- pure renderers (tested)

/** A step's status pill: Draft, or "Approved 19 Oct". */
function statusHtml(t, now) {
  if (t.status !== "approved") return `<span class="badge warn">Draft</span>`;
  const at = ukDay(t.approved_at, now);
  return `<span class="badge good">Approved${at ? ` ${esc(at)}` : ""}</span>`;
}

const issuesOf = (t) => (Array.isArray(t.issues) ? t.issues.filter((x) => typeof x === "string" && x.trim()) : []);

/** Whether Approve can go: the saved wording passes every check and isn't approved yet (the box unchanged). */
export const canApprove = (t) => isObj(t) && t.status !== "approved" && issuesOf(t).length === 0;

/**
 * One follow-up's card for a GET /api/voice template {step, day_offset, body, status, approved_at, issues, preview}:
 * "Follow-up 3 · day 4", Draft / "Approved 19 Oct", the wording in a box (an extra line break first: the HTML parser
 * drops one at the start of a textarea), "28 / 60 words" (red over the limit or when empty), the checks of the saved
 * wording (red lines, or "Passes every check."), what they'll see, Save (on once the box changes) and Approve (off
 * while the checks fail and once approved). opts.now: the clock for the approval date's year.
 * Hooks: [data-step=<n>], [data-body], [data-words], [data-unsaved], [data-save], [data-approve].
 */
export function followupCardHtml(template, { now = new Date() } = {}) {
  const t = isObj(template) ? template : {};
  const step = stepOf(t);
  if (!step) return "";
  const day = Number.isSafeInteger(t.day_offset) ? t.day_offset : FOLLOWUP_DAYS[step - 1];
  const body = lf(t.body);
  const words = followupWords(body);
  const issues = issuesOf(t);
  const preview = typeof t.preview === "string" ? t.preview : null;
  const checks = issues.length ? issues.map((i) => `<li class="bad">${esc(i)}</li>`).join("") : `<li class="ok">${esc(PASSES)}</li>`;
  return `<section class="card voice-card" data-step="${step}">
    <div class="card-head"><h2>Follow-up ${step} · day ${esc(day)}</h2>${statusHtml(t, now)}</div>
    <div class="grid-2">
      <div><label for="fu-${step}">The email</label>
        <textarea id="fu-${step}" rows="9" data-body>\n${esc(body)}</textarea>
        <p class="hint"><span data-words${words > MAX_WORDS || words === 0 ? ` class="bad-text"` : ""}>${esc(wordsLabel(body))}</span>
          <span data-unsaved hidden> · ${esc(UNSAVED)}</span></p>
        <ul class="checks">${checks}</ul></div>
      <div class="preview-mail"><h4>${esc("What they'll see")}</h4>${preview !== null
        ? `<pre class="msg-body">${esc(preview)}</pre><p class="hint">${esc(FOOTER_LINE)}</p>`
        : `<p class="muted">${esc(NO_PREVIEW)}</p>`}</div>
    </div>
    <div class="actions"><button type="button" class="btn secondary" data-save disabled>Save</button>
      <button type="button" class="btn" data-approve${canApprove(t) ? "" : " disabled"}>Approve</button></div>
  </section>`;
}

/** The follow-up emails: the banner, then the 9 cards in step order. */
export function followupsHtml(templates, { now = new Date() } = {}) {
  const list = listOf(templates).filter((t) => stepOf(t)).sort((a, b) => a.step - b.step);
  return `${voiceBannerHtml(list)}<div class="stack">${list.map((t) => followupCardHtml(t, { now })).join("")}</div>`;
}

const kindLabel = (kind) => (typeof kind === "string" && Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : "Example reply");

// One of Nik's examples or rules: what it is, when, Delete, and the text as plain text.
function exampleHtml(e) {
  const situation = str(e.situation);
  return `<div class="msg" data-example="${esc(textOf(e.id))}">
    <div class="msg-head"><span class="badge plain">${esc(kindLabel(e.kind))}</span>${situation ? ` <b>When ${esc(situation)}</b>` : ""}
      <button type="button" class="btn ghost sm" data-delete="${esc(textOf(e.id))}">Delete</button></div>
    <pre class="msg-body">${esc(textOf(e.body))}</pre>
  </div>`;
}

// One first email Nik sent: the day it went, Delete, and his words (the footer is already off).
function sentHtml(e, now) {
  const day = ukDay(e.created_at, now);
  return `<div class="msg" data-example="${esc(textOf(e.id))}">
    <div class="msg-head"><b>${esc(day ? `Sent ${day}` : "Sent")}</b>
      <button type="button" class="btn ghost sm" data-delete="${esc(textOf(e.id))}">Delete</button></div>
    <pre class="msg-body">${esc(textOf(e.body))}</pre>
  </div>`;
}

/**
 * "Your style" for GET /api/voice's examples [{id, kind, situation, body, source, created_at}] and has_price_reply:
 * the "How much is it?" card until he has his own price answer (Write it), the add form (Type, When with the
 * suggestions, Text, Add), his examples and rules with Delete (or the empty line), then, collapsed, "First emails
 * you've sent (12)" (source nik_sent), each with Delete. opts.now: the clock for the dates' year.
 * Hooks: [data-price-card], [data-write-price], form[data-add] with [data-kind], [data-when], [data-suggest], [data-text],
 * [data-add-error]; [data-delete=<id>].
 */
export function styleHtml(examples, hasPriceReply, { now = new Date() } = {}) {
  const list = listOf(examples);
  const own = list.filter((e) => e.source !== "nik_sent");
  const sent = list.filter((e) => e.source === "nik_sent");
  const price = hasPriceReply === true ? "" : `<section class="card voice-card highlight" data-price-card>
      <p><b>${esc(PRICE_ASK)}</b> ${esc(PRICE_LINE)}</p>
      <div class="actions"><button type="button" class="btn" data-write-price>Write it</button></div>
    </section>`;
  const form = `<section class="card voice-card">
      <div class="card-head"><h2>Add an example or a rule</h2></div>
      <form data-add novalidate>
        <div class="field-row">
          <div><label for="v-kind">Type</label><select id="v-kind" data-kind>
            <option value="example">${esc(KIND_LABELS.example)}</option><option value="rule">${esc(KIND_LABELS.rule)}</option></select></div>
          <div><label for="v-when">When</label><input id="v-when" type="text" autocomplete="off" data-when placeholder="e.g. they ask the price">
            <div class="quick">${SUGGESTIONS.map((s) => `<button type="button" class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>
        </div>
        <div><label for="v-text">Text</label><textarea id="v-text" rows="5" data-text placeholder="Write it the way you'd say it."></textarea></div>
        <p class="error" data-add-error hidden></p>
        <div class="actions"><button type="submit" class="btn">Add</button></div>
      </form>
    </section>`;
  const mine = own.length ? `<section class="card voice-card"><div class="thread">${own.map(exampleHtml).join("")}</div></section>`
    : `<div class="card empty-state"><p>${esc(EMPTY)}</p></div>`;
  const firsts = sent.length ? `<details class="card voice-card" data-sent>
      <summary>${esc(`First emails you've sent (${sent.length})`)}</summary>
      <p class="hint">${esc(SENT_LINE)}</p>
      <div class="thread">${sent.map((e) => sentHtml(e, now)).join("")}</div>
    </details>` : "";
  return `<p class="muted">${esc(STYLE_LINE)}</p><div class="stack">${price}${form}${mine}${firsts}</div>`;
}

/** Everything under the page title for a GET /api/voice answer: Follow-up emails, then Your style. */
export function voiceBodyHtml(data, { now = new Date() } = {}) {
  const d = isObj(data) ? data : {};
  return `<div class="section-title"><h2>Follow-up emails</h2></div>
    <div id="voice-followups">${followupsHtml(d.templates, { now })}</div>
    <div class="section-title"><h2>Your style</h2></div>
    <div id="voice-style">${styleHtml(d.examples, d.has_price_reply, { now })}</div>`;
}

// ---------------------------------------------------------------- the page itself (needs a page: lib.js)

let lib = null; // lib.js, loaded by the first voicePage()
let pageAsk = 0; // the newest load: an older answer is never drawn over a newer one or another page
let data = null; // the newest GET /api/voice answer, kept up to date as Nik saves, approves, adds and deletes

const byId = (id) => document.getElementById(id);

/** The Voice page (#/voice): title, then GET /api/voice's follow-ups and Nik's style. */
export async function voicePage() {
  lib ??= await import("./lib.js");
  const { pageHead, view } = lib;
  const ask = ++pageAsk;
  view.innerHTML = `${pageHead(TITLE, esc(SUB))}<div id="voice-body"><p class="muted">Loading your follow-ups and examples…</p></div>`;
  let answer;
  try {
    answer = await lib.api("/api/voice");
  } catch (err) {
    const el = byId("voice-body");
    if (ask === pageAsk && el) el.innerHTML = loadErrorHtml(err.message);
    return;
  }
  const el = byId("voice-body");
  if (ask !== pageAsk || !el) return;
  data = { templates: listOf(answer?.templates), examples: listOf(answer?.examples), has_price_reply: answer?.has_price_reply === true };
  el.innerHTML = voiceBodyHtml(data);
  el.querySelectorAll("[data-step]").forEach(bindCard);
  bindStyle();
}

const loadErrorHtml = (message) => `<p class="error">${esc(message)}</p>
  <p class="hint">Refresh the page to try again. <a href="#/setup">Setup</a> shows what's connected.</p>`;

// ---------------------------------------------------------------- follow-up cards

const templateOf = (step) => data?.templates.find((t) => t.step === step) ?? null;

// The server's newer copy of a step in `data`, its card drawn again (and bound), and the banner with it.
function showTemplate(template) {
  const step = stepOf(template);
  if (!step || !data) return;
  const at = data.templates.findIndex((t) => t.step === step);
  if (at === -1) data.templates.push(template);
  else data.templates[at] = template;
  const card = document.querySelector(`#voice-followups [data-step="${step}"]`);
  if (card) {
    card.outerHTML = followupCardHtml(template);
    const fresh = document.querySelector(`#voice-followups [data-step="${step}"]`);
    if (fresh) bindCard(fresh);
  }
  const banner = document.querySelector("#voice-followups [data-voice-banner]");
  if (banner) banner.outerHTML = voiceBannerHtml(data.templates);
}

function bindCard(card) {
  const step = Number(card.dataset.step);
  const box = card.querySelector("[data-body]");
  const words = card.querySelector("[data-words]");
  const unsaved = card.querySelector("[data-unsaved]");
  const save = card.querySelector("[data-save]");
  const approve = card.querySelector("[data-approve]");
  if (!box || !save || !approve) return;
  let busy = false;

  // The box against the saved wording: Save is on once it differs, Approve only while it doesn't.
  const refresh = () => {
    const saved = templateOf(step);
    const changed = !saved || lf(box.value) !== lf(saved.body);
    const n = followupWords(box.value);
    words.textContent = wordsLabel(box.value);
    words.classList.toggle("bad-text", n > MAX_WORDS || n === 0);
    unsaved.hidden = !changed;
    card.classList.toggle("changed", changed); // the checks and preview are the saved wording's: greyed (style.css)
    box.readOnly = busy; // what's typed while it saves would be drawn over
    save.disabled = busy || !changed;
    approve.disabled = busy || changed || !canApprove(saved);
  };
  box.oninput = refresh;

  save.onclick = async () => {
    if (save.disabled) return;
    busy = true;
    refresh();
    const ask = pageAsk;
    let out;
    try {
      out = await lib.api(`/api/voice/followups/${step}`, { method: "PUT", body: JSON.stringify({ body: box.value }) });
    } catch (err) {
      busy = false;
      if (card.isConnected) refresh();
      lib.toast(err.message);
      return;
    }
    lib.toast(SAVED);
    if (ask === pageAsk && isObj(out?.template)) return showTemplate(out.template);
    busy = false; // no template back (or another load since): the card is usable again, not stuck read-only
    if (card.isConnected) refresh();
  };

  approve.onclick = async () => {
    const saved = templateOf(step);
    if (approve.disabled || !saved) return;
    busy = true;
    refresh();
    const ask = pageAsk;
    let out;
    try {
      // The words the card showed: the server refuses (409) if they aren't the saved ones any more.
      out = await lib.api(`/api/voice/followups/${step}/approve`, { method: "POST", body: JSON.stringify({ body: saved.body }) });
    } catch (err) {
      busy = false;
      lib.toast(err.message);
      // A 400 carries the checks that failed: the card shows them (and Approve stays off).
      if (ask === pageAsk && Array.isArray(err.issues) && err.issues.length) showTemplate({ ...saved, issues: err.issues });
      else if (card.isConnected) refresh();
      return;
    }
    lib.toast(out?.all === true ? ALL_ON : `Follow-up ${step} approved (${Number(out?.approved) || 0} of ${STEPS}).`);
    if (ask === pageAsk && isObj(out?.template)) return showTemplate(out.template);
    busy = false;
    if (card.isConnected) refresh();
  };
}

// ---------------------------------------------------------------- your style

// Your style drawn again from `data` (the follow-up cards, and any changes in their boxes, are left alone). What's
// half-typed in the add form and an open "First emails you've sent" stay as they were, so deleting one of several
// doesn't wipe the form or fold the list away; after an add (clearForm) the form starts empty again.
function drawStyle({ clearForm = false } = {}) {
  const el = byId("voice-style");
  if (!el || !data) return;
  const keep = clearForm ? null : ["[data-kind]", "[data-when]", "[data-text]"].map((s) => el.querySelector(s)?.value);
  const open = el.querySelector("details[data-sent]")?.open === true;
  el.innerHTML = styleHtml(data.examples, data.has_price_reply);
  if (keep) ["[data-kind]", "[data-when]", "[data-text]"].forEach((s, i) => {
    const field = el.querySelector(s);
    if (field && typeof keep[i] === "string") field.value = keep[i];
  });
  const sent = el.querySelector("details[data-sent]");
  if (sent && open) sent.open = true;
  bindStyle();
}

// After an add or a delete: the examples and has_price_reply as the server now has them (it decides what counts as
// his price answer). If that read fails, the change already made locally stays.
async function reloadStyle(ask, opts) {
  try {
    const answer = await lib.api("/api/voice");
    if (ask !== pageAsk || !data) return;
    data.examples = listOf(answer?.examples);
    data.has_price_reply = answer?.has_price_reply === true;
  } catch {
    if (ask !== pageAsk) return;
  }
  drawStyle(opts);
}

function bindStyle() {
  const el = byId("voice-style");
  if (!el) return;
  const form = el.querySelector("form[data-add]");
  const kind = form?.querySelector("[data-kind]");
  const when = form?.querySelector("[data-when]");
  const text = form?.querySelector("[data-text]");
  const error = form?.querySelector("[data-add-error]");
  if (!form || !kind || !when || !text || !error) return;

  el.querySelectorAll("[data-suggest]").forEach((chip) => chip.onclick = () => {
    when.value = chip.dataset.suggest;
    text.focus();
  });
  const writePrice = el.querySelector("[data-write-price]");
  if (writePrice) writePrice.onclick = () => {
    kind.value = "example";
    when.value = PRICE_SITUATION;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    text.focus({ preventScroll: true });
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector("[type=submit]");
    if (button.disabled) return;
    button.disabled = true;
    error.hidden = true;
    const ask = pageAsk;
    let out;
    try {
      out = await lib.api("/api/voice/examples", {
        method: "POST", body: JSON.stringify({ kind: kind.value, situation: when.value, body: text.value }),
      });
    } catch (err) {
      button.disabled = false;
      error.textContent = err.message;
      error.hidden = false;
      return;
    }
    lib.toast("Added to your style.");
    if (data && isObj(out?.example)) data.examples.unshift(out.example);
    await reloadStyle(ask, { clearForm: true });
  };

  el.querySelectorAll("[data-delete]").forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.delete;
    if (!id || !confirm("Delete this? Claude stops using it.")) return;
    btn.disabled = true;
    const ask = pageAsk;
    try {
      await lib.api(`/api/voice/examples/${encodeURIComponent(id)}`, { method: "DELETE" });
      lib.toast("Deleted.");
      if (data) data.examples = data.examples.filter((x) => x.id !== id);
    } catch (err) {
      lib.toast(err.message); // e.g. already deleted in another tab: the list is read again below
    }
    await reloadStyle(ask);
  });
}
