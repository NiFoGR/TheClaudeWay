// The lead drawer's Email slot (stage 5–6, docs/rebuild/06-email-followups.md Part A §A3 and §A8, Task 13). leads.js
// mounts it into stage 3's #d-email slot: Write first email calls mountEmail, and a lead whose first email is queued,
// sending, sent or failed gets it as soon as the panel opens. Stage 3's read-only Conversation, right after the slot,
// hides itself once the slot has content (style.css), so the thread here is the only copy of the messages.
//
// What it shows (GET /api/compose/:id and GET /api/thread/:id, fetched together):
// - the composer, while the prospect is `ready` and no first email is queued, sending or sent: To (a dropdown of the
//   lead's sourced addresses, the best one first), Subject, the body, the helpers (Why them, Claude's suggested opener
//   with Insert, Insert demo link), "What they'll see" (POST /api/compose/:id/preview, 300 ms after Nik stops typing:
//   the From line and the exact text), the checks (a green tick or a red line each) and Send (POST …/send), which stays
//   disabled until every check passes and while the preview or Send itself is on its way;
// - the thread, once there are messages: the summary line, then every message oldest first (You / Claude / System /
//   Them, what it is, its status), Cancel on a queued outgoing one (POST /api/messages/:id/cancel, after "Cancel this
//   email? It won't be sent.") and Try again on a failed first email (POST /api/messages/:id/retry). A first email that
//   didn't send shows both: the thread with Try again, and the composer to write a new one. A first email still
//   waiting while their demo isn't ready (the lead set aside after Send) has demoReady's reason in red above it.
//
// Every string from the server (Claude's research, scraped addresses and pages, inbound mail, errors) goes through
// esc(); every source link through safeUrl() (http(s) only, else no link). The renderers and helpers are pure and this
// file imports nothing that reads the page when it loads (html.js only), so tests/compose-ui.test.mjs runs them in
// node; mountEmail loads lib.js (api, toast, modal: it reads the page) the first time it's called.
import { esc, icon, safeUrl } from "./html.js";

const PREVIEW_WAIT_MS = 300; // the preview waits this long after the last key (Part A §A3)
const LABEL_EVERY_MS = 30000; // Send's label ("Send now" / "Send Mon 07:00") is redrawn this often while it's open
const SOON_MS = 5 * 60000; // due within this of now = "now": the tick sends every 5 minutes (it also covers a browser
// clock a little behind the server's)
const NEAR_MS = 6 * 86400000; // a time within this reads "Mon 07:00", one further off "Mon 9 Nov 07:00"
const BODY_LINES = 12; // longer bodies are collapsed after this many lines (Part A §A8)
// The cold window (functions/_lib/followups.js COLD_WINDOW, copied as data: tests/compose-ui.test.mjs checks the two
// still match): Mon–Sat 07:00–19:00 UK. A first email sent outside it waits for the next start, which is what Send's
// label and a queued email's status say.
export const COLD_WINDOW = Object.freeze({ start: "07:00", end: "19:00", days: Object.freeze([1, 2, 3, 4, 5, 6]) });

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BADGES = Object.freeze({ nik: "You", claude: "Claude", system: "System", them: "Them" });
const KINDS = Object.freeze({ first: "First email", reply: "Reply", system: "System email" });
const CLASS_LABELS = Object.freeze({
  bounce: "Bounced: the address doesn't work", auto: "Auto-reply", opt_out: "Asked not to be emailed",
});
// first-email.js's codes about where the lead is: with any of them there's no composer (the thread shows instead).
const STATE_CODES = new Set(["no_prospect", "already_emailed", "queued_already"]);
const LIVE_FIRST = new Set(["queued", "sending", "sent"]); // a first email like this one leaves no room for another

const CANCEL_ASK = "Cancel this email? It won't be sent.";
const FOLLOWUPS_NOTE = "Your follow-ups aren't approved yet, so this lead won't get any until you approve them on the";
const NOT_READY = "This lead isn't ready to email yet: it needs a grade, an email and a demo first.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const own = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const pad = (n) => String(n).padStart(2, "0");
const nowOf = (nowMs) => (Number.isFinite(nowMs) ? nowMs : Date.now());
const msOf = (iso) => (typeof iso === "string" && iso.trim() ? Date.parse(iso) : NaN);
// Text on one line (an error or a subject in a sentence).
const oneLine = (v) => str(v).replace(/\s+/g, " ");

// ---------------------------------------------------------------- UK times

const UK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  hourCycle: "h23",
});

/** The UK wall clock at `ms`: {y, m, d, hh, mm, weekday (0 = Sunday)}, or null when it can't be read. */
function ukOf(ms) {
  if (!Number.isFinite(ms)) return null;
  let parts;
  try {
    parts = Object.fromEntries(UK.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  } catch {
    return null; // outside the dates a Date can hold
  }
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  return { y, m, d, hh: Number(parts.hour) % 24, mm: Number(parts.minute), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const WINDOW_START = minutesOf(COLD_WINDOW.start);
const WINDOW_END = minutesOf(COLD_WINDOW.end);

function inWindow(ms) {
  const p = ukOf(ms);
  if (!p) return false;
  const at = p.hh * 60 + p.mm;
  return COLD_WINDOW.days.includes(p.weekday) && at >= WINDOW_START && at < WINDOW_END;
}

/** When the cold window next opens after `ms` (outside it): "Mon 07:00". */
function nextStartLabel(ms) {
  const p = ukOf(ms);
  if (!p) return COLD_WINDOW.start;
  let day = p.weekday;
  if (!(COLD_WINDOW.days.includes(day) && p.hh * 60 + p.mm < WINDOW_START)) {
    do day = (day + 1) % 7; while (!COLD_WINDOW.days.includes(day));
  }
  return `${WEEKDAYS[day]} ${COLD_WINDOW.start}`;
}

/** "Mon 07:00" for a time in the next 6 days, else "Mon 9 Nov 07:00"; "" when it can't be read. */
function whenLabel(ms, nowMs) {
  const p = ukOf(ms);
  if (!p) return "";
  const time = `${pad(p.hh)}:${pad(p.mm)}`;
  if (ms - nowMs < NEAR_MS) return `${WEEKDAYS[p.weekday]} ${time}`;
  return `${WEEKDAYS[p.weekday]} ${p.d} ${MONTHS[p.m - 1]} ${time}`;
}

/** "22 Oct 09:15" (with the year when it isn't this one: "30 Dec 2025 10:00"); "" when it can't be read. */
function dayTime(iso, nowMs) {
  const p = ukOf(msOf(iso));
  if (!p) return "";
  const year = p.y === ukOf(nowMs)?.y ? "" : ` ${p.y}`;
  return `${p.d} ${MONTHS[p.m - 1]}${year} ${pad(p.hh)}:${pad(p.mm)}`;
}

// When an email due at `due` (ms, NaN = unknown) actually goes, as of `nowMs`: null for "now" (due within the next 5
// minutes, and the window is open), else "Mon 07:00" (its own time when that's later, or the window's next start).
function goesAt(due, nowMs) {
  if (Number.isFinite(due) && due > nowMs + SOON_MS) return whenLabel(due, nowMs) || nextStartLabel(nowMs);
  return inWindow(nowMs) ? null : nextStartLabel(nowMs);
}

// ---------------------------------------------------------------- pure helpers (tested)

/**
 * `snippet` put into `text` at `cursor` (clamped to the text; no cursor = the end) → {text, cursor}, the cursor just
 * after what was put in. Insert and Insert demo link use it on the body.
 */
export function insertAt(text, cursor, snippet) {
  const s = typeof text === "string" ? text : "";
  const add = typeof snippet === "string" ? snippet : "";
  const at = Number.isFinite(cursor) ? Math.min(Math.max(Math.trunc(cursor), 0), s.length) : s.length;
  return { text: s.slice(0, at) + add + s.slice(at), cursor: at + add.length };
}

/**
 * Send's label: "Send now" inside the cold window, else "Send Mon 07:00" (the next window start). `dueAtIso` is
 * composeContext's due_at (when it would go when the composer loaded); `nowMs` the time now, so a composer left open
 * past 19:00 says when it will really go.
 */
export function sendLabel(dueAtIso, nowMs) {
  const at = goesAt(msOf(dueAtIso), nowOf(nowMs));
  return at ? `Send ${at}` : "Send now";
}

/** The toast after Send or Try again, for the due_at it answered with. */
export function queuedToast(dueAtIso, nowMs) {
  const at = goesAt(msOf(dueAtIso), nowOf(nowMs));
  return at ? `Queued for ${at}.` : "Queued. It goes out within 5 minutes.";
}

/**
 * A message's status in Part A §A8's words: "Goes out Mon 07:00" / "Going out in a few minutes" (queued), "Sending…",
 * "Sent 22 Oct 09:15", "Didn't send: <error>", "Cancelled", "Received 23 Oct 14:02"; an inbound one with a class says
 * what it was instead: "Bounced: the address doesn't work", "Auto-reply", "Asked not to be emailed".
 */
export function statusLine(message, nowMs) {
  const m = isObj(message) ? message : {};
  const now = nowOf(nowMs);
  if (m.direction === "in" || m.status === "received") {
    const label = own(CLASS_LABELS, m.class);
    if (label) return label;
    const when = dayTime(m.received_at, now);
    return when ? `Received ${when}` : "Received";
  }
  switch (m.status) {
    case "queued": {
      const at = goesAt(msOf(m.due_at), now);
      return at ? `Goes out ${at}` : "Going out in a few minutes";
    }
    case "sending":
      return "Sending…";
    case "sent": {
      const when = dayTime(m.sent_at, now);
      return when ? `Sent ${when}` : "Sent";
    }
    case "failed": {
      const error = oneLine(m.error);
      return error ? `Didn't send: ${error}` : "Didn't send";
    }
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

/** Who wrote it: "You" (nik), "Claude", "System" (system, and anything unknown) or "Them". */
export const badge = (author) => own(BADGES, author) ?? "System";

// ---------------------------------------------------------------- pure renderers (tested)

// The composer, unless the lead isn't `ready` or a first email is already waiting or has gone.
const canCompose = (ctx) => ctx.stage === "ready" && !listOf(ctx.blocking).some((i) => STATE_CODES.has(i.code));

const sourceLink = (url, text) => {
  const href = safeUrl(url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : "";
};

// The To options with a real address, the best one first (as composeContext sends them).
const toOptions = (ctx) => listOf(ctx.to_options).filter((o) => str(o.email));
const optionText = (o) => [str(o.email), o.best === true ? "best" : "", str(o.where)].filter(Boolean).join(" · ");

/** Where the chosen address was found: "Found: Contact page · see where" (the link only when it's http(s)). */
function whereHtml(option) {
  if (!isObj(option)) return "";
  const where = str(option.where);
  const link = sourceLink(option.source_url, where ? "see where" : "Where it was found");
  return [where ? `Found: ${esc(where)}` : "", link].filter(Boolean).join(" · ");
}

function helpersHtml(ctx) {
  const facts = listOf(ctx.angle).filter((a) => str(a.fact));
  const opener = str(ctx.opener);
  const why = facts.length ? `<div><h4>Why them</h4><ul>${facts.map((a) => {
    const link = sourceLink(a.source_url, "source");
    return `<li>${esc(a.fact)}${link ? ` ${link}` : ""}</li>`;
  }).join("")}</ul></div>` : "";
  const suggest = opener ? `<div><h4>${esc("Claude's suggested opener")}</h4><pre class="msg-body">${esc(opener)}</pre>
      <div class="actions"><button type="button" class="btn secondary sm" data-insert-opener>Insert</button></div></div>` : "";
  return `<div class="compose-help">${why}${suggest}
    <div class="actions"><button type="button" class="btn secondary sm" data-insert-demo>Insert demo link</button></div></div>`;
}

/**
 * The composer for composeContext's answer `ctx` (Part A §A3): the yellow note while the 9 follow-ups aren't all
 * approved, To, Subject, the helpers, the body, "What they'll see" and the checks (filled by the preview) and Send
 * (disabled until the first preview passes; its label as of `nowMs`). Hooks: [data-compose], [data-to],
 * [data-to-where], [data-subject], [data-body], [data-insert-opener], [data-insert-demo], [data-preview], [data-checks],
 * [data-send].
 */
export function composerHtml(ctx, nowMs) {
  const c = isObj(ctx) ? ctx : {};
  const options = toOptions(c);
  const chosen = options.find((o) => o.best === true) ?? options[0] ?? null;
  const greeting = str(c.greeting?.line) || "Hi,";
  const select = options.length
    ? options.map((o) => `<option value="${esc(str(o.email))}"${o === chosen ? " selected" : ""}>${esc(optionText(o))}</option>`).join("")
    : `<option value="" selected>No address found for them</option>`;
  const note = c.followups_approved === true ? ""
    : `<p class="banner warn">${esc(FOLLOWUPS_NOTE)} <a href="#/voice">Voice page</a>.</p>`;
  return `<div class="compose" data-compose>
    ${note}
    <div><label for="c-to">To</label><select id="c-to" data-to${options.length ? "" : " disabled"}>${select}</select>
      <p class="hint" data-to-where>${whereHtml(chosen)}</p></div>
    <div><label for="c-subject">Subject</label>
      <input id="c-subject" type="text" autocomplete="off" data-subject placeholder="Short and plain, e.g. Your website"></div>
    ${helpersHtml(c)}
    <div><label for="c-body">Your email</label>
      <textarea id="c-body" rows="10" data-body placeholder="${esc(`Write it your way. '${greeting}' and your sign-off are added for you.`)}"></textarea></div>
    <div class="preview-mail" data-preview><p class="muted">Checking your email…</p></div>
    <ul class="checks" data-checks></ul>
    <div class="actions"><button type="button" class="btn" data-send disabled>${esc(sendLabel(c.due_at, nowMs))}</button></div>
  </div>`;
}

/** "What they'll see": From, To, Subject, then the exact text, from the preview's {text, from} and the fields sent. */
export function previewHtml(out, fields) {
  const o = isObj(out) ? out : {};
  const f = isObj(fields) ? fields : {};
  const from = oneLine(o.from) || "No mailbox can send it yet";
  return `<h4>${esc("What they'll see")}</h4>
    <div class="sub-line">From: ${esc(from)}</div>
    <div class="sub-line">To: ${esc(oneLine(f.to) || "Pick an address")}</div>
    <div class="msg-subject">Subject: ${esc(oneLine(f.subject))}</div>
    <pre class="msg-body">${esc(typeof o.text === "string" ? o.text : "")}</pre>`;
}

// The checks, in Send's order: each a green tick when none of its codes is in the issues, else its red lines. One
// marked needsBody is only checked once there's an email (with none, only "Write the email first." shows for it).
const CHECKS = [
  { codes: ["subject_missing", "subject_re"], ok: () => "Subject added" },
  { codes: ["body_missing"], ok: () => "Email written" },
  { codes: ["greeting"], needsBody: true, ok: ({ greeting }) => `No greeting of yours: "${greeting}" is added for you` },
  { codes: ["demo_missing", "demo_twice"], needsBody: true, ok: () => "Demo link in once" },
  { codes: ["other_link"], needsBody: true, ok: () => "No other links" },
  { codes: ["seo"], ok: () => 'No "SEO"' },
  { codes: ["too_long"], needsBody: true, ok: () => "Under 150 words" },
  { codes: ["placeholder"], ok: () => "Nothing left to fill in" },
  { codes: ["not_in_list", "suppressed", "shared_address"], ok: ({ to }) => (to ? `${to} is one of their addresses and OK to email` : "") },
  { codes: ["demo_not_ready"], ok: () => "Their demo is ready" },
  { codes: ["no_mailbox", "warming_up", "no_room"], ok: () => "Room in your mailbox for it and its 9 follow-ups" },
];
const CHECKED = new Set(CHECKS.flatMap((c) => c.codes));

/**
 * The checks list for the preview's (or a refused Send's) issues [{code, message}]: a green tick for each check that
 * passes, the plain-English message of each that doesn't (red); codes with no tick of their own (where the lead is, no
 * sender name, …) are red lines too, the lead's state first. `ctx` gives the greeting line, `fields.to` the address.
 */
export function checksHtml(issues, ctx, fields) {
  const list = listOf(issues);
  const has = (code) => list.some((i) => i.code === code);
  const vars = { greeting: str(ctx?.greeting?.line) || "Hi,", to: oneLine(fields?.to) };
  const bad = (i) => `<li class="bad">${esc(str(i.message) || "Something isn't right: refresh the page and try again.")}</li>`;
  const out = list.filter((i) => STATE_CODES.has(i.code)).map(bad);
  const noBody = has("body_missing");
  for (const check of CHECKS) {
    const found = list.filter((i) => check.codes.includes(i.code));
    if (found.length) out.push(...found.map(bad));
    else if (!(check.needsBody && noBody)) {
      const line = check.ok(vars);
      if (line) out.push(`<li class="ok">${esc(line)}</li>`);
    }
  }
  out.push(...list.filter((i) => !STATE_CODES.has(i.code) && !CHECKED.has(i.code)).map(bad));
  return out.join("");
}

// A body as plain text, collapsed after 12 lines: the first 12 and "…", Show all, and the whole text (hidden).
function bodyHtml(body) {
  const text = typeof body === "string" ? body : "";
  const lines = text.split("\n");
  if (lines.length <= BODY_LINES) return `<pre class="msg-body">${esc(text)}</pre>`;
  return `<pre class="msg-body">${esc(`${lines.slice(0, BODY_LINES).join("\n")}\n…`)}</pre>
    <button type="button" class="btn ghost sm" data-more>Show all ${lines.length} lines</button>
    <pre class="msg-body" hidden>${esc(text)}</pre>`;
}

function messageHtml(m, nowMs, retryId) {
  const inbound = m.direction === "in";
  const who = inbound ? "Them" : badge(m.author);
  const what = inbound ? "" : m.kind === "followup"
    ? `Follow-up${Number.isSafeInteger(m.step) ? ` ${m.step}` : ""}` : own(KINDS, m.kind) ?? "";
  const status = statusLine(m, nowMs);
  const failed = !inbound && m.status === "failed";
  // An inbound one labelled by its class keeps its time.
  const time = inbound && own(CLASS_LABELS, m.class) ? dayTime(m.received_at, nowMs) : "";
  const head = [`<span class="badge ${who.toLowerCase()}">${esc(who)}</span>${what ? ` <b>${esc(what)}</b>` : ""}`,
    failed ? "" : esc(status), esc(time)].filter(Boolean).join(" · ");
  const buttons = [];
  if (!inbound && m.status === "queued") buttons.push(`<button type="button" class="btn secondary sm" data-cancel="${esc(m.id)}">Cancel</button>`);
  if (retryId !== null && m.id === retryId) buttons.push(`<button type="button" class="btn sm" data-retry="${esc(m.id)}">Try again</button>`);
  return `<div class="msg ${inbound ? "in" : "out"}">
    <div class="msg-head">${head}</div>
    ${str(m.subject) ? `<div class="msg-subject">${esc(m.subject)}</div>` : ""}
    ${bodyHtml(m.body)}
    ${failed ? `<p class="error">${esc(status)}</p>` : ""}
    ${buttons.length ? `<div class="actions">${buttons.join("")}</div>` : ""}
  </div>`;
}

// The failed first email Try again goes on: the newest one, while the lead is ready and no first email of theirs is
// queued, sending or sent (the server checks all of it again). null when none.
function retryIdOf(messages, stage) {
  if (stage !== "ready") return null;
  const firsts = messages.filter((m) => m.direction !== "in" && m.kind === "first");
  if (firsts.some((m) => LIVE_FIRST.has(m.status))) return null;
  const failed = firsts.filter((m) => m.status === "failed");
  return failed.length ? failed[failed.length - 1].id ?? null : null;
}

/**
 * The thread for GET /api/thread's {summary, messages} (Part A §A8): the summary line, then every message oldest first
 * (badge, what it is, status, subject, the body as plain text), with Cancel on a queued outgoing one and Try again on
 * the failed first email (opts.stage = the prospect's; only `ready` gets it). Hooks: [data-more], [data-cancel=<id>],
 * [data-retry=<id>].
 */
export function threadBlockHtml(thread, nowMs, { stage = null } = {}) {
  const t = isObj(thread) ? thread : {};
  const now = nowOf(nowMs);
  const messages = listOf(t.messages);
  const summary = str(t.summary);
  const retryId = retryIdOf(messages, stage);
  return `${summary ? `<p class="banner info">${esc(summary)}</p>` : ""}${messages.length
    ? `<div class="thread">${messages.map((m) => messageHtml(m, now, retryId)).join("")}</div>`
    : `<p class="muted">Nothing sent yet.</p>`}`;
}

/**
 * The whole slot for composeContext's answer and the thread: the thread once there are messages (or the lead is past
 * `ready`), then the composer while it can take a first email; with neither, why not (blocking's first message).
 */
export function emailSlotHtml(ctx, thread, nowMs) {
  const c = isObj(ctx) ? ctx : {};
  const t = isObj(thread) ? thread : {};
  const blocking = listOf(c.blocking);
  const compose = canCompose(c);
  const showThread = listOf(t.messages).length > 0 || (!compose && typeof c.stage === "string" && c.stage !== "ready");
  const out = [];
  // Part A §A3 "Set aside after Send": a first email still waiting to go while their demo isn't ready (a later search
  // set the lead aside, say) says why in red above the thread (demoReady's "No demo yet: Excluded: <reason>"), so Nik
  // can cancel it there.
  if (!compose && blocking.some((i) => i.code === "queued_already")) {
    out.push(...blocking.filter((i) => i.code === "demo_not_ready" && str(i.message))
      .map((i) => `<p class="error" style="margin:0 0 10px">${esc(str(i.message))}</p>`));
  }
  if (showThread) out.push(threadBlockHtml(t, nowMs, { stage: c.stage ?? null }));
  if (compose) out.push(`${showThread ? `<h4 class="thread-head">Write a new one</h4>` : ""}${composerHtml(c, nowMs)}`);
  if (!out.length) out.push(`<p class="muted">${esc(str(blocking[0]?.message) || NOT_READY)}</p>`);
  return out.join("");
}

/** The Cancel dialog for a queued email of `kind` (Part A §A8): "Cancel this email? It won't be sent.", one true line on
 * what happens next, Keep it / Cancel the email. Hooks: [data-close], [data-cancel-yes], [data-cancel-error]. */
export function cancelDialogHtml(kind) {
  const after = kind === "first" ? "The lead stays ready to email, so you can write it again."
    : kind === "followup" ? "That follow-up is skipped and the next one is booked as normal." : "";
  return `<div class="modal-head"><h2>${esc(CANCEL_ASK)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-body">${after ? `<p class="muted" style="margin:0">${esc(after)}</p>` : ""}<p class="error" data-cancel-error hidden></p></div>
    <div class="modal-foot"><button type="button" class="btn secondary" data-close>Keep it</button>
      <button type="button" class="btn danger" data-cancel-yes>Cancel the email</button></div>`;
}

// ---------------------------------------------------------------- the page (needs lib.js)

let lib = null; // lib.js, loaded by the first mountEmail()
const mounts = new WeakMap(); // slot → its newest draw: an older answer is never drawn over a newer one

/**
 * Put the email part of lead `placeId`'s drawer into `el` (stage 3's #d-email slot): the composer while the lead is
 * `ready` and no first email is queued, sending or sent, the thread once there are messages. Called again while the
 * composer is open for the same lead, it leaves Nik's draft as it is. If the slot can't load, it's emptied (stage 3's
 * read-only Conversation shows again) and the error is thrown, in plain English, for leads.js to show.
 */
export async function mountEmail(el, placeId) {
  if (!el) return;
  const id = typeof placeId === "string" ? placeId : String(placeId ?? "");
  if (el.dataset.placeId === id && el.querySelector("[data-compose]")) return; // writing to them already
  await draw(el, id);
}

async function draw(el, id) {
  lib ??= await import("./lib.js");
  const ask = (mounts.get(el) ?? 0) + 1;
  mounts.set(el, ask);
  const live = () => mounts.get(el) === ask && el.isConnected;
  if (!el.firstElementChild) el.innerHTML = `<p class="muted">Loading…</p>`;
  const path = encodeURIComponent(id);
  let ctx;
  let thread;
  try {
    [ctx, thread] = await Promise.all([lib.api(`/api/compose/${path}`), lib.api(`/api/thread/${path}`)]);
  } catch (err) {
    if (!live()) return;
    el.innerHTML = "";
    delete el.dataset.placeId;
    throw err;
  }
  if (!live()) return;
  el.dataset.placeId = id;
  el.innerHTML = emailSlotHtml(ctx, thread, Date.now());
  bindThread(el, id, listOf(thread?.messages));
  if (canCompose(isObj(ctx) ? ctx : {})) bindComposer(el, id, ctx, live);
}

// Draw the slot again after Send, Cancel or Try again; a failure is a toast (the email itself is done or refused).
async function redraw(el, id) {
  if (!el.isConnected) return;
  try {
    await draw(el, id);
  } catch (err) {
    lib.toast(`Couldn't load the email thread (${String(err?.message || err).replace(/[.\s]+$/, "")}). Close this lead and open it again.`);
  }
}

function bindThread(el, id, messages) {
  el.querySelectorAll("[data-more]").forEach((btn) => btn.onclick = () => {
    const short = btn.previousElementSibling;
    const full = btn.nextElementSibling;
    if (short) short.hidden = true;
    if (full) full.hidden = false;
    btn.remove();
  });
  el.querySelectorAll("[data-cancel]").forEach((btn) => btn.onclick = () => {
    const m = messages.find((x) => x.id === btn.dataset.cancel);
    confirmCancel(el, id, btn.dataset.cancel, m?.kind);
  });
  el.querySelectorAll("[data-retry]").forEach((btn) => btn.onclick = () => retry(el, id, btn));
}

/** Cancel → "Cancel this email? It won't be sent." → POST /api/messages/:id/cancel; a refusal shows in the dialog. */
function confirmCancel(el, id, messageId, kind) {
  const d = lib.modal(cancelDialogHtml(kind));
  const yes = d.querySelector("[data-cancel-yes]");
  const error = d.querySelector("[data-cancel-error]");
  yes.onclick = async () => {
    yes.disabled = true;
    error.hidden = true;
    try {
      await lib.api(`/api/messages/${encodeURIComponent(messageId)}/cancel`, { method: "POST" });
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      yes.disabled = false;
      redraw(el, id); // it may have gone meanwhile: the thread shows what happened
      return;
    }
    d.close();
    lib.toast("Cancelled. It won't be sent.");
    redraw(el, id);
  };
}

/** Try again on a failed first email: POST /api/messages/:id/retry, then the thread with the new copy. */
async function retry(el, id, btn) {
  btn.disabled = true;
  let out;
  try {
    out = await lib.api(`/api/messages/${encodeURIComponent(btn.dataset.retry)}/retry`, { method: "POST" });
  } catch (err) {
    lib.toast(err.message);
    if (btn.isConnected) btn.disabled = false;
    return;
  }
  lib.toast(queuedToast(out?.due_at, Date.now()));
  redraw(el, id);
}

function bindComposer(el, id, ctx, live) {
  const box = el.querySelector("[data-compose]");
  if (!box) return;
  const to = box.querySelector("[data-to]");
  const where = box.querySelector("[data-to-where]");
  const subject = box.querySelector("[data-subject]");
  const body = box.querySelector("[data-body]");
  const preview = box.querySelector("[data-preview]");
  const checks = box.querySelector("[data-checks]");
  const send = box.querySelector("[data-send]");
  const path = encodeURIComponent(id);
  const options = toOptions(ctx);
  let timer = 0;
  let asked = 0; // the newest preview: an older answer is never drawn over it
  let passed = false; // the newest preview had no issues
  let sending = false;
  let moved = false; // a preview found the lead can't take a first email any more, and the slot was redrawn

  const fields = () => ({ to: to.value, subject: subject.value, body: body.value });
  const showSend = () => {
    send.disabled = !passed || sending;
    send.textContent = sendLabel(ctx.due_at, Date.now());
  };

  async function check() {
    if (!live()) return; // redrawn or closed since the key was pressed
    const mine = ++asked;
    const sent = fields();
    let out;
    try {
      out = await lib.api(`/api/compose/${path}/preview`, { method: "POST", body: JSON.stringify(sent) });
    } catch (err) {
      if (mine !== asked || !live()) return;
      checks.innerHTML = `<li class="bad">${esc(`Couldn't check your email: ${String(err?.message || err)}`)}</li>`;
      passed = false;
      showSend();
      return;
    }
    if (mine !== asked || !live()) return;
    const issues = listOf(out?.issues);
    // Another tab sent one (or the lead moved on) since this opened: show the thread instead, once.
    if (!moved && issues.some((i) => STATE_CODES.has(i.code))) {
      moved = true;
      redraw(el, id);
      return;
    }
    preview.innerHTML = previewHtml(out, sent);
    checks.innerHTML = checksHtml(issues, ctx, sent);
    passed = issues.length === 0;
    showSend();
  }

  // Any change: Send waits for the new preview, sent 300 ms after the last key.
  const changed = () => {
    clearTimeout(timer);
    asked++; // an answer for the old text no longer counts
    passed = false;
    showSend();
    timer = setTimeout(check, PREVIEW_WAIT_MS);
  };

  const insert = (snippet) => {
    const start = body.selectionStart ?? body.value.length;
    const end = body.selectionEnd ?? start;
    const out = insertAt(body.value.slice(0, start) + body.value.slice(end), start, snippet);
    body.value = out.text;
    body.focus();
    body.setSelectionRange(out.cursor, out.cursor);
    changed();
  };

  to.onchange = () => {
    where.innerHTML = whereHtml(options.find((o) => str(o.email) === to.value));
    changed();
  };
  subject.oninput = changed;
  body.oninput = changed;
  const opener = box.querySelector("[data-insert-opener]");
  if (opener) opener.onclick = () => insert(str(ctx.opener));
  box.querySelector("[data-insert-demo]").onclick = () => insert("{demo_link}");

  send.onclick = async () => {
    if (send.disabled) return;
    clearTimeout(timer);
    sending = true;
    showSend();
    let out;
    try {
      out = await lib.api(`/api/compose/${path}/send`, { method: "POST", body: JSON.stringify(fields()) });
    } catch (err) {
      sending = false;
      lib.toast(err.message);
      const issues = listOf(err.issues);
      if (issues.some((i) => STATE_CODES.has(i.code))) return redraw(el, id); // another tab sent one: show the thread
      if (!live()) return;
      if (issues.length) {
        checks.innerHTML = checksHtml(issues, ctx, fields());
        passed = false; // Send waits for an edit and a clean preview
      }
      showSend();
      return;
    }
    lib.toast(queuedToast(out?.due_at, Date.now()));
    redraw(el, id);
  };

  // Send's label follows the clock while the composer is open ("Send now" → "Send Mon 07:00" at 19:00).
  const clock = setInterval(() => {
    if (!live()) clearInterval(clock);
    else showSend();
  }, LABEL_EVERY_MS);

  check();
}
