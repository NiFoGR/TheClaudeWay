// The lead drawer's Email slot (stage 5–6, docs/rebuild/06-email-followups.md Part A §A3 and §A8, Task 13):
// public/js/compose.js. Its pure helpers (insertAt, sendLabel, statusLine, badge, queuedToast) and its pure renderers
// (emailSlotHtml, composerHtml, threadBlockHtml, previewHtml, checksHtml): the composer while the lead is ready and no
// first email is queued, sending or sent, else the thread; Cancel on a queued outgoing email, Try again on a failed
// first email; every server string escaped and every source link through safeUrl(). compose.js touches no page when it
// loads (lib.js, which reads the page, is loaded inside mountEmail), so this file needs none.
// Run: node --test control-room/tests/compose-ui.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COLD_WINDOW, badge, cancelDialogHtml, checksHtml, composerHtml, emailSlotHtml, insertAt, previewHtml, queuedToast,
  sendLabel, statusLine, threadBlockHtml,
} from "../public/js/compose.js";

// compose.js (and html.js) loaded above with no page at all.
const PURE = typeof globalThis.document === "undefined";

const XSS = `"><img src=x onerror=alert(1)>`;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
const count = (html, s) => html.split(s).length - 1;
// The text a person reads: tags dropped, entities decoded, spaces collapsed (none left before a full stop).
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ \./g, ".").trim();

const THU = Date.parse("2026-10-22T08:15:00Z"); // Thu 22 Oct 2026, 09:15 UK (BST): inside the cold window
const SUN = Date.parse("2026-10-25T10:00:00Z"); // Sun 25 Oct 2026, 10:00 UK (GMT from today): outside it

/** composeContext's answer for Green Leaf Landscapes, ready to email (as first-email.test.mjs's readyLead). */
const ctxOf = (patch = {}) => ({
  place_id: "p1",
  business: "Green Leaf Landscapes",
  to_options: [
    { email: "mark@greenleaf.co.uk", where: "Contact page", source_url: "https://greenleaf.co.uk/contact", best: true },
    { email: "info@greenleaf.co.uk", where: "Footer", source_url: "https://greenleaf.co.uk/", best: false },
  ],
  greeting: { line: "Hi Mark,", name: "Mark" },
  angle: [{ fact: "Only 3 photos on their site", source_url: "https://greenleaf.co.uk/" }],
  opener: "I was looking at your garden work in Leeds.",
  demo: { ok: true, url: "https://aetoswebsites.com/d/green-leaf", reason: "" },
  due_at: "2026-10-22T08:15:00Z",
  mailbox: { id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example" },
  sender_name: "Nik",
  blocking: [],
  followups_approved: true,
  stage: "ready",
  first_message_id: null,
  ...patch,
});
const msg = (patch = {}) => ({
  id: "m-1", direction: "out", kind: "first", step: null, author: "nik", subject: "Your website", body: "Hi Mark,\n\nHello.",
  status: "sent", due_at: "2026-10-22T08:15:00Z", sent_at: "2026-10-22T08:15:00Z", received_at: null, error: null, class: null,
  ...patch,
});

test("helpers", () => {
  assert.deepEqual(insertAt("ab", 1, "{demo_link}"), { text: "a{demo_link}b", cursor: 12 });
  assert.equal(sendLabel("2026-10-26T07:00:00Z", Date.parse("2026-10-25T10:00:00Z")), "Send Mon 07:00");
  assert.equal(sendLabel("2026-10-22T08:15:00Z", Date.parse("2026-10-22T08:15:00Z")), "Send now");
  assert.equal(statusLine({ status: "failed", error: "Mailbox password rejected" }, 0), "Didn't send: Mailbox password rejected");
  assert.equal(statusLine({ direction: "in", status: "received", class: "bounce", received_at: "2026-10-23T13:02:00Z" }, 0), "Bounced: the address doesn't work");
  assert.equal(badge("them"), "Them");
});

test("compose.js loads with no page", () => assert.equal(PURE, true));

test("insertAt keeps the cursor inside the text", () => {
  assert.deepEqual(insertAt("", 0, "{demo_link}"), { text: "{demo_link}", cursor: 11 });
  assert.deepEqual(insertAt("ab", 99, "!"), { text: "ab!", cursor: 3 });
  assert.deepEqual(insertAt("ab", -3, "!"), { text: "!ab", cursor: 1 });
  assert.deepEqual(insertAt("ab", undefined, "!"), { text: "ab!", cursor: 3 }); // no cursor yet: the end
  assert.deepEqual(insertAt(null, 0, "x"), { text: "x", cursor: 1 });
});

test("sendLabel: now inside the window, else the next window start", () => {
  // A context loaded inside the window and left open: its due_at is in the past.
  assert.equal(sendLabel("2026-10-22T08:15:00Z", Date.parse("2026-10-22T10:40:00Z")), "Send now");
  // Left open past 19:00 UK: the server will queue it for the next window start.
  assert.equal(sendLabel("2026-10-22T08:15:00Z", Date.parse("2026-10-22T18:05:00Z")), "Send Fri 07:00"); // 19:05 BST
  assert.equal(sendLabel("2026-10-24T08:00:00Z", Date.parse("2026-10-24T18:30:00Z")), "Send Mon 07:00"); // Sat 19:30
  assert.equal(sendLabel("", Date.parse("2026-10-27T05:30:00Z")), "Send Tue 07:00"); // Tue 05:30 GMT
  // A browser clock a little behind the server's is still "now".
  assert.equal(sendLabel("2026-10-22T08:15:00Z", Date.parse("2026-10-22T08:14:30Z")), "Send now");
  // More than 6 days away: the date too.
  assert.equal(sendLabel("2026-11-09T09:15:00Z", THU), "Send Mon 9 Nov 09:15");
});

test("statusLine: Part A §A8's wording", () => {
  assert.equal(statusLine(msg({ status: "queued", sent_at: null, due_at: "2026-10-26T07:00:00Z" }), SUN), "Goes out Mon 07:00");
  assert.equal(statusLine(msg({ status: "queued", sent_at: null, due_at: "2026-10-22T08:15:00Z" }), THU), "Going out in a few minutes");
  // Due, but the window has closed (a Saturday evening): it goes at the next window start.
  assert.equal(statusLine(msg({ status: "queued", sent_at: null, due_at: "2026-10-24T17:50:00Z" }), Date.parse("2026-10-24T18:30:00Z")), "Goes out Mon 07:00");
  assert.equal(statusLine(msg({ status: "sending", sent_at: null }), THU), "Sending…");
  assert.equal(statusLine(msg(), THU), "Sent 22 Oct 09:15");
  assert.equal(statusLine(msg({ sent_at: "2025-12-30T10:00:00Z" }), THU), "Sent 30 Dec 2025 10:00"); // another year
  assert.equal(statusLine(msg({ status: "failed", error: "  The send was interrupted. " }), THU), "Didn't send: The send was interrupted.");
  assert.equal(statusLine(msg({ status: "failed", error: null }), THU), "Didn't send");
  assert.equal(statusLine(msg({ status: "cancelled" }), THU), "Cancelled");
  const inbound = { direction: "in", kind: "inbound", author: "them", status: "received", received_at: "2026-10-23T13:02:00Z" };
  assert.equal(statusLine({ ...inbound, class: "human" }, THU), "Received 23 Oct 14:02");
  assert.equal(statusLine({ ...inbound, class: null }, THU), "Received 23 Oct 14:02");
  assert.equal(statusLine({ ...inbound, class: "auto" }, THU), "Auto-reply");
  assert.equal(statusLine({ ...inbound, class: "opt_out" }, THU), "Asked not to be emailed");
});

test("badge: who wrote it", () => {
  assert.equal(badge("nik"), "You");
  assert.equal(badge("claude"), "Claude");
  assert.equal(badge("system"), "System");
  assert.equal(badge("them"), "Them");
  assert.equal(badge("constructor"), "System"); // anything else (never a prototype key)
});

test("queuedToast: Part A §A3's toasts", () => {
  assert.equal(queuedToast("2026-10-22T08:15:00Z", THU), "Queued. It goes out within 5 minutes.");
  assert.equal(queuedToast("2026-10-26T07:00:00Z", SUN), "Queued for Mon 07:00.");
});

test("the composer: To, Subject, Body, helpers, the yellow note", () => {
  const html = composerHtml(ctxOf(), THU);
  assert.match(html, /data-compose/);
  // To: the sourced addresses only (a dropdown, no free typing), the best one preselected and labelled best.
  assert.match(html, /<select[^>]*data-to/);
  assert.match(html, /<option value="mark@greenleaf\.co\.uk" selected>mark@greenleaf\.co\.uk · best · Contact page<\/option>/);
  assert.match(html, /<option value="info@greenleaf\.co\.uk">info@greenleaf\.co\.uk · Footer<\/option>/);
  assert.match(html, /href="https:\/\/greenleaf\.co\.uk\/contact" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /placeholder="Short and plain, e\.g\. Your website"/);
  assert.match(html, /placeholder="Write it your way\. &#39;Hi Mark,&#39; and your sign-off are added for you\."/);
  // Helpers: Why them (with its source link), Claude's suggested opener with Insert, Insert demo link.
  assert.match(plain(html), /Why them Only 3 photos on their site/);
  assert.match(html, /Claude&#39;s suggested opener/);
  assert.match(html, /I was looking at your garden work in Leeds\./);
  assert.match(html, /data-insert-opener[^>]*>Insert</);
  assert.match(html, /data-insert-demo[^>]*>Insert demo link</);
  assert.match(html, /data-send disabled>Send now</);
  assert.doesNotMatch(html, /aren't approved yet|aren&#39;t approved yet/);

  const unapproved = composerHtml(ctxOf({ followups_approved: false, greeting: { line: "Hi,", name: null } }), THU);
  assert.match(plain(unapproved),
    /Your follow-ups aren't approved yet, so this lead won't get any until you approve them on the Voice page\./);
  assert.match(unapproved, /href="#\/voice"/);
  assert.match(unapproved, /placeholder="Write it your way\. &#39;Hi,&#39; and your sign-off are added for you\."/);
  // Outside the window the button says when it goes.
  assert.match(composerHtml(ctxOf({ due_at: "2026-10-26T07:00:00Z" }), SUN), /data-send disabled>Send Mon 07:00</);
  // No opener, no facts: those helpers aren't shown; Insert demo link always is.
  const bare = composerHtml(ctxOf({ angle: [], opener: "" }), THU);
  assert.doesNotMatch(bare, /Why them|data-insert-opener/);
  assert.match(bare, /data-insert-demo/);
});

test("the composer escapes everything from the server and links only http(s) sources", () => {
  const html = composerHtml(ctxOf({
    business: XSS,
    to_options: [{ email: `a@b.co${XSS}`, where: XSS, source_url: "javascript:alert(1)", best: true }],
    greeting: { line: `Hi ${XSS},`, name: XSS },
    angle: [{ fact: XSS, source_url: "javascript:alert(1)" }, { fact: "ok", source_url: `https://x.co/${XSS}` }],
    opener: XSS,
  }), THU);
  noRawHtml(html);
  assert.doesNotMatch(html, /javascript:/i);
  assert.ok(count(html, "&lt;img") >= 4);
});

test("the slot: the composer while ready, else the thread", () => {
  // Ready, nothing sent: the composer only.
  const fresh = emailSlotHtml(ctxOf(), { summary: "Follow-ups start the day after your first email goes", messages: [] }, THU);
  assert.match(fresh, /data-compose/);
  assert.doesNotMatch(fresh, /class="thread"/);

  // A first email queued: the thread with Cancel, no composer.
  const queued = emailSlotHtml(
    ctxOf({ blocking: [{ code: "queued_already", message: "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one." }] }),
    { summary: "Follow-ups start the day after your first email goes", messages: [msg({ status: "queued", sent_at: null })] }, THU,
  );
  assert.doesNotMatch(queued, /data-compose/);
  assert.match(queued, /class="thread"/);
  assert.match(queued, /data-cancel="m-1"/);
  assert.match(plain(queued), /Going out in a few minutes/);

  // Emailed: the thread, its summary, no Cancel on a sent one, no composer.
  const emailed = emailSlotHtml(ctxOf({ stage: "emailed", blocking: [{ code: "already_emailed", message: "x" }] }), {
    summary: "Follow-up 3 of 9: Mon 26 Oct 09:15",
    messages: [msg(), msg({ id: "f1", kind: "followup", step: 1, author: "system", subject: "Re: Your website", sent_at: "2026-10-23T08:15:00Z" }),
      msg({ id: "f2", kind: "followup", step: 2, author: "system", status: "queued", sent_at: null, due_at: "2026-10-24T08:15:00Z" })],
  }, THU);
  assert.doesNotMatch(emailed, /data-compose/);
  assert.match(plain(emailed), /Follow-up 3 of 9: Mon 26 Oct 09:15/);
  assert.match(emailed, /<span class="badge you">You<\/span>/);
  assert.match(emailed, /<span class="badge system">System<\/span>/);
  assert.match(plain(emailed), /Follow-up 1 · Sent 23 Oct 09:15/);
  assert.equal(count(emailed, "data-cancel="), 1);
  assert.match(emailed, /data-cancel="f2"/);
  assert.doesNotMatch(emailed, /data-retry/);

  // A failed first email on a ready lead: the thread with its error and Try again, and the composer to write a new one.
  const failed = emailSlotHtml(ctxOf({ first_message_id: "m-1" }), {
    summary: "Follow-ups start the day after your first email goes",
    messages: [msg({ status: "failed", sent_at: null, error: "Mailbox password rejected" })],
  }, THU);
  assert.match(failed, /<p class="error">Didn&#39;t send: Mailbox password rejected<\/p>/);
  assert.match(failed, /data-retry="m-1"[^>]*>Try again</);
  assert.match(failed, /data-compose/);

  // No prospect: why, in plain English.
  const none = emailSlotHtml(ctxOf({ stage: null, blocking: [{ code: "no_prospect", message: "This lead isn't ready to email yet: it needs a grade, an email and a demo first." }] }),
    { summary: "", messages: [] }, THU);
  assert.doesNotMatch(none, /data-compose|class="thread"/);
  assert.match(plain(none), /This lead isn't ready to email yet: it needs a grade, an email and a demo first\./);
});

test("Try again only on the newest failed first email, while none is waiting or sent and the lead is ready", () => {
  const two = [msg({ id: "a", status: "failed", sent_at: null }), msg({ id: "b", status: "failed", sent_at: null })];
  const html = threadBlockHtml({ summary: "", messages: two }, THU, { stage: "ready" });
  assert.equal(count(html, "data-retry="), 1);
  assert.match(html, /data-retry="b"/);
  // A copy already queued: no Try again.
  assert.doesNotMatch(threadBlockHtml({ messages: [...two, msg({ id: "c", status: "queued", sent_at: null })] }, THU, { stage: "ready" }), /data-retry/);
  // Not ready any more: no Try again.
  assert.doesNotMatch(threadBlockHtml({ messages: two }, THU, { stage: "lost" }), /data-retry/);
  // A failed follow-up never gets it.
  assert.doesNotMatch(threadBlockHtml({ messages: [msg({ kind: "followup", step: 1, status: "failed" })] }, THU, { stage: "ready" }), /data-retry/);
});

test("the thread: badges, inbound labels, plain-text bodies, long ones collapsed after 12 lines", () => {
  const inbound = { direction: "in", kind: "inbound", author: "them", status: "received", subject: "Re: Your website", received_at: "2026-10-23T13:02:00Z" };
  const html = threadBlockHtml({
    summary: "Follow-ups stopped: they replied",
    messages: [
      { ...inbound, id: "i1", class: "bounce", body: "Delivery failed" },
      { ...inbound, id: "i2", class: "human", body: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") },
      msg({ id: "r1", kind: "reply", author: "claude" }),
    ],
  }, THU, { stage: "replied" });
  assert.match(html, /<span class="badge them">Them<\/span>/);
  assert.match(html, /<span class="badge claude">Claude<\/span>/);
  assert.match(plain(html), /Bounced: the address doesn't work · 23 Oct 14:02/); // a labelled one keeps its time
  assert.match(plain(html), /Received 23 Oct 14:02/);
  assert.match(plain(html), /Reply · Sent 22 Oct 09:15/);
  assert.equal(count(html, "data-more"), 1);
  assert.match(html, /line 12\n…<\/pre>/);
  assert.match(html, /<pre class="msg-body" hidden>line 1\n[^<]*line 20<\/pre>/);
  assert.doesNotMatch(html, /data-cancel|data-retry/);
  assert.match(threadBlockHtml({ summary: "", messages: [] }, THU), /Nothing sent yet\./);
});

test("the thread escapes everything", () => {
  const html = threadBlockHtml({
    summary: XSS,
    messages: [msg({ id: XSS, subject: XSS, body: XSS, status: "failed", error: XSS }),
      msg({ id: `q${XSS}`, status: "queued", subject: XSS, body: XSS, author: XSS, kind: XSS })],
  }, THU, { stage: "ready" });
  noRawHtml(html);
  assert.ok(count(html, "&lt;img") >= 6);
});

test("the preview: From, To, Subject and the exact text", () => {
  const text = "Hi Mark,\n\nI made you a site: https://aetoswebsites.com/d/green-leaf\n\nNik";
  const html = previewHtml({ text, from: "Nik Example <nik@aetoswebsites.com>", issues: [] }, { to: "mark@greenleaf.co.uk", subject: "Your website" });
  assert.match(html, /What they&#39;ll see/);
  assert.match(plain(html), /From: Nik Example <nik@aetoswebsites\.com>/);
  assert.match(plain(html), /To: mark@greenleaf\.co\.uk/);
  assert.match(plain(html), /Subject: Your website/);
  assert.ok(html.includes(`<pre class="msg-body">Hi Mark,\n\nI made you a site: https://aetoswebsites.com/d/green-leaf\n\nNik</pre>`));
  assert.match(plain(previewHtml({ text: "", from: "", issues: [] }, { to: "", subject: "" })), /From: No mailbox can send it yet/);
  noRawHtml(previewHtml({ text: XSS, from: XSS }, { to: XSS, subject: XSS }));
});

test("checks: a green tick or a red line in plain English", () => {
  const fields = { to: "mark@greenleaf.co.uk" };
  // Nothing written yet: the red lines, and ticks only for what's been checked.
  const blank = checksHtml([
    { code: "subject_missing", message: "Add a subject." }, { code: "body_missing", message: "Write the email first." },
  ], ctxOf(), fields);
  assert.match(blank, /<li class="bad">Add a subject\.<\/li>/);
  assert.match(blank, /<li class="bad">Write the email first\.<\/li>/);
  assert.doesNotMatch(blank, /Demo link in once|Under 150 words|No other links/); // not checked without a body
  assert.match(blank, /<li class="ok">Their demo is ready<\/li>/);

  const good = checksHtml([], ctxOf(), fields);
  assert.equal(count(good, `class="bad"`), 0);
  for (const line of ["Subject added", "Email written", "Demo link in once", "No other links", "Under 150 words",
    "mark@greenleaf.co.uk is one of their addresses and OK to email", "Their demo is ready",
    "Room in your mailbox for it and its 9 follow-ups"]) assert.ok(plain(good).includes(line), line);

  const bad = checksHtml([
    { code: "other_link", message: "Only the demo link is allowed. Remove: www.greenleaf.co.uk" },
    { code: "no_room", message: "Your mailboxes are full on Mon 9 Nov (follow-ups already booked that day). Send this one tomorrow." },
    { code: "no_sender_name", message: "Add your name on Setup → Business details first: every email is signed with it." },
  ], ctxOf(), fields);
  assert.match(bad, /<li class="bad">Only the demo link is allowed\. Remove: www\.greenleaf\.co\.uk<\/li>/);
  assert.match(bad, /<li class="bad">Your mailboxes are full on Mon 9 Nov/);
  assert.match(bad, /<li class="bad">Add your name on Setup → Business details first/); // a code with no tick of its own
  assert.doesNotMatch(bad, /No other links|Room in your mailbox/);
  noRawHtml(checksHtml([{ code: XSS, message: XSS }, { code: "not_in_list", message: XSS }], ctxOf(), { to: XSS }));
});

// ---------------------------------------------------------------- review additions

test("the browser's cold window is the server's (functions/_lib/followups.js COLD_WINDOW)", async () => {
  const { COLD_WINDOW: server } = await import("../functions/_lib/followups.js");
  assert.deepEqual(COLD_WINDOW, server);
});

test("sendLabel at the window's edges, both clock changes", () => {
  // GMT (from Sun 25 Oct 2026): Mon 07:00 opens it, 06:59 doesn't.
  assert.equal(sendLabel("2026-10-26T07:00:00Z", Date.parse("2026-10-26T07:00:00Z")), "Send now");
  assert.equal(sendLabel("2026-10-26T07:00:00Z", Date.parse("2026-10-26T06:59:00Z")), "Send Mon 07:00");
  // BST: Sat 18:59 is the last minute in; 19:00 is out, and Sunday is skipped.
  assert.equal(sendLabel("2026-10-24T17:59:00Z", Date.parse("2026-10-24T17:59:00Z")), "Send now");
  assert.equal(sendLabel("2026-10-24T17:59:00Z", Date.parse("2026-10-24T18:00:00Z")), "Send Mon 07:00");
  assert.equal(sendLabel("2026-10-26T07:00:00Z", Date.parse("2026-10-25T12:00:00Z")), "Send Mon 07:00"); // Sunday
  // GMT → BST (Sun 28 Mar 2027): Mon 29 Mar 06:30Z is 07:30 UK, 05:30Z is 06:30 UK.
  assert.equal(sendLabel("2027-03-29T06:30:00Z", Date.parse("2027-03-29T06:30:00Z")), "Send now");
  assert.equal(sendLabel("2027-03-29T06:00:00Z", Date.parse("2027-03-29T05:30:00Z")), "Send Mon 07:00");
});

test("the Cancel dialog: Part A §A8's question, then Keep it / Cancel the email", () => {
  const first = cancelDialogHtml("first");
  assert.match(first, /<h2>Cancel this email\? It won&#39;t be sent\.<\/h2>/);
  assert.match(plain(first), /The lead stays ready to email, so you can write it again\./);
  assert.match(first, /data-close>Keep it</);
  assert.match(first, /data-cancel-yes>Cancel the email</);
  assert.match(first, /data-cancel-error hidden/);
  assert.match(plain(cancelDialogHtml("followup")), /That follow-up is skipped and the next one is booked as normal\./);
  const reply = cancelDialogHtml("reply");
  assert.match(reply, /Cancel this email\? It won&#39;t be sent\./);
  assert.doesNotMatch(reply, /stays ready|skipped/);
});

test("a first email waiting while their demo isn't ready (set aside after Send) says why, with Cancel", () => {
  const reason = "Their demo isn't ready: No demo yet: Excluded: a branch of a chain. Fix it on the Demo card first.";
  const queued = "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one.";
  const html = emailSlotHtml(
    ctxOf({ blocking: [{ code: "queued_already", message: queued }, { code: "demo_not_ready", message: reason }] }),
    { summary: "Follow-ups start the day after your first email goes", messages: [msg({ status: "queued", sent_at: null })] }, THU,
  );
  assert.match(html, /<p class="error"[^>]*>Their demo isn&#39;t ready: No demo yet: Excluded: a branch of a chain\. Fix it on the Demo card first\.<\/p>/);
  assert.match(html, /data-cancel="m-1"/);
  assert.doesNotMatch(html, /data-compose/);
  noRawHtml(emailSlotHtml(ctxOf({ blocking: [{ code: "queued_already", message: "q" }, { code: "demo_not_ready", message: XSS }] }),
    { messages: [msg({ status: "queued" })] }, THU));
  // Only while one waits: once sent, the summary line speaks for the follow-ups.
  const sent = emailSlotHtml(
    ctxOf({ stage: "emailed", blocking: [{ code: "already_emailed", message: "x" }, { code: "demo_not_ready", message: reason }] }),
    { summary: "Follow-ups on hold: their demo isn't available", messages: [msg()] }, THU,
  );
  assert.doesNotMatch(sent, /No demo yet/);
  // While Nik can write one, it is a red check in the composer, not a line above it.
  const ready = emailSlotHtml(ctxOf({ blocking: [{ code: "demo_not_ready", message: reason }] }), { messages: [] }, THU);
  assert.equal(count(ready, "No demo yet"), 0);
  assert.match(ready, /data-compose/);
});

test("leads.js mounts the slot as the panel opens once a first email is queued, sending, sent or failed", async () => {
  const src = await readFile(new URL("../public/js/leads.js", import.meta.url), "utf8");
  assert.match(src, /new Set\(\["queued", "sending", "sent", "failed"\]\)/);
  assert.match(src, /if \(hasFirstEmail\(detail\.messages\)\) showEmail\(r, id, ask\)/);
  assert.match(src, /await import\("\.\/compose\.js"\)/);
  assert.match(src, /compose\.mountEmail\(slot, id\)/);
});
