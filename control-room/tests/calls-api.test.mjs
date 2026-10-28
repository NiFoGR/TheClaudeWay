// Stage 8 calls: Nik's call routes (GET/POST /api/calls, GET/POST /api/calls/:id; logic in _lib/calls-db.js, Nik's
// emails through _lib/replies-db.js's sendAsNik). Run: node --test control-room/tests/calls-api.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { setSetting } from "../functions/_lib/settings.js";
import { addTodo } from "../functions/_lib/todo.js";
import * as calls from "../functions/api/calls.js";
import * as callId from "../functions/api/calls/[id].js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-21T08:30:00Z"); // Wed 21 Oct 2026 09:30 UK
const EARLIER = "2026-10-19T07:00:00Z";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = async (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;

// Lead "a" (Diamond Kickboxing, Mark), emailed and replied; m6 asked for Thursday at 3pm (a call_time Todo); research
// with a confident owner; the current demo and an older ended one. Lead "b" has no prospect and no demo.
async function seeded() {
  const DB = fakeD1();
  await setSetting(DB, "business:sender_name", "Nik");
  await insert(DB, "mailboxes", {
    id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik Smith", role: "cold", started_on: "2026-09-01", created_at: EARLIER,
  });
  await insert(DB, "leads", {
    place_id: "a", name: "DIAMOND KICKBOXING LTD", trade: "martial arts gym", search_town: "Leeds", town: "Leeds",
    phone: "0113 496 0000", rating: 4.8, review_count: 52, first_seen_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "leads", {
    place_id: "b", name: "Bob's Plumbing", trade: "plumber", search_town: "Leeds", town: "Leeds", phone: "0113 496 0001",
    first_seen_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "prospects", {
    place_id: "a", stage: "replied", stage_at: EARLIER, email: "mark@diamondkb.co.uk", greet_name: "Mark", mailbox_id: "mb1",
    subject: "Your new website", root_message_id: "<first-a@aetoswebsites.com>", first_sent_at: EARLIER,
    created_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "f1", place_id: "a", mailbox_id: "mb1", direction: "out", kind: "first", author: "nik", to_addr: "mark@diamondkb.co.uk",
    from_addr: "nik@aetoswebsites.com", subject: "Your new website", body: "Hi Mark,\n\nYour demo.",
    message_id: "<first-a@aetoswebsites.com>", status: "sent", due_at: EARLIER, sent_at: EARLIER, created_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "m6", place_id: "a", mailbox_id: "mb1", direction: "in", kind: "inbound", author: "them", to_addr: "nik@aetoswebsites.com",
    from_addr: "mark@diamondkb.co.uk", subject: "Re: Your new website", body: "Can you ring me Thursday at 3pm?",
    message_id: "<m6@diamondkb.co.uk>", status: "received", received_at: "2026-10-21T08:00:00Z", class: "human", needs_reply: 0,
    handled_at: "2026-10-21T08:01:00Z", intent: "proposes_time", created_at: "2026-10-21T08:00:00Z",
  });
  await addTodo(DB, {
    kind: "call_time", title: "Confirm a time with Mark (Diamond Kickboxing) by 6pm (they asked for Thu 3pm)",
    link: "/#/replies/a", place_id: "a", due_at: "2026-10-21T17:00:00Z", dedupe: "call_time:m6",
  });
  await insert(DB, "research", {
    place_id: "a", status: "done", grade: "A", grade_reason: "Busy, weak site.",
    angle: JSON.stringify([{ fact: "52 reviews at 4.8 stars.", source_url: "https://maps.google.com/x" }]),
    owner: JSON.stringify({ first: "Mark", full: "Mark Jones", source_url: "https://diamondkb.co.uk/about", confident: true }),
    queued_at: EARLIER, researched_at: EARLIER,
  });
  await insert(DB, "demos", { slug: "diamond-kb-ab12", place_id: "a", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-03-30T09:00:00Z" });
  await insert(DB, "demos", { slug: "diamond-kb-old1", place_id: "a", created_at: "2026-03-01T09:00:00Z", expires_at: "2026-03-15T09:00:00Z" });
  return DB;
}

function harness(DB, now = NOW) {
  const waits = [];
  const ctx = (path, body = null, params = {}, at = now) => ({
    request: new Request(`${ORIGIN}${path}`, body === null
      ? { method: "GET" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    env: { DB },
    params,
    now: at,
    waitUntil: (p) => waits.push(p),
  });
  return { ctx, waits };
}

test("Nik books Thursday 3pm with a message, sees the call page, an unknown action is refused (the spec's test)", async () => {
  const DB = await seeded();
  const { ctx } = harness(DB);
  const g = await (await calls.onRequestGet(ctx("/api/calls?place_id=a"))).json();
  assert.equal(g.free_slots.length, 3);
  const b = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", phone: "07700 900123", message: "Thursday at 3pm works. I'll ring you then. Thank you.", message_id: "m6" }));
  assert.equal(b.status, 200);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe='call_time:m6'")).status, "done");
  assert.equal((await one(DB, "SELECT author FROM messages WHERE kind='reply'")).author, "nik");
  assert.equal((await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-01T10:00:00Z" }))).status, 422);
  const id = (await b.json()).call.id;
  const page = await (await callId.onRequestGet(ctx(`/api/calls/${id}`, null, { id }))).json();
  assert.equal(page.label, "Thursday 22 October at 3pm"); assert.equal(page.offer.full.build, 195000);
  assert.equal(page.offer.guarantee.headline, "Top 3 in Google search results in 90 days. GUARANTEED.");
  assert.equal((await callId.onRequestPost(ctx(`/api/calls/${id}`, { action: "explode" }, { id }))).status, 422);
});

test("GET /api/calls: the prospect's calls (labelled) and the next 3 free slots, taken days skipped", async () => {
  const DB = await seeded();
  const { ctx } = harness(DB);
  const g = await (await calls.onRequestGet(ctx("/api/calls?place_id=a"))).json();
  assert.deepEqual(g.calls, []);
  assert.equal(g.phone, "0113 496 0000");
  // Wed 21 Oct 09:30 UK: today's slot is 11am (1.5 h away, under 3 h), so Fri 23, Sat 24, Sun 25 (11:00 GMT from 25 Oct).
  assert.deepEqual(g.free_slots, [
    { slot_at: "2026-10-23T10:00:00Z", label: "Friday 23 October at 11am" },
    { slot_at: "2026-10-24T10:00:00Z", label: "Saturday 24 October at 11am" },
    { slot_at: "2026-10-25T11:00:00Z", label: "Sunday 25 October at 11am" },
  ]);
  // b books Friday: Friday is gone for a, Tuesday 27 comes in.
  const booked = await calls.onRequestPost(ctx("/api/calls", { place_id: "b", at: "2026-10-23T10:00:00Z" }));
  assert.equal(booked.status, 200);
  const after = await (await calls.onRequestGet(ctx("/api/calls?place_id=a"))).json();
  assert.deepEqual(after.free_slots.map((s) => s.slot_at), ["2026-10-24T10:00:00Z", "2026-10-25T11:00:00Z", "2026-10-27T11:00:00Z"]);
  const own = await (await calls.onRequestGet(ctx("/api/calls?place_id=b"))).json();
  assert.equal(own.calls.length, 1);
  assert.equal(own.calls[0].status, "confirmed");
  assert.equal(own.calls[0].label, "Friday 23 October at 11am");
  assert.equal(own.calls[0].phone, "0113 496 0001"); // no phone given: the lead's
  // No place_id: no calls, still the free slots
  const none = await (await calls.onRequestGet(ctx("/api/calls"))).json();
  assert.deepEqual(none.calls, []);
  assert.equal(none.free_slots.length, 3);
});

test("POST /api/calls: booking by hand, the warning on a taken day, refusals, and Nik's email sent at once", async () => {
  const DB = await seeded();
  const { ctx, waits } = harness(DB);
  // a bad body
  const notJson = await calls.onRequestPost(ctx("/api/calls", "{not json"));
  assert.equal(notJson.status, 400);
  assert.match((await notJson.json()).error, /Refresh the page and try again/);
  // past and bad times
  const past = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-01T10:00:00Z" }));
  assert.equal(past.status, 422);
  assert.equal((await past.json()).error, "Pick a time in the future.");
  const bad = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "Thursday at 3" }));
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error, "That isn't a valid date and time.");
  // no such lead
  const gone = await calls.onRequestPost(ctx("/api/calls", { place_id: "zzz", at: "2026-10-22T14:00:00Z" }));
  assert.equal(gone.status, 404);
  // a message with no email to answer, or a message from another lead: refused before anything is booked
  const noId = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", message: "See you then." }));
  assert.equal(noId.status, 422);
  const wrongLead = await calls.onRequestPost(ctx("/api/calls", { place_id: "b", at: "2026-10-22T14:00:00Z", message: "Hi", message_id: "m6" }));
  assert.equal(wrongLead.status, 422);
  const blank = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", message: "  ", message_id: "m6" }));
  assert.equal(blank.status, 422);
  assert.equal((await blank.json()).error, "Couldn't save: write something first.");
  assert.equal((await all(DB, "SELECT id FROM calls")).length, 0);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe='call_time:m6'")).status, "open");

  // b holds Thursday by hand; a's Thursday 3pm still books, with a warning
  assert.equal((await calls.onRequestPost(ctx("/api/calls", { place_id: "b", at: "2026-10-22T09:00:00Z" }))).status, 200);
  const res = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", phone: "07700 900123", message: "Thursday at 3pm works. I'll ring you then. Thank you.", message_id: "m6" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.warning, "You already have a call that day.");
  assert.equal(body.label, "Thursday 22 October at 3pm");
  assert.equal(body.call.phone, "07700 900123");
  assert.equal(body.call.status, "confirmed");
  assert.equal(body.reply.status, "queued");
  assert.equal(body.reply.due_at, "2026-10-21T08:30:00Z");
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "call_booked");
  const reply = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(reply.to_addr, "mark@diamondkb.co.uk");
  assert.equal(reply.in_reply_to, "<m6@diamondkb.co.uk>");
  assert.match(reply.body, /^Thursday at 3pm works\. I'll ring you then\. Thank you\./);
  assert.equal(waits.length, 1);                               // sent straight away (held here: no mailbox password)
  await Promise.all(waits);
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = ?", `call:${body.call.id}`);
  assert.equal(todo.status, "open");
  assert.equal(todo.link, `/#/call/${body.call.id}`);
  // pressing it again (a retry): the same call, no second reply
  const again = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", phone: "07700 900123", message: "Thursday at 3pm works. I'll ring you then. Thank you.", message_id: "m6" }));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).call.id, body.call.id);
  assert.equal((await all(DB, "SELECT id FROM messages WHERE kind='reply'")).length, 1);
});

test("POST /api/calls: the call is booked even when the email can't go, and Nik is told", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE prospects SET mailbox_id = NULL WHERE place_id = 'a'").run();
  await DB.prepare("UPDATE messages SET mailbox_id = NULL").run();
  const { ctx } = harness(DB);
  const res = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", message: "See you then.", message_id: "m6" }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, "The call is booked, but the email wasn't sent. Couldn't send: this thread has no mailbox. Add one on Setup → Mailboxes, then try again.");
  assert.equal(body.call.status, "confirmed");
  assert.equal((await one(DB, "SELECT status FROM calls")).status, "confirmed");
  assert.equal((await all(DB, "SELECT id FROM messages WHERE kind='reply'")).length, 0);
});

test("GET /api/calls/:id: the call page's data (lead in callScript's shape, links, offer for the call's day)", async () => {
  const DB = await seeded();
  const { ctx } = harness(DB);
  const id = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-24T10:00:00Z", phone: "07700 900123" }))).json()).call.id;
  const page = await (await callId.onRequestGet(ctx(`/api/calls/${id}`, null, { id }))).json();
  assert.equal(page.call.id, id);
  assert.equal(page.call.phone, "07700 900123");
  assert.equal(page.label, "Saturday 24 October at 11am");
  assert.equal(page.after_slot, false);
  assert.equal(page.thread_link, "/#/replies/a");
  // the weekend deal on a Saturday call, in pence, with the guarantee: the same object as GET /api/leads/:id's offer
  assert.deepEqual(page.offer, JSON.parse(JSON.stringify({ ...offerFor(new Date("2026-10-24T10:00:00Z")), guarantee: GUARANTEE })));
  assert.equal(page.offer.full.build, 175000);
  assert.equal(page.lead.name, "DIAMOND KICKBOXING LTD");
  assert.equal(page.lead.owner_first, "Mark");
  assert.equal(page.lead.town, "Leeds");
  assert.equal(page.lead.rating, 4.8);
  assert.deepEqual(page.lead.angle, [{ fact: "52 reviews at 4.8 stars.", source_url: "https://maps.google.com/x" }]);
  assert.equal(page.lead.demo_url, "https://aetoswebsites.com/d/diamond-kb-ab12");
  assert.deepEqual(page.links, {
    demo: "https://aetoswebsites.com/d/diamond-kb-ab12",
    order: "https://aetoswebsites.com/d/diamond-kb-ab12/order",
  });
  assert.equal(page.research.grade, "A");
  // after the slot time
  const later = harness(DB, new Date("2026-10-24T10:05:00Z")).ctx;
  assert.equal((await (await callId.onRequestGet(later(`/api/calls/${id}`, null, { id }))).json()).after_slot, true);
  // no such call
  const missing = await callId.onRequestGet(ctx("/api/calls/nope", null, { id: "nope" }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "That call isn't in the database.");
});

test("GET /api/calls/:id: a lead with no demo, research or prospect", async () => {
  const DB = await seeded();
  const { ctx } = harness(DB);
  const id = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "b", at: "2026-10-23T10:00:00Z" }))).json()).call.id;
  const page = await (await callId.onRequestGet(ctx(`/api/calls/${id}`, null, { id }))).json();
  assert.equal(page.lead.owner_first, null);
  assert.equal(page.lead.demo_url, "");
  assert.deepEqual(page.links, { demo: null, order: null });
  assert.equal(page.research, null);
  assert.equal(page.offer.full.build, 195000); // a Friday
});

test("POST /api/calls/:id: cancel, outcomes, the order link sent at once, refusals", async () => {
  const DB = await seeded();
  const { ctx, waits } = harness(DB);
  const id = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-23T10:00:00Z" }))).json()).call.id;
  const p = (body, at = NOW) => callId.onRequestPost(ctx(`/api/calls/${id}`, body, { id }, at));

  const unknown = await p({ action: "explode" });
  assert.equal(unknown.status, 422);
  assert.equal((await unknown.json()).error, "Unknown action.");
  assert.equal((await callId.onRequestPost(ctx("/api/calls/nope", { action: "done" }, { id: "nope" }))).status, 404);
  assert.equal((await callId.onRequestPost(ctx(`/api/calls/${id}`, "{nope", { id }))).status, 400);

  const after = new Date("2026-10-23T10:40:00Z");
  const empty = await p({ action: "ordering", message: " " }, after);
  assert.equal(empty.status, 422);
  assert.equal((await empty.json()).error, "Couldn't save: write something first.");

  const ordering = await p({ action: "ordering", note: "Wants it by Christmas", message: "Great speaking to you. Here's the link to get started:\n\nhttps://aetoswebsites.com/d/diamond-kb-ab12/order" }, after);
  assert.equal(ordering.status, 200);
  assert.deepEqual(await ordering.json(), { ok: true });
  const call = await one(DB, "SELECT status, note FROM calls WHERE id = ?", id);
  assert.deepEqual({ ...call }, { status: "done", note: "Wants it by Christmas" });
  const reply = await one(DB, "SELECT author, body FROM messages WHERE kind='reply'");
  assert.equal(reply.author, "nik");
  assert.match(reply.body, /\/d\/diamond-kb-ab12\/order/);
  assert.equal(waits.length, 1); // the order link goes straight away
  await Promise.all(waits);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = ?", `call:${id}`)).status, "done");

  // already done
  const twice = await p({ action: "done" }, after);
  assert.equal(twice.status, 409);
  assert.equal((await twice.json()).error, "That call is already done.");
});

test("POST /api/calls/:id: cancel moves the stage back and dispatches the optional note", async () => {
  const DB = await seeded();
  const { ctx, waits } = harness(DB);
  const id = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-23T10:00:00Z" }))).json()).call.id;
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "call_booked");
  const r = await callId.onRequestPost(ctx(`/api/calls/${id}`, { action: "cancel", message: "Sorry Mark, something's come up. Can we do next week?" }, { id }));
  assert.equal(r.status, 200);
  assert.equal((await one(DB, "SELECT status FROM calls WHERE id = ?", id)).status, "cancelled");
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "replied");
  assert.equal((await all(DB, "SELECT id FROM messages WHERE kind='reply' AND author='nik'")).length, 1);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  // no message: nothing dispatched
  const id2 = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-24T10:00:00Z" }))).json()).call.id;
  assert.equal((await callId.onRequestPost(ctx(`/api/calls/${id2}`, { action: "cancel" }, { id: id2 }))).status, 200);
  assert.equal(waits.length, 1);
});

test("GET /api/calls/:id: an ended demo keeps its links (sending one extends it), but the script doesn't claim a site", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM demos WHERE slug = 'diamond-kb-ab12'").run();
  const { ctx } = harness(DB);
  const id = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-23T10:00:00Z" }))).json()).call.id;
  const page = await (await callId.onRequestGet(ctx(`/api/calls/${id}`, null, { id }))).json();
  assert.equal(page.lead.demo_url, "");
  assert.deepEqual(page.links, {
    demo: "https://aetoswebsites.com/d/diamond-kb-old1",
    order: "https://aetoswebsites.com/d/diamond-kb-old1/order",
  });
});

test("Too-long words are refused before anything is booked or changed", async () => {
  const DB = await seeded();
  const { ctx } = harness(DB);
  const long = "x".repeat(20001);
  const booking = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", message: long, message_id: "m6" }));
  assert.equal(booking.status, 422);
  assert.equal((await booking.json()).error, "Couldn't save: that's too long (20,001 characters, 20,000 max).");
  assert.equal((await all(DB, "SELECT id FROM calls")).length, 0);
  const tooLongPhone = await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-22T14:00:00Z", phone: "0".repeat(41) }));
  assert.equal(tooLongPhone.status, 422);
  assert.equal((await tooLongPhone.json()).error, "That phone number is too long (40 characters max).");
  const id = (await (await calls.onRequestPost(ctx("/api/calls", { place_id: "a", at: "2026-10-23T10:00:00Z" }))).json()).call.id;
  const after = new Date("2026-10-23T10:40:00Z");
  const msg = await callId.onRequestPost(ctx(`/api/calls/${id}`, { action: "ordering", message: long }, { id }, after));
  assert.equal(msg.status, 422);
  assert.equal((await msg.json()).error, "Couldn't save: that message is too long (20,001 characters, 20,000 max).");
  const note = await callId.onRequestPost(ctx(`/api/calls/${id}`, { action: "done", note: long }, { id }, after));
  assert.equal(note.status, 422);
  assert.equal((await note.json()).error, "Couldn't save: that note is too long (20,001 characters, 20,000 max).");
  assert.equal((await one(DB, "SELECT status FROM calls WHERE id = ?", id)).status, "confirmed");
});
