// GET /api/calls?place_id= → {calls, free_slots, phone}: a prospect's calls (newest first, each with its UK `label`),
// the next 3 free call slots for them [{slot_at, label}] (their own held offer stays free to them) and the lead's
// phone (the booking form's default). POST /api/calls {place_id, at, phone?, message?, message_id?} → Nik books a call
// by hand (stage 8, docs/rebuild/07-replies-calls.md): any future time, a slot or not (confirmCall byNik in
// _lib/calls-db.js); a day that already has a call is booked anyway, with `warning`. With `message` + `message_id`
// (the Replies page's call-time card, "Book and send") his words go as his reply to that email (sendAsNik in
// _lib/replies-db.js), which closes its call_time Todo; it goes straight away (dispatchDue, replies only, one email) in
// waitUntil. 200 {ok, call, label, warning?, reply?}; 422 {error} "Pick a time in the future." and the other plain-English
// refusals, 404 a lead that isn't there. The call is booked before the email is written: when only the email fails,
// the answer is that 422 with `call`, and pressing again books nothing new and sends once. A lead with another
// escalation or call_time Todo still open stays needs_nik (keepNeedsNik). Behind the login
// (_middleware.js). Tested in tests/calls-api.test.mjs.
import { nextFreeSlots, slotLabel, takenFrom } from "../_lib/calls.js";
import { callsFor, confirmCall, liveCalls } from "../_lib/calls-db.js";
import { dispatchDue } from "../_lib/mail/outbox.js";
import { applyStageEvent } from "../_lib/prospects.js";
import { sendAsNik } from "../_lib/replies-db.js";
import { errorText } from "../_lib/tick.js";
import { bad, db, iso, json } from "../_lib/util.js";

const UNREADABLE = "Couldn't book: the request wasn't readable. Refresh the page and try again.";
const NO_LEAD = "That lead isn't in the database.";
const WRITE_FIRST = "Couldn't save: write something first.";
const NO_EMAIL = "Couldn't send: there's no email of theirs to answer. Book without a message, or reply from the thread.";
const WRONG_EMAIL = "Couldn't send: that email isn't from this lead. Refresh the page and try again.";
const PHONE_MAX = 40; // characters
const PHONE_LONG = `That phone number is too long (${PHONE_MAX} characters max).`;
const MESSAGE_MAX = 20000; // characters: sendAsNik's limit, checked before anything is booked
const fmtCount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// While any escalation or call_time Todo of a lead is open its stage stays needs_nik (replies-db.js's NIK_KINDS rule), so
// Claude never answers in a thread Nik still has to deal with. Booking moves a needs_nik lead to call_booked
// (call_confirmed), so it goes back to needs_nik while one is still open; replies-db's nikHandled books it again once
// he has dealt with the last. Only for a lead that was needs_nik before the booking.
const STAGE_SQL = "SELECT stage FROM prospects WHERE place_id = ?";
const NIK_OPEN_SQL = `SELECT COUNT(*) AS n FROM todos WHERE place_id = ? AND status = 'open' AND kind IN ('escalation', 'call_time')`;
async function keepNeedsNik(DB, placeId, wasStage, at) {
  if (wasStage !== "needs_nik") return;
  if (!(Number(await DB.prepare(NIK_OPEN_SQL).bind(placeId).first("n")) > 0)) return;
  await applyStageEvent(DB, placeId, "escalate", at);
}

const text = (value) => (typeof value === "string" ? value.trim() : "");
const withLabel = (call) => ({ ...call, label: slotLabel(call.slot_at) });

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  const placeId = text(new URL(request.url).searchParams.get("place_id"));
  const [own, live, lead] = await Promise.all([
    placeId ? callsFor(DB, placeId) : [],
    liveCalls(DB, at),
    placeId ? DB.prepare("SELECT phone FROM leads WHERE place_id = ?").bind(placeId).first() : null,
  ]);
  const free = nextFreeSlots(at, takenFrom(live, at, placeId || undefined));
  return json({
    calls: own.map(withLabel),
    free_slots: free.map((slot) => ({ slot_at: iso(slot), label: slotLabel(slot) })),
    phone: text(lead?.phone) || null,
  });
}

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad(UNREADABLE);
  const DB = await db(env);
  const at = context.now ?? new Date();
  const placeId = text(input.place_id);
  const phone = typeof input.phone === "string" ? input.phone.trim() : null;
  if (phone && phone.length > PHONE_MAX) return bad(PHONE_LONG, 422);
  const message = typeof input.message === "string" ? input.message : "";
  const messageId = text(input.message_id);

  // The email is checked before anything is booked: it must be one of this lead's, and say something.
  if (messageId) {
    const words = message.replace(/\r\n?/g, "\n").trim();
    if (!words) return bad(WRITE_FIRST, 422);
    if (words.length > MESSAGE_MAX) {
      return bad(`Couldn't save: that's too long (${fmtCount(words.length)} characters, ${fmtCount(MESSAGE_MAX)} max).`, 422);
    }
    const theirs = await DB.prepare("SELECT place_id FROM messages WHERE id = ? AND direction = 'in'").bind(messageId).first();
    if (!theirs || theirs.place_id !== placeId) return bad(WRONG_EMAIL, 422);
  } else if (message.trim()) {
    return bad(NO_EMAIL, 422);
  }

  const wasStage = placeId ? await DB.prepare(STAGE_SQL).bind(placeId).first("stage") : null;
  const booked = await confirmCall(DB, { place_id: placeId, slot_at: input.at, phone, now: at, byNik: true });
  if (!booked.ok) return bad(booked.reason, booked.reason === NO_LEAD ? 404 : 422);
  const out = { ok: true, call: booked.call, label: slotLabel(booked.call.slot_at) };
  if (booked.warning) out.warning = booked.warning;
  if (!messageId) {
    await keepNeedsNik(DB, placeId, wasStage, at);
    return json(out);
  }

  const sent = await sendAsNik(DB, { message_id: messageId, body: message, now: at });
  await keepNeedsNik(DB, placeId, wasStage, at);
  if (sent.status !== 200) {
    return json({ error: `The call is booked, but the email wasn't sent. ${sent.body.error}`, call: booked.call }, sent.status);
  }
  const reply = sent.body;
  out.reply = { reply_id: reply.reply_id, status: reply.status, due_at: reply.due_at };
  if (reply.status === "queued" && reply.due_at && reply.due_at <= iso(at) && typeof context.waitUntil === "function") {
    context.waitUntil(dispatchDue(DB, env, at, { limit: 1, kinds: ["reply"] }).catch((err) => {
      console.error(`Nik's message about the call couldn't be sent straight away (the tick's send step sends it): ${errorText(err, env)}`);
    }));
  }
  return json(out);
}
