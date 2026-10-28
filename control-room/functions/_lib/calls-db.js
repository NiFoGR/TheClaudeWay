// Calls (db), stage 8: holding, booking, cancelling and recording calls in Nik's 11am slots. The rules are calls.js's
// (pure); this file applies them to the `calls` table. Run: node --test control-room/tests/calls-db.test.mjs
//
// - One call per UK day. The check is made twice: canHold on the rows read, then again inside the write (an INSERT or
//   UPDATE guarded by NOT EXISTS), so two confirms racing for the same day can't both land. Nik's own bookings
//   (byNik) are never refused for a taken day: they get a warning instead.
// - One live call per prospect: a new offer releases their earlier offers; a booking cancels every other offered or
//   confirmed call of theirs (and closes that call's Todo).
// - Reply drill calls (place_id "drill:…", Task 17) are practice: they never take a day from anyone, aren't in
//   liveCalls, and a drill booking adds no `call` Todo. "test:" leads (Nik's own test lead) work like real ones.
// - Every calls write is one DB.batch, with the closing of that call's Todos in it. A call's Todos (`call:<id>`,
//   `call-outcome:<id>`) are closed keeping their dedupe (status done), not with todo.js's closeTodos (which frees
//   it): a call id is never booked again, so they never need to come back. New Todos go through todo.js's addTodo,
//   stage changes only through prospects.js's applyStageEvent, and Nik's messages through replies.js's buildReply +
//   the outbox's queueMessage.
import { callTodoTitle, canHold, offerExpired, OFFER_HOLD_HOURS } from "./calls.js";
import { queueMessage } from "./mail/outbox.js";
import { businessName } from "./mail/rules.js";
import { applyStageEvent } from "./prospects.js";
import { buildReply } from "./replies.js";
import { getSetting } from "./settings.js";
import { addTodo } from "./todo.js";
import { addUkDays, ukDate, ukDayStartUtc, ukParts, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

const HOUR_MS = 3600000;
const DRILL = "drill:";
const isDrill = (placeId) => String(placeId ?? "").startsWith(DRILL);

const BAD_TIME = "That isn't a valid date and time.";
const DAY_TAKEN = "That day already has a call booked or offered.";
const NIK_DAY_TAKEN = "You already have a call that day.";
const PAST = "Pick a time in the future.";
const NO_LEAD = "That lead isn't in the database.";
const NO_CALL = "That call isn't in the database.";
const UNKNOWN_ACTION = "Unknown action.";
const EMPTY_MESSAGE = "Couldn't save: write something first.";
const NO_THREAD = "Couldn't send: there's no email thread with them yet.";
const NO_MAILBOX = "Couldn't send: this thread has no mailbox. Add one on Setup → Mailboxes, then try again.";
const CHANGED = "That call changed while you were saving. Reload the page and try again.";
const PASSED = "That slot has passed or is under 30 minutes away.";
const DRILL_NOT_SENT = "drill: not sent";

// What each of Nik's actions does: the status it sets, the statuses it may start from, and the stage event it fires.
const ACTIONS = {
  cancel: { status: "cancelled", from: ["offered", "confirmed"], event: "call_cancelled" },
  done: { status: "done", from: ["confirmed"], event: null },
  no_show: { status: "no_show", from: ["confirmed"], event: "call_cancelled" },
  ordering: { status: "done", from: ["confirmed"], event: null, message: "required" },
  lost: { status: "done", from: ["confirmed"], event: "said_no", lost_reason: "call" },
};
const STATUS_WORDS = { done: "done", cancelled: "cancelled", no_show: "marked as no answer" };

// A Date, or ISO text with a zone ("2026-10-23T10:00:00Z"). Anything else is an Invalid Date.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const text = typeof value === "string" ? value.trim() : "";
  return ISO_TIME.test(text) ? new Date(text) : new Date(NaN);
}
const isValid = (date) => !Number.isNaN(date.getTime());

function nowDate(now, fn) {
  const at = toDate(now);
  if (!isValid(at)) throw new TypeError(`${fn} needs the time now, as a Date or an ISO time.`);
  return at;
}

// The UK day `at` falls on, as [start, end) in stored UTC text.
function ukDayBounds(at) {
  const day = ukDate(at);
  return [iso(ukToUtc(day, "00:00")), iso(ukToUtc(addUkDays(day, 1), "00:00"))];
}

// Offers made after this are still held (offerExpired's 48 hours; the slot-time half is `slot_at > now`).
const holdCutoff = (at) => iso(new Date(at.getTime() - OFFER_HOLD_HOURS * HOUR_MS));

// The calls that could take the slot's UK day, plus every live call of this prospect. ?1/?2 = the day, ?3 = place_id.
const DAY_AND_OWN_SQL = `SELECT * FROM calls WHERE status IN ('offered', 'confirmed')
  AND ((slot_at >= ?1 AND slot_at < ?2) OR place_id = ?3) ORDER BY created_at, id`;

// The lead and the prospect behind a place_id (either may be missing).
const LEAD_SQL = `SELECT l.place_id AS lead_id, l.name, l.phone AS lead_phone, p.place_id AS prospect_id, p.greet_name
  FROM (SELECT ?1 AS place_id) AS k
  LEFT JOIN leads AS l ON l.place_id = k.place_id
  LEFT JOIN prospects AS p ON p.place_id = k.place_id`;

// True inside a write when another call takes the day: a confirmed call, or an offer still held. `own` says whose
// calls count: "others" (a booking replaces the prospect's own calls) or "offer" (an offer is also blocked by their
// own confirmed call, as canHold says; their own offers never block them). Drill calls never count.
// Parameters: ?d1/?d2 the day, ?pid, ?now, ?cut (holdCutoff).
const clashSql = (own) => `EXISTS (SELECT 1 FROM calls AS o WHERE o.slot_at >= ?d1 AND o.slot_at < ?d2
  AND substr(o.place_id, 1, ${DRILL.length}) <> '${DRILL}'
  AND ${own === "others" ? "o.place_id <> ?pid AND " : ""}(o.status = 'confirmed'
    OR (o.status = 'offered' AND o.place_id <> ?pid AND o.created_at > ?cut AND o.slot_at > ?now)))`;

// D1 binds by position, so the guarded SQL names its values (?pid, ?d1…) and they are numbered here in the order
// they first appear; every name must have a value.
function prepare(DB, sql, values) {
  const used = [];
  const text = sql.replace(/\?([a-z]\w*)/g, (_, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`calls-db: no value for ?${name}`);
    if (!used.includes(name)) used.push(name);
    return `?${used.indexOf(name) + 1}`;
  });
  return DB.prepare(text).bind(...used.map((n) => values[n]));
}

// Closes the open `call:<id>` and `call-outcome:<id>` Todos of the calls in the JSON list ?2 (done at ?1), only when
// the call ?3 now has status ?4: so a write that lost a race closes nothing.
const CLOSE_TODOS_SQL = `UPDATE todos SET status = 'done', done_at = ?1
  WHERE status = 'open' AND dedupe IN (SELECT 'call:' || value FROM json_each(?2) UNION ALL SELECT 'call-outcome:' || value FROM json_each(?2))
    AND EXISTS (SELECT 1 FROM calls WHERE id = ?3 AND status = ?4)`;

const callRow = (fields) => ({ phone: null, note: "", ...fields });

/** Every call of this prospect, newest first. */
export async function callsFor(DB, place_id) {
  const { results } = await DB.prepare("SELECT * FROM calls WHERE place_id = ? ORDER BY created_at DESC, rowid DESC")
    .bind(String(place_id ?? ""))
    .all();
  return results;
}

/**
 * The calls that take a day: offers still held (slot ahead, offered under 48 hours ago) and confirmed calls from the
 * start of today (UK) on, so a call earlier today still takes today. Soonest first; drill calls left out.
 */
export async function liveCalls(DB, now) {
  const at = nowDate(now, "liveCalls");
  const { results } = await DB.prepare(
    `SELECT * FROM calls WHERE substr(place_id, 1, ${DRILL.length}) <> '${DRILL}'
       AND ((status = 'confirmed' AND slot_at >= ?1) OR (status = 'offered' AND slot_at > ?2 AND created_at > ?3))
     ORDER BY slot_at, id`,
  ).bind(iso(ukDayStartUtc(at)), iso(at), holdCutoff(at)).all();
  return results;
}

/**
 * Offer `slot_at` to this prospect: held for 48 hours (or until the slot), and their earlier offers released.
 * Refused with canHold's reason when it isn't a slot, is under 3 hours away, or the day is taken.
 */
export async function holdSlot(DB, { place_id, slot_at, now } = {}) {
  const at = nowDate(now, "holdSlot");
  const slot = toDate(slot_at);
  if (!isValid(slot)) return { ok: false, reason: BAD_TIME };
  const placeId = String(place_id ?? "");
  if (!placeId) return { ok: false, reason: NO_LEAD };
  const [d1, d2] = ukDayBounds(slot);
  const { results: calls } = await DB.prepare(DAY_AND_OWN_SQL).bind(d1, d2, placeId).all();
  const dayCalls = calls.filter((c) => c.slot_at >= d1 && c.slot_at < d2 && (c.place_id === placeId || !isDrill(c.place_id)));
  const check = canHold(slot, placeId, dayCalls, at);
  if (!check.ok) return { ok: false, reason: check.reason };

  const id = crypto.randomUUID();
  const stamp = iso(at);
  const call = callRow({ id, place_id: placeId, slot_at: iso(slot), status: "offered", created_at: stamp, updated_at: stamp });
  const [inserted] = await DB.batch([
    prepare(DB, `INSERT INTO calls (id, place_id, slot_at, status, phone, note, created_at, updated_at)
      SELECT ?id, ?pid, ?slot, 'offered', NULL, '', ?now, ?now WHERE NOT ${clashSql("offer")}`,
    { id, pid: placeId, slot: call.slot_at, now: stamp, d1, d2, cut: holdCutoff(at) }),
    DB.prepare(`UPDATE calls SET status = 'cancelled', updated_at = ?1
      WHERE place_id = ?2 AND status = 'offered' AND id <> ?3 AND EXISTS (SELECT 1 FROM calls WHERE id = ?3)`)
      .bind(stamp, placeId, id),
  ]);
  if (!(inserted.meta.changes > 0)) return { ok: false, reason: DAY_TAKEN };
  return { ok: true, call };
}

/**
 * Book a call. Claude's confirms (and the reply route's) need one of the slots, at least 30 minutes ahead, on a day
 * no other prospect holds or has booked; their own offer of that slot becomes the booking, even after its hold ran
 * out. Nik's (byNik) can be any future time, and a taken day gives `warning` instead of a refusal. The phone is the
 * one given, else the lead's. Every other offered or confirmed call of theirs is cancelled; the `call:<id>` Todo is
 * added (due at the call) and the prospect moves to call_booked. Confirming the same time again changes nothing
 * (but a new phone number).
 */
export async function confirmCall(DB, { place_id, slot_at, phone = null, now, byNik = false } = {}) {
  const at = nowDate(now, "confirmCall");
  const slot = toDate(slot_at);
  if (!isValid(slot)) return { ok: false, reason: BAD_TIME };
  const placeId = String(place_id ?? "");
  const lead = placeId ? await DB.prepare(LEAD_SQL).bind(placeId).first() : null;
  if (!lead || (lead.lead_id == null && lead.prospect_id == null)) return { ok: false, reason: NO_LEAD };

  const slotText = iso(slot);
  const stamp = iso(at);
  const given = typeof phone === "string" ? phone.trim() : phone == null ? "" : String(phone).trim();
  const number = given || (typeof lead.lead_phone === "string" && lead.lead_phone.trim()) || null;
  const [d1, d2] = ukDayBounds(slot);
  const { results: calls } = await DB.prepare(DAY_AND_OWN_SQL).bind(d1, d2, placeId).all();
  const own = calls.filter((c) => c.place_id === placeId);
  const others = calls.filter((c) => c.place_id !== placeId && !isDrill(c.place_id) && c.slot_at >= d1 && c.slot_at < d2);
  const todoFor = (call) => ({
    kind: "call",
    title: callTodoTitle({ first: lead.greet_name, business: businessName(lead.name ?? ""), slot_at: call.slot_at, phone: call.phone }),
    link: `/#/call/${call.id}`,
    place_id: placeId,
    due_at: call.slot_at,
    dedupe: `call:${call.id}`,
  });

  // Already booked for this time: keep it (a new number is saved).
  const same = own.find((c) => c.status === "confirmed" && c.slot_at === slotText);
  if (same) {
    // A call that has already happened isn't booked again (its Todo may have been closed by the calls step).
    if (slot.getTime() <= at.getTime()) return { ok: false, reason: byNik ? PAST : PASSED };
    const call = { ...same };
    if (given && given !== same.phone) {
      call.phone = given;
      call.updated_at = stamp;
      const todo = todoFor(call);
      await DB.batch([
        DB.prepare("UPDATE calls SET phone = ?, updated_at = ? WHERE id = ?").bind(given, stamp, same.id),
        DB.prepare("UPDATE todos SET title = ? WHERE dedupe = ? AND status = 'open'").bind(todo.title, todo.dedupe),
      ]);
    }
    if (!isDrill(placeId)) await addTodo(DB, todoFor(call));
    await applyStageEvent(DB, placeId, "call_confirmed", at);
    return { ok: true, call };
  }

  let warning;
  if (byNik) {
    if (slot.getTime() <= at.getTime()) return { ok: false, reason: PAST };
    const taken = others.some((c) => c.status === "confirmed" || (c.status === "offered" && !offerExpired(c, at)));
    if (taken) warning = NIK_DAY_TAKEN;
  } else {
    const check = canHold(slot, placeId, others, at, { confirm: true });
    if (!check.ok) return { ok: false, reason: check.reason };
  }

  // Their own offer of this exact slot becomes the booking; otherwise a new row. Either way created_at is when it was
  // booked (file 11 counts "calls booked" by a confirmed call's created_at), not when it was offered.
  const offer = own.find((c) => c.status === "offered" && c.slot_at === slotText);
  const id = offer ? offer.id : crypto.randomUUID();
  const guard = byNik ? "" : ` AND NOT ${clashSql("others")}`;
  const params = { id, pid: placeId, slot: slotText, phone: number, now: stamp };
  if (!byNik) Object.assign(params, { d1, d2, cut: holdCutoff(at) });
  const write = offer
    ? prepare(DB, `UPDATE calls SET status = 'confirmed', phone = ?phone, created_at = ?now, updated_at = ?now
        WHERE id = ?id AND place_id = ?pid AND slot_at = ?slot AND status = 'offered'${guard}`, params)
    : prepare(DB, `INSERT INTO calls (id, place_id, slot_at, status, phone, note, created_at, updated_at)
        SELECT ?id, ?pid, ?slot, 'confirmed', ?phone, '', ?now, ?now WHERE 1${guard}`, params);
  const replaced = own.filter((c) => c.id !== id && c.status === "confirmed").map((c) => c.id);
  const [written] = await DB.batch([
    write,
    DB.prepare(CLOSE_TODOS_SQL).bind(stamp, JSON.stringify(replaced), id, "confirmed"),
    DB.prepare(`UPDATE calls SET status = 'cancelled', updated_at = ?1
      WHERE place_id = ?2 AND status IN ('offered', 'confirmed') AND id <> ?3
        AND EXISTS (SELECT 1 FROM calls WHERE id = ?3 AND status = 'confirmed')`).bind(stamp, placeId, id),
  ]);
  if (!(written.meta.changes > 0)) return { ok: false, reason: DAY_TAKEN };

  const call = offer
    ? { ...offer, status: "confirmed", phone: number, created_at: stamp, updated_at: stamp }
    : callRow({ id, place_id: placeId, slot_at: slotText, status: "confirmed", phone: number, created_at: stamp, updated_at: stamp });
  if (!isDrill(placeId)) await addTodo(DB, todoFor(call));
  await applyStageEvent(DB, placeId, "call_confirmed", at);
  return warning ? { ok: true, call, warning } : { ok: true, call };
}

// The thread a message from Nik about this call goes in: the prospect, the thread's mailbox and their latest email
// from a person (never an out-of-office or a delivery report, whose sender may be a robot or MAILER-DAEMON), or, if
// they never wrote, the first email's thread to the prospect's address. {reason} when it can't be sent. A reply drill
// lead's message is stored cancelled ("drill: not sent"), never sent.
async function nikReply(DB, placeId, body, at) {
  const prospect = await DB.prepare(
    `SELECT p.place_id, p.email, p.subject, p.mailbox_id, p.root_message_id,
       m.id AS box_id, m.address AS box_address
     FROM prospects AS p LEFT JOIN mailboxes AS m ON m.id = p.mailbox_id WHERE p.place_id = ?`,
  ).bind(placeId).first();
  if (!prospect) return { reason: NO_THREAD };
  if (prospect.box_id == null) return { reason: NO_MAILBOX };
  const latest = await DB.prepare(
    `SELECT place_id, from_addr, subject, message_id, refs FROM messages
     WHERE place_id = ? AND direction = 'in' AND class = 'human' AND from_addr IS NOT NULL
     ORDER BY COALESCE(received_at, created_at) DESC, created_at DESC LIMIT 1`,
  ).bind(placeId).first();
  const inbound = latest ?? {
    place_id: placeId, from_addr: prospect.email, subject: prospect.subject, message_id: prospect.root_message_id, refs: null,
  };
  const senderName = await getSetting(DB, "business:sender_name", "");
  const row = buildReply({
    inbound,
    prospect,
    mailbox: { id: prospect.box_id, address: prospect.box_address },
    senderName,
    body,
    author: "nik",
    now: at,
  });
  return { row: isDrill(placeId) ? { ...row, status: "cancelled", error: DRILL_NOT_SENT } : row };
}

/**
 * Nik's actions on a call: cancel (offered or confirmed → cancelled; a booked one moves the stage back to replied),
 * done, no_show (stage back to replied), ordering (done, and `message` — the order link — goes to them as Nik's reply
 * in the thread), lost (done; stage lost, lost_reason call). `note` is kept on the call (blank keeps the old one); a
 * cancel's optional `message` is sent the same way. Every action closes `call:<id>` and `call-outcome:<id>`.
 */
export async function updateCall(DB, id, action, { note = "", message = "", now } = {}) {
  const at = nowDate(now, "updateCall");
  const rule = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!rule) return { ok: false, reason: UNKNOWN_ACTION };
  const call = typeof id === "string" && id ? await DB.prepare("SELECT * FROM calls WHERE id = ?").bind(id).first() : null;
  if (!call) return { ok: false, reason: NO_CALL };
  if (!rule.from.includes(call.status)) {
    const reason = call.status === "offered"
      ? "That call was only offered, never booked: cancel it instead."
      : `That call is already ${STATUS_WORDS[call.status] ?? call.status}.`;
    return { ok: false, reason };
  }

  const text = String(message ?? "").replace(/\r\n?/g, "\n").trim();
  if (rule.message === "required" && !text) return { ok: false, reason: EMPTY_MESSAGE };
  let reply = null;
  if (text) {
    const built = await nikReply(DB, call.place_id, text, at);
    if (built.reason) return { ok: false, reason: built.reason };
    reply = built.row;
  }

  const kept = String(note ?? "").trim();
  const stamp = iso(at);
  const [updated] = await DB.batch([
    DB.prepare(`UPDATE calls SET status = ?1, note = CASE WHEN ?2 = '' THEN note ELSE ?2 END, updated_at = ?3
      WHERE id = ?4 AND status = ?5`).bind(rule.status, kept, stamp, call.id, call.status),
    DB.prepare(CLOSE_TODOS_SQL).bind(stamp, JSON.stringify([call.id]), call.id, rule.status),
  ]);
  if (!(updated.meta.changes > 0)) return { ok: false, reason: CHANGED };

  if (reply) await queueMessage(DB, reply);
  // Cancelling an offer that was never booked leaves the stage alone.
  if (rule.event && !(action === "cancel" && call.status === "offered")) {
    await applyStageEvent(DB, call.place_id, rule.event, at, rule.lost_reason ? { lost_reason: rule.lost_reason } : {});
  }
  return { ok: true };
}

/**
 * Cancel every offered or confirmed call of this prospect still ahead (slot after `now`), soonest first, through
 * updateCall's cancel (status cancelled, `note` kept, its Todos closed, a booked one's stage back with call_cancelled,
 * which leaves a lost prospect lost). For when they say no, not now or opt out, by Claude's reading (recordReply) or
 * stage 0's (the inbound step's opt_out). → how many were cancelled.
 */
export async function cancelOpenCalls(DB, placeId, note, now) {
  const at = nowDate(now, "cancelOpenCalls");
  const { results } = await DB.prepare(
    "SELECT id FROM calls WHERE place_id = ? AND status IN ('offered', 'confirmed') AND slot_at > ? ORDER BY slot_at, id",
  ).bind(String(placeId ?? ""), iso(at)).all();
  let cancelled = 0;
  for (const c of results) if ((await updateCall(DB, c.id, "cancel", { note, now: at })).ok) cancelled++;
  return cancelled;
}

// --- The tick's calls step (position 9, every 5 minutes) -----------------------------------------------------------

const DAY_TODO_FROM_HOUR = 7;    // today's calls go on the board from 07:00 UK
const OUTCOME_AFTER_MIN = 30;    // ask how a call went 30 minutes after its time
const OUTCOME_MAX = 3;           // outcome Todos added a run, so a backlog can't eat the tick's D1 budget
const DAY_KEY = "calls-day:";
const pad2 = (n) => String(n).padStart(2, "0");

// "Mark (Diamond Kickboxing)"; no name → the business; neither → "them" (as callTodoTitle writes it).
function whoFor(row) {
  const name = String(row.greet_name ?? "").trim();
  const firm = businessName(row.name ?? "");
  return name && firm ? `${name} (${firm})` : name || firm || "them";
}

// Confirmed calls (no drills) with their lead's name and greeting name; each use adds its own slot_at filter. A call of
// a prospect who opted out is never listed (their opt-out cancels it: cancelOpenCalls; this covers a call left
// confirmed by an opt-out from before that).
const CALLS_WITH_NAMES = `SELECT c.id, c.place_id, c.slot_at, l.name, p.greet_name, COALESCE(c.phone, l.phone) AS phone
  FROM calls AS c LEFT JOIN leads AS l ON l.place_id = c.place_id LEFT JOIN prospects AS p ON p.place_id = c.place_id
  WHERE c.status = 'confirmed' AND substr(c.place_id, 1, ${DRILL.length}) <> '${DRILL}'
    AND NOT (COALESCE(p.stage, '') = 'lost' AND COALESCE(p.lost_reason, '') = 'opt_out')`;

/**
 * The tick's `calls` step: (1) releases offers whose hold ran out (48 hours, or the slot time if sooner: offerExpired's
 * rule, in SQL); (2) from 07:00 UK, once a day, when any confirmed calls are today, adds the `call` Todo
 * "Today's calls: 11:00 Mark (Diamond Kickboxing)" (dedupe calls-day:<YYYY-MM-DD>, due 07:00 UK), and closes an
 * earlier day's list left open; (3) 30 minutes
 * after a confirmed call's time, adds "How did the call with Mark (Diamond Kickboxing) go?" (dedupe
 * call-outcome:<id>, due then, linking to the call page) and closes its `call:<id>` Todo. At most 3 outcomes a run,
 * and fewer when ctx.budget is short. Drill calls get no Todos. Returns "released 1, today 1, outcome 0".
 */
export async function runCallsStep(ctx = {}) {
  const { DB, budget } = ctx;
  const at = nowDate(ctx.now, "runCallsStep");
  const stamp = iso(at);

  // 1. Expired offers.
  const released = await DB.prepare(
    "UPDATE calls SET status = 'cancelled', updated_at = ?1 WHERE status = 'offered' AND (created_at <= ?2 OR slot_at <= ?1)",
  ).bind(stamp, holdCutoff(at)).run();

  // 2. Today's calls, once a day from 07:00 UK (read only while the day's Todo isn't there yet). An earlier day's
  // list still open is closed first (dedupe kept), so yesterday's "Today's calls" never sits on the board as overdue.
  const day = ukDate(at);
  const dedupe = `calls-day:${day}`;
  await DB.prepare(`UPDATE todos SET status = 'done', done_at = ?1
    WHERE status = 'open' AND substr(dedupe, 1, ${DAY_KEY.length}) = '${DAY_KEY}' AND dedupe < ?2`).bind(stamp, dedupe).run();
  let today = 0;
  if (ukParts(at).hh >= DAY_TODO_FROM_HOUR) {
    const [d1, d2] = ukDayBounds(at);
    const { results } = await DB.prepare(`${CALLS_WITH_NAMES} AND c.slot_at >= ?1 AND c.slot_at < ?2
      AND NOT EXISTS (SELECT 1 FROM todos WHERE dedupe = ?3) ORDER BY c.slot_at, c.id`).bind(d1, d2, dedupe).all();
    if (results.length) {
      const list = results.map((c) => {
        const { hh, mm } = ukParts(toDate(c.slot_at));
        return `${pad2(hh)}:${pad2(mm)} ${whoFor(c)}`;
      });
      const added = await addTodo(DB, {
        kind: "call",
        title: `Today's calls: ${list.join(", ")}`,
        link: `/#/call/${results[0].id}`,
        due_at: ukToUtc(day, `${pad2(DAY_TODO_FROM_HOUR)}:00`),
        dedupe,
      });
      if (added) today = 1;
    }
  }

  // 3. Outcomes: the select, the close, one addTodo each, and one query kept for the tick's closing beat.
  const room = budget && typeof budget.left === "function" ? budget.left() - 3 : OUTCOME_MAX;
  const limit = Math.max(0, Math.min(OUTCOME_MAX, room));
  let outcome = 0;
  if (limit > 0) {
    const { results } = await DB.prepare(`${CALLS_WITH_NAMES} AND c.slot_at <= ?1
      AND NOT EXISTS (SELECT 1 FROM todos WHERE dedupe = 'call-outcome:' || c.id) ORDER BY c.slot_at, c.id LIMIT ?2`)
      .bind(iso(new Date(at.getTime() - OUTCOME_AFTER_MIN * 60000)), limit).all();
    // Their `call:<id>` Todos are closed first, keeping the dedupe as every other calls write here does: if the run
    // stops before an outcome Todo is added, that call is simply picked up again next run (its close is a no-op).
    if (results.length) {
      await DB.prepare(`UPDATE todos SET status = 'done', done_at = ?1
        WHERE status = 'open' AND dedupe IN (SELECT 'call:' || value FROM json_each(?2))`)
        .bind(stamp, JSON.stringify(results.map((c) => c.id))).run();
    }
    for (const c of results) {
      const added = await addTodo(DB, {
        kind: "call",
        title: `How did the call with ${whoFor(c)} go?`,
        link: `/#/call/${c.id}`,
        place_id: c.place_id,
        due_at: new Date(toDate(c.slot_at).getTime() + OUTCOME_AFTER_MIN * 60000),
        dedupe: `call-outcome:${c.id}`,
      });
      if (added) outcome++;
    }
  }
  return `released ${released.meta.changes ?? 0}, today ${today}, outcome ${outcome}`;
}
