// Calls in the database (stage 8): hold, confirm, cancel and outcomes. Run: node --test control-room/tests/calls-db.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { callsFor, cancelOpenCalls, confirmCall, holdSlot, liveCalls, updateCall } from "../functions/_lib/calls-db.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const D = (s) => new Date(s);
const EARLIER = "2026-10-19T07:01:03Z";
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

// Three replied prospects: a (Mark, Green Leaf Landscapes, who wrote back from mark@), b and c.
async function seeded() {
  const DB = fakeD1();
  await insert(DB, "settings", { key: "business:sender_name", value: "Nik" });
  await insert(DB, "mailboxes", {
    id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-10-01",
    created_at: EARLIER,
  });
  for (const [placeId, name, phone, greet] of [
    ["a", "GREEN LEAF LANDSCAPES LTD", "0113 496 0000", "Mark"],
    ["b", "Diamond Kickboxing", "07969 770905", "Sam"],
    ["c", "Smith Roofing", null, null],
  ]) {
    await insert(DB, "leads", {
      place_id: placeId, name, trade: "landscaper", search_town: "Leeds", phone, first_seen_at: EARLIER, updated_at: EARLIER,
    });
    await insert(DB, "prospects", {
      place_id: placeId, stage: "replied", stage_at: EARLIER, email: `${placeId}@them.co.uk`, greet_name: greet,
      mailbox_id: "mb1", subject: "Your new website", root_message_id: `<root-${placeId}@aetoswebsites.com>`,
      created_at: EARLIER, updated_at: EARLIER,
    });
  }
  await insert(DB, "messages", {
    id: "ma1", place_id: "a", mailbox_id: "mb1", direction: "in", kind: "inbound", author: "them",
    to_addr: "nik@aetoswebsites.com", from_addr: "mark@greenleaf.co.uk", subject: "Re: Your new website",
    body: "Can we have a call?", message_id: "<ma1@greenleaf.co.uk>", in_reply_to: "<root-a@aetoswebsites.com>",
    refs: "<root-a@aetoswebsites.com>", status: "received", received_at: "2026-10-19T09:00:00Z", class: "human",
    needs_reply: 0, created_at: "2026-10-19T09:00:00Z",
  });
  return DB;
}

// --- Task 8, Step 1 (as written in the plan) -----------------------------------------------------------------------

test("hold, confirm, cancel and ordering", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z"), FRI = D("2026-10-23T10:00:00Z");
  assert.equal((await holdSlot(DB, { place_id: "a", slot_at: FRI, now: NOW })).ok, true);
  assert.deepEqual(await holdSlot(DB, { place_id: "b", slot_at: FRI, now: NOW }), { ok: false, reason: "That day already has a call booked or offered." });
  await holdSlot(DB, { place_id: "a", slot_at: D("2026-10-24T10:00:00Z"), now: NOW });
  assert.equal((await callsFor(DB, "a")).filter((c) => c.status === "offered").length, 1);    // previous offer released
  assert.equal((await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-24T10:00:00Z"), phone: null, now: NOW })).ok, false);
  assert.equal((await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-24T10:00:00Z"), phone: null, now: D("2026-10-22T08:00:01Z") })).ok, true); // A's hold expired
  const c = await confirmCall(DB, { place_id: "a", slot_at: FRI, phone: "07700 900123", now: NOW });
  assert.equal(c.call.status, "confirmed"); assert.equal(c.call.phone, "07700 900123");
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "call_booked");
  const t = await one(DB, `SELECT * FROM todos WHERE dedupe='call:${c.call.id}'`);
  assert.equal(t.kind, "call"); assert.equal(t.due_at, "2026-10-23T10:00:00Z"); assert.equal(t.link, `/#/call/${c.call.id}`);
  assert.equal(t.title, "Call Mark (Green Leaf Landscapes) Fri 11:00 · 07700 900123");
  assert.equal((await confirmCall(DB, { place_id: "c", slot_at: D("2026-10-23T14:00:00Z"), phone: null, now: NOW, byNik: true })).warning, "You already have a call that day.");
  await updateCall(DB, c.call.id, "cancel", { now: NOW });
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "replied");
  assert.equal((await one(DB, `SELECT status FROM todos WHERE dedupe='call:${c.call.id}'`)).status, "done");
  const c2 = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-25T11:00:00Z"), phone: "07700 900123", now: NOW }); // Sun, GMT
  await updateCall(DB, c2.call.id, "ordering", { note: "wants it", message: "Great speaking to you. Here's the link to get started:\n\nhttps://aetoswebsites.com/d/green-leaf-ab12/order", now: D("2026-10-25T11:40:00Z") });
  const m = await one(DB, "SELECT * FROM messages WHERE author='nik' AND kind='reply'");
  assert.match(m.body, /\/d\/green-leaf-ab12\/order/);
  assert.equal((await one(DB, `SELECT note FROM calls WHERE id='${c2.call.id}'`)).note, "wants it");
});

// --- More cases ----------------------------------------------------------------------------------------------------

test("the ordering reply goes in their thread, from the thread's mailbox, signed, at once", async () => {
  const DB = await seeded();
  const c = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-25T11:00:00Z"), phone: null, now: D("2026-10-20T08:00:00Z") });
  assert.equal(c.call.phone, "0113 496 0000");                                   // no number given: the lead's
  const r = await updateCall(DB, c.call.id, "ordering", { message: "Here's the link:\n\nhttps://aetoswebsites.com/d/x/order", now: D("2026-10-25T23:40:00Z") });
  assert.deepEqual(r, { ok: true });
  const m = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(m.author, "nik"); assert.equal(m.to_addr, "mark@greenleaf.co.uk"); assert.equal(m.mailbox_id, "mb1");
  assert.equal(m.in_reply_to, "<ma1@greenleaf.co.uk>"); assert.equal(m.subject, "Re: Your new website");
  assert.equal(m.due_at, "2026-10-25T23:40:00Z");                                // Nik's mail goes at any hour
  assert.match(m.body, /\n\nNik\nAetos Websites$/);
  assert.equal((await one(DB, "SELECT status FROM calls WHERE id=?", c.call.id)).status, "done");
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "call_booked"); // won only from payment
});

test("ordering needs a message and a mailbox; nothing changes when refused", async () => {
  const DB = await seeded();
  const c = await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: D("2026-10-20T08:00:00Z") });
  assert.deepEqual(await updateCall(DB, c.call.id, "ordering", { message: "  ", now: D("2026-10-23T10:40:00Z") }),
    { ok: false, reason: "Couldn't save: write something first." });
  await DB.prepare("UPDATE prospects SET mailbox_id = NULL WHERE place_id='b'").run();
  assert.deepEqual(await updateCall(DB, c.call.id, "ordering", { message: "Link", now: D("2026-10-23T10:40:00Z") }),
    { ok: false, reason: "Couldn't send: this thread has no mailbox. Add one on Setup → Mailboxes, then try again." });
  assert.equal((await one(DB, "SELECT status FROM calls WHERE id=?", c.call.id)).status, "confirmed");
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM messages WHERE kind='reply'")).n, 0);
  // no inbound from b: the reply goes to the prospect's address in the first email's thread
  await DB.prepare("UPDATE prospects SET mailbox_id = 'mb1' WHERE place_id='b'").run();
  assert.equal((await updateCall(DB, c.call.id, "ordering", { message: "Link", now: D("2026-10-23T10:40:00Z") })).ok, true);
  const m = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(m.to_addr, "b@them.co.uk"); assert.equal(m.in_reply_to, "<root-b@aetoswebsites.com>");
  assert.equal(m.subject, "Re: Your new website");
});

test("outcomes: done, no answer, not for them; each closes the call's todos and keeps the note", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z");
  const done = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-21T10:00:00Z"), phone: "1", now: NOW });
  const noShow = await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-23T10:00:00Z"), phone: "2", now: NOW });
  const lost = await confirmCall(DB, { place_id: "c", slot_at: D("2026-10-24T10:00:00Z"), phone: "3", now: NOW });
  await insert(DB, "todos", {
    id: "o1", kind: "call", place_id: "a", title: "How did the call go?", dedupe: `call-outcome:${done.call.id}`,
    created_at: EARLIER,
  });
  assert.deepEqual(await updateCall(DB, done.call.id, "done", { note: "Thinking about it", now: D("2026-10-21T10:40:00Z") }), { ok: true });
  assert.deepEqual(await updateCall(DB, noShow.call.id, "no_show", { now: D("2026-10-23T10:40:00Z") }), { ok: true });
  assert.deepEqual(await updateCall(DB, lost.call.id, "lost", { note: "Too dear", now: D("2026-10-24T10:40:00Z") }), { ok: true });
  assert.deepEqual((await all(DB, "SELECT place_id, status, note FROM calls ORDER BY place_id")).map((r) => [r.place_id, r.status, r.note]),
    [["a", "done", "Thinking about it"], ["b", "no_show", ""], ["c", "done", "Too dear"]]);
  assert.deepEqual((await all(DB, "SELECT place_id, stage, lost_reason FROM prospects ORDER BY place_id")).map((r) => [r.place_id, r.stage, r.lost_reason]),
    [["a", "call_booked"], ["b", "replied"], ["c", "lost", "call"]].map(([p, s, l = null]) => [p, s, l]));
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM todos WHERE status='open'")).n, 0);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE id='o1'")).status, "done");
  assert.deepEqual(await updateCall(DB, done.call.id, "no_show", { now: D("2026-10-21T10:50:00Z") }),
    { ok: false, reason: "That call is already done." });
  assert.deepEqual(await updateCall(DB, "nope", "done", { now: NOW }), { ok: false, reason: "That call isn't in the database." });
  assert.deepEqual(await updateCall(DB, done.call.id, "explode", { now: NOW }), { ok: false, reason: "Unknown action." });
});

test("cancel with a note from Nik sends it; an offered call can be cancelled too", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z");
  const held = await holdSlot(DB, { place_id: "b", slot_at: D("2026-10-21T10:00:00Z"), now: NOW });
  assert.equal(held.call.status, "offered"); assert.equal(held.call.created_at, "2026-10-20T08:00:00Z");
  assert.deepEqual(await updateCall(DB, held.call.id, "cancel", { now: NOW }), { ok: true });
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='b'")).stage, "replied");
  const c = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-21T10:00:00Z"), phone: null, now: NOW });  // the day is free again
  assert.equal(c.ok, true);
  await updateCall(DB, c.call.id, "cancel", { message: "Sorry Mark, something came up. Can we do Friday?", now: NOW });
  const m = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(m.author, "nik"); assert.match(m.body, /^Sorry Mark/);
  assert.deepEqual(await updateCall(DB, c.call.id, "cancel", { now: NOW }), { ok: false, reason: "That call is already cancelled." });
});

test("one live call per prospect; a repeat confirm of the same slot is a no-op", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z");
  const held = await holdSlot(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), now: NOW });
  const c = await confirmCall(DB, { place_id: "a", slot_at: "2026-10-23T10:00:00Z", phone: "07700 900123", now: NOW });
  assert.equal(c.call.id, held.call.id);                                         // their offer becomes the booking
  const again = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: "07700 900123", now: NOW });
  assert.equal(again.ok, true); assert.equal(again.call.id, c.call.id);
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM todos WHERE kind='call'")).n, 1);
  // Nik moves it to Saturday: the Friday call is cancelled and its todo closed
  const moved = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-24T13:00:00Z"), phone: null, now: NOW, byNik: true });
  assert.equal(moved.ok, true); assert.equal(moved.warning, undefined);
  assert.deepEqual((await callsFor(DB, "a")).map((r) => r.status), ["confirmed", "cancelled"]);
  assert.equal((await one(DB, `SELECT status FROM todos WHERE dedupe='call:${c.call.id}'`)).status, "done");
  assert.equal((await one(DB, `SELECT title FROM todos WHERE dedupe='call:${moved.call.id}'`)).title, "Call Mark (Green Leaf Landscapes) Sat 14:00 · 0113 496 0000");
});

test("refusals: not a slot, too soon, past, bad time", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z");
  assert.deepEqual(await holdSlot(DB, { place_id: "a", slot_at: D("2026-10-22T10:00:00Z"), now: NOW }),
    { ok: false, reason: "That isn't one of Nik's call slots (11am Tue, Wed, Fri, Sat, Sun)." });
  assert.equal((await holdSlot(DB, { place_id: "a", slot_at: D("2026-10-20T10:00:00Z"), now: NOW })).ok, false); // 2 h away
  assert.equal((await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-20T10:00:00Z"), phone: null, now: NOW })).ok, true); // ≥ 30 min
  assert.deepEqual(await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-20T07:00:00Z"), phone: null, now: NOW, byNik: true }),
    { ok: false, reason: "Pick a time in the future." });
  assert.deepEqual(await holdSlot(DB, { place_id: "a", slot_at: "Friday", now: NOW }), { ok: false, reason: "That isn't a valid date and time." });
  assert.deepEqual(await confirmCall(DB, { place_id: "zz", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: NOW }),
    { ok: false, reason: "That lead isn't in the database." });
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM calls")).n, 1);
});

test("a confirm that loses a race for the day writes nothing", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z");
  // b's booking lands between a's read and a's write: simulated by a DB whose first calls read misses it
  let hide = true;
  const empty = { bind: () => empty, all: async () => ({ results: [] }), first: async () => null };
  const racing = {
    batch: (stmts) => DB.batch(stmts),
    prepare(sql) {
      if (hide && /FROM calls/.test(sql) && !/INSERT|UPDATE/.test(sql)) {
        hide = false;
        return empty;
      }
      return DB.prepare(sql);
    },
  };
  await insert(DB, "calls", {
    id: "bcall", place_id: "b", slot_at: "2026-10-23T10:00:00Z", status: "confirmed", created_at: EARLIER, updated_at: EARLIER,
  });
  assert.deepEqual(await confirmCall(racing, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: NOW }),
    { ok: false, reason: "That day already has a call booked or offered." });
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM calls")).n, 1);
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM todos")).n, 0);
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='a'")).stage, "replied");
});

test("liveCalls: held offers and confirmed calls from today on", async () => {
  const DB = await seeded();
  const rows = [
    ["x1", "a", "2026-10-23T10:00:00Z", "offered", "2026-10-20T08:00:00Z"],   // held
    ["x2", "b", "2026-10-24T10:00:00Z", "offered", "2026-10-18T08:00:00Z"],   // hold ran out
    ["x3", "c", "2026-10-25T11:00:00Z", "confirmed", EARLIER],
    ["x4", "c", "2026-10-21T06:30:00Z", "confirmed", EARLIER],                 // earlier today (UK): still takes the day
    ["x5", "c", "2026-10-20T10:00:00Z", "confirmed", EARLIER],                 // yesterday
    ["x6", "a", "2026-10-27T11:00:00Z", "cancelled", EARLIER],
  ];
  for (const [id, place_id, slot_at, status, created_at] of rows) {
    await insert(DB, "calls", { id, place_id, slot_at, status, created_at, updated_at: created_at });
  }
  assert.deepEqual((await liveCalls(DB, D("2026-10-21T08:00:00Z"))).map((r) => r.id), ["x4", "x1", "x3"]);
});

test("drill calls are practice: they never take a day and add no call Todo", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z"), FRI = D("2026-10-23T10:00:00Z");
  await insert(DB, "prospects", {
    place_id: "drill:confirms_slot", stage: "emailed", stage_at: EARLIER, email: "drill@drilltest.co.uk",
    created_at: EARLIER, updated_at: EARLIER,
  });
  assert.equal((await holdSlot(DB, { place_id: "drill:call_request", slot_at: FRI, now: NOW })).ok, true);
  const d = await confirmCall(DB, { place_id: "drill:confirms_slot", slot_at: FRI, phone: "07700 900123", now: NOW });
  assert.equal(d.ok, true);
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id='drill:confirms_slot'")).stage, "call_booked");
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM todos")).n, 0);
  assert.deepEqual(await liveCalls(DB, NOW), []);
  const real = await confirmCall(DB, { place_id: "a", slot_at: FRI, phone: null, now: NOW });
  assert.equal(real.ok, true); assert.equal(real.warning, undefined);
});

test("Nik's message answers their last email from a person, never an out-of-office or a delivery report", async () => {
  const DB = await seeded();
  const c = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: D("2026-10-20T08:00:00Z") });
  await insert(DB, "messages", {
    id: "ma2", place_id: "a", mailbox_id: "mb1", direction: "in", kind: "inbound", author: "them",
    to_addr: "nik@aetoswebsites.com", from_addr: "MAILER-DAEMON@mx.greenleaf.co.uk", subject: "Delivery delayed",
    body: "Your message is delayed", message_id: "<ma2@mx.greenleaf.co.uk>", status: "received",
    received_at: "2026-10-22T09:00:00Z", class: "auto", needs_reply: 0, created_at: "2026-10-22T09:00:00Z",
  });
  assert.equal((await updateCall(DB, c.call.id, "ordering", { message: "Link", now: D("2026-10-23T10:40:00Z") })).ok, true);
  const m = await one(DB, "SELECT * FROM messages WHERE kind='reply'");
  assert.equal(m.to_addr, "mark@greenleaf.co.uk"); assert.equal(m.in_reply_to, "<ma1@greenleaf.co.uk>");
});

test("a drill lead's message from Nik is stored cancelled, never sent", async () => {
  const DB = await seeded();
  await insert(DB, "prospects", {
    place_id: "drill:confirms_slot", stage: "emailed", stage_at: EARLIER, email: "drill@drilltest.co.uk", mailbox_id: "mb1",
    subject: "Your new website", root_message_id: "<root-drill@aetoswebsites.com>", created_at: EARLIER, updated_at: EARLIER,
  });
  const d = await confirmCall(DB, { place_id: "drill:confirms_slot", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: D("2026-10-20T08:00:00Z") });
  assert.equal((await updateCall(DB, d.call.id, "ordering", { message: "Link", now: D("2026-10-23T10:40:00Z") })).ok, true);
  assert.deepEqual(await one(DB, "SELECT status, error FROM messages WHERE kind='reply'"), { status: "cancelled", error: "drill: not sent" });
});

test("a booked call that has already happened isn't confirmed again", async () => {
  const DB = await seeded();
  const c = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: D("2026-10-20T08:00:00Z") });
  await DB.prepare("UPDATE todos SET status = 'done', dedupe = dedupe || '@x'").run();   // closed by the calls step
  assert.deepEqual(await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: D("2026-10-23T10:31:00Z") }),
    { ok: false, reason: "That slot has passed or is under 30 minutes away." });
  assert.deepEqual(await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: null, now: D("2026-10-23T10:31:00Z"), byNik: true }),
    { ok: false, reason: "Pick a time in the future." });
  assert.equal((await one(DB, "SELECT COUNT(*) n FROM todos WHERE status='open'")).n, 0);
  assert.equal(c.ok, true);
});

// --- Regressions ----------------------------------------------------------------------------------------------------

test("a booked call's created_at is when it was booked, also when their own offer becomes the booking", async () => {
  const DB = await seeded();
  const held = await holdSlot(DB, { place_id: "a", slot_at: D("2026-10-27T11:00:00Z"), now: D("2026-10-25T20:00:00Z") }); // Sun
  assert.equal(held.ok, true);
  const c = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-27T11:00:00Z"), phone: "07700 900123", now: D("2026-10-26T09:00:00Z") }); // Mon
  assert.equal(c.ok, true);
  assert.equal(c.call.id, held.call.id);
  const row = await one(DB, "SELECT * FROM calls WHERE id = ?", c.call.id);
  assert.equal(row.status, "confirmed");
  assert.equal(row.created_at, "2026-10-26T09:00:00Z");
  assert.equal(c.call.created_at, "2026-10-26T09:00:00Z");
  assert.equal(c.call.status, "confirmed");
  assert.deepEqual({ ...row }, c.call); // the returned call is the stored row
});

test("cancelOpenCalls: every offered or confirmed call still ahead is cancelled with the note, its Todo closed", async () => {
  const DB = await seeded();
  const NOW = D("2026-10-20T08:00:00Z");
  const booked = await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-23T10:00:00Z"), phone: "1", now: NOW });
  const other = await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-24T10:00:00Z"), phone: "2", now: NOW });
  assert.equal(await cancelOpenCalls(DB, "a", "Cancelled by their email: they asked not to be emailed again.", D("2026-10-21T08:00:00Z")), 1);
  const row = await one(DB, "SELECT status, note FROM calls WHERE id = ?", booked.call.id);
  assert.deepEqual({ ...row }, { status: "cancelled", note: "Cancelled by their email: they asked not to be emailed again." });
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = ?", `call:${booked.call.id}`)).status, "done");
  assert.equal((await one(DB, "SELECT status FROM calls WHERE id = ?", other.call.id)).status, "confirmed"); // someone else's stays
  assert.equal((await one(DB, "SELECT stage FROM prospects WHERE place_id = 'a'")).stage, "replied"); // call_cancelled
  assert.equal(await cancelOpenCalls(DB, "a", "again", D("2026-10-21T08:05:00Z")), 0);
});
