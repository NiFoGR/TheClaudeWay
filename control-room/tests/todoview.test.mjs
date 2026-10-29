// The Todo page's pure HTML (docs/rebuild/11-todo-kpis.md Part A "Todo page", Part B Task 8): public/js/todoview.js.
// Health lights (red and amber rows with their fix, greens folded into one chip), Today's rows and buttons by kind
// (Send/Edit only when the item can be sent, tel: links, in-app links), the pipeline columns and the client cards,
// the empty states, and escaping of everything scraped, inbound or Claude-written. todo.js puts it on the page.
// Run: node --test control-room/tests/todoview.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadBoard } from "../functions/_lib/todo.js";
import { clientsHtml, lightsHtml, pipelineHtml, todoItemHtml, todoListHtml } from "../public/js/todoview.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// todoview.js (and what it imports) loaded above with no page at all: it's pure.
const PURE = typeof globalThis.document === "undefined";

test("escapes everything", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = todoItemHtml({ id: "t1", kind: "escalation", title: evil, detail: evil, draft: "<script>x</script>", can_send: true, business: evil, place_id: "p1",
    lead_link: "/#/lead/p1", thread_link: "/#/replies/p1", phone: "07969 123456" })
    + pipelineHtml({ columns: [{ stage: "ready", label: "Ready to email", count: 1, more: 0, cards: [{ place_id: "p1", business: evil, grade: "A", event: evil, next: null, lead_link: "/#/lead/p1", thread_link: "/#/replies/p1" }] }], lost: { count: 0, cards: [] } });
  assert.ok(html.includes("&lt;img") && !html.includes("<img") && !html.includes("<script"));
});

test("call row has tel link and thread link; red lights first with their fix", () => {
  const row = todoItemHtml({ id: "t2", kind: "call", title: "Call Mark", phone: "07969 123456", thread_link: "/#/replies/p1", place_id: "p1" });
  assert.match(row, /href="tel:07969123456"/); assert.match(row, /Open email thread/);
  const l = lightsHtml([{ name: "a", level: "green", detail: "ok", fix: "" }, { name: "b", level: "red", detail: "Sending stopped", fix: "Paste the password" }]);
  assert.ok(l.indexOf("Sending stopped") < l.indexOf("1 check fine") && l.includes("Paste the password"));
});

test("Send and Edit only when the item can be sent", () => {
  assert.match(todoItemHtml({ id: "t3", kind: "escalation", title: "x", draft: "Hi", can_send: true, place_id: "p1", thread_link: "/#/replies/p1" }), />Send</);
  const client = todoItemHtml({ id: "t4", kind: "escalation", title: "Client wrote in", draft: null, can_send: false, client_id: "c1", link: "/#/money" });
  assert.ok(!/>Send|>Edit/.test(client) && client.includes(">Open<"));
});

test("empty states in plain English", () => {
  assert.match(todoListHtml({ overdue: [], today: [], later: [] }), /Nothing for you right now/);
  assert.match(pipelineHtml({ columns: [], lost: { count: 0, cards: [] } }), /No one in the pipeline yet/);
  assert.match(clientsHtml({ cards: [], past: 0 }), /No clients yet/);
  assert.match(lightsHtml([{ name: "a", level: "green", detail: "", fix: "" }, { name: "b", level: "grey", detail: "Chatbot", fix: "" }]), /Everything is running/);
});

// ---------------------------------------------------------------- beyond the plan's four: Part A's other words

test("todoview.js is pure: it loads without a page", () => {
  assert.equal(PURE, true);
  const src = readFileSync(new URL("../public/js/todoview.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\/lib\.js"/);
  assert.match(src, /from "\.\/html\.js"/);
});

test("lights: amber rows too, plural chip, greys only in the list, and the error line", () => {
  const l = lightsHtml([
    { name: "z", level: "grey", detail: "Chatbot", fix: "" },
    { name: "g1", level: "green", detail: "Tick ran", fix: "" },
    { name: "g2", level: "green", detail: "Mail received", fix: "" },
    { name: "am", level: "amber", detail: "Few emails found", fix: "Check the research" },
    { name: "rd", level: "red", detail: "Sending stopped", fix: "Paste the password" },
  ]);
  assert.ok(l.indexOf("Sending stopped") < l.indexOf("Few emails found"));
  assert.ok(l.indexOf("Few emails found") < l.indexOf("2 checks fine"));
  assert.match(l, /<b>Sending stopped<\/b>/);
  assert.match(l, /Check the research/);
  assert.match(l, /Chatbot[\s\S]*not in use/);
  assert.doesNotMatch(l, /Everything is running/);
  assert.match(lightsHtml([], "the database isn't bound"), /Couldn&#39;t check the system lights: the database isn&#39;t bound\. Refresh the page\./);
  assert.doesNotMatch(lightsHtml([{ name: "x", level: "red", detail: "<img src=x>", fix: "<script>" }]), /<img|<script/);
});

test("today: Overdue label, no label for today, Coming up collapsed with its count", () => {
  const item = (id, kind = "setup") => ({ id, kind, title: `Item ${id}`, detail: "", link: "/#/setup" });
  const html = todoListHtml({ overdue: [item("o1", "payment")], today: [item("d1")], later: [item("l1"), item("l2")] });
  assert.match(html, /Overdue/);
  assert.match(html, /<details[^>]*>\s*<summary[^>]*>Coming up \(2\)<\/summary>/);
  assert.ok(html.indexOf("Item o1") < html.indexOf("Item d1") && html.indexOf("Item d1") < html.indexOf("Item l1"));
  assert.doesNotMatch(html, /Nothing for you right now/);
  const later = todoListHtml({ overdue: [], today: [], later: [item("l1")] });
  assert.match(later, /Nothing for you right now/);
  assert.match(later, /Coming up \(1\)/);
  assert.match(todoListHtml(undefined), /Nothing for you right now/);
});

test("rows by kind: hot, call time, health, client mail, no lead, outside links", () => {
  const hot = todoItemHtml({ id: "h", kind: "hot", title: "Hilltop Roofing opened their demo 3 times", phone: "01925 100004", place_id: "ph", lead_link: "/#/lead/ph", thread_link: "/#/replies/ph" });
  assert.match(hot, /href="tel:01925100004"[^>]*>[\s\S]*Call 01925 100004/);
  assert.match(hot, /href="\/#\/lead\/ph"[^>]*>Open lead</);
  const noPhone = todoItemHtml({ id: "h2", kind: "hot", title: "x", phone: null, place_id: "p", lead_link: "/#/lead/p" });
  assert.doesNotMatch(noPhone, /tel:/);
  for (const html of [hot, noPhone]) assert.match(html, /data-status="done"[^>]*>Done</), assert.match(html, /data-status="dismissed"[^>]*>Dismiss</);

  const ct = todoItemHtml({ id: "c", kind: "call_time", title: "Sam asked for a call", detail: "They wrote: Friday?", draft: "Friday 10:00 works.", can_send: true, place_id: "pn", thread_link: "/#/replies/pn" });
  assert.match(ct, />Send</); assert.match(ct, />Edit</); assert.match(ct, /Friday 10:00 works\./); assert.match(ct, /Open email thread/);

  const health = todoItemHtml({ id: "x", kind: "health", title: "No towns left", detail: "Add towns", link: "/#/scraper" });
  assert.match(health, /href="\/#\/scraper"[^>]*>Open</);
  assert.doesNotMatch(health, /Open lead|Open email thread|tel:/);

  // A todo whose lead is gone (no lead_link / thread_link): no links, no crash.
  const gone = todoItemHtml({ id: "g", kind: "escalation", title: "Old one", detail: "", draft: null, can_send: false, place_id: "gone", lead_link: null, thread_link: null, link: null });
  assert.doesNotMatch(gone, /href=/);

  const mail = todoItemHtml({ id: "m", kind: "setup", title: "Send the welcome email by hand", detail: "To: a@b.co\nSubject: Welcome\n\nHi Ann,\nhttps://pay.example/x", link: "/#/money" });
  assert.match(mail, /class="[^"]*detail[^"]*"[^>]*>To: a@b\.co\nSubject: Welcome\n\nHi Ann,/);

  const outside = todoItemHtml({ id: "o", kind: "setup", title: "x", link: "https://dashboard.stripe.com/" });
  assert.match(outside, /href="https:\/\/dashboard\.stripe\.com\/"[^>]*target="_blank"/);
  assert.doesNotMatch(todoItemHtml({ id: "j", kind: "setup", title: "x", link: "javascript:alert(1)" }), /href="javascript/);

  const call = todoItemHtml({ id: "t", kind: "call", title: "Call Ian", phone: "07969 123456", due_at: "2026-10-27T11:00:00Z", call_at: "2026-10-27T11:00:00Z", place_id: "pc", thread_link: "/#/replies/pc", link: "/#/call/c1" });
  assert.match(call, /Tue 11:00/);                                   // GMT on 27 Oct
  assert.match(todoItemHtml({ id: "t", kind: "call", title: "x", due_at: "2026-10-22T10:00:00Z", call_at: "2026-10-22T10:00:00Z", place_id: "pc" }), /Thu 11:00/); // BST
  // Stage 8's call-outcome Todo is due 30 minutes after the call (no call_at): its due time is not the call's time.
  const outcome = todoItemHtml({ id: "o", kind: "call", title: "How did the call with Ian (Peak) go?", due_at: "2026-10-27T11:30:00Z", call_at: null, place_id: "pc", phone: "07969 123456", link: "/#/call/c1" });
  assert.doesNotMatch(outcome, /11:30/);
  assert.match(outcome, /<div class="todo-meta">07969 123456<\/div>/);
  assert.match(outcome, /href="tel:07969123456"/);
  // Stage 8's own titles: the booked call's title already has the time and number (shown once, not twice), and the
  // day list (no lead, due 07:00 UK) gets no "Tue 07:00" line that would read as a call at 7am.
  const booked = todoItemHtml({ id: "b", kind: "call", title: "Call Ian (Peak) Tue 11:00 · 07969 123456", phone: "07969 123456", due_at: "2026-10-27T11:00:00Z", call_at: "2026-10-27T11:00:00Z", place_id: "pc", thread_link: "/#/replies/pc" });
  assert.equal(booked.match(/Tue 11:00/g).length, 1);
  assert.doesNotMatch(booked, /todo-meta/);
  assert.match(booked, /href="tel:07969123456"/);
  const day = todoItemHtml({ id: "d", kind: "call", title: "Today's calls: 11:00 Ian, 14:00 Sam", due_at: "2026-10-27T07:00:00Z", call_at: null, link: "/#/call/c1" });
  assert.doesNotMatch(day, /07:00|todo-meta|tel:/);
  assert.match(day, /href="\/#\/call\/c1"[^>]*>Open call</);
});

test("pipeline: header counts, Hot tag, grade, next line, thread link past ready, more, empty column, Lost", () => {
  const card = (id, extra = {}) => ({ place_id: id, business: `Biz ${id}`, grade: "–", hot: false, event: "You emailed · today", next: null, lead_link: `/#/lead/${id}`, thread_link: `/#/replies/${id}`, ...extra });
  const html = pipelineHtml({
    columns: [
      { stage: "ready", label: "Ready to email", count: 1, more: 0, cards: [card("r", { thread_link: null, grade: "A" })] },
      { stage: "emailed", label: "Emailed", count: 52, more: 2, cards: [card("e", { hot: true, next: "Next email tomorrow" })] },
      { stage: "won", label: "Won", count: 0, more: 0, cards: [] },
    ],
    lost: { count: 1, more: 0, cards: [card("l", { event: "Said no thanks · yesterday" })] },
  });
  assert.match(html, /Ready to email[\s\S]*?>1</);
  assert.match(html, /<span class="tag hot">Hot<\/span>/);
  assert.match(html, /Next email tomorrow/);
  assert.match(html, /\+2 more on the Leads page/);
  assert.match(html, /href="\/#\/leads\?view=all"/);
  assert.match(html, /Nobody here/);
  assert.match(html, /Lost \(1\)/);
  assert.match(html, /Said no thanks · yesterday/);
  assert.match(html, /grade a"/);
  // Ready cards have no thread link; the others do.
  assert.doesNotMatch(html, /href="\/#\/replies\/r"/);
  assert.match(html, /href="\/#\/replies\/e"[^>]*>Email thread</);
  // Columns with cards open, empty ones closed (on a phone they stack as <details>).
  assert.match(html, /<details class="col" data-key="col:ready" open>/);
  assert.match(html, /<details class="col" data-key="col:won">/);
  // The Lost section is collapsed.
  assert.match(html, /<details class="lost" data-key="lost">/);
  const empty = pipelineHtml({ columns: [{ stage: "ready", label: "Ready to email", count: 0, more: 0, cards: [] }], lost: { count: 0, cards: [] } });
  assert.match(empty, /No one in the pipeline yet\. Pick today&#39;s leads on the Leads page\./);
  assert.match(empty, /href="\/#\/leads\?view=ready"/);
});

test("clients: lines, late and failed card in red, care task, past clients, links", () => {
  const html = clientsHtml({
    cards: [
      { client_id: "c1", name: "Westside <b>Mechanics</b>", phase: "building", build: "2 days late", late: true, guarantee: null, rank: "No Map Rank scan yet", rank_link: "/#/maprank", monthly: "Card failed 20 Oct", card_failed: true, attention: true, care: null },
      { client_id: "c2", name: "Peak", phase: "live", build: null, late: false, guarantee: "Guarantee day 5 of 90", rank: "Top 3 in 40% of their area", rank_link: "/#/maprank?scan=s1&biz=p", monthly: "£249 a month", card_failed: false, attention: false, care: "Monthly check · Sat 24 Oct" },
    ],
    past: 3,
  });
  assert.match(html, /Westside &lt;b&gt;Mechanics/);
  assert.match(html, /class="late">2 days late/);
  assert.match(html, /class="late">Card failed 20 Oct/);
  assert.match(html, /No care tasks due/);
  assert.match(html, /Monthly check · Sat 24 Oct/);
  assert.match(html, /Guarantee day 5 of 90/);
  assert.match(html, /href="\/#\/maprank\?scan=s1&amp;biz=p"/);
  assert.match(html, /3 past clients on the Money page/);
  assert.match(html, /class="ccard attention"/);
  assert.doesNotMatch(clientsHtml({ cards: [], past: 2 }), /No clients yet/);
  assert.match(clientsHtml({ cards: [], past: 1 }), /1 past client on the Money page/);
  assert.match(clientsHtml(undefined), /No clients yet\. Your first one shows up here the minute they pay\./);
});

test("the seeded board renders every section", async () => {
  const DB = fakeD1();
  DB.exec(readFileSync(new URL("./fixtures/board-seed.sql", import.meta.url), "utf8"));
  const b = await loadBoard(DB, {}, new Date("2026-10-22T12:00:00Z"));
  const html = lightsHtml(b.health, b.health_error) + todoListHtml(b.today) + pipelineHtml(b.pipeline) + clientsHtml(b.clients);
  for (const c of b.pipeline.columns) assert.ok(html.includes(c.label), c.label);
  assert.match(html, /Lost \(1\)/);
  assert.match(html, /Castle Car Sales|Westside Mechanics/);
  assert.match(html, /Overdue/);
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
});
