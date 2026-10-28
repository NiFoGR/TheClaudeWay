// The Replies page (#/replies, nav "Replies") and one conversation (#/replies/<place_id>) (stage 7,
// docs/rebuild/07-replies-calls.md Part A "What Nik sees in the Control Room", Part B Task 15).
//
// Top line: "Claude replies: On" + Pause Claude's replies (or "Claude replies: Paused" + Turn Claude's replies back
// on; POST /api/replies {paused}), and "3 waiting · median reply time this week: 3 min · reply hours 7am–11:30pm".
// Needs you: the open escalation and call_time Todos as cards. An escalation shows their message and Claude's draft
// in a box, Send as me (POST /api/replies/send {message_id, body}) and Dismiss (POST /api/replies/dismiss {todo_id}).
// A call-time card has a date and a time (pre-filled with what they asked for when its title can be read, askedSlot),
// the phone (the lead's) and a message that fills itself in as "<Day> at <time> works. I'll ring you then. Thank
// you." until Nik edits it, then Book and send (POST /api/calls
// {place_id, at, phone, message, message_id}: the time is UK time, sent as UTC) and Dismiss.
// Conversations: the 50 most recent threads (GET /api/replies). Test it: Run the reply drill (POST /api/replies/drill;
// the result from GET /api/replies/drill) and Add my email as a test lead (POST /api/replies/test-prospect {email}).
// A thread: every message oldest first, labelled You / Claude / Them / Follow-up 3, UK time, the intent on theirs;
// Reply as me (answers their latest email) and the call box (renderCallBox from call.js, loaded when it's there).
//
// Inbound mail, Claude's words and scraped names are untrusted: every value goes through esc(). The renderers are pure
// and this file imports nothing that reads the page when it loads (html.js, leadview.js), so
// tests/replies-page.test.mjs runs them in node; the entry points load lib.js (it reads the page) when first called.
import { esc } from "./html.js";
import { STAGE_LABELS } from "./leadview.js";

/** The empty state of Conversations (Part A). */
export const EMPTY = "No replies yet. When someone writes back, Claude answers within minutes between 7am and 11:30pm, and it shows here.";
const WRITE_FIRST = "Couldn't save: write something first.";
const PICK_TIME = "Couldn't book: pick a day and a time first.";
const NO_EMAIL_TO_ANSWER = "Couldn't send: there's no email of theirs to answer here. Open the thread and reply from there.";
const HOURS = "reply hours 7am–11:30pm";
const TITLE = "Replies";
const SUB = "Every reply to your emails, what Claude said, and what needs you.";
const DRILL_STARTED = "Drill started: Claude answers the 14 test emails within about 10 minutes. Press Check the result then.";
const TEST_LEAD_ADDED = "Test lead added. Email your Aetos mailbox from that address and Claude answers within minutes (7am–11:30pm).";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STAGE_TONE = { won: "good", lost: "bad", replied: "gold", needs_nik: "warn", call_booked: "gold" };
const WHO_CLASS = { nik: "you", claude: "claude", system: "system" };
const STATUS_NOTE = { queued: "Waiting to go", sending: "Sending", failed: "Didn't send", cancelled: "Not sent" };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const textOf = (v) => (typeof v === "string" ? v : "");
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const own = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);
const threadHref = (placeId) => `#/replies/${encodeURIComponent(placeId)}`;

// ---------------------------------------------------------------- UK time

const UK_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const UK_SHOWN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** "21 Oct, 09:05" in UK time, or "" when it can't be read. */
export function ukTime(isoTime) {
  const d = typeof isoTime === "string" && isoTime ? new Date(isoTime) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(UK_SHOWN.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

// UK clock time at instant `ms`, read as if it were UTC, minus `ms`: the UK offset then (0 or 1 hour).
function ukOffset(ms) {
  const p = Object.fromEntries(UK_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(ms / 60000) * 60000;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::\d{2})?$/;

// {y, m, d, hh, mm} from a date input ("2026-10-22") and a time input ("15:00"), or null.
function readInputs(date, time) {
  const a = DATE_RE.exec(str(date));
  const b = TIME_RE.exec(str(time));
  if (!a || !b) return null;
  const [y, m, d, hh, mm] = [a[1], a[2], a[3], b[1], b[2]].map(Number);
  if (hh > 23 || mm > 59) return null;
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  return { y, m, d, hh, mm };
}

/** A UK date and time from the inputs ("2026-10-22", "15:00") as stored UTC ("2026-10-22T14:00:00Z"), or null. */
export function ukInputToIso(date, time) {
  const t = readInputs(date, time);
  if (!t) return null;
  const guess = Date.UTC(t.y, t.m - 1, t.d, t.hh, t.mm);
  let at = guess - ukOffset(guess);
  at = guess - ukOffset(at); // right on both sides of a clock change
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Nik's message on a call-time card: "Thursday at 3pm works. I'll ring you then. Thank you." ("" until both are picked). */
export function callTimeMessage(date, time) {
  const t = readInputs(date, time);
  if (!t) return "";
  const day = WEEKDAYS[new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay()];
  const hour = t.hh % 12 || 12;
  const clock = `${hour}${t.mm ? `:${String(t.mm).padStart(2, "0")}` : ""}${t.hh < 12 ? "am" : "pm"}`;
  return `${day} at ${clock} works. I'll ring you then. Thank you.`;
}

const DAY_RE = /\b(?:(mon)(?:day)?|(tue)(?:s|sday)?|(wed)(?:s|nesday)?|(thu)(?:r|rs|rsday)?|(fri)(?:day)?|(sat)(?:urday)?|(sun)(?:day)?)\b/;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pad2 = (n) => String(n).padStart(2, "0");

// The clock time in what they asked for ("3pm", "3:30 p.m.", "15:00", "noon") as "HH:MM", or "".
function askedClock(asked) {
  const t12 = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\b/.exec(asked);
  if (t12) {
    const h = Number(t12[1]);
    const mm = Number(t12[2] ?? 0);
    if (h < 1 || h > 12 || mm > 59) return "";
    return `${pad2((h % 12) + (t12[3] === "p" ? 12 : 0))}:${pad2(mm)}`;
  }
  const t24 = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(asked);
  if (t24) return `${pad2(Number(t24[1]))}:${t24[2]}`;
  return /\b(?:noon|midday)\b/.test(asked) ? "12:00" : "";
}

/**
 * The day and time a call-time Todo's title says they asked for ("… (they asked for Thu 3pm)"), as the card's date
 * and time inputs: {date: "2026-10-22" | "", time: "15:00" | ""}. A weekday is its next one in UK time from `now`
 * (today when the time is still ahead), "today"/"tomorrow" as said; anything it can't read is left "" for Nik to pick.
 */
export function askedSlot(title, now = new Date()) {
  const m = /\(they asked for (.+)\)\s*$/i.exec(textOf(title));
  const asked = m ? m[1].toLowerCase() : "";
  const time = askedClock(asked);
  const at = now instanceof Date ? now : new Date(now);
  if (!asked || Number.isNaN(at.getTime())) return { date: "", time };
  const p = Object.fromEntries(UK_PARTS.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  const today = Date.UTC(p.year, p.month - 1, p.day);
  let add = null;
  if (/\btoday\b/.test(asked)) add = 0;
  else if (/\btomorrow\b/.test(asked)) add = 1;
  else {
    const d = DAY_RE.exec(asked);
    if (d) {
      add = (DAY_KEYS.indexOf(d.slice(1).find(Boolean)) - new Date(today).getUTCDay() + 7) % 7;
      const nowClock = `${pad2(p.hour % 24)}:${pad2(p.minute)}`;
      if (add === 0 && time && time <= nowClock) add = 7; // "Thu 3pm" said on Thursday at 4pm: next week's
    }
  }
  if (add === null) return { date: "", time };
  const day = new Date(today + add * 86_400_000);
  return { date: `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`, time };
}

/** The place_id in "#/replies/<place_id>" (decoded), or null for the list (or an unreadable one). */
export function threadIdFrom(hash) {
  const raw = String(hash ?? "").replace(/^#\/?/, "");
  const path = raw.split("?")[0];
  const id = path.split("/").slice(1).join("/");
  if (!id) return null;
  try {
    return decodeURIComponent(id) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pure renderers (tested)

function medianText(minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return "none yet";
  if (minutes < 0.5) return "under 1 min";
  return `${Math.round(minutes)} min`;
}

/** The top line: on or paused, the switch, and "3 waiting · median reply time this week: 3 min · reply hours 7am–11:30pm". */
export function statusHtml(data) {
  const paused = data?.paused === true;
  const waiting = Number.isSafeInteger(data?.waiting) && data.waiting >= 0 ? data.waiting : 0;
  const line = `${waiting} waiting · median reply time this week: ${medianText(data?.median_minutes)} · ${HOURS}`;
  return `<div class="card" data-replies-status>
    <div class="card-head"><h2>${esc(paused ? "Claude replies: Paused" : "Claude replies: On")}</h2>
      <button class="btn${paused ? "" : " secondary"}" data-pause>${esc(paused ? "Turn Claude's replies back on" : "Pause Claude's replies")}</button></div>
    <p class="muted">${esc(line)}</p>
    ${paused ? `<p class="hint">${esc("Claude won't answer anyone while paused. Reply yourself from a conversation below.")}</p>` : ""}
  </div>`;
}

const textareaHtml = (attrs, value) => `<textarea ${attrs}>\n${esc(value)}</textarea>`;

function escalationCard(t) {
  const draft = textOf(t.draft);
  const messageId = str(t.message_id);
  const placeId = str(t.place_id);
  const boxLabel = draft ? "Claude's draft (edit it before you send)" : "Your reply";
  const id = `ny-${esc(t.id)}`;
  return `<div class="card" data-todo="${esc(t.id)}" data-kind="escalation" data-message="${esc(messageId)}">
    <div class="card-head"><h2>${esc(textOf(t.title))}</h2>${placeId ? `<a class="small" href="${esc(threadHref(placeId))}">Open the thread</a>` : ""}</div>
    ${str(t.detail) ? `<pre class="msg-body">${esc(textOf(t.detail))}</pre>` : ""}
    <div><label for="${id}">${esc(boxLabel)}</label>${textareaHtml(`id="${id}" rows="7" data-draft`, draft)}</div>
    <div class="actions"><button class="btn" data-send>Send as me</button><button class="btn secondary" data-dismiss>Dismiss</button></div>
    <p class="error" data-error hidden></p>
  </div>`;
}

function callTimeCard(t, now) {
  const asked = askedSlot(t.title, now); // pre-filled with what they asked for, when it can be read
  const messageId = str(t.message_id);
  const placeId = str(t.place_id);
  const id = `ny-${esc(t.id)}`;
  return `<div class="card" data-todo="${esc(t.id)}" data-kind="call_time" data-message="${esc(messageId)}" data-place="${esc(placeId)}">
    <div class="card-head"><h2>${esc(textOf(t.title))}</h2>${placeId ? `<a class="small" href="${esc(threadHref(placeId))}">Open the thread</a>` : ""}</div>
    ${str(t.detail) ? `<pre class="msg-body">${esc(textOf(t.detail))}</pre>` : ""}
    <div class="field-row">
      <div><label for="${id}-d">Day</label><input id="${id}-d" type="date" data-date value="${esc(asked.date)}"></div>
      <div><label for="${id}-t">Time (UK)</label><input id="${id}-t" type="time" data-time value="${esc(asked.time)}"></div>
      <div><label for="${id}-p">Their phone</label><input id="${id}-p" type="tel" data-phone value="${esc(str(t.phone))}"></div>
    </div>
    <div><label for="${id}-m">Your message to them</label>${textareaHtml(`id="${id}-m" rows="3" data-message-box placeholder="Pick the day and time: the message fills itself in."`, callTimeMessage(asked.date, asked.time))}</div>
    <div class="actions"><button class="btn" data-book>Book and send</button><button class="btn secondary" data-dismiss>Dismiss</button></div>
    <p class="error" data-error hidden></p>
  </div>`;
}

/** Needs you: one card per open escalation or call_time Todo (GET /api/replies needs_you); `now` reads "Thu 3pm". */
export function needsYouHtml(todos, now = new Date()) {
  const list = listOf(todos).filter((t) => t.kind === "escalation" || t.kind === "call_time");
  if (!list.length) return `<p class="muted">${esc("Nothing needs you right now.")}</p>`;
  return `<div class="stack">${list.map((t) => (t.kind === "call_time" ? callTimeCard(t, now) : escalationCard(t))).join("")}</div>`;
}

function stageBadge(stage) {
  const label = own(STAGE_LABELS, stage) ?? str(stage);
  if (!label) return "";
  const tone = own(STAGE_TONE, stage);
  return `<span class="badge${tone ? ` ${tone}` : ""}">${esc(label)}</span>`;
}

/** Conversations: business, stage, who wrote last, the first 80 characters, when; each links to its thread. */
export function conversationsHtml(rows) {
  const list = listOf(rows).filter((r) => str(r.place_id));
  if (!list.length) return `<div class="card empty-state"><p>${esc(EMPTY)}</p></div>`;
  const row = (r) => `<tr>
      <td><a href="${esc(threadHref(r.place_id))}">${esc(str(r.business) || r.place_id)}</a></td>
      <td>${stageBadge(r.stage)}</td>
      <td>${esc(textOf(r.last_who))}</td>
      <td class="muted">${esc(textOf(r.snippet))}</td>
      <td class="muted">${esc(ukTime(r.at))}</td>
    </tr>`;
  return `<div class="table-card"><div class="table-wrap"><table class="leads-table">
    <thead><tr><th>Business</th><th>Stage</th><th>Last</th><th>Message</th><th>When</th></tr></thead>
    <tbody>${list.map(row).join("")}</tbody></table></div></div>`;
}

/**
 * "Last drill: 14/14 right", or the cases it got wrong; "No drill run yet."; while Claude is still answering it
 * (GET /api/replies/drill's `waiting` > 0) it says so instead of showing a part-graded result as wrong.
 */
export function drillLine(last) {
  if (!isObj(last) || !Number.isFinite(last.right) || !Number.isFinite(last.total)) return "No drill run yet.";
  const waiting = Number(last.waiting);
  if (Number.isFinite(waiting) && waiting > 0) {
    return `Drill still running: Claude hasn't answered ${waiting} of the ${last.total} practice emails yet. Press Check the result again in a few minutes.`;
  }
  const head = `Last drill: ${last.right}/${last.total} right`;
  const wrong = listOf(last.wrong).map((w) => `${textOf(w.key)} (expected ${textOf(w.expected)}, got ${textOf(w.got)})`);
  return wrong.length ? `${head}. Wrong: ${wrong.join("; ")}` : head;
}

/** Test it: the reply drill and Nik's own test lead. */
export function testItHtml(last) {
  return `<div class="card" data-test-it>
    <div class="card-head"><h2>Test it</h2></div>
    <p class="muted">${esc("The drill sends Claude 14 practice emails, one of each kind, and checks what it did. Nothing is emailed to anyone.")}</p>
    <div class="actions"><button class="btn secondary" data-drill>Run the reply drill</button>
      <button class="btn ghost" data-drill-check>Check the result</button></div>
    <p data-drill-line>${esc(drillLine(last))}</p>
    <form data-test-lead>
      <label for="replies-test-email">Your own email (Claude treats it as a lead, so you can see its replies)</label>
      <div class="toolbar"><input id="replies-test-email" type="email" required autocomplete="email" data-test-email placeholder="you@gmail.com">
        <button class="btn secondary" type="submit">Add my email as a test lead</button></div>
      <p class="error" data-test-error hidden></p>
    </form>
  </div>`;
}

function messageHtml(m) {
  const who = str(m.who);
  const inbound = who === "them";
  const cls = own(WHO_CLASS, who);
  const intent = inbound && str(m.intent) ? `<span class="tag">${esc(str(m.intent).replace(/_/g, " "))}</span>` : "";
  const note = !inbound ? own(STATUS_NOTE, m.status) : undefined;
  return `<div class="msg ${inbound ? "in" : "out"}">
    <div class="msg-head"><span class="badge${cls ? ` ${cls}` : ""}">${esc(str(m.label) || "System")}</span>
      <span class="muted">${esc(ukTime(m.at))}</span> ${intent}${note ? ` <span class="muted">· ${esc(note)}</span>` : ""}</div>
    <pre class="msg-body">${esc(textOf(m.text))}</pre>
  </div>`;
}

/** Every message of one thread, oldest first (GET /api/replies/:place_id messages), as text. */
export function threadHtml(messages) {
  const list = listOf(messages);
  if (!list.length) return `<p class="muted">${esc("No emails in this thread yet.")}</p>`;
  return `<div class="thread">${list.map(messageHtml).join("")}</div>`;
}

/** Reply as me: answers their latest email (`replyTo`), any hour, from the thread's mailbox. */
export function replyBoxHtml(replyTo) {
  if (!str(replyTo)) return `<div class="card"><div class="card-head"><h2>Reply as me</h2></div><p class="muted">${esc(NO_EMAIL_TO_ANSWER)}</p></div>`;
  return `<form class="card" data-reply data-message="${esc(str(replyTo))}">
    <div class="card-head"><h2>Reply as me</h2></div>
    <label for="reply-as-me">${esc("Your words go as they are, in the same thread, with your name and Aetos Websites under them.")}</label>
    ${textareaHtml('id="reply-as-me" rows="6" data-reply-body', "")}
    <div class="actions"><button class="btn" type="submit">Send as me</button></div>
    <p class="error" data-error hidden></p>
  </form>`;
}

// ---------------------------------------------------------------- the pages (need a browser)

let lib = null; // ./lib.js, loaded on first use (it reads the page)
let pageAsk = 0; // the newest load: a slow answer never draws over the next page

const byId = (id) => document.getElementById(id);

function showError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

async function post(path, body) {
  return lib.api(path, { method: "POST", body: JSON.stringify(body) });
}

/** #/replies: the top line, Needs you, Conversations and Test it. */
export async function repliesPage() {
  lib ??= await import("./lib.js");
  const ask = ++pageAsk;
  lib.view.innerHTML = `${lib.pageHead(TITLE, esc(SUB))}<div id="replies-body"><p class="muted">Loading replies…</p></div>`;
  let data;
  try {
    data = await lib.api("/api/replies");
  } catch (err) {
    const el = byId("replies-body");
    if (ask === pageAsk && el) el.innerHTML = `<p class="error">${esc(err.message)}</p><p class="hint">Refresh the page to try again. <a href="#/setup">Setup</a> shows what's connected.</p>`;
    return;
  }
  const el = byId("replies-body");
  if (ask !== pageAsk || !el) return;
  el.innerHTML = `<div class="stack">
    <div id="replies-status">${statusHtml(data)}</div>
    <h2 class="section-title">Needs you</h2>
    <div id="replies-needs">${needsYouHtml(data.needs_you)}</div>
    <h2 class="section-title">Conversations</h2>
    ${conversationsHtml(data.conversations)}
    ${testItHtml(data.last_drill)}
  </div>`;
  bindStatus(data, ask);
  el.querySelectorAll("#replies-needs [data-todo]").forEach((card) => bindCard(card, ask));
  bindTestIt(el, Boolean(data.last_drill));
}

function bindStatus(data, ask) {
  const box = byId("replies-status");
  const button = box?.querySelector("[data-pause]");
  if (!button) return;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const out = await post("/api/replies", { paused: !(data.paused === true) });
      data.paused = out.paused === true;
      lib.toast(data.paused ? "Claude's replies are paused." : "Claude's replies are back on.");
    } catch (err) {
      lib.toast(err.message);
    }
    if (ask !== pageAsk || !box.isConnected) return;
    box.innerHTML = statusHtml(data);
    bindStatus(data, ask);
  };
}

function bindCard(card, ask) {
  const error = card.querySelector("[data-error]");
  const todoId = card.dataset.todo;
  const messageId = card.dataset.message;
  const buttons = () => card.querySelectorAll("button");
  const busy = (on) => buttons().forEach((b) => { b.disabled = on; });
  const run = async (fn, done) => {
    if (error) error.hidden = true;
    busy(true);
    let out;
    try {
      out = await fn();
    } catch (err) {
      busy(false);
      showError(error, err.message);
      return;
    }
    lib.toast(done(out));
    if (ask === pageAsk && card.isConnected) repliesPage(); // not when Nik has gone to another page meanwhile
  };

  const dismiss = card.querySelector("[data-dismiss]");
  if (dismiss) dismiss.onclick = () => run(() => post("/api/replies/dismiss", { todo_id: todoId }), () => "Dismissed.");

  const send = card.querySelector("[data-send]");
  const draft = card.querySelector("[data-draft]");
  if (send && draft) send.onclick = () => {
    if (!messageId) return showError(error, NO_EMAIL_TO_ANSWER);
    if (!draft.value.trim()) return showError(error, WRITE_FIRST);
    run(() => post("/api/replies/send", { message_id: messageId, body: draft.value }), () => "Sent as you.");
  };

  const book = card.querySelector("[data-book]");
  const date = card.querySelector("[data-date]");
  const time = card.querySelector("[data-time]");
  const phone = card.querySelector("[data-phone]");
  const message = card.querySelector("[data-message-box]");
  if (!book || !date || !time || !phone || !message) return;
  let edited = false; // once Nik changes the message himself, picking another time leaves it alone
  const fill = () => { if (!edited) message.value = callTimeMessage(date.value, time.value); };
  date.oninput = fill;
  time.oninput = fill;
  message.oninput = () => { edited = message.value.trim() !== "" && message.value !== callTimeMessage(date.value, time.value); };
  book.onclick = () => {
    if (!messageId || !card.dataset.place) return showError(error, NO_EMAIL_TO_ANSWER);
    const at = ukInputToIso(date.value, time.value);
    if (!at) return showError(error, PICK_TIME);
    if (!message.value.trim()) return showError(error, WRITE_FIRST);
    run(
      () => post("/api/calls", { place_id: card.dataset.place, at, phone: phone.value, message: message.value, message_id: messageId }),
      (out) => [`Booked: ${textOf(out?.label) || "the call"}.`, textOf(out?.warning)].filter(Boolean).join(" "),
    );
  };
}

function bindTestIt(root, hadDrill) {
  const card = root.querySelector("[data-test-it]");
  if (!card) return;
  const line = card.querySelector("[data-drill-line]");
  const runDrill = card.querySelector("[data-drill]");
  const check = card.querySelector("[data-drill-check]");
  const refresh = async (quiet) => {
    try {
      const out = await lib.api("/api/replies/drill");
      if (line?.isConnected) line.textContent = drillLine(out);
    } catch (err) {
      if (!quiet && line?.isConnected) line.textContent = err.message;
    }
  };
  if (runDrill) runDrill.onclick = async () => {
    runDrill.disabled = true;
    try {
      await post("/api/replies/drill", {});
      if (line) line.textContent = DRILL_STARTED;
    } catch (err) {
      if (line) line.textContent = err.message;
    }
    runDrill.disabled = false;
  };
  if (check) check.onclick = () => refresh(false);
  // A drill has been graded before: show how the latest one is doing now (GET grades it again).
  if (hadDrill) refresh(true);

  const form = card.querySelector("[data-test-lead]");
  const email = form?.querySelector("[data-test-email]");
  const error = form?.querySelector("[data-test-error]");
  if (!form || !email) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector("[type=submit]");
    if (error) error.hidden = true;
    button.disabled = true;
    try {
      await post("/api/replies/test-prospect", { email: email.value.trim() });
      lib.toast(TEST_LEAD_ADDED);
    } catch (err) {
      showError(error, err.message);
    }
    button.disabled = false;
  };
}

/** #/replies/<place_id>: one conversation, Reply as me and the call box. */
export async function threadPage(placeId) {
  lib ??= await import("./lib.js");
  const ask = ++pageAsk;
  const back = `<a href="#/replies">← All replies</a>`;
  lib.view.innerHTML = `${lib.pageHead("Conversation", back)}<div id="replies-thread"><p class="muted">Loading the conversation…</p></div>`;
  let t;
  try {
    t = await lib.api(`/api/replies/${encodeURIComponent(placeId)}`);
  } catch (err) {
    const el = byId("replies-thread");
    if (ask === pageAsk && el) el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (ask !== pageAsk || !byId("replies-thread")) return; // a newer load, or Nik has gone to another page
  const stage = stageBadge(t.stage);
  lib.view.innerHTML = `${lib.pageHead(str(t.business) || "Conversation", `${back}${stage ? ` · ${stage}` : ""}`)}
    <div class="grid-main">
      <div class="card">${threadHtml(t.messages)}</div>
      <div class="stack">${replyBoxHtml(t.reply_to)}<div id="thread-call"></div></div>
    </div>`;
  bindReply(placeId, ask);
  // The call box is Task 16's call.js: shown when it's there, the slot left empty when it isn't.
  import("./call.js")
    .then((m) => {
      const slot = byId("thread-call");
      if (ask === pageAsk && slot && typeof m.renderCallBox === "function") return m.renderCallBox(slot, placeId);
    })
    .catch(() => {});
}

function bindReply(placeId, ask) {
  const form = document.querySelector("form[data-reply]");
  const box = form?.querySelector("[data-reply-body]");
  const error = form?.querySelector("[data-error]");
  if (!form || !box) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (error) error.hidden = true;
    if (!box.value.trim()) return showError(error, WRITE_FIRST);
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      await post("/api/replies/send", { message_id: form.dataset.message, body: box.value });
    } catch (err) {
      button.disabled = false;
      showError(error, err.message);
      return;
    }
    lib.toast("Sent as you.");
    if (ask === pageAsk && form.isConnected) threadPage(placeId);
  };
}
