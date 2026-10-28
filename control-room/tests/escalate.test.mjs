// Stage 7 replies: escalations to Nik and Nik's own replies (escalateMessage, sendAsNik, dismissTodo in
// _lib/replies-db.js; routes POST /api/agent/escalate, /api/replies/send, /api/replies/dismiss).
// Run: node --test control-room/tests/escalate.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { onRequest as gate } from "../functions/_middleware.js";
import { dismissTodo, escalateMessage, recordReply, sendAsNik } from "../functions/_lib/replies-db.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { addTodo } from "../functions/_lib/todo.js";
import { onRequestPost as escalateRoute } from "../functions/api/agent/escalate.js";
import { onRequestPost as dismissRoute } from "../functions/api/replies/dismiss.js";
import { onRequestPost as sendRoute } from "../functions/api/replies/send.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const TOKEN = randomBytes(32).toString("base64url");
const ORIGIN = "https://control.example";
const D = (s) => new Date(s);
const NOW = D("2026-10-21T08:30:00Z"); // Wed 21 Oct 2026 09:30 UK
const EARLIER = "2026-10-19T07:00:00Z";
const DRAFT = "Hi Sam,\n\nSorry, you won't hear from me again.";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = async (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const count = async (DB, sql, ...args) => Number((await one(DB, sql, ...args)).n);

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
  message_id: `<${id}@them.co.uk>`, status: "received", received_at: at, class: "human", needs_reply: 1,
  created_at: at, ...extra,
});

// Task 9's seed for p1 (Nik's first email, a follow-up, m1 and m2 waiting, research A, the current demo and an older
// ended one), plus the thread's mailbox and the sender name. Only p1, so "SELECT stage FROM prospects" is p1's.
async function seeded() {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", TOKEN);
  await setSetting(DB, "business:sender_name", "Nik");
  await insert(DB, "mailboxes", {
    id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik Smith", role: "cold", started_on: "2026-09-01", created_at: EARLIER,
  });
  await insert(DB, "leads", lead("p1", "GREEN LEAF LANDSCAPES LTD"));
  await insert(DB, "prospects", prospect("p1"));
  await insert(DB, "messages", out("f1", "p1", "first", "nik", "2026-10-19T09:00:00Z", {
    body: "Hi Sam,\n\nYour demo: https://aetoswebsites.com/d/green-leaf-ab12\n\nNik\nAetos Websites\nReply \"no thanks\" and I won't email again.",
  }));
  await insert(DB, "messages", out("fu1", "p1", "followup", "system", "2026-10-20T09:00:00Z", { step: 1 }));
  await insert(DB, "messages", inbound("m1", "p1", "2026-10-21T08:05:00Z", { body: "Looks good." }));
  await insert(DB, "messages", inbound("m2", "p1", "2026-10-21T08:07:00Z", { body: "Stop sending me this rubbish.\n\nOn Tue, Nik wrote:\n> Hi" }));
  await insert(DB, "research", {
    place_id: "p1", status: "done", grade: "A", grade_reason: "Busy, weak site.",
    angle: JSON.stringify([{ fact: "No website on Google Maps.", source_url: "https://maps.google.com/x" }]),
    owner: JSON.stringify({ first: "Sam", full: "Sam Green", source_url: "https://greenleaf.co.uk/about", confident: true }),
    site_review: JSON.stringify({ verdict: "weak", summary: "One page, no services listed.", problems: [], good: [] }),
    queued_at: EARLIER, researched_at: EARLIER,
  });
  await insert(DB, "demos", { slug: "green-leaf-ab12", place_id: "p1", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-03-30T09:00:00Z" });
  await insert(DB, "demos", { slug: "green-leaf-old1", place_id: "p1", created_at: "2026-03-01T09:00:00Z", expires_at: "2026-03-15T09:00:00Z" });
  return DB;
}

test("escalate, Claude kept out of the thread, then Nik's Send as me (the spec's test)", async () => {
  const DB = await seeded();
  const e = await escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "Swearing about the emails", draft: "Hi Sam,\n\nSorry, you won't hear from me again.", now: NOW });
  assert.equal(e.status, 200);
  const t = await one(DB, "SELECT * FROM todos WHERE dedupe='escalation:m2'");
  assert.equal(t.kind, "escalation"); assert.equal(t.title, "Angry reply from Green Leaf Landscapes: Claude's draft is ready");
  assert.equal(t.draft, "Hi Sam,\n\nSorry, you won't hear from me again."); assert.match(t.detail, /^Swearing about the emails\n\nThey wrote:\n/);
  assert.equal(t.link, "/#/replies/p1");
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "needs_nik");
  assert.equal((await one(DB, "SELECT needs_reply, intent FROM messages WHERE id='m2'")).intent, "angry");
  assert.equal((await escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "x", draft: "y", now: NOW })).status, 409);
  await insert(DB, "messages", inbound("m9", "p1", "2026-10-21T08:20:00Z", { body: "And another thing." }));
  assert.equal((await recordReply(DB, { message_id: "m9", intent: "price", body: "Hi", now: NOW })).status, 409); // m9 same thread, needs_nik
  const s = await sendAsNik(DB, { message_id: "m2", body: "Hi Sam, sorry about that. Nik", now: D("2026-10-21T23:50:00Z") });
  assert.equal(s.status, 200);
  const r = await one(DB, "SELECT * FROM messages WHERE author='nik' AND kind='reply'");
  assert.equal(r.due_at, "2026-10-21T23:50:00Z");                       // Nik's replies go at any hour
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe='escalation:m2'")).status, "done");
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "replied");
  assert.equal((await sendAsNik(DB, { message_id: "m2", body: " ", now: NOW })).body.error, "Couldn't save: write something first.");
});

test("escalateMessage: the todo's detail, handled messages, titles for each intent", async () => {
  const DB = await seeded();
  const e = await escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "  Swearing\nabout the emails  ", draft: DRAFT, now: NOW });
  assert.equal(e.status, 200);
  assert.equal(e.body.ok, true);
  const t = await one(DB, "SELECT * FROM todos WHERE dedupe='escalation:m2'");
  assert.equal(t.detail, "Swearing about the emails\n\nThey wrote:\nStop sending me this rubbish."); // quoted history off
  assert.equal(t.due_at, "2026-10-21T08:30:00Z");
  assert.equal(t.place_id, "p1");
  assert.equal(t.status, "open");
  assert.equal(e.body.todo_id, t.id);
  // the earlier waiting message is handled too (no intent); m2 carries the intent
  assert.deepEqual(await all(DB, "SELECT id, needs_reply, handled_at, intent FROM messages WHERE direction='in' ORDER BY id"), [
    { id: "m1", needs_reply: 0, handled_at: "2026-10-21T08:30:00Z", intent: null },
    { id: "m2", needs_reply: 0, handled_at: "2026-10-21T08:30:00Z", intent: "angry" },
  ]);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0); // nothing is sent

  // a new message in a needs_nik thread is escalated too (other), with its own todo
  await insert(DB, "messages", inbound("m9", "p1", "2026-10-21T08:20:00Z", { body: "Hello?" }));
  const again = await escalateMessage(DB, { message_id: "m9", intent: "other", reason: "Thread is with Nik", draft: "Hi Sam,\n\nNik here.", now: NOW });
  assert.equal(again.status, 200);
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe='escalation:m9'")).title, "Green Leaf Landscapes needs you: Claude's draft is ready");

  const titles = { legal: "Legal question from Green Leaf Landscapes: Claude's draft is ready", unclear: "Unclear reply from Green Leaf Landscapes: Claude's draft is ready" };
  for (const [intent, title] of Object.entries(titles)) {
    const DB2 = await seeded();
    assert.equal((await escalateMessage(DB2, { message_id: "m2", intent, reason: "r", draft: DRAFT, now: NOW })).status, 200);
    assert.equal((await one(DB2, "SELECT title FROM todos WHERE dedupe='escalation:m2'")).title, title);
  }
});

test("escalateMessage refusals", async () => {
  const DB = await seeded();
  const post = (x) => escalateMessage(DB, { now: NOW, message_id: "m2", intent: "angry", reason: "r", draft: DRAFT, ...x });
  assert.equal((await post({ message_id: "nope" })).status, 404);
  assert.equal((await post({ message_id: "f1" })).status, 404);                 // ours, not theirs
  assert.equal((await post({ message_id: undefined })).status, 404);
  const older = await post({ message_id: "m1" });
  assert.equal(older.status, 409); assert.equal(older.body.error, "A newer message is waiting from them: escalate m2.");
  const intent = await post({ intent: "price" });
  assert.equal(intent.status, 422); assert.deepEqual(intent.body.reasons, ["Escalate only angry, legal, unclear or other: answer the rest with /api/agent/reply."]);
  const noDraft = await post({ draft: "  " });
  assert.equal(noDraft.status, 422); assert.deepEqual(noDraft.body.reasons, ["Write the draft reply Nik can edit and send."]);
  const long = await post({ draft: "x".repeat(4001) });
  assert.equal(long.status, 422); assert.deepEqual(long.body.reasons, ["The draft is too long: 4,001 characters (4,000 max)."]);
  const noReason = await post({ reason: "" });
  assert.equal(noReason.status, 422); assert.deepEqual(noReason.body.reasons, ["Say in reason, in one line, why Nik should look at it."]);
  // nothing written by any refusal
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM todos"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply = 1"), 2);
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "replied");
  // 4,000 characters exactly is stored as given
  assert.equal((await post({ draft: `  ${"y".repeat(3996)}\n\n` })).status, 200);
  assert.equal((await one(DB, "SELECT draft FROM todos")).draft, `  ${"y".repeat(3996)}\n\n`);
});

test("two Routine sessions escalate the same message at once: one 200, one 409, one todo", async () => {
  const DB = await seeded();
  const post = () => escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "r", draft: DRAFT, now: NOW });
  const results = await Promise.all([post(), post()]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM todos"), 1);
  // and a reply racing an escalation: whichever lands first wins, the other is 409
  const DB2 = await seeded();
  const [a, b] = await Promise.all([
    escalateMessage(DB2, { message_id: "m2", intent: "angry", reason: "r", draft: DRAFT, now: NOW }),
    recordReply(DB2, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950.", now: NOW }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(await count(DB2, "SELECT COUNT(*) n FROM todos WHERE kind='escalation'") + await count(DB2, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 1);
});

test("sendAsNik: the reply row, threaded, unchecked, any hour; errors in plain English", async () => {
  const DB = await seeded();
  await escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "r", draft: DRAFT, now: NOW });
  // Nik's words skip the guard: a price that isn't ours and "SEO" are his call
  const s = await sendAsNik(DB, { message_id: "m2", body: "Hi Sam,\r\n\r\nSorry. It's £1,500 for you, SEO included.  ", now: D("2026-10-22T02:10:00Z") });
  assert.equal(s.status, 200);
  const r = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(s.body.reply_id, r.id); assert.equal(s.body.status, "queued"); assert.equal(s.body.due_at, "2026-10-22T02:10:00Z");
  assert.equal(r.author, "nik"); assert.equal(r.direction, "out"); assert.equal(r.status, "queued");
  assert.equal(r.mailbox_id, "mb1"); assert.equal(r.from_addr, "nik@aetoswebsites.com"); assert.equal(r.to_addr, "p1@them.co.uk");
  assert.equal(r.subject, "Re: Your new website"); assert.equal(r.in_reply_to, "<m2@them.co.uk>"); assert.equal(r.refs, "<m2@them.co.uk>");
  assert.equal(r.body, "Hi Sam,\n\nSorry. It's £1,500 for you, SEO included.\n\nNik\nAetos Websites");
  assert.equal(r.place_id, "p1");

  // Reply as me on a waiting message: it and the earlier ones are handled, so Claude doesn't answer them too
  await insert(DB, "messages", inbound("m10", "p1", "2026-10-22T08:00:00Z"));
  await insert(DB, "messages", inbound("m11", "p1", "2026-10-22T08:01:00Z"));
  await insert(DB, "messages", inbound("m12", "p1", "2026-10-22T08:02:00Z"));
  assert.equal((await sendAsNik(DB, { message_id: "m11", body: "Thanks.", now: D("2026-10-22T08:05:00Z") })).status, 200);
  assert.deepEqual((await all(DB, "SELECT id, needs_reply FROM messages WHERE id IN ('m10','m11','m12') ORDER BY id")).map((m) => m.needs_reply), [0, 0, 1]);

  const missing = await sendAsNik(DB, { message_id: "nope", body: "Hi", now: NOW });
  assert.equal(missing.status, 404);
  assert.equal((await sendAsNik(DB, { message_id: "f1", body: "Hi", now: NOW })).status, 404); // ours, not theirs
  const empty = await sendAsNik(DB, { message_id: "m2", body: undefined, now: NOW });
  assert.equal(empty.status, 422); assert.equal(empty.body.error, "Couldn't save: write something first.");
  // no mailbox on the thread (none on the prospect, none on their message)
  await DB.prepare("UPDATE prospects SET mailbox_id = NULL").run();
  await DB.prepare("UPDATE messages SET mailbox_id = NULL WHERE id = 'm12'").run();
  const box = await sendAsNik(DB, { message_id: "m12", body: "Hi", now: NOW });
  assert.equal(box.status, 422);
  assert.equal(box.body.error, "Couldn't send: this thread has no mailbox. Add one on Setup → Mailboxes, then try again.");
  // the mailbox the message came in on is used when the prospect has none
  assert.equal((await sendAsNik(DB, { message_id: "m10", body: "Hi", now: NOW })).status, 200);
  assert.equal((await one(DB, "SELECT mailbox_id FROM messages WHERE in_reply_to = '<m10@them.co.uk>'")).mailbox_id, "mb1");
});

test("sendAsNik: a suppressed address is refused, a drill thread is never sent", async () => {
  const DB = await seeded();
  await insert(DB, "suppression", { value: "p1@them.co.uk", kind: "email", reason: "opt_out", created_at: EARLIER });
  const s = await sendAsNik(DB, { message_id: "m2", body: "Hi", now: NOW });
  assert.equal(s.status, 422);
  assert.equal(s.body.error, "Couldn't send: p1@them.co.uk is on the do-not-email list (they opted out). Nothing was sent.");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);

  await insert(DB, "prospects", prospect("drill:angry", { stage: "needs_nik", mailbox_id: null, greet_name: null }));
  await insert(DB, "messages", inbound("drill-angry", "drill:angry", "2026-10-21T08:00:00Z", { mailbox_id: null, needs_reply: 0 }));
  const d = await sendAsNik(DB, { message_id: "drill-angry", body: "Hi", now: NOW });
  assert.equal(d.status, 200);
  assert.deepEqual(await one(DB, "SELECT status, error FROM messages WHERE place_id='drill:angry' AND kind='reply'"), { status: "cancelled", error: "drill: not sent" });
});

test("closing: escalation and call_time for the message; nik_handled only when no other is open", async () => {
  const DB = await seeded();
  await escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "r", draft: DRAFT, now: NOW });
  await insert(DB, "messages", inbound("m9", "p1", "2026-10-21T08:20:00Z"));
  await escalateMessage(DB, { message_id: "m9", intent: "other", reason: "r", draft: DRAFT, now: NOW });
  await addTodo(DB, { kind: "call_time", title: "Confirm a time", place_id: "p1", due_at: NOW, dedupe: "call_time:m2" });
  // a todo for another message id that starts the same is left alone
  await insert(DB, "messages", inbound("m20", "p1", "2026-10-21T08:00:00Z", { needs_reply: 0 }));
  await addTodo(DB, { kind: "escalation", title: "Other", place_id: "pX", due_at: NOW, dedupe: "escalation:m20" });

  assert.equal((await sendAsNik(DB, { message_id: "m2", body: "Sorry.", now: NOW })).status, 200);
  assert.deepEqual(await all(DB, "SELECT dedupe, status, done_at FROM todos ORDER BY dedupe"), [
    { dedupe: "call_time:m2", status: "done", done_at: "2026-10-21T08:30:00Z" },
    { dedupe: "escalation:m2", status: "done", done_at: "2026-10-21T08:30:00Z" },
    { dedupe: "escalation:m20", status: "open", done_at: null },
    { dedupe: "escalation:m9", status: "open", done_at: null },
  ]);
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "needs_nik"); // m9's escalation is still open

  const t9 = await one(DB, "SELECT id FROM todos WHERE dedupe='escalation:m9'");
  const d = await dismissTodo(DB, { todo_id: t9.id, now: NOW });
  assert.equal(d.status, 200); assert.equal(d.body.ok, true);
  assert.deepEqual(await one(DB, "SELECT status, done_at FROM todos WHERE id = ?", t9.id), { status: "dismissed", done_at: "2026-10-21T08:30:00Z" });
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "replied");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 1); // Dismiss sends nothing
});

test("dismissTodo: refusals, the message's call_time closed too, a booked call keeps call_booked", async () => {
  const DB = await seeded();
  assert.equal((await dismissTodo(DB, { todo_id: "nope", now: NOW })).status, 404);
  assert.equal((await dismissTodo(DB, { now: NOW })).status, 404);
  const other = await addTodo(DB, { kind: "pick", title: "Pick", due_at: NOW, dedupe: "checkback:p1" });
  const wrong = await dismissTodo(DB, { todo_id: other, now: NOW });
  assert.equal(wrong.status, 422); assert.equal(wrong.body.error, "Only an escalation or a call-time Todo can be dismissed here.");

  await escalateMessage(DB, { message_id: "m2", intent: "unclear", reason: "r", draft: DRAFT, now: NOW });
  await addTodo(DB, { kind: "call_time", title: "Confirm a time", place_id: "p1", due_at: NOW, dedupe: "call_time:m2" });
  await insert(DB, "calls", { id: "c1", place_id: "p1", slot_at: "2026-10-23T10:00:00Z", status: "confirmed", phone: "01925 123456", note: "", created_at: EARLIER, updated_at: EARLIER });
  const ct = await one(DB, "SELECT id FROM todos WHERE dedupe='call_time:m2'");
  assert.equal((await dismissTodo(DB, { todo_id: ct.id, now: NOW })).status, 200);
  assert.deepEqual((await all(DB, "SELECT status FROM todos WHERE dedupe IN ('call_time:m2','escalation:m2') ORDER BY dedupe")).map((t) => t.status), ["dismissed", "dismissed"]);
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "call_booked"); // their confirmed call is still ahead
  const twice = await dismissTodo(DB, { todo_id: ct.id, now: NOW });
  assert.equal(twice.status, 409); assert.equal(twice.body.error, "That Todo is already closed.");
});

test("routes: the agent token on /api/agent/escalate, Nik's login on /api/replies/*, Send as me goes at once", async () => {
  const DB = await seeded();
  const env = { DB };
  const req = (path, body, headers = {}) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const agent = (body, token = TOKEN) => escalateRoute({ request: req("/api/agent/escalate", body, token ? { authorization: `Bearer ${token}` } : {}), env, now: NOW });
  assert.equal((await agent({ message_id: "m2", intent: "angry", reason: "r", draft: DRAFT }, "wrong")).status, 401);
  assert.equal((await agent({ message_id: "m2", intent: "angry", reason: "r", draft: DRAFT }, null)).status, 401);
  const notJson = await escalateRoute({ request: new Request(`${ORIGIN}/api/agent/escalate`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "nope" }), env, now: NOW });
  assert.equal(notJson.status, 400);
  const res = await agent({ message_id: "m2", intent: "angry", reason: "r", draft: DRAFT });
  assert.equal(res.status, 200); assert.equal((await res.json()).ok, true);
  assert.equal((await agent({ message_id: "m2", intent: "angry", reason: "r", draft: DRAFT })).status, 409);

  // the gate: /api/replies/* needs the login cookie (no Bearer token gets past it); /api/agent/* reaches its function
  for (const path of ["/api/replies/send", "/api/replies/dismiss"]) {
    const gated = await gate({
      request: new Request(`https://control-room.pages.dev${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      env: { ...env, CONTROL_ROOM_PASSWORD: "correct horse battery staple" },
      next: () => assert.fail(`${path} reached its function without a login`),
    });
    assert.equal(gated.status, 401, path);
  }
  let reached = false;
  await gate({
    request: new Request("https://control-room.pages.dev/api/agent/escalate", { method: "POST" }),
    env: { ...env, CONTROL_ROOM_PASSWORD: "correct horse battery staple" },
    next: async () => { reached = true; return new Response("{}"); },
  });
  assert.equal(reached, true);

  const waits = [];
  const ctx = (path, body) => ({ request: req(path, body), env, now: NOW, waitUntil: (p) => waits.push(p) });
  const empty = await sendRoute(ctx("/api/replies/send", { message_id: "m2", body: "" }));
  assert.equal(empty.status, 422); assert.equal((await empty.json()).error, "Couldn't save: write something first.");
  assert.equal(waits.length, 0);
  const sent = await sendRoute(ctx("/api/replies/send", { message_id: "m2", body: "Sorry, Sam." }));
  assert.equal(sent.status, 200); assert.equal((await sent.json()).status, "queued");
  assert.equal(waits.length, 1);
  assert.deepEqual(await waits[0], { sent: 0, failed: 0, held: 1 }); // no mailbox password in the test: held, never lost
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe='escalation:m2'")).status, "done");
  const badSend = await sendRoute({ request: new Request(`${ORIGIN}/api/replies/send`, { method: "POST", body: "nope" }), env, now: NOW });
  assert.equal(badSend.status, 400);

  const todo = await addTodo(DB, { kind: "escalation", title: "Your client emailed", place_id: "p1", due_at: NOW, dedupe: "client-mail:m1" });
  const dis = await dismissRoute(ctx("/api/replies/dismiss", { todo_id: todo }));
  assert.equal(dis.status, 200);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE id = ?", todo)).status, "dismissed");
  assert.equal((await dismissRoute(ctx("/api/replies/dismiss", { todo_id: "nope" }))).status, 404);
});

test("sendAsNik: a double press of Send queues one reply; new words, or after Cancel, queue another", async () => {
  const DB = await seeded();
  await escalateMessage(DB, { message_id: "m2", intent: "angry", reason: "r", draft: DRAFT, now: NOW });
  const first = await sendAsNik(DB, { message_id: "m2", body: "Sorry, Sam.", now: NOW });
  const again = await sendAsNik(DB, { message_id: "m2", body: "Sorry, Sam.\n", now: D("2026-10-21T08:31:00Z") });
  assert.equal(first.status, 200); assert.equal(again.status, 200);
  assert.equal(again.body.reply_id, first.body.reply_id);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply' AND author='nik'"), 1);
  // different words are a new reply
  assert.equal((await sendAsNik(DB, { message_id: "m2", body: "One more thing.", now: D("2026-10-21T08:32:00Z") })).status, 200);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply' AND author='nik'"), 2);
  // cancelled, then sent again: it goes
  await DB.prepare("UPDATE messages SET status = 'cancelled' WHERE id = ?").bind(first.body.reply_id).run();
  const resent = await sendAsNik(DB, { message_id: "m2", body: "Sorry, Sam.", now: D("2026-10-21T08:33:00Z") });
  assert.notEqual(resent.body.reply_id, first.body.reply_id);
  // the same words much later are a new reply too
  const later = await sendAsNik(DB, { message_id: "m2", body: "Sorry, Sam.", now: D("2026-10-21T09:00:00Z") });
  assert.notEqual(later.body.reply_id, resent.body.reply_id);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply' AND author='nik' AND status='queued'"), 3);
});
