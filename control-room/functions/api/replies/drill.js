// The reply drill (stage 7, docs/rebuild/07-replies-calls.md Task 17; "Run the reply drill" / "Check the result" on
// the Replies page). Behind the login (_middleware.js). Tested in tests/reply-drill.test.mjs.
//
// POST /api/replies/drill → wipes every drill:% row (prospects, messages, calls, todos), seeds the 14 practice
// emails of DRILL_CASES (prospect drill:<key>, stage emailed, one inbound message each: class human, needs_reply 1;
// the confirms_slot thread also gets Claude's earlier offer of the next free slot, stored cancelled, and that slot
// held as an offered call), then wakes the reply Routine once: "reply waiting: 14 message(s)". Nothing is ever sent:
// drill replies are stored cancelled ("drill: not sent"), drill calls take no day from a real lead and add no call
// Todo, and a drill opt-out suppresses nobody (replies-db.js / calls-db.js). 200 {ok, seeded, fired, slot};
// 409 while Claude's replies are paused (the drill would never be answered); 502 when the Routine couldn't be woken
// (the emails stay seeded: the next run answers them). The fire's error never holds the URL or the token.
//
// GET /api/replies/drill → gradeDrill over what the Routine did, read from the database: per case the inbound
// message's intent, whether a reply row answers it (In-Reply-To = its Message-ID) or an escalation:<id> Todo exists,
// the case's call status (confirmed, else offered) and its open Todo kinds. 200 {right, total, wrong, waiting,
// checked_at}, also stored as the setting replies:last_drill (the Replies page shows it). 404 before any drill.
import { holdSlot, liveCalls } from "../../_lib/calls-db.js";
import { nextFreeSlots, slotLabel, takenFrom } from "../../_lib/calls.js";
import { DRILL_CASES, gradeDrill } from "../../_lib/replyDrill.js";
import { signature } from "../../_lib/replies.js";
import { fireRoutine } from "../../_lib/routines.js";
import { getSetting, setSetting } from "../../_lib/settings.js";
import { db, iso, json, parseJson } from "../../_lib/util.js";

const DRILL = "drill:";
const IS_DRILL = `substr(place_id, 1, ${DRILL.length}) = '${DRILL}'`;
const LAST_DRILL = "replies:last_drill";
const SUBJECT = "Your new website";
const OFFER_LEAD_MS = 10 * 60_000; // Claude's earlier offer in the confirms_slot thread, 10 minutes before the drill
const DRILL_NOT_SENT = "drill: not sent";

const PAUSED = "Claude's replies are paused, so the drill would never be answered. Turn them back on, then run it.";
const NO_SLOT = "There's no free call slot in the next 56 days, so the call cases can't be practised. Free a day, then run the drill again.";
const NO_DRILL = "No drill has been run yet: press Run the reply drill first.";
const notWoken = (error) => `The 14 practice emails are ready, but Claude couldn't be woken: ${error}`;

const WIPE = ["todos", "calls", "messages", "prospects"].map((t) => `DELETE FROM ${t} WHERE ${IS_DRILL}`);

// Each drill lead with its newest inbound message and what the Routine did about it (one statement).
const OUTCOMES_SQL = `SELECT p.place_id, i.id AS message_id, i.intent,
    EXISTS (SELECT 1 FROM messages r WHERE r.place_id = p.place_id AND r.direction = 'out' AND r.kind = 'reply'
      AND r.author = 'claude' AND r.in_reply_to = i.message_id) AS replied,
    EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = 'escalation:' || i.id) AS escalated,
    (SELECT CASE WHEN SUM(c.status = 'confirmed') > 0 THEN 'confirmed' WHEN SUM(c.status = 'offered') > 0 THEN 'offered' END
      FROM calls c WHERE c.place_id = p.place_id) AS call_status,
    (SELECT json_group_array(t.kind) FROM todos t WHERE t.place_id = p.place_id AND t.status = 'open') AS todo_kinds,
    (SELECT COUNT(*) FROM messages w WHERE w.place_id = p.place_id AND w.direction = 'in' AND w.needs_reply = 1) AS waiting
  FROM prospects p
  LEFT JOIN messages i ON i.id = (SELECT m.id FROM messages m WHERE m.place_id = p.place_id AND m.direction = 'in'
    ORDER BY COALESCE(m.received_at, m.created_at) DESC, m.id DESC LIMIT 1)
  WHERE substr(p.place_id, 1, ${DRILL.length}) = '${DRILL}'`;

function insert(DB, table, row) {
  const cols = Object.keys(row);
  return DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row));
}

/** Seed the drill and wake the reply Routine. `context.now` and `context.fetchImpl` are for tests. */
export async function onRequestPost(context) {
  const { env } = context;
  const DB = await db(env);
  const at = context.now ?? new Date();
  if ((await getSetting(DB, "replies:paused")) === "1") return json({ error: PAUSED }, 409);

  // The slot Claude "offered" in the confirms_slot thread: the next one free of real calls (drill calls take none).
  const [slot] = nextFreeSlots(at, takenFrom(await liveCalls(DB, at), at));
  if (!slot) return json({ error: NO_SLOT }, 422);

  const run = crypto.randomUUID().slice(0, 8);
  const offerAt = new Date(at.getTime() - OFFER_LEAD_MS);
  const senderName = (await getSetting(DB, "business:sender_name", "")) ?? "";
  const stamp = iso(at);
  const rows = [];
  DRILL_CASES.forEach((c, n) => {
    const placeId = `${DRILL}${c.key}`;
    const from = `${c.key.replace(/_/g, "-")}@example.com`;
    // Oldest first in the cases' order, so the inbox hands them to Claude in that order.
    const receivedAt = iso(new Date(at.getTime() - (DRILL_CASES.length - n) * 1000));
    rows.push(insert(DB, "prospects", {
      place_id: placeId, stage: "emailed", stage_at: stamp, email: from, greet_name: null, mailbox_id: null,
      subject: SUBJECT, created_at: stamp, updated_at: stamp,
    }));
    if (c.key === "confirms_slot") {
      const offerStamp = iso(offerAt);
      rows.push(insert(DB, "messages", {
        id: `drill-${run}-offer`, place_id: placeId, direction: "out", kind: "reply", author: "claude", to_addr: from,
        subject: `Re: ${SUBJECT}`,
        body: `Hi,\n\nYes of course. Soonest I am available for a phone call is ${slotLabel(slot)}. If that doesn't work let me know a day and time if you can. Thank you.\n\n${signature(senderName)}`,
        status: "cancelled", error: DRILL_NOT_SENT, due_at: offerStamp, created_at: offerStamp,
      }));
    }
    const id = `drill-${run}-${c.key}`;
    rows.push(insert(DB, "messages", {
      id, place_id: placeId, direction: "in", kind: "inbound", author: "them", from_addr: from, subject: `Re: ${SUBJECT}`,
      body: c.text, message_id: `<${id}@example.com>`, status: "received", received_at: receivedAt, class: "human",
      needs_reply: 1, created_at: receivedAt,
    }));
  });
  await DB.batch([...WIPE.map((sql) => DB.prepare(sql)), ...rows]);

  const held = await holdSlot(DB, { place_id: `${DRILL}confirms_slot`, slot_at: slot, now: offerAt });
  if (!held.ok) return json({ error: `Couldn't hold the practice call: ${held.reason} Run the drill again.` }, 409);

  const text = `reply waiting: ${DRILL_CASES.length} message(s)`;
  const fetchImpl = context.fetchImpl ?? env?.__fetch; // tests only; live both are undefined, so fireRoutine uses fetch
  const fired = await fireRoutine(DB, "reply", text, fetchImpl ? { fetchImpl, now: at } : { now: at });
  if (!fired.ok) return json({ error: notWoken(fired.error) }, 502);
  return json({ ok: true, seeded: DRILL_CASES.length, fired: true, slot: iso(slot) });
}

/** Grade the drill and store the result. `context.now` is for tests. */
export async function onRequestGet(context) {
  const DB = await db(context.env);
  const at = context.now ?? new Date();
  const { results } = await DB.prepare(OUTCOMES_SQL).all();
  if (!results.length) return json({ error: NO_DRILL }, 404);

  const outcomes = {};
  let waiting = 0;
  for (const r of results) {
    const key = r.place_id.slice(DRILL.length);
    const kinds = parseJson(r.todo_kinds, []);
    outcomes[key] = {
      action: Number(r.escalated) === 1 ? "escalate" : Number(r.replied) === 1 ? "reply" : "none",
      intent: r.intent ?? null,
      call_status: r.call_status ?? null,
      todo_kinds: Array.isArray(kinds) ? kinds : [],
    };
    waiting += Number(r.waiting) || 0;
  }
  const result = { ...gradeDrill(DRILL_CASES, outcomes), waiting, checked_at: iso(at) };
  await setSetting(DB, LAST_DRILL, JSON.stringify(result));
  return json(result);
}
