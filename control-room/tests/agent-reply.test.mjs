// Stage 7 replies: POST /api/agent/reply (recordReply in _lib/replies-db.js). Claude's reply is checked (replyGuard,
// the call day, the slot), then queued in the thread from the thread's mailbox in one batch with the waiting messages
// marked handled; the intent's stage event, call and Todos follow. Run: node --test control-room/tests/agent-reply.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { recordReply } from "../functions/_lib/replies-db.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { onRequestPost } from "../functions/api/agent/reply.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const TOKEN = randomBytes(32).toString("base64url");
const ORIGIN = "https://control.example";
const D = (s) => new Date(s);
const NOW = D("2026-10-21T08:30:00Z"); // Wed 21 Oct 2026 09:30 UK
const EARLIER = "2026-10-19T07:00:00Z";

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

// Task 9's seed (p1: Nik's first email and its nik_sent row, a follow-up, m1 and m2 waiting, research A, the current
// demo and an older ended one), plus the thread's mailbox and the sender name. Task 9's won p2 with a handled inbound
// message is left out: the spec's own check lists every inbound message and expects only m1 and m2.
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
  await insert(DB, "style_examples", {
    id: "sent:f1", kind: "example", situation: "first email", body: "Hi Sam,\n\nYour demo: https://aetoswebsites.com/d/green-leaf-ab12",
    source: "nik_sent", created_at: "2026-10-19T09:00:00Z",
  });
  await insert(DB, "messages", out("fu1", "p1", "followup", "system", "2026-10-20T09:00:00Z", { step: 1 }));
  await insert(DB, "messages", inbound("m1", "p1", "2026-10-21T08:05:00Z", { body: "Looks good." }));
  await insert(DB, "messages", inbound("m2", "p1", "2026-10-21T08:07:00Z", { body: "How much?\n\nOn Tue, Nik wrote:\n> Hi" }));
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

// Another lead's thread with one waiting message (id) from <place_id>@them.co.uk.
async function thread(DB, place_id, name, id, extra = {}) {
  if (name) await insert(DB, "leads", lead(place_id, name));
  await insert(DB, "prospects", prospect(place_id, extra));
  await insert(DB, "messages", inbound(id, place_id, "2026-10-21T08:00:00Z"));
}

const req = (body, token = TOKEN) => new Request(`${ORIGIN}/api/agent/reply`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test("POST /api/agent/reply: checked, threaded replies and what each intent does (the spec's test)", async () => {
  const DB = await seeded();
  let minute = 10;
  const addWaiting = (id) => insert(DB, "messages", inbound(id, "p1", `2026-10-21T08:${minute++}:00Z`));

  const ok = await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950 for the website, then £249 a month, with the first 60 days free.\n\nhttps://aetoswebsites.com/d/green-leaf-ab12/order", now: NOW });
  assert.equal(ok.status, 200);
  const r = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(r.author, "claude"); assert.equal(r.in_reply_to, "<m2@them.co.uk>"); assert.match(r.body, /\n\nNik\nAetos Websites$/);
  assert.deepEqual((await all(DB, "SELECT id, needs_reply, intent FROM messages WHERE direction='in' ORDER BY id")).map((m) => [m.id, m.needs_reply, m.intent]), [["m1", 0, null], ["m2", 0, "price"]]);
  assert.equal((await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi", now: NOW })).status, 409);       // duplicate session
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 1);
  // newer message waiting
  await addWaiting("m3"); await addWaiting("m4");
  assert.match((await recordReply(DB, { message_id: "m3", intent: "question", body: "Hi", now: NOW })).body.error, /reply to m4/);
  // guard
  const bad = await recordReply(DB, { message_id: "m4", intent: "price", body: "It's £1,500 and we do SEO.", now: NOW });
  assert.equal(bad.status, 422); assert.equal(bad.body.reasons.length, 2);
  assert.equal((await recordReply(DB, { message_id: "m4", intent: "angry", body: "x", now: NOW })).status, 422);
  // call offer and confirm
  const off = await recordReply(DB, { message_id: "m4", intent: "call_request", body: "Hi Sam,\n\nYes of course. Soonest I am available for a phone call is Friday 23 October at 11am. If that doesn't work let me know a day and time if you can. Thank you.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" }, now: NOW });
  assert.equal(off.status, 200); assert.equal((await one(DB, "SELECT status FROM calls")).status, "offered");
  // night reply waits for 07:00
  await addWaiting("m5");
  await recordReply(DB, { message_id: "m5", intent: "interested", body: "Hi Sam,\n\nGreat. Press Order on your demo when you're ready.", now: D("2026-10-21T22:31:00Z") });
  assert.equal((await one(DB, "SELECT due_at FROM messages WHERE in_reply_to='<m5@them.co.uk>'")).due_at, "2026-10-22T06:00:00Z");
  // not now, not interested, opt out, proposes time
  await addWaiting("m6");
  await recordReply(DB, { message_id: "m6", intent: "proposes_time", body: "Hi Sam,\n\nLet me check and I'll confirm by the end of the day.", asked_time: "Thu 3pm", now: NOW });
  const ct = await one(DB, "SELECT * FROM todos WHERE dedupe='call_time:m6'");
  assert.equal(ct.title, "Confirm a time with Sam (Green Leaf Landscapes) by 6pm (they asked for Thu 3pm)"); assert.equal(ct.due_at, "2026-10-21T17:00:00Z");
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='p1'")).stage, "needs_nik");
  // (p7 in its own thread)
  await thread(DB, "p7", "OAK TREE ROOFING LTD", "m7");
  await recordReply(DB, { message_id: "m7", intent: "not_now", body: "Hi,\n\nNo problem. Would it be OK if I checked back in with you in 3 months?", now: NOW });
  assert.deepEqual(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id='p7'"), { stage: "lost", lost_reason: "not_now" });
  assert.equal((await one(DB, "SELECT due_at FROM todos WHERE dedupe='checkback:p7'")).due_at, "2027-01-19T08:30:00Z");
  await thread(DB, "p8", "Pine Plumbing", "m8");
  await recordReply(DB, { message_id: "m8", intent: "opt_out", now: NOW });
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE in_reply_to='<m8@them.co.uk>'"), 0);
  assert.equal((await one(DB, "SELECT reason FROM suppression WHERE value='p8@them.co.uk'")).reason, "opt_out");
  // drill replies are never sent
  await thread(DB, "drill:price", null, "drill-price", { stage: "emailed", greet_name: null });
  await recordReply(DB, { message_id: "drill-price", intent: "price", body: "Hi,\n\nIt's £1,950.", now: NOW });
  assert.deepEqual(await one(DB, "SELECT status, error FROM messages WHERE place_id='drill:price' AND kind='reply'"), { status: "cancelled", error: "drill: not sent" });
});

test("two Routine sessions answer the same message at once: one 200, one 409, one reply", async () => {
  const DB = await seeded();
  const body = "Hi Sam,\n\nIt's £1,950 for the website, then £249 a month.";
  const results = await Promise.all([
    recordReply(DB, { message_id: "m2", intent: "price", body, now: NOW }),
    recordReply(DB, { message_id: "m2", intent: "price", body, now: NOW }),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  assert.equal(results.find((x) => x.status === 409).body.error, "Already answered.");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 1);
});

test("the reply row: thread, mailbox, subject, signature, handled times", async () => {
  const DB = await seeded();
  const res = await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi Sam,\r\n\r\nIt's £1,950.  ", now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true); assert.equal(res.body.status, "queued"); assert.equal(res.body.due_at, "2026-10-21T08:30:00Z");
  const r = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(res.body.reply_id, r.id);
  assert.equal(r.mailbox_id, "mb1"); assert.equal(r.from_addr, "nik@aetoswebsites.com"); assert.equal(r.to_addr, "p1@them.co.uk");
  assert.equal(r.subject, "Re: Your new website");
  assert.equal(r.refs, "<m2@them.co.uk>");
  assert.equal(r.body, "Hi Sam,\n\nIt's £1,950.\n\nNik\nAetos Websites");
  assert.equal(r.status, "queued"); assert.equal(r.direction, "out"); assert.equal(r.place_id, "p1");
  assert.match(r.message_id, /^<[^@>]+@aetoswebsites\.com>$/);
  const handled = await all(DB, "SELECT id, handled_at FROM messages WHERE id IN ('m1', 'm2') ORDER BY id");
  assert.deepEqual(handled.map((m) => m.handled_at), ["2026-10-21T08:30:00Z", "2026-10-21T08:30:00Z"]);
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='p1'")).stage, "replied");
  // from a different address at their firm: Claude answers the address that wrote, prospects.email unchanged
  await insert(DB, "messages", inbound("m3", "p1", "2026-10-21T08:20:00Z", { from_addr: "office@them.co.uk" }));
  await recordReply(DB, { message_id: "m3", intent: "interested", body: "Hi,\n\nGreat, press Order on your demo when you're ready.", now: NOW });
  assert.equal((await one(DB, "SELECT to_addr FROM messages WHERE in_reply_to='<m3@them.co.uk>'")).to_addr, "office@them.co.uk");
  assert.equal((await one(DB, "SELECT email FROM prospects WHERE place_id='p1'")).email, "p1@them.co.uk");
});

test("refusals, in the spec's order, with their exact text", async () => {
  const DB = await seeded();
  const post = (x) => recordReply(DB, { now: NOW, ...x });
  assert.equal((await post({ message_id: "nope", intent: "price", body: "Hi" })).status, 404);
  assert.equal((await post({ message_id: "f1", intent: "price", body: "Hi" })).status, 404);           // ours, not theirs
  assert.equal((await post({ intent: "price", body: "Hi" })).status, 404);
  assert.deepEqual((await post({ message_id: "m1", intent: "price", body: "Hi" })).body.error, "A newer message is waiting from them: reply to m2.");
  const unknown = await post({ message_id: "m2", intent: "chit_chat", body: "Hi" });
  assert.equal(unknown.status, 422); assert.equal(unknown.body.error, "Use /api/agent/escalate for angry, legal, unclear or other.");
  for (const intent of ["angry", "legal", "unclear", "other"]) {
    assert.equal((await post({ message_id: "m2", intent, body: "x" })).body.error, "Use /api/agent/escalate for angry, legal, unclear or other.");
  }
  const empty = await post({ message_id: "m2", intent: "price", body: "   " });
  assert.equal(empty.status, 422); assert.deepEqual(empty.body.reasons, ["Write a reply, or escalate."]);
  const guard = await post({ message_id: "m2", intent: "price", body: "Hi Sam,\n\nSee https://bit.ly/x\n\nNik" });
  assert.equal(guard.status, 422); assert.equal(guard.body.error, "Reply refused");
  assert.deepEqual(guard.body.reasons, [
    "Links can only go to their demo, their order page or aetoswebsites.com (found bit.ly).",
    "Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply.",
  ]);
  const day = await post({ message_id: "m2", intent: "call_request", body: "Hi Sam,\n\nI can ring you at 11am.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" } });
  assert.equal(day.status, 422); assert.deepEqual(day.body.reasons, ["Your reply doesn't mention Friday, the day you're offering."]);
  const asked = await post({ message_id: "m2", intent: "proposes_time", body: "Hi Sam,\n\nLet me check and I'll confirm by the end of the day." });
  assert.equal(asked.status, 422); assert.equal(asked.body.error, "Say what time they asked for in asked_time.");
  // nothing was written by any refusal
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 2);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM calls"), 0);
  // a thread Nik is handling
  DB.raw.prepare("UPDATE prospects SET stage = 'needs_nik' WHERE place_id = 'p1'").run();
  const nik = await post({ message_id: "m2", intent: "price", body: "Hi" });
  assert.equal(nik.status, 409); assert.equal(nik.body.error, "Nik is handling this thread: escalate instead.");
});

test("a call must come with the right intent and action", async () => {
  const DB = await seeded();
  const post = (x) => recordReply(DB, { message_id: "m2", now: NOW, body: "Hi Sam,\n\nHow about Friday 23 October at 11am?", ...x });
  assert.equal((await post({ intent: "call_request" })).status, 422);                                         // no call
  assert.equal((await post({ intent: "confirms_slot" })).status, 422);
  assert.equal((await post({ intent: "interested", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" } })).status, 422);
  assert.equal((await post({ intent: "confirms_slot", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" } })).status, 422);
  assert.equal((await post({ intent: "call_request", call: { action: "book", slot_at: "2026-10-23T10:00:00Z" } })).status, 422);
  assert.equal((await post({ intent: "call_request", call: "Friday" })).status, 422);
  const notSlot = await post({ intent: "call_request", call: { action: "offer", slot_at: "Friday at 11" } });
  assert.equal(notSlot.status, 422);
  assert.equal(notSlot.body.reasons[0], "That isn't a valid date and time. Offer Friday 23 October at 11am instead.");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM calls"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
});

test("the slot is taken between inbox and reply: 422 with the next free slot, nothing written", async () => {
  const DB = await seeded();
  await insert(DB, "calls", { id: "cX", place_id: "pX", slot_at: "2026-10-23T10:00:00Z", status: "offered", phone: null, note: "", created_at: "2026-10-21T08:00:00Z", updated_at: "2026-10-21T08:00:00Z" });
  const res = await recordReply(DB, { message_id: "m2", intent: "call_request", body: "Hi Sam,\n\nSoonest I can ring is Friday 23 October at 11am.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" }, now: NOW });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body.reasons, ["That day already has a call booked or offered. Offer Saturday 24 October at 11am instead."]);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 2);
  // a drill call never takes the day
  DB.raw.prepare("UPDATE calls SET place_id = 'drill:call' WHERE id = 'cX'").run();
  assert.equal((await recordReply(DB, { message_id: "m2", intent: "call_request", body: "Hi Sam,\n\nSoonest I can ring is Friday 23 October at 11am.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" }, now: NOW })).status, 200);
});

test("confirms_slot books the call: confirmed, call_booked, a call Todo at the slot", async () => {
  const DB = await seeded();
  const offer = await recordReply(DB, { message_id: "m2", intent: "call_request", body: "Hi Sam,\n\nSoonest I am available is Friday 23 October at 11am.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" }, now: NOW });
  assert.equal(offer.status, 200);
  await insert(DB, "messages", inbound("m3", "p1", "2026-10-21T09:00:00Z", { body: "Yes that works, my number is 07700 900123" }));
  const res = await recordReply(DB, { message_id: "m3", intent: "confirms_slot", body: "Hi Sam,\n\nGreat, Friday 23 October at 11am it is. I'll ring you on 07700 900123.", call: { action: "confirm", slot_at: "2026-10-23T10:00:00Z", phone: "07700 900123" }, now: D("2026-10-21T09:05:00Z") });
  assert.equal(res.status, 200);
  assert.equal(res.body.call.status, "confirmed");
  const calls = await all(DB, "SELECT status, phone FROM calls");
  assert.deepEqual(calls, [{ status: "confirmed", phone: "07700 900123" }]);
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='p1'")).stage, "call_booked");
  const todo = await one(DB, "SELECT title, due_at, link FROM todos WHERE kind='call'");
  assert.equal(todo.title, "Call Sam (Green Leaf Landscapes) Fri 11:00 · 07700 900123");
  assert.equal(todo.due_at, "2026-10-23T10:00:00Z");
  assert.match(todo.link, /^\/#\/call\//);
  // they write again before the call: the reply leaves the stage as call_booked
  await insert(DB, "messages", inbound("m4", "p1", "2026-10-21T10:00:00Z"));
  DB.raw.prepare("UPDATE prospects SET stage = 'replied' WHERE place_id = 'p1'").run();     // what inbound_human did
  await recordReply(DB, { message_id: "m4", intent: "question", body: "Hi Sam,\n\nYes, you keep the website.", now: D("2026-10-21T10:05:00Z") });
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='p1'")).stage, "call_booked");
});

test("proposes_time that is a free slot is simply booked (no call_time Todo, no needs_nik)", async () => {
  const DB = await seeded();
  const res = await recordReply(DB, { message_id: "m2", intent: "proposes_time", body: "Hi Sam,\n\nSaturday 24 October at 11am works. I'll ring you then.", call: { action: "confirm", slot_at: "2026-10-24T10:00:00Z" }, now: NOW });
  assert.equal(res.status, 200);
  assert.deepEqual(await one(DB, "SELECT status, phone FROM calls"), { status: "confirmed", phone: "01925 123456" });   // the lead's number
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM todos WHERE kind='call_time'"), 0);
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='p1'")).stage, "call_booked");
  assert.equal((await one(DB, "SELECT intent FROM messages WHERE id='m2'")).intent, "proposes_time");
});

test("proposes_time after 5pm: the Todo is due 6pm tomorrow, and the title says so", async () => {
  const DB = await seeded();
  DB.raw.prepare("UPDATE prospects SET greet_name = NULL WHERE place_id = 'p1'").run();
  await recordReply(DB, { message_id: "m2", intent: "proposes_time", body: "Hi,\n\nLet me check and I'll confirm by tomorrow evening.", asked_time: "  Thu\n3pm ", now: D("2026-10-21T16:30:00Z") });
  const ct = await one(DB, "SELECT * FROM todos WHERE dedupe='call_time:m2'");
  assert.equal(ct.kind, "call_time");
  assert.equal(ct.title, "Confirm a time with Green Leaf Landscapes by 6pm tomorrow (they asked for Thu 3pm)");
  assert.equal(ct.due_at, "2026-10-22T17:00:00Z");
  assert.equal(ct.link, "/#/replies/p1"); assert.equal(ct.place_id, "p1");
  assert.match(ct.detail, /They wrote:\nHow much\?$/);
});

test("not_interested and not_now: lost with the reason; the checkback Todo", async () => {
  const DB = await seeded();
  await recordReply(DB, { message_id: "m2", intent: "not_interested", body: "Hi Sam,\n\nNo problem at all, thanks for letting me know.", now: NOW });
  assert.deepEqual(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id='p1'"), { stage: "lost", lost_reason: "not_interested" });
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM todos"), 0);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE kind='reply'")).status, "queued");   // the polite line still goes
  await thread(DB, "p7", "OAK TREE ROOFING LTD", "m7");
  await recordReply(DB, { message_id: "m7", intent: "not_now", body: "Hi,\n\nNo problem. Would it be OK if I checked back in with you in 3 months?", now: NOW });
  const t = await one(DB, "SELECT * FROM todos WHERE dedupe='checkback:p7'");
  assert.equal(t.kind, "pick");
  assert.equal(t.title, "Check back with Oak Tree Roofing (they said not now on 21 Oct)");
  assert.equal(t.link, "/#/lead/p7"); assert.equal(t.place_id, "p7");
});

test("opt_out: nothing sent, address suppressed, lost, queued mail to them cancelled", async () => {
  const DB = await seeded();
  await insert(DB, "messages", out("q1", "p1", "followup", "system", "2026-10-22T09:00:00Z", { status: "queued", sent_at: null, step: 2 }));
  await insert(DB, "messages", out("q2", "p1", "reply", "claude", "2026-10-22T06:00:00Z", { status: "queued", sent_at: null }));
  await insert(DB, "messages", inbound("m3", "p1", "2026-10-21T08:20:00Z", { from_addr: "office@them.co.uk", body: "Take me off your list" }));
  const res = await recordReply(DB, { message_id: "m3", intent: "opt_out", body: "ignored", now: NOW });
  assert.equal(res.status, 200); assert.equal(res.body.reply_id, null);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE in_reply_to='<m3@them.co.uk>'"), 0);
  assert.deepEqual((await all(DB, "SELECT value FROM suppression ORDER BY value")).map((s) => s.value), ["office@them.co.uk", "p1@them.co.uk"]);
  assert.deepEqual(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id='p1'"), { stage: "lost", lost_reason: "opt_out" });
  assert.deepEqual((await all(DB, "SELECT status FROM messages WHERE id IN ('q1', 'q2') ORDER BY id")).map((m) => m.status), ["cancelled", "cancelled"]);
  assert.equal((await one(DB, "SELECT intent, needs_reply FROM messages WHERE id='m3'")).intent, "opt_out");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 0);
});

test("no mailbox on the thread: refused in plain English, nothing written", async () => {
  const DB = await seeded();
  DB.raw.prepare("DELETE FROM mailboxes").run();
  const res = await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950.", now: NOW });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "Couldn't send: this thread has no mailbox. Add one on Setup → Mailboxes, then try again.");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 2);
});

test("the guard checks the offer at send time: a weekend deal posted on Friday night is fine", async () => {
  const DB = await seeded();
  const fri = D("2026-10-23T22:45:00Z"); // Fri 23:45 UK: goes at Sat 07:00 UK, the weekend deal is on
  const res = await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nThis weekend it's £1,750, with the first 90 days free.", now: fri });
  assert.equal(res.status, 200); assert.equal(res.body.due_at, "2026-10-24T06:00:00Z");
  // and on a Wednesday the same words are refused
  const DB2 = await seeded();
  const wed = await recordReply(DB2, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nThis weekend it's £1,750, with the first 90 days free.", now: NOW });
  assert.deepEqual(wed.body.reasons, ["The weekend deal isn't on when this goes out: use the weekday offer."]);
});

test("the route: agent token, then the reply is sent at once when it is due now", async () => {
  const DB = await seeded();
  const env = { DB };
  const waits = [];
  const ctx = (body, token, now = NOW) => ({ request: req(body, token), env, now, waitUntil: (p) => waits.push(p) });
  assert.equal((await onRequestPost(ctx({ message_id: "m2", intent: "price", body: "Hi" }, "wrong"))).status, 401);
  assert.equal((await onRequestPost(ctx({ message_id: "m2", intent: "price", body: "Hi" }, null))).status, 401);
  const bad = await onRequestPost({ request: new Request(`${ORIGIN}/api/agent/reply`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "not json" }), env, now: NOW });
  assert.equal(bad.status, 400);
  const res = await onRequestPost(ctx({ message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950." }, TOKEN));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "queued");
  assert.equal(waits.length, 1);
  assert.deepEqual(await waits[0], { sent: 0, failed: 0, held: 1 });   // no mailbox password in the test: held, never lost
  // a night reply waits for 07:00: nothing is dispatched now
  await insert(DB, "messages", inbound("m3", "p1", "2026-10-21T22:00:00Z"));
  const night = await onRequestPost(ctx({ message_id: "m3", intent: "interested", body: "Hi Sam,\n\nGreat. Press Order on your demo when you're ready." }, TOKEN, D("2026-10-21T22:31:00Z")));
  assert.equal(night.status, 200);
  assert.equal(waits.length, 1);
  // a refusal is the status and body recordReply gives
  const refused = await onRequestPost(ctx({ message_id: "m3", intent: "price", body: "Hi" }, TOKEN));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "Already answered.");
  // drill replies are never dispatched
  await thread(DB, "drill:price", null, "drill-price", { stage: "emailed", greet_name: null });
  await onRequestPost(ctx({ message_id: "drill-price", intent: "price", body: "Hi,\n\nIt's £1,950." }, TOKEN));
  assert.equal(waits.length, 1);
});

test("another prospect takes the day between the checks and the booking: the reply is undone, 422", async () => {
  const DB = await seeded();
  // Right after the reply batch lands, another prospect's offer for the same Friday arrives.
  const raced = Object.create(DB);
  raced.batch = async (stmts) => {
    const out = await DB.batch(stmts);
    if (stmts.length === 3 && !(await DB.prepare("SELECT 1 AS x FROM calls WHERE id = 'cX'").first("x"))) {
      await insert(DB, "calls", { id: "cX", place_id: "pX", slot_at: "2026-10-23T10:00:00Z", status: "offered", phone: null, note: "", created_at: "2026-10-21T08:29:00Z", updated_at: "2026-10-21T08:29:00Z" });
    }
    return out;
  };
  const res = await recordReply(raced, { message_id: "m2", intent: "call_request", body: "Hi Sam,\n\nSoonest I can ring is Friday 23 October at 11am.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" }, now: NOW });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body.reasons, ["That day already has a call booked or offered. Offer Saturday 24 October at 11am instead."]);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  assert.deepEqual((await all(DB, "SELECT id, needs_reply, handled_at, intent FROM messages WHERE direction='in' ORDER BY id")),
    [{ id: "m1", needs_reply: 1, handled_at: null, intent: null }, { id: "m2", needs_reply: 1, handled_at: null, intent: null }]);
  assert.deepEqual((await all(DB, "SELECT place_id FROM calls")).map((c) => c.place_id), ["pX"]);
});

test("paused, a paying client's thread, an opted-out thread: 409 and no reply; a client's or opted-out mail goes to Nik", async () => {
  const DB = await seeded();
  await setSetting(DB, "replies:paused", "1");
  const paused = await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950.", now: NOW });
  assert.equal(paused.status, 409);
  assert.equal(paused.body.error, "Nik has paused Claude's replies: post nothing more and finish the run.");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 2); // paused: still waiting
  await setSetting(DB, "replies:paused", "0");
  DB.raw.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  const won = await recordReply(DB, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950.", now: NOW });
  assert.equal(won.status, 409); assert.equal(won.body.error, "They're a paying client: Nik answers them himself. Move on.");
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  // the stage changed after the inbox was read: the waiting mail is handed to Nik, not left waiting for good
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 0);
  assert.deepEqual((await all(DB, "SELECT dedupe FROM todos ORDER BY dedupe")).map((t) => t.dedupe), ["client-mail:m1", "client-mail:m2"]);

  const DB2 = await seeded();
  DB2.raw.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'opt_out' WHERE place_id = 'p1'").run();
  const opted = await recordReply(DB2, { message_id: "m2", intent: "price", body: "Hi Sam,\n\nIt's £1,950.", now: NOW });
  assert.equal(opted.status, 409); assert.equal(opted.body.error, "They opted out (or their address bounced): nothing is sent to them. Move on.");
  assert.equal(await count(DB2, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  assert.equal(await count(DB2, "SELECT COUNT(*) n FROM messages WHERE needs_reply=1"), 0);
  assert.deepEqual((await all(DB2, "SELECT dedupe FROM todos ORDER BY dedupe")).map((t) => t.dedupe), ["optout-mail:m1", "optout-mail:m2"]);
});

test("not_now answered next morning: the checkback Todo names the day they said it", async () => {
  const DB = await seeded();
  await thread(DB, "p7", "OAK TREE ROOFING LTD", "m7");
  DB.raw.prepare("UPDATE messages SET received_at = '2026-10-20T21:10:00Z' WHERE id = 'm7'").run();   // Tue 20 Oct 22:10 UK
  await recordReply(DB, { message_id: "m7", intent: "not_now", body: "Hi,\n\nNo problem. Would it be OK if I checked back in with you in 3 months?", now: D("2026-10-21T06:05:00Z") });
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe='checkback:p7'")).title, "Check back with Oak Tree Roofing (they said not now on 20 Oct)");
});

test("an opt-out with a booked call: the call is cancelled and its Todo closed, so Nik never rings them", async () => {
  const DB = await seeded();
  const off = await recordReply(DB, { message_id: "m2", intent: "confirms_slot", body: "Hi Sam,\n\nFriday 23 October at 11am it is.", call: { action: "confirm", slot_at: "2026-10-23T10:00:00Z", phone: "07700 900123" }, now: NOW });
  assert.equal(off.status, 200);
  await insert(DB, "messages", inbound("m3", "p1", "2026-10-21T09:00:00Z", { body: "Actually take me off your list" }));
  assert.equal((await recordReply(DB, { message_id: "m3", intent: "opt_out", now: D("2026-10-21T09:05:00Z") })).status, 200);
  const c = await one(DB, "SELECT id, status, note FROM calls");
  assert.equal(c.status, "cancelled"); assert.equal(c.note, "Cancelled by their email: they asked not to be emailed again.");
  assert.equal((await one(DB, `SELECT status FROM todos WHERE dedupe='call:${c.id}'`)).status, "done");
  assert.deepEqual(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id='p1'"), { stage: "lost", lost_reason: "opt_out" });
});

test("a drill opt-out adds nothing to the suppression list", async () => {
  const DB = await seeded();
  await thread(DB, "drill:opt_out", null, "drill-opt", { stage: "emailed", greet_name: null });
  assert.equal((await recordReply(DB, { message_id: "drill-opt", intent: "opt_out", now: NOW })).status, 200);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM suppression"), 0);
  assert.deepEqual(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id='drill:opt_out'"), { stage: "lost", lost_reason: "opt_out" });
});

// ---------------------------------------------------------------- the promise and the offer are the ones at send_at

test("proposes_time read at 16:58 UK, posted at 17:02: the reply must promise \"by tomorrow evening\", as Nik's Todo says", async () => {
  const DB = await seeded();
  const { buildInbox } = await import("../functions/_lib/replies-db.js");
  const inbox = await buildInbox(DB, D("2026-10-21T15:58:00Z")); // Wed 21 Oct 16:58 UK (BST)
  assert.equal(inbox.conversations[0].calls.call_time_promise, "by the end of the day");
  const stale = await recordReply(DB, { message_id: "m2", intent: "proposes_time", body: "Hi Sam,\n\nLet me check and I'll confirm by the end of the day.", asked_time: "Thu 3pm", now: D("2026-10-21T16:02:00Z") });
  assert.equal(stale.status, 422);
  assert.deepEqual(stale.body.reasons, ["Your reply must say you'll confirm \"by tomorrow evening\" (it goes out after 5pm UK)."]);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM todos"), 0);
  const ok = await recordReply(DB, { message_id: "m2", intent: "proposes_time", body: "Hi Sam,\n\nLet me check and I'll confirm By Tomorrow Evening.", asked_time: "Thu 3pm", now: D("2026-10-21T16:02:00Z") });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.due_at, "2026-10-21T16:02:00Z"); // goes at once
  const ct = await one(DB, "SELECT * FROM todos WHERE dedupe='call_time:m2'");
  assert.equal(ct.title, "Confirm a time with Sam (Green Leaf Landscapes) by 6pm tomorrow (they asked for Thu 3pm)");
  assert.equal(ct.due_at, "2026-10-22T17:00:00Z");
});

test("proposes_time posted at 23:35 UK goes out at 07:00: it promises \"by the end of the day\", the Todo due 18:00 that day", async () => {
  const DB = await seeded();
  const { buildInbox } = await import("../functions/_lib/replies-db.js");
  const night = D("2026-10-21T22:35:00Z"); // Wed 21 Oct 23:35 UK
  assert.equal((await buildInbox(DB, night)).conversations[0].calls.call_time_promise, "by the end of the day");
  const stale = await recordReply(DB, { message_id: "m2", intent: "proposes_time", body: "Hi Sam,\n\nLet me check and I'll confirm by tomorrow evening.", asked_time: "Thu 3pm", now: night });
  assert.equal(stale.status, 422);
  assert.deepEqual(stale.body.reasons, ["Your reply must say you'll confirm \"by the end of the day\" (it goes out at 7am UK)."]);
  const ok = await recordReply(DB, { message_id: "m2", intent: "proposes_time", body: "Hi Sam,\n\nLet me check and I'll confirm by the end of the day.", asked_time: "Thu 3pm", now: night });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.due_at, "2026-10-22T06:00:00Z");
  const ct = await one(DB, "SELECT * FROM todos WHERE dedupe='call_time:m2'");
  assert.equal(ct.title, "Confirm a time with Sam (Green Leaf Landscapes) by 6pm (they asked for Thu 3pm)");
  assert.equal(ct.due_at, "2026-10-22T17:00:00Z");
});

test("read on Sunday 23:28, posted 23:31 (goes Monday 07:00): the weekend price is refused, with the weekday offer", async () => {
  const DB = await seeded();
  const { buildInbox } = await import("../functions/_lib/replies-db.js");
  const inbox = await buildInbox(DB, D("2026-10-25T23:28:00Z")); // Sun 25 Oct 23:28 UK (GMT)
  assert.equal(inbox.offer.weekend, true);
  assert.equal(inbox.offer.full.build, 1750);
  const post = (body) => recordReply(DB, { message_id: "m2", intent: "price", body, now: D("2026-10-25T23:31:00Z") });
  const first = await post("Hi Sam,\n\nIt's £1,750 to build, then £249 a month, with the first 90 days free.");
  assert.equal(first.status, 422);
  assert.ok(first.body.reasons.includes("The weekend deal isn't on when this goes out: use the weekday offer."));
  assert.equal(first.body.send_at, "2026-10-26T07:00:00Z");
  assert.equal(first.body.offer.weekend, false);
  assert.equal(first.body.offer.full.build, 1950);
  assert.equal(first.body.offer.full.free_days, 60);
  assert.ok(first.body.reasons.includes("The offer changes before this goes out (it goes out Mon 26 Oct 07:00): rewrite every price and free-days line from `offer` in this reply."));
  // the usual fix (the free-days phrase deleted) is still the weekend price: refused, with the offer again
  const second = await post("Hi Sam,\n\nIt's £1,750 to build, then £249 a month.");
  assert.equal(second.status, 422);
  assert.ok(second.body.reasons.includes("£1,750 is the Website Only price; the Full Package is £1,950 to build."));
  assert.equal(second.body.offer.full.build, 1950);
  assert.equal(await count(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'"), 0);
  // rewritten from the offer it was given: queued for Monday 07:00
  const third = await post("Hi Sam,\n\nIt's £1,950 to build, then £249 a month, with the first 60 days free.");
  assert.equal(third.status, 200);
  assert.equal(third.body.due_at, "2026-10-26T07:00:00Z");
  // an ordinary refusal (no change of offer before it goes) carries no offer
  await insert(DB, "messages", inbound("m9", "p1", "2026-10-26T09:00:00Z"));
  const plain = await recordReply(DB, { message_id: "m9", intent: "price", body: "It's £1,500.", now: D("2026-10-26T09:05:00Z") });
  assert.equal(plain.status, 422);
  assert.equal(plain.body.offer, undefined);
});
