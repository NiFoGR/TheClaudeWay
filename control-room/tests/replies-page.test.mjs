// Stage 7 Replies page (docs/rebuild/07-replies-calls.md Part A "What Nik sees", Part B Task 15): GET/POST /api/replies
// (the list, the median reply time, the pause switch), GET /api/replies/:place_id (one thread) and the pure renderers
// in public/js/replies.js (threadHtml, needsYouHtml, conversationsHtml, …). replies.js touches no page when it loads
// (lib.js is loaded inside the page entry points), so this file needs none.
// Run: node --test control-room/tests/replies-page.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSetting, setSetting } from "../functions/_lib/settings.js";
import { addTodo } from "../functions/_lib/todo.js";
import * as replies from "../functions/api/replies.js";
import * as thread from "../functions/api/replies/[place_id].js";
import {
  askedSlot, callTimeMessage, conversationsHtml, drillLine, needsYouHtml, statusHtml, threadHtml, threadIdFrom, ukInputToIso,
} from "../public/js/replies.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// replies.js (and what it imports) loaded above with no page at all.
const PURE = typeof globalThis.document === "undefined";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-21T08:30:00Z"); // Wed 21 Oct 2026 09:30 UK
const EARLIER = "2026-10-19T07:00:00Z";
const XSS = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = async (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();

const lead = (place_id, name, extra = {}) => ({
  place_id, name, trade: "landscaper", search_town: "Warrington", town: "Warrington", phone: "01925 123456",
  first_seen_at: EARLIER, updated_at: EARLIER, ...extra,
});
const prospect = (place_id, extra = {}) => ({
  place_id, stage: "replied", stage_at: EARLIER, email: `${place_id}@them.co.uk`, greet_name: "Sam", mailbox_id: "mb1",
  subject: "Your new website", root_message_id: `<first-${place_id}@aetoswebsites.com>`, first_sent_at: EARLIER,
  created_at: EARLIER, updated_at: EARLIER, ...extra,
});
const out = (id, place_id, kind, author, at, extra = {}) => ({
  id, place_id, mailbox_id: "mb1", direction: "out", kind, author, to_addr: `${place_id}@them.co.uk`,
  from_addr: "nik@aetoswebsites.com", subject: "Your new website", body: `Body of ${id}`,
  message_id: `<${id}@aetoswebsites.com>`, status: "sent", due_at: at, sent_at: at, created_at: at, ...extra,
});
const inbound = (id, place_id, at, extra = {}) => ({
  id, place_id, mailbox_id: "mb1", direction: "in", kind: "inbound", author: "them", to_addr: "nik@aetoswebsites.com",
  from_addr: `${place_id}@them.co.uk`, subject: "Re: Your new website", body: `Hi, message ${id}`,
  message_id: `<${id}@them.co.uk>`, status: "received", received_at: at, class: "human", needs_reply: 0,
  created_at: at, ...extra,
});
// An inbound message and Claude's (or Nik's) reply to it `minutes` later.
async function pair(DB, place_id, id, receivedAt, minutes, { author = "claude", status = "sent", intent = "price" } = {}) {
  const sentAt = new Date(Date.parse(receivedAt) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await insert(DB, "messages", inbound(id, place_id, receivedAt, { intent, handled_at: receivedAt }));
  await insert(DB, "messages", out(`r-${id}`, place_id, "reply", author, sentAt, {
    in_reply_to: `<${id}@them.co.uk>`, status, sent_at: status === "sent" ? sentAt : null,
  }));
}

// p1 Green Leaf (replied: three Claude replies this week, 1, 3 and 10 minutes, so the median is 3), p2 Diamond
// Kickboxing (needs_nik: one waiting message and an escalation Todo, a call_time Todo), p3 never replied (only Nik's
// first email: not a conversation), drill:1 and test:nik (30 and 40 minutes: never in the median), an old reply
// (8 days ago, 60 minutes) and one of Nik's own (20 minutes): not in the median either.
async function seeded() {
  const DB = fakeD1();
  await setSetting(DB, "business:sender_name", "Nik");
  await insert(DB, "mailboxes", {
    id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik Smith", role: "cold", started_on: "2026-09-01", created_at: EARLIER,
  });
  await insert(DB, "leads", lead("p1", "GREEN LEAF LANDSCAPES LTD"));
  await insert(DB, "leads", lead("p2", "DIAMOND KICKBOXING LTD", { phone: "07969 770905" }));
  await insert(DB, "leads", lead("p3", "Quiet Plumbing"));
  await insert(DB, "prospects", prospect("p1"));
  await insert(DB, "prospects", prospect("p2", { stage: "needs_nik", greet_name: "Mark" }));
  await insert(DB, "prospects", prospect("p3", { stage: "emailed" }));
  await insert(DB, "prospects", prospect("drill:1", { stage: "replied" }));
  await insert(DB, "prospects", prospect("test:nik", { stage: "replied", greet_name: "Nik" }));

  await insert(DB, "messages", out("f1", "p1", "first", "nik", "2026-10-14T09:00:00Z"));
  await insert(DB, "messages", out("fu1", "p1", "followup", "system", "2026-10-15T09:00:00Z", { step: 1 }));
  await pair(DB, "p1", "a1", "2026-10-15T10:00:00Z", 1);
  await pair(DB, "p1", "a2", "2026-10-16T10:00:00Z", 3);
  await pair(DB, "p1", "a3", "2026-10-20T10:00:00Z", 10, { intent: "call_request" });
  await pair(DB, "p1", "old", "2026-10-12T10:00:00Z", 60); // 9 days ago: not this week
  await pair(DB, "p1", "nk", "2026-10-20T12:00:00Z", 20, { author: "nik" }); // Nik's own: not Claude's speed
  await pair(DB, "drill:1", "d1", "2026-10-20T11:00:00Z", 30, { status: "cancelled" });
  await pair(DB, "test:nik", "t1", "2026-10-20T11:00:00Z", 40);

  await insert(DB, "messages", out("f2", "p2", "first", "nik", "2026-10-19T09:00:00Z"));
  await insert(DB, "messages", inbound("m2", "p2", "2026-10-21T08:05:00Z", {
    body: "Stop sending me this rubbish.\n\nOn Tue, Nik wrote:\n> Hi", needs_reply: 1,
  }));
  await insert(DB, "messages", out("f3", "p3", "first", "nik", "2026-10-19T09:00:00Z"));

  await addTodo(DB, {
    kind: "escalation", title: "Angry reply from Diamond Kickboxing: Claude's draft is ready",
    detail: "Swearing about the emails\n\nThey wrote:\nStop sending me this rubbish.", draft: "Hi Mark,\n\nSorry about that.",
    link: "/#/replies/p2", place_id: "p2", due_at: "2026-10-21T08:10:00Z", dedupe: "escalation:m2",
  });
  await addTodo(DB, {
    kind: "call_time", title: "Confirm a time with Mark (Diamond Kickboxing) by 6pm (they asked for Thu 3pm)",
    detail: "They asked for Thu 3pm.", link: "/#/replies/p2", place_id: "p2", due_at: "2026-10-21T17:00:00Z",
    dedupe: "call_time:m2",
  });
  await addTodo(DB, { kind: "pick", title: "Pick today's leads", dedupe: "pick:2026-10-21" }); // never "needs you"
  return DB;
}

const ctx = (DB, path, body = null, params = {}) => ({
  request: new Request(`${ORIGIN}${path}`, body === null
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  env: { DB },
  params,
  now: NOW,
});

// ---------------------------------------------------------------- the spec's test (Task 15, Step 1)

test("the spec's test: escaping, empty state, cards, median, pause, nav entry", async () => {
  const DB = await seeded();
  const html = threadHtml([{ id: "m1", who: "them", label: "Them", at: "2026-10-21T08:05:00Z", intent: "price", text: "<script>alert(1)</script>How much?" }]);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /price/);
  assert.match(conversationsHtml([]), /No replies yet\. When someone writes back, Claude answers within minutes between 7am and 11:30pm, and it shows here\./);
  assert.match(needsYouHtml([{ id: "t1", kind: "escalation", title: "Angry reply from X: Claude's draft is ready", draft: "Hi", detail: "d" }]), /Send as me/);
  assert.match(needsYouHtml([{ id: "t2", kind: "call_time", title: "Confirm a time with X by 6pm (they asked for Thu 3pm)", detail: "d" }]), /Book and send/);
  const list = await (await replies.onRequestGet(ctx(DB, "/api/replies"))).json();
  assert.equal(list.median_minutes, 3);
  await replies.onRequestPost(ctx(DB, "/api/replies", { paused: true }));
  assert.equal(await getSetting(DB, "replies:paused"), "1");
});

// ---------------------------------------------------------------- GET /api/replies

test("GET /api/replies: paused, waiting, needs you, conversations, last drill", async () => {
  const DB = await seeded();
  const res = await replies.onRequestGet(ctx(DB, "/api/replies"));
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.paused, false);
  assert.equal(list.waiting, 1);
  assert.equal(list.last_drill, null);

  // Needs you: the open escalation and call_time Todos (never a pick), with the email they're about and the lead's phone.
  assert.deepEqual(list.needs_you.map((t) => [t.kind, t.message_id, t.place_id, t.phone]), [
    ["escalation", "m2", "p2", "07969 770905"],
    ["call_time", "m2", "p2", "07969 770905"],
  ]);
  assert.equal(list.needs_you[0].draft, "Hi Mark,\n\nSorry about that.");
  assert.equal(list.needs_you[0].title, "Angry reply from Diamond Kickboxing: Claude's draft is ready");
  assert.match(list.needs_you[0].detail, /They wrote:\nStop sending me this rubbish\./);

  // Conversations: threads with a reply from them, newest first; p3 (never replied) isn't one.
  const byId = Object.fromEntries(list.conversations.map((c) => [c.place_id, c]));
  assert.deepEqual(list.conversations.map((c) => c.place_id), ["p2", "p1", "test:nik", "drill:1"]);
  assert.deepEqual(byId.p2, {
    place_id: "p2", business: "Diamond Kickboxing", stage: "needs_nik", last_who: "Them",
    snippet: "Stop sending me this rubbish.", at: "2026-10-21T08:05:00Z",
  });
  assert.equal(byId.p1.business, "Green Leaf Landscapes");
  assert.equal(byId.p1.last_who, "You"); // Nik's own reply at 12:20 on the 20th is the newest in p1
  assert.equal(byId.p1.at, "2026-10-20T12:20:00Z");
  assert.equal(byId.p1.snippet, "Body of r-nk");
  assert.equal(byId["drill:1"].last_who, "Claude"); // a drill reply is stored cancelled and still shows
});

test("GET /api/replies: the snippet is 80 characters at most, quoted history off; Claude last; at most 50", async () => {
  const DB = fakeD1();
  await insert(DB, "leads", lead("q1", "Long Talker"));
  await insert(DB, "prospects", prospect("q1"));
  const long = `${"word ".repeat(30)}end\n\nOn Tue, Nik wrote:\n> quoted`;
  await insert(DB, "messages", inbound("q1m", "q1", "2026-10-20T10:00:00Z", { body: long }));
  for (let i = 0; i < 55; i++) {
    const id = `z${String(i).padStart(2, "0")}`;
    await insert(DB, "leads", lead(id, `Firm ${id}`));
    await insert(DB, "prospects", prospect(id));
    await insert(DB, "messages", inbound(`${id}m`, id, `2026-10-${String(1 + (i % 18)).padStart(2, "0")}T09:${String(i).padStart(2, "0")}:00Z`));
  }
  await insert(DB, "messages", out("q1r", "q1", "reply", "claude", "2026-10-20T10:03:00Z", { body: "Hi Sam,\n\nHave a look." }));
  // A follow-up cancelled by their reply never went: it isn't the last word.
  await insert(DB, "messages", out("q1c", "q1", "followup", "system", "2026-10-20T11:00:00Z", { status: "cancelled", sent_at: null, step: 2 }));
  const list = await (await replies.onRequestGet(ctx(DB, "/api/replies"))).json();
  assert.equal(list.conversations.length, 50);
  assert.equal(list.conversations[0].place_id, "q1");
  assert.equal(list.conversations[0].last_who, "Claude");
  assert.equal(list.conversations[0].snippet, "Hi Sam, Have a look.");
  assert.equal(list.median_minutes, null); // sent_at is set but nothing it answered (no in_reply_to): no pair
  assert.equal(list.waiting, 0);

  const DB2 = fakeD1();
  await insert(DB2, "leads", lead("q2", "Long Talker"));
  await insert(DB2, "prospects", prospect("q2"));
  await insert(DB2, "messages", inbound("q2m", "q2", "2026-10-20T10:00:00Z", { body: long }));
  const one2 = (await (await replies.onRequestGet(ctx(DB2, "/api/replies"))).json()).conversations[0];
  assert.equal(one2.snippet, `${"word ".repeat(16).trim()}`); // 80 characters, the space it ends on trimmed
  assert.ok(!one2.snippet.includes("quoted"));
});

test("GET /api/replies: the median counts overnight mail from 07:00, only Claude's sent replies of the last 7 days", async () => {
  const DB = fakeD1();
  await insert(DB, "leads", lead("n1", "Night Owl"));
  await insert(DB, "prospects", prospect("n1"));
  // Arrived 02:00 UK (01:00Z), answered 07:04 UK (06:04Z): 4 minutes, not 5 hours.
  await pair(DB, "n1", "o1", "2026-10-20T01:00:00Z", 304);
  // Queued, not sent yet: skipped.
  await pair(DB, "n1", "o2", "2026-10-20T10:00:00Z", 2, { status: "queued" });
  const list = await (await replies.onRequestGet(ctx(DB, "/api/replies"))).json();
  assert.equal(list.median_minutes, 4);
});

test("GET /api/replies: last_drill from the setting replies:last_drill", async () => {
  const DB = await seeded();
  await setSetting(DB, "replies:last_drill", JSON.stringify({ right: 13, total: 14, wrong: [{ key: "angry", expected: "escalate angry", got: "reply not_interested" }] }));
  const list = await (await replies.onRequestGet(ctx(DB, "/api/replies"))).json();
  assert.deepEqual(list.last_drill, { right: 13, total: 14, wrong: [{ key: "angry", expected: "escalate angry", got: "reply not_interested" }] });
  await setSetting(DB, "replies:last_drill", "not json");
  assert.equal((await (await replies.onRequestGet(ctx(DB, "/api/replies"))).json()).last_drill, null);
});

// ---------------------------------------------------------------- POST /api/replies

test("POST /api/replies {paused}: on and off; anything else is refused in plain English", async () => {
  const DB = await seeded();
  const on = await replies.onRequestPost(ctx(DB, "/api/replies", { paused: true }));
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { ok: true, paused: true });
  assert.equal((await (await replies.onRequestGet(ctx(DB, "/api/replies"))).json()).paused, true);
  const off = await replies.onRequestPost(ctx(DB, "/api/replies", { paused: false }));
  assert.deepEqual(await off.json(), { ok: true, paused: false });
  assert.equal(await getSetting(DB, "replies:paused"), "0");
  for (const body of ["{nope", { paused: "yes" }, {}, []]) {
    const res = await replies.onRequestPost(ctx(DB, "/api/replies", body));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /^Couldn't (save|change)/);
  }
  assert.equal(await getSetting(DB, "replies:paused"), "0");
});

// ---------------------------------------------------------------- GET /api/replies/:place_id

test("GET /api/replies/:place_id: every message oldest first, labelled, their text without quoted history", async () => {
  const DB = await seeded();
  const res = await thread.onRequestGet(ctx(DB, "/api/replies/p1", null, { place_id: "p1" }));
  assert.equal(res.status, 200);
  const t = await res.json();
  assert.equal(t.business, "Green Leaf Landscapes");
  assert.equal(t.stage, "replied");
  assert.equal(t.place_id, "p1");
  assert.equal(t.phone, "01925 123456");
  assert.deepEqual(t.messages.slice(0, 4).map((m) => [m.id, m.who, m.label]), [
    ["old", "them", "Them"], ["r-old", "claude", "Claude"], ["f1", "nik", "You"], ["fu1", "system", "Follow-up 1"],
  ]);
  const ats = t.messages.map((m) => m.at);
  assert.deepEqual(ats, [...ats].sort());
  assert.equal(t.messages.find((m) => m.id === "a3").intent, "call_request");
  assert.equal(t.messages.find((m) => m.id === "r-a3").intent, null); // intent tags are on theirs only
  assert.equal(t.reply_to, "nk"); // their latest email: Reply as me answers it
  for (const m of t.messages) assert.deepEqual(Object.keys(m).sort(), ["at", "id", "intent", "label", "status", "text", "who"]);

  const t2 = await (await thread.onRequestGet(ctx(DB, "/api/replies/p2", null, { place_id: "p2" }))).json();
  assert.equal(t2.messages.find((m) => m.id === "m2").text, "Stop sending me this rubbish.");
  assert.equal(t2.stage, "needs_nik");

  // A drill thread: the place_id comes URL-encoded; a practice lead with no lead row still has a name.
  const d = await (await thread.onRequestGet(ctx(DB, "/api/replies/drill%3A1", null, { place_id: "drill%3A1" }))).json();
  assert.equal(d.place_id, "drill:1");
  assert.equal(d.business, "Drill Test Landscapes · drill 1");
  const tn = await (await thread.onRequestGet(ctx(DB, "/api/replies/test%3Anik", null, { place_id: "test%3Anik" }))).json();
  assert.equal(tn.business, "Drill Test Landscapes · your test lead");
  assert.equal(d.messages.find((m) => m.id === "r-d1").status, "cancelled");

  const none = await thread.onRequestGet(ctx(DB, "/api/replies/nope", null, { place_id: "nope" }));
  assert.equal(none.status, 404);
  assert.match((await none.json()).error, /isn't in the database/);
});

// ---------------------------------------------------------------- the page's pure parts

test("replies.js loads with no page and imports nothing that reads one", () => {
  assert.ok(PURE);
  const src = readFileSync(new URL("../public/js/replies.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^import[^\n]*["']\.\/lib\.js["']/m); // lib.js reads the page: loaded inside the entry points
  assert.match(src, /import\("\.\/call\.js"\)/); // Task 16's call box, loaded when the thread opens
  assert.match(src, /renderCallBox/);
  assert.match(src, /export async function repliesPage\b/);
  assert.match(src, /export async function threadPage\b/);
  for (const route of ["/api/replies/send", "/api/replies/dismiss", "/api/calls", "/api/replies/drill", "/api/replies/test-prospect"]) {
    assert.ok(src.includes(route), `replies.js never calls ${route}`);
  }
});

test("threadHtml: labels, UK time, intent tag on theirs, hostile text escaped, status of what didn't go", () => {
  const html = threadHtml([
    { id: "f1", who: "nik", label: "You", at: "2026-10-20T08:00:00Z", intent: null, status: "sent", text: "Hi Sam" },
    { id: "fu", who: "system", label: "Follow-up 3", at: "2026-10-20T09:00:00Z", intent: null, status: "sent", text: "Nudge" },
    { id: "m1", who: "them", label: "Them", at: "2026-10-21T08:05:00Z", intent: "call_request", status: "received", text: XSS },
    { id: "r1", who: "claude", label: "Claude", at: "2026-10-21T08:08:00Z", intent: null, status: "cancelled", text: "Drill" },
  ]);
  noRawHtml(html);
  for (const s of ["You", "Follow-up 3", "Them", "Claude", "call request", "21 Oct, 09:05", "Not sent"]) assert.ok(html.includes(s), s);
  assert.equal(html.split("call request").length - 1, 1);
  assert.match(threadHtml([]), /No emails/);
  assert.match(threadHtml(null), /No emails/);
});

test("needsYouHtml: escalation and call-time cards, everything escaped, empty state", () => {
  const esc8 = needsYouHtml([
    { id: "t1", kind: "escalation", title: XSS, detail: XSS, draft: XSS, message_id: "m2", place_id: "p2", link: "/#/replies/p2" },
    { id: "t2", kind: "call_time", title: XSS, detail: XSS, message_id: "m3", place_id: "p2", phone: XSS },
  ]);
  noRawHtml(esc8);
  for (const s of ["Send as me", "Dismiss", "Book and send", 'type="date"', 'type="time"', "data-phone"]) assert.ok(esc8.includes(s), s);
  assert.ok(esc8.includes('value="&quot;&gt;&lt;img src=x'));
  assert.ok(esc8.includes("Claude&#39;s draft"));
  // A Todo without an email to answer still shows both buttons (Send as me then says what's wrong).
  const noMsg = needsYouHtml([{ id: "t3", kind: "escalation", title: "x", detail: "d" }]);
  assert.match(noMsg, /Send as me/);
  assert.match(noMsg, /Dismiss/);
  assert.match(noMsg, /data-message=""/);
  assert.match(needsYouHtml([]), /Nothing needs you/);
});

test("conversationsHtml: business, stage, who wrote last, snippet, link to the thread; escaped", () => {
  const html = conversationsHtml([
    { place_id: "drill:1", business: XSS, stage: "needs_nik", last_who: "Them", snippet: XSS, at: "2026-10-21T08:05:00Z" },
    { place_id: "p1", business: "Green Leaf Landscapes", stage: "replied", last_who: "Claude", snippet: "Have a look", at: "2026-10-21T08:05:00Z" },
  ]);
  noRawHtml(html);
  assert.ok(html.includes('href="#/replies/drill%3A1"'));
  assert.ok(html.includes('href="#/replies/p1"'));
  for (const s of ["Needs you", "Replied", "Them", "Claude", "Green Leaf Landscapes", "Have a look"]) assert.ok(html.includes(s), s);
});

test("statusHtml: the top line, on and paused", () => {
  const on = statusHtml({ paused: false, waiting: 3, median_minutes: 3 });
  assert.ok(on.includes("Claude replies: On"));
  assert.ok(on.includes("Pause Claude&#39;s replies"));
  assert.ok(on.includes("3 waiting · median reply time this week: 3 min · reply hours 7am–11:30pm"));
  const paused = statusHtml({ paused: true, waiting: 0, median_minutes: null });
  assert.ok(paused.includes("Claude replies: Paused"));
  assert.ok(paused.includes("Turn Claude&#39;s replies back on"));
  assert.ok(paused.includes("0 waiting · median reply time this week: none yet · reply hours 7am–11:30pm"));
  assert.ok(statusHtml({ paused: false, waiting: 1, median_minutes: 2.6 }).includes("median reply time this week: 3 min"));
  assert.ok(statusHtml({ paused: false, waiting: 1, median_minutes: 0.2 }).includes("median reply time this week: under 1 min"));
});

test("drillLine: the last drill's result", () => {
  assert.equal(drillLine({ right: 14, total: 14, wrong: [] }), "Last drill: 14/14 right");
  assert.equal(drillLine({ right: 13, total: 14, wrong: [{ key: "angry", expected: "escalate angry", got: "reply not_interested" }] }),
    "Last drill: 13/14 right. Wrong: angry (expected escalate angry, got reply not_interested)");
  assert.equal(drillLine(null), "No drill run yet.");
});

test("drillLine: a drill Claude is still answering says so, not 0/14 wrong", () => {
  assert.equal(drillLine({ right: 0, total: 14, wrong: [{ key: "angry", expected: "escalate angry", got: "none" }], waiting: 9 }),
    "Drill still running: Claude hasn't answered 9 of the 14 practice emails yet. Press Check the result again in a few minutes.");
  assert.equal(drillLine({ right: 14, total: 14, wrong: [], waiting: 0 }), "Last drill: 14/14 right");
});

test("threadIdFrom: the second hash segment, decoded", () => {
  assert.equal(threadIdFrom("#/replies"), null);
  assert.equal(threadIdFrom("#/replies/"), null);
  assert.equal(threadIdFrom("#/replies/ChIJabc"), "ChIJabc");
  assert.equal(threadIdFrom("#/replies/drill%3A1?x=1"), "drill:1");
  assert.equal(threadIdFrom("#/replies/%E0%A4%A"), null); // unreadable
});

test("callTimeMessage and ukInputToIso: Nik's call-time message and the UK time it books", () => {
  assert.equal(callTimeMessage("2026-10-22", "15:00"), "Thursday at 3pm works. I'll ring you then. Thank you.");
  assert.equal(callTimeMessage("2026-10-24", "11:30"), "Saturday at 11:30am works. I'll ring you then. Thank you.");
  assert.equal(callTimeMessage("2026-10-24", "12:00"), "Saturday at 12pm works. I'll ring you then. Thank you.");
  assert.equal(callTimeMessage("", "15:00"), "");
  assert.equal(ukInputToIso("2026-10-22", "15:00"), "2026-10-22T14:00:00Z"); // BST
  assert.equal(ukInputToIso("2026-10-26", "15:00"), "2026-10-26T15:00:00Z"); // GMT from 25 Oct
  assert.equal(ukInputToIso("2026-03-29", "11:00"), "2026-03-29T10:00:00Z"); // BST from 01:00 on 29 Mar
  assert.equal(ukInputToIso("2026-03-28", "11:00"), "2026-03-28T11:00:00Z");
  assert.equal(ukInputToIso("2026-10-22", ""), null);
  assert.equal(ukInputToIso("22/10/2026", "15:00"), null);
});

test("askedSlot: the call-time card starts on the day and time they asked for, in UK time", () => {
  const WED = new Date("2026-10-21T08:30:00Z"); // Wed 21 Oct 09:30 UK (BST)
  const title = (asked, by = "by 6pm") => `Confirm a time with Mark (Diamond Kickboxing) ${by} (they asked for ${asked})`;
  assert.deepEqual(askedSlot(title("Thu 3pm"), WED), { date: "2026-10-22", time: "15:00" });
  assert.deepEqual(askedSlot(title("Thursday at 3:30 p.m.", "by 6pm tomorrow"), WED), { date: "2026-10-22", time: "15:30" });
  assert.deepEqual(askedSlot(title("Monday 10am"), WED), { date: "2026-10-26", time: "10:00" }); // across 25 Oct
  assert.deepEqual(askedSlot(title("tomorrow at noon"), WED), { date: "2026-10-22", time: "12:00" });
  assert.deepEqual(askedSlot(title("Wed 15:00"), WED), { date: "2026-10-21", time: "15:00" }); // later today
  assert.deepEqual(askedSlot(title("Wed 9am"), WED), { date: "2026-10-28", time: "09:00" }); // passed today: next week's
  assert.deepEqual(askedSlot(title("Sat 11am"), new Date("2026-10-23T23:30:00Z")), { date: "2026-10-24", time: "11:00" }); // Sat 00:30 UK (Fri in UTC)
  assert.deepEqual(askedSlot(title("Sat 12am"), new Date("2026-10-23T23:30:00Z")), { date: "2026-10-31", time: "00:00" }); // midnight has passed
  assert.deepEqual(askedSlot(title("any time (no free slots)"), WED), { date: "", time: "" });
  assert.deepEqual(askedSlot(title("after work"), WED), { date: "", time: "" });
  assert.deepEqual(askedSlot(title("13pm Fri"), WED), { date: "2026-10-23", time: "" });
  assert.deepEqual(askedSlot("Pick today's leads", WED), { date: "", time: "" });
  assert.deepEqual(askedSlot(null, WED), { date: "", time: "" });

  // The card: inputs and message pre-filled; unreadable asks leave them for Nik.
  const card = needsYouHtml([{ id: "t2", kind: "call_time", title: title("Thu 3pm"), detail: "d", message_id: "m2", place_id: "p2" }], WED);
  assert.ok(card.includes('type="date" data-date value="2026-10-22"'));
  assert.ok(card.includes('type="time" data-time value="15:00"'));
  assert.ok(card.includes("Thursday at 3pm works. I&#39;ll ring you then. Thank you.</textarea>"));
  const blank = needsYouHtml([{ id: "t3", kind: "call_time", title: title("whenever"), detail: "d" }], WED);
  assert.ok(blank.includes('data-date value=""'));
  assert.ok(blank.includes("data-message-box placeholder=\"Pick the day and time: the message fills itself in.\">\n</textarea>"));
  // Hostile text in the asked time is escaped wherever it lands.
  noRawHtml(needsYouHtml([{ id: "t4", kind: "call_time", title: title(`Thu 3pm ${XSS}`), detail: "d" }], WED));
});

test("replies.js never redraws over another page after an answer comes back", () => {
  const src = readFileSync(new URL("../public/js/replies.js", import.meta.url), "utf8");
  assert.match(src, /if \(ask !== pageAsk \|\| !byId\("replies-thread"\)\) return;/);
  assert.match(src, /if \(ask === pageAsk && card\.isConnected\) repliesPage\(\)/);
  assert.match(src, /if \(ask === pageAsk && form\.isConnected\) threadPage\(placeId\)/);
});
