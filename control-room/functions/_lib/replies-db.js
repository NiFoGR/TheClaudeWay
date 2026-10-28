// Replies (db), stage 7. onHumanInbound is the hook stage 0's inbound step calls for every human email linked to a
// prospect (outcome "human"): it decides whether Claude may answer it, moves the prospect on and stops the
// follow-ups. Stage changes only go through prospects.js's applyStageEvent and follow-ups only stop through
// followups.js's stopFollowups; nothing here writes prospects.stage or the follow-up columns itself.
// Inbound text is untrusted: it's copied into todos as plain text, and whatever shows it escapes it.
//
// It also holds the tick step reply_fire (wake the reply Routine when mail waits) and registers the Replies health
// light with stage 0's registerLight at module load (tick.js imports this module, so the light exists wherever health
// is computed).
//
// And what the reply Routine reads: buildInbox (GET /api/agent/inbox, everything Claude is given in one request) and
// seedVoice (Nik's two example replies, added once). And recordReply (POST /api/agent/reply): Claude's reply checked,
// queued in the thread and the intent's bookkeeping done. And escalateMessage (POST /api/agent/escalate: a draft for
// Nik as an escalation Todo), sendAsNik ("Send as me" / "Reply as me", unchecked, any hour) and dismissTodo.
import { callTimeDue, canHold, nextFreeSlots, offerExpired, slotLabel, takenFrom } from "./calls.js";
import { cancelOpenCalls, confirmCall, holdSlot, liveCalls } from "./calls-db.js";
import { DEMO_BASE, demoLink } from "./demo-db.js";
import { stopFollowups } from "./followups.js";
import { registerLight } from "./health.js";
import { businessName } from "./mail/rules.js";
import { offerFacts } from "./offer.js";
import { queueMessage } from "./mail/outbox.js";
import { applyStageEvent, isSuppressed, suppress } from "./prospects.js";
import {
  ESCALATE_INTENTS, INTENTS, REPLY_HOURS, buildReply, escalationTitle, intentEffects, replyLight, sendTime, shouldFireReply,
  stripQuoted,
} from "./replies.js";
import { DRILL_LEAD } from "./replyDrill.js";
import { REPLY_HOSTS, replyGuard } from "./replyGuard.js";
import { fireRoutine } from "./routines.js";
import { addTodo } from "./todo.js";
import { addUkDays, inUkWindow, ukDate, ukDayStartUtc, ukParts, ukToUtc } from "./ukTime.js";
import { iso, parseJson } from "./util.js";

/** A lead lost for one of these reasons is answered again when they write (event reopen: lost → replied). */
export const REOPEN_REASONS = Object.freeze(["not_now", "not_interested", "sequence_done", "call"]);

// Lost for these, they asked not to be written to (or the address is dead): Nik reads it, Claude never answers.
const NO_CONTACT = ["opt_out", "bounce"];
const DETAIL_CHARS = 600; // their message in a todo, as text

// The prospect, its lead's name and the client made from it (a lead paid at most once, but the oldest wins if not).
const PROSPECT_SQL = `
  SELECT p.stage, p.lost_reason, l.name AS lead_name, c.id AS client_id, c.name AS client_name
  FROM prospects AS p
  LEFT JOIN leads AS l ON l.place_id = p.place_id
  LEFT JOIN (SELECT id, name FROM clients WHERE place_id = ?1 ORDER BY created_at, id LIMIT 1) AS c ON 1
  WHERE p.place_id = ?1`;
const NO_REPLY_SQL = "UPDATE messages SET needs_reply = 0 WHERE id = ?";
const CLIENT_SQL = "UPDATE messages SET needs_reply = 0, client_id = COALESCE(?, client_id) WHERE id = ?";
// Stage 6's stop rules read last_inbound_at; it never moves backwards (as stage 0 writes it).
const LAST_INBOUND_SQL = `UPDATE prospects SET last_inbound_at = ?1, updated_at = ?2
  WHERE place_id = ?3 AND (last_inbound_at IS NULL OR last_inbound_at < ?1)`;

function toDate(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError("onHumanInbound needs the time now, as a Date or an ISO time.");
  return d;
}

// The thread on the Replies page (like hot.js's lead links, the place_id is encoded: "drill:1" stays one part).
const threadLink = (placeId) => `/#/replies/${encodeURIComponent(placeId)}`;

// The first n characters, never cutting an emoji in half.
function clip(text, n) {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

// What a todo about their email shows under its title: their words, as text.
function theyWrote(message) {
  const body = typeof message.body === "string" ? message.body.trim() : "";
  const subject = `Subject: ${message.subject || "(no subject)"}`;
  return body ? `${subject}\n\nThey wrote:\n${clip(body, DETAIL_CHARS)}` : subject;
}

// Claude never answers this prospect: a paying client (won: Nik answers), or lost because they opted out or their
// address bounced (Nik reads it). The same rule, in SQL, is CLAUDE_ANSWERS below.
const nikReads = (prospect) => prospect.stage === "won" || (prospect.stage === "lost" && NO_CONTACT.includes(prospect.lost_reason));

// The read-it-yourself Todo for one of their emails Claude won't answer (a client's, or after an opt-out or bounce).
async function nikReadsTodo(DB, prospect, placeId, message, at) {
  const sender = message.from_addr || null;
  if (prospect.stage === "won") {
    const name = businessName(prospect.lead_name) || prospect.client_name || sender || "A client";
    return addTodo(DB, {
      kind: "escalation",
      title: `Your client ${name} emailed: read and reply yourself`,
      detail: theyWrote(message),
      link: threadLink(placeId),
      place_id: placeId,
      client_id: prospect.client_id ?? message.client_id ?? null,
      due_at: at,
      dedupe: `client-mail:${message.id}`,
    });
  }
  const name = businessName(prospect.lead_name) || sender || "A lead";
  return addTodo(DB, {
    kind: "escalation",
    title: `${name} wrote back after opting out: read and reply yourself`,
    detail: theyWrote(message),
    link: threadLink(placeId),
    place_id: placeId,
    due_at: at,
    dedupe: `optout-mail:${message.id}`,
  });
}

/**
 * Stage 7's hook for one stored human email (a messages row; `now` a Date). Safe to repeat for the same message
 * (stage 0 runs it again on a second try of a cut-off row): todos are deduped and every write is idempotent.
 * - no place_id (or no prospect behind it): needs_reply = 0 → "unmatched" (it stays in the inbox Nik reads);
 * - prospect won: needs_reply = 0, client_id = the client made from it, a `client-mail:<id>` todo → "client";
 * - prospect lost for opt_out or bounce: needs_reply = 0, an `optout-mail:<id>` todo → "opted_out";
 * - otherwise reopen (lost for a REOPEN_REASONS reason) or inbound_human, the follow-ups stopped and
 *   last_inbound_at set; the message keeps needs_reply = 1 for Claude → "replied".
 */
export async function onHumanInbound(DB, message, now) {
  const at = toDate(now);
  if (!message || typeof message.id !== "string" || !message.id) {
    throw new TypeError("onHumanInbound needs the stored message (its messages row, with its id).");
  }
  const placeId = message.place_id;
  const prospect = placeId ? await DB.prepare(PROSPECT_SQL).bind(placeId).first() : null;
  if (!prospect) {
    await DB.prepare(NO_REPLY_SQL).bind(message.id).run();
    return "unmatched";
  }

  if (nikReads(prospect)) {
    const client = prospect.stage === "won";
    await (client ? DB.prepare(CLIENT_SQL).bind(prospect.client_id ?? null, message.id) : DB.prepare(NO_REPLY_SQL).bind(message.id)).run();
    await nikReadsTodo(DB, prospect, placeId, message, at);
    return client ? "client" : "opted_out";
  }

  const reopen = prospect.stage === "lost" && REOPEN_REASONS.includes(prospect.lost_reason);
  await applyStageEvent(DB, placeId, reopen ? "reopen" : "inbound_human", at);
  await stopFollowups(DB, placeId, "replied", at);
  const received = Date.parse(message.received_at ?? "");
  if (!Number.isNaN(received)) {
    await DB.prepare(LAST_INBOUND_SQL).bind(iso(received), iso(at), placeId).run();
  }
  return "replied";
}

// ---------------------------------------------------------------- the tick step reply_fire and the Replies light

// "Waiting for Claude", defined once (`p` = the prospects row): inbound mail tied to a prospect Claude may answer,
// neither won nor lost for opt_out/bounce (nikReads in SQL). The light, reply_fire and the inbox all use it, so mail
// Claude is never shown can't keep the light red or wake the Routine every 10 minutes.
const CLAUDE_ANSWERS = (p) => `${p}.stage <> 'won' AND NOT (${p}.stage = 'lost' AND COALESCE(${p}.lost_reason, '') IN ('opt_out', 'bounce'))`;
const WAITING_WHERE = (m, p) => `${m}.direction = 'in' AND ${m}.needs_reply = 1 AND ${CLAUDE_ANSWERS(p)}`;
const FAILED_DAYS = 7; // a reply that didn't send shows on the light for this long, unless a later email goes
const DAY_MS = 86_400_000;

/**
 * Mail still waiting in this thread once Claude may no longer answer it (they opted out or bounced, or paid, after it
 * came in) is handed to Nik: every waiting inbound message there stops waiting (needs_reply = 0, handled_at = now; a
 * client's also gets client_id) and gets the Todo onHumanInbound files for such mail when it arrives
 * (`client-mail:<id>` for a won prospect, `optout-mail:<id>` for one lost for opt_out or bounce). A thread Claude may
 * still answer, or no prospect, changes nothing. Called by stage 0's inbound step after an opt_out or bounce, by
 * stage 9 after `paid`, by recordReply/escalateMessage when they refuse such a thread, and by buildInbox's sweep.
 * Safe to repeat. → how many messages it handed over.
 */
export async function handOffWaiting(DB, placeId, now) {
  const at = inboxNow(now, "handOffWaiting");
  if (typeof placeId !== "string" || !placeId) return 0;
  const prospect = await DB.prepare(PROSPECT_SQL).bind(placeId).first();
  if (!prospect || !nikReads(prospect)) return 0;
  const clientId = prospect.stage === "won" ? prospect.client_id ?? null : null;
  const { results } = await DB.prepare(`UPDATE messages SET needs_reply = 0, handled_at = ?1, client_id = COALESCE(?2, client_id)
    WHERE place_id = ?3 AND direction = 'in' AND needs_reply = 1
    RETURNING id, client_id, from_addr, subject, substr(body, 1, ${DETAIL_CHARS * 4}) AS body`).bind(iso(at), clientId, placeId).all();
  for (const message of results ?? []) await nikReadsTodo(DB, prospect, placeId, message, at);
  return (results ?? []).length;
}

// One statement (the light's only query, as stage 0 caps every registered light): the mail waiting for Claude
// (WAITING_WHERE), its oldest and newest, whether Claude's replies are paused, and the replies that didn't send. The
// oldest is when it arrived (the light's age). The newest is the later of its arrival and when it was stored: mail the
// relay saved just before a fire but the tick read only after it still counts as new, so it isn't left for 10 minutes.
// A reply that didn't send (status failed: the send is final, nothing retries it) counts for FAILED_DAYS unless a later
// email went in the thread since (Nik's "Reply as me" resend). The drill and the test lead never count, nor a thread
// that opted out or bounced since. ?1 = the oldest created_at counted.
const WAITING_SQL = `WITH failed AS (
    SELECT f.id, f.place_id, f.error, f.created_at FROM messages AS f
    LEFT JOIN prospects AS q ON q.place_id = f.place_id
    WHERE f.direction = 'out' AND f.kind = 'reply' AND f.status = 'failed' AND f.created_at >= ?1
      AND substr(COALESCE(f.place_id, ''), 1, 6) <> 'drill:' AND substr(COALESCE(f.place_id, ''), 1, 5) <> 'test:'
      AND NOT (COALESCE(q.stage, '') = 'lost' AND COALESCE(q.lost_reason, '') IN ('opt_out', 'bounce'))
      AND NOT EXISTS (SELECT 1 FROM messages AS g
        WHERE g.direction = 'out' AND g.status IN ('queued', 'sending', 'sent') AND g.created_at > f.created_at
          AND (g.place_id = f.place_id OR (f.place_id IS NULL AND g.place_id IS NULL AND g.to_addr = f.to_addr)))
  )
  SELECT COUNT(*) AS waiting,
    MIN(COALESCE(m.received_at, m.created_at)) AS oldest_at,
    MAX(MAX(COALESCE(m.received_at, m.created_at), m.created_at)) AS newest_at,
    (SELECT value FROM settings WHERE key = 'replies:paused') = '1' AS paused,
    (SELECT COUNT(*) FROM failed) AS failed,
    (SELECT place_id FROM failed ORDER BY created_at DESC, id DESC LIMIT 1) AS failed_place_id,
    (SELECT error FROM failed ORDER BY created_at DESC, id DESC LIMIT 1) AS failed_error
  FROM messages AS m JOIN prospects AS p ON p.place_id = m.place_id
  WHERE ${WAITING_WHERE("m", "p")}`;
// The last reply fire, failed attempts included (a broken Routine is tried at most every 2 minutes, not every tick).
const LAST_FIRE_SQL = "SELECT MAX(at) AS at FROM routine_fires WHERE routine = 'reply'";
// The most a run costs: waitingStats 1, the last fire 1, fireRoutine up to 5 (2 secrets, the 429 hold, the log row
// and a new hold after a 429). One more is kept for the tick's closing beat.
const REPLY_FIRE_MAX = 7;
const MINUTE_MS = 60_000;

const asDate = (value) => {
  const t = Date.parse(value ?? "");
  return Number.isNaN(t) ? null : new Date(t);
};

/**
 * {waiting, oldestAt, newestAt, paused, failed, failedPlaceId, failedError}: the mail waiting for Claude's reply and the
 * replies that didn't send in the last 7 days (as of `now`, default the time now). One D1 statement.
 */
export async function waitingStats(DB, now = new Date()) {
  const at = inboxNow(now, "waitingStats");
  const row = await DB.prepare(WAITING_SQL).bind(iso(new Date(at.getTime() - FAILED_DAYS * DAY_MS))).first();
  return {
    waiting: Number(row?.waiting) || 0,
    oldestAt: asDate(row?.oldest_at),
    newestAt: asDate(row?.newest_at),
    paused: Number(row?.paused) === 1,
    failed: Number(row?.failed) || 0,
    failedPlaceId: row?.failed_place_id ?? null,
    failedError: row?.failed_error ?? null,
  };
}

function nowOf(now) {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? NaN);
  if (Number.isNaN(d.getTime())) throw new TypeError("reply_fire needs the time now, as a Date or an ISO time.");
  return d;
}

/**
 * The tick step reply_fire (every tick, straight after inbound): wakes the reply Routine with
 * "reply waiting: <n> message(s)" when shouldFireReply says so. → "fired (2 waiting)", "skipped: <why>" or
 * "fire failed (2 waiting): <why>" (fireRoutine logged the attempt; its error never holds the URL or token, and the
 * routine:reply light shows it). Never retried here: the next tick decides again.
 */
export async function runReplyFire({ DB, now, fetchImpl, budget } = {}) {
  const at = nowOf(now);
  if (budget && typeof budget.left === "function" && budget.left() < REPLY_FIRE_MAX + 1) {
    return "skipped: not enough D1 queries left this tick";
  }
  const stats = await waitingStats(DB, at);
  if (stats.paused) return "skipped: paused";
  if (!inUkWindow(at, REPLY_HOURS)) return "skipped: outside reply hours";
  if (!stats.waiting) return "skipped: nothing waiting";

  const lastFireAt = asDate(await DB.prepare(LAST_FIRE_SQL).first("at"));
  if (!shouldFireReply({ ...stats, lastFireAt, now: at })) {
    if (!lastFireAt) return `skipped: not due (${stats.waiting} waiting)`; // never with today's rules
    const minutes = Math.floor((at.getTime() - lastFireAt.getTime()) / MINUTE_MS);
    return minutes < 2
      ? `skipped: fired under 2 minutes ago (${stats.waiting} waiting)`
      : `skipped: no new mail since the fire ${minutes} minutes ago (${stats.waiting} waiting)`;
  }

  const text = `reply waiting: ${stats.waiting} message(s)`;
  const result = await fireRoutine(DB, "reply", text, fetchImpl ? { fetchImpl, now: at } : { now: at });
  return result?.ok ? `fired (${stats.waiting} waiting)` : `fire failed (${stats.waiting} waiting): ${result?.error ?? "unknown error"}`;
}

registerLight(async (DB, env, now) => replyLight({ ...(await waitingStats(DB, now)), now }));

// ---------------------------------------------------------------- the reply Routine's inbox and Nik's voice seeds

/** Nik's two example replies (Part A "Voice", D-4), added once (setting voice:seeded) as his own words. */
export const VOICE_SEEDS = Object.freeze([
  Object.freeze({
    id: "seed:more-info",
    situation: "They ask for more info",
    body: "Sure. Click the link below to see the website I made for you and browse around.\n\n[their demo link]\nOur own site: aetoswebsites.com\n\nIf you have any further questions, feel free to ask here.",
  }),
  Object.freeze({
    id: "seed:call",
    situation: "They ask for a call",
    body: "Yes of course. Soonest I am available for a phone call is [time and day]. If that doesn't work let me know a day and time if you can. Thank you.",
  }),
]);

const INBOX_MAX = 10; // conversations per inbox
const STRANDED_MAX = 10; // threads handed to Nik per inbox read (the rest on the next read)
const VOICE_SENT_MAX = 10; // Nik's own emails Claude copies the tone of
const VOICE_MAX = 500; // examples and rules (the Voice page's own limit)
const THREAD_BODY_MAX = 20000; // characters read per message: stripQuoted keeps at most 4,000 of the start
const LANDING = "https://aetoswebsites.com";
const PRACTICE = ["drill:", "test:"]; // the reply drill and Nik's own test lead (Task 17)
const isPractice = (placeId) => PRACTICE.some((p) => String(placeId ?? "").startsWith(p));
const isDrill = (placeId) => String(placeId ?? "").startsWith("drill:");
const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");

const SEEDED_SQL = "SELECT value FROM settings WHERE key = 'voice:seeded'";
// Guarded by the setting inside the same batch, so two first runs at once add each seed once (and the fixed ids keep
// a repeat a no-op); once seeded, a seed Nik deletes on the Voice page never comes back.
const SEED_SQL = `INSERT OR IGNORE INTO style_examples (id, kind, situation, body, source, created_at)
  SELECT ?1, 'example', ?2, ?3, 'nik_written', ?4 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'voice:seeded')`;
const SEEDED_SET_SQL = "INSERT OR IGNORE INTO settings (key, value) VALUES ('voice:seeded', ?)";

function inboxNow(now, fn) {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? NaN);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${fn} needs the time now, as a Date or an ISO time.`);
  return d;
}

/** Add Nik's two example replies (VOICE_SEEDS, source nik_written) once; setting voice:seeded marks it done. */
export async function seedVoice(DB, now) {
  const at = iso(inboxNow(now, "seedVoice"));
  if ((await DB.prepare(SEEDED_SQL).first("value")) != null) return;
  await DB.batch([
    ...VOICE_SEEDS.map((s) => DB.prepare(SEED_SQL).bind(s.id, s.situation, s.body, at)),
    DB.prepare(SEEDED_SET_SQL).bind(at),
  ]);
}

const INBOX_SETTINGS_SQL = `SELECT key, value FROM settings
  WHERE key IN ('replies:paused', 'offer:chatbot_live', 'offer:review_booster_live')`;
const VOICE_SQL = `SELECT kind, situation, body FROM style_examples
  WHERE source = 'nik_written' AND kind IN ('example', 'rule') ORDER BY created_at, id LIMIT ${VOICE_MAX}`;
// Nik's own words: the first emails he sent (nik_sent rows, footer already off; one deleted on the Voice page is gone)
// and the replies he wrote himself (never one cancelled, e.g. a drill's "drill: not sent").
const VOICE_SENT_SQL = `SELECT body, reply FROM (
    SELECT body, created_at AS at, id, 0 AS reply FROM style_examples WHERE source = 'nik_sent'
    UNION ALL
    SELECT body, COALESCE(sent_at, created_at) AS at, id, 1 AS reply FROM messages
      WHERE direction = 'out' AND kind = 'reply' AND author = 'nik' AND status <> 'cancelled'
  ) ORDER BY at DESC, id DESC LIMIT ${VOICE_SENT_MAX}`;
// The waiting conversations, oldest waiting first: inbound mail tied to a prospect that is neither won (a client: Nik
// answers) nor lost for opt_out/bounce (CLAUDE_ANSWERS; handOffWaiting hands those to Nik). The lead's current demo is its
// newest demos row (latestDemo's rule) as a correlated subquery, never a join on place_id: a lead can have several.
// ?1 = the most conversations.
const CONVERSATIONS_SQL = `WITH w AS (
    SELECT place_id, MIN(COALESCE(received_at, created_at)) AS first_at FROM messages
    WHERE direction = 'in' AND needs_reply = 1 AND place_id IS NOT NULL GROUP BY place_id
  )
  SELECT p.place_id, p.stage, p.greet_name, l.place_id AS lead_id, l.name, l.trade, l.town, l.search_town, l.phone,
    r.grade, r.grade_reason, r.angle, r.owner, r.site_review,
    (SELECT d.slug FROM demos d WHERE d.place_id = p.place_id ORDER BY d.created_at DESC, d.slug DESC LIMIT 1) AS slug
  FROM w JOIN prospects p ON p.place_id = w.place_id
  LEFT JOIN leads l ON l.place_id = p.place_id
  LEFT JOIN research r ON r.place_id = p.place_id
  WHERE ${CLAUDE_ANSWERS("p")}
  ORDER BY w.first_at, p.place_id
  LIMIT ?1`;
// The threads whose mail still waits though Claude may not answer it any more (handOffWaiting's sweep, for mail from
// before a hand-off ran or from a path that changed the stage without one).
const STRANDED_SQL = `SELECT DISTINCT m.place_id FROM messages AS m JOIN prospects AS p ON p.place_id = m.place_id
  WHERE m.direction = 'in' AND m.needs_reply = 1 AND NOT (${CLAUDE_ANSWERS("p")})
  ORDER BY m.place_id LIMIT ${STRANDED_MAX}`;
// Every message of those threads, oldest first. ?1 = JSON list of place_ids.
const THREAD_SQL = `SELECT id, place_id, direction, kind, author, subject, substr(body, 1, ${THREAD_BODY_MAX}) AS body,
    status, class, needs_reply, COALESCE(sent_at, received_at, created_at) AS at, COALESCE(received_at, created_at) AS in_at
  FROM messages WHERE place_id IN (SELECT value FROM json_each(?1))
  ORDER BY place_id, at, created_at, id`;
// The calls that may take a day from today (UK) on, soonest first (so a prospect's current call is their soonest
// confirmed one when they have two). ?1 = the start of today, UK.
const CALLS_SQL = `SELECT id, place_id, slot_at, status, phone, created_at FROM calls
  WHERE status IN ('offered', 'confirmed') AND slot_at >= ?1 ORDER BY slot_at, id`;

// "Tue 20 Oct 09:14", UK time.
function ukStamp(date) {
  const { m, d, hh, mm, weekday } = ukParts(date);
  return `${DAYS3[weekday]} ${d} ${MONTHS3[m - 1]} ${pad2(hh)}:${pad2(mm)}`;
}

// Nik's reply as he wrote it: the "\n\n<name>\nAetos Websites" lines the server adds under every reply (replies.js's
// signature; just "Aetos Websites" without a sender name) taken off. Only for replies: a first email's row has no
// signature (its footer is already off), so a line of his own ending "Aetos Websites" is never cut.
const withoutSignature = (body) => String(body ?? "").replace(/\r\n?/g, "\n").replace(/\n\n(?:[^\n]*\n)?Aetos Websites\s*$/, "").trim();

// Shown to Claude, never sent: an outbound row that was cancelled (a follow-up stopped by their reply) or failed never
// reached them, except in a drill thread, where every reply is stored cancelled by design. Delivery reports aren't
// "them".
function shown(row) {
  if (row.direction === "in") return row.class !== "bounce";
  return !(row.status === "failed" || (row.status === "cancelled" && !isDrill(row.place_id)));
}

function threadEntry(row) {
  return {
    id: row.id,
    who: row.direction === "in" ? "them" : row.author,
    kind: row.kind,
    at: row.at,
    subject: row.subject ?? null,
    text: stripQuoted(row.body),
  };
}

function leadOf(row) {
  if (row.lead_id == null && isPractice(row.place_id)) {
    return { business: DRILL_LEAD.name, trade: DRILL_LEAD.trade, town: DRILL_LEAD.town, phone: DRILL_LEAD.phone, greet_name: row.greet_name ?? null };
  }
  return {
    business: businessName(row.name) || row.name || null,
    trade: row.trade ?? null,
    town: row.town || row.search_town || null,
    phone: row.phone ?? null,
    greet_name: row.greet_name ?? null,
  };
}

function researchOf(row) {
  const angle = parseJson(row.angle, []);
  const owner = parseJson(row.owner, null);
  const review = parseJson(row.site_review, null);
  return {
    grade: row.grade ?? null,
    grade_reason: row.grade_reason ?? null,
    angle: Array.isArray(angle) ? angle : [],
    owner: owner && typeof owner === "object" && !Array.isArray(owner) ? owner : null,
    site_summary: typeof review?.summary === "string" ? review.summary : null,
  };
}

// Their latest demo's links, kept even when it has ended (the reply we send makes syncDemoExpiry extend it). A practice
// lead without a demo points at aetoswebsites.com; a real lead without one gets none (Claude never makes one up).
function linksOf(row) {
  if (row.slug) return { demo: demoLink(row.slug), order: `${DEMO_BASE}/d/${row.slug}/order`, landing: LANDING };
  if (isPractice(row.place_id)) return { demo: LANDING, order: LANDING, landing: LANDING };
  return { demo: null, order: null, landing: LANDING };
}

// Their live call (a confirmed one still ahead first, else an offer still held), the next 3 free slots (another
// prospect's live call takes its day, a drill call takes nobody's, their own held offer stays free to them) and what
// Claude promises for another time (from sendAt, when the reply goes out).
function callsOf(placeId, calls, at, sendAt) {
  const mine = calls.filter((c) => c.place_id === placeId);
  const confirmed = mine.filter((c) => c.status === "confirmed" && Date.parse(c.slot_at) > at.getTime());
  const offered = mine.filter((c) => c.status === "offered" && !offerExpired(c, at));
  const newestFirst = (a, b) => (a.created_at === b.created_at ? 0 : b.created_at > a.created_at ? 1 : -1);
  const live = [...confirmed, ...offered.sort(newestFirst)][0] ?? null;
  const counted = calls.filter((c) => c.place_id === placeId || !isDrill(c.place_id));
  const free = nextFreeSlots(at, takenFrom(counted, at, placeId));
  return {
    current: live ? { id: live.id, status: live.status, slot_at: live.slot_at, label: slotLabel(live.slot_at), phone: live.phone ?? null } : null,
    free_slots: free.map((slot) => ({ slot_at: iso(slot), label: slotLabel(slot) })),
    // From when the reply goes out (as recordReply's call_time Todo), not when the inbox is read.
    call_time_promise: callTimeDue(sendAt).promise,
  };
}

/**
 * Everything the reply Routine is given (Part A "What Claude is given"): {paused, now_uk, inside_hours, send_at, offer
 * (offerFacts at send_at, with the chat assistant / reviews lines while offer:chatbot_live / offer:review_booster_live
 * are '1'), voice {examples, rules, sent}, conversations}. Conversations are oldest waiting first, at most `limit`
 * (10): {place_id, stage, reply_to, waiting, lead, research, links, thread, calls}. Thread text is their raw text with
 * the quoted history off (never rendered: whatever shows it escapes it). 2 D1 batches; the one write is the sweep: mail
 * still waiting in a thread Claude may no longer answer (CLAUDE_ANSWERS) is handed to Nik (handOffWaiting).
 */
export async function buildInbox(DB, now, { limit = INBOX_MAX } = {}) {
  const at = inboxNow(now, "buildInbox");
  const max = Math.min(INBOX_MAX, Math.max(1, Math.floor(Number(limit)) || INBOX_MAX));
  const sendAt = sendTime(at);
  const [settingRows, voiceRows, sentRows, convRows, strandedRows] = await DB.batch([
    DB.prepare(INBOX_SETTINGS_SQL),
    DB.prepare(VOICE_SQL),
    DB.prepare(VOICE_SENT_SQL),
    DB.prepare(CONVERSATIONS_SQL).bind(max),
    DB.prepare(STRANDED_SQL),
  ]);
  for (const { place_id } of strandedRows.results ?? []) await handOffWaiting(DB, place_id, at);
  const setting = Object.fromEntries((settingRows.results ?? []).map((r) => [r.key, r.value]));
  const conv = convRows.results ?? [];

  let threads = [];
  let calls = [];
  if (conv.length) {
    const [threadRows, callRows] = await DB.batch([
      DB.prepare(THREAD_SQL).bind(JSON.stringify(conv.map((c) => c.place_id))),
      DB.prepare(CALLS_SQL).bind(iso(ukDayStartUtc(at))),
    ]);
    threads = threadRows.results ?? [];
    calls = callRows.results ?? [];
  }

  const voice = voiceRows.results ?? [];
  const pick = (kind) => voice.filter((v) => v.kind === kind).map((v) => ({ situation: v.situation, body: v.body }));
  return {
    paused: setting["replies:paused"] === "1",
    now_uk: ukStamp(at),
    inside_hours: inUkWindow(at, REPLY_HOURS),
    send_at: iso(sendAt),
    offer: offerFacts(sendAt, {
      chatbot: setting["offer:chatbot_live"] === "1",
      reviews: setting["offer:review_booster_live"] === "1",
    }),
    voice: {
      examples: pick("example"),
      rules: pick("rule"),
      sent: (sentRows.results ?? []).map((r) => ({ body: Number(r.reply) === 1 ? withoutSignature(r.body) : String(r.body ?? "") })),
    },
    conversations: conv.map((row) => {
      const rows = threads.filter((m) => m.place_id === row.place_id);
      const waiting = rows
        .filter((m) => m.direction === "in" && Number(m.needs_reply) === 1)
        .sort((a, b) => (a.in_at < b.in_at ? -1 : a.in_at > b.in_at ? 1 : a.id < b.id ? -1 : 1))
        .map((m) => m.id);
      return {
        place_id: row.place_id,
        stage: row.stage,
        reply_to: waiting.at(-1) ?? null,
        waiting,
        lead: leadOf(row),
        research: researchOf(row),
        links: linksOf(row),
        thread: rows.filter(shown).map(threadEntry),
        calls: callsOf(row.place_id, calls, at, sendAt),
      };
    }),
  };
}

// ---------------------------------------------------------------- POST /api/agent/reply: Claude's reply, checked

const NO_MESSAGE = "No message with that id: use reply_to from the inbox exactly.";
const ANSWERED = "Already answered.";
const NIK_HANDLING = "Nik is handling this thread: escalate instead.";
const CLIENT_THREAD = "They're a paying client: Nik answers them himself. Move on.";
const NO_CONTACT_THREAD = "They opted out (or their address bounced): nothing is sent to them. Move on.";
const PAUSED = "Nik has paused Claude's replies: post nothing more and finish the run.";
const USE_ESCALATE = "Use /api/agent/escalate for angry, legal, unclear or other.";
const WRITE_SOMETHING = "Write a reply, or escalate.";
const REFUSED = "Reply refused";
const ASK_TIME = "Say what time they asked for in asked_time.";
const BAD_TIME = "That isn't a valid date and time.";
const NO_MAILBOX = "Couldn't send: this thread has no mailbox. Add one on Setup → Mailboxes, then try again.";
const BAD_CALL = 'call must be {"action": "offer" or "confirm", "slot_at": "<a slot_at from calls>", "phone": "<optional>"}.';
const NO_FREE = 'There are no free slots in the next 56 days: post it as proposes_time with asked_time "any time (no free slots)".';
const DRILL_NOT_SENT = "drill: not sent";
const offerChanged = (sendAt) =>
  `The offer changes before this goes out (it goes out ${ukStamp(sendAt)}): rewrite every price and free-days line from \`offer\` in this reply.`;
// The intents that may carry a call, and which actions; call_request and confirms_slot must.
const CALL_ACTIONS = { call_request: ["offer", "confirm"], proposes_time: ["confirm"], confirms_slot: ["confirm"] };
const CALL_NEEDED = {
  call_request: 'Send the slot you offer: "call": {"action": "offer", "slot_at": "<calls.free_slots[0].slot_at>"}.',
  confirms_slot: 'Send the slot they accepted: "call": {"action": "confirm", "slot_at": "<the slot>", "phone": "<their number, if known>"}.',
};
const callNotHere = (intent) => `A ${intent} reply can't send that call: offer a slot with call_request, book one with confirms_slot (or proposes_time when their time is a free slot).`;
const ASKED_MAX = 80; // characters of asked_time kept for the Todo title
const PHONE_MAX = 40;
const CHECKBACK_MS = 90 * 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// The same ISO shape calls-db.js accepts (a zone is required), so a slot passing here isn't refused there.
const SLOT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The message answered, its prospect, lead, the thread's mailbox and the lead's latest demo (latestDemo's rule, as a
// correlated subquery: never a join on place_id). ?1 = message id.
const REPLY_MESSAGE_SQL = `SELECT m.id, m.place_id, m.direction, m.needs_reply, m.from_addr, m.subject, m.message_id, m.refs,
    m.received_at,
    substr(m.body, 1, ${THREAD_BODY_MAX}) AS body,
    p.place_id AS prospect_id, p.stage, p.lost_reason, p.email, p.subject AS prospect_subject, p.mailbox_id, p.greet_name,
    l.name AS lead_name, b.id AS box_id, b.address AS box_address,
    (SELECT d.slug FROM demos d WHERE d.place_id = m.place_id ORDER BY d.created_at DESC, d.slug DESC LIMIT 1) AS slug
  FROM messages m
  LEFT JOIN prospects p ON p.place_id = m.place_id
  LEFT JOIN leads l ON l.place_id = m.place_id
  LEFT JOIN mailboxes b ON b.id = p.mailbox_id
  WHERE m.id = ?1`;
// Every message waiting in that thread, oldest first (the inbox's order). ?1 = message id.
const REPLY_WAITING_SQL = `SELECT id FROM messages
  WHERE place_id = (SELECT place_id FROM messages WHERE id = ?1) AND direction = 'in' AND needs_reply = 1
  ORDER BY COALESCE(received_at, created_at), id`;
const REPLY_SETTINGS_SQL = `SELECT key, value FROM settings
  WHERE key IN ('business:sender_name', 'offer:chatbot_live', 'offer:review_booster_live', 'replies:paused')`;
// The live calls on the slot's UK day. ?1/?2 = the day as [start, end).
const DAY_CALLS_SQL = "SELECT * FROM calls WHERE status IN ('offered', 'confirmed') AND slot_at >= ?1 AND slot_at < ?2";
// Every write of the reply batch lands only while the message still waits and Nik isn't handling the thread, so two
// Routine sessions answering the same message write one reply between them (the second gets 409).
const STILL_WAITING = `EXISTS (SELECT 1 FROM messages WHERE id = ? AND needs_reply = 1)
  AND NOT EXISTS (SELECT 1 FROM prospects WHERE place_id = ? AND stage = 'needs_nik')`;
// The note on a call cancelled because of their email.
const CALL_OFF_NOTE = {
  not_now: "Cancelled by their email: they said not now.",
  not_interested: "Cancelled by their email: they said no.",
  opt_out: "Cancelled by their email: they asked not to be emailed again.",
};
const FUTURE_CALL_SQL = "SELECT 1 AS booked FROM calls WHERE place_id = ? AND status = 'confirmed' AND slot_at > ? LIMIT 1";

const refuse = (status, error, reasons, extra = {}) => ({ status, body: reasons ? { error, reasons, ...extra } : { error } });
const refuse422 = (reason) => refuse(422, reason, [reason]);

// A client's or an opted-out (bounced) thread: Claude may not answer it, so its waiting mail is handed to Nik
// (handOffWaiting: the stage changed after the inbox was read) and the post gets 409. null for any other thread.
async function nikOnlyRefusal(DB, row, at) {
  if (!nikReads(row)) return null;
  await handOffWaiting(DB, row.place_id, at);
  return refuse(409, row.stage === "won" ? CLIENT_THREAD : NO_CONTACT_THREAD);
}

// "Mark (Diamond Kickboxing)", else the business, else the name, else "them".
function whoOf(name, business) {
  const first = String(name ?? "").trim();
  return first && business ? `${first} (${business})` : business || first || "them";
}

// The business a todo names: the lead's name (tidied), the drill fixture's for a practice lead with no lead row, else
// their address.
function businessOf(row) {
  const name = businessName(row.lead_name ?? "");
  if (name) return name;
  if (isPractice(row.place_id)) return DRILL_LEAD.name;
  return row.email || row.from_addr || "";
}

// What a Todo shows of their email: their words without the quoted history, as text (whatever shows it escapes it).
function theirWords(row, firstLine) {
  const text = clip(stripQuoted(row.body), DETAIL_CHARS);
  return text ? `${firstLine}\n\nThey wrote:\n${text}` : firstLine;
}

// The UK day `at` falls on, as [start, end) in stored UTC text.
function ukDayRange(at) {
  const day = ukDate(at);
  return [iso(ukToUtc(day, "00:00")), iso(ukToUtc(addUkDays(day, 1), "00:00"))];
}

// The call in the post, checked for shape: {call} (or null), or {error}.
function readCall(intent, call) {
  if (call === undefined || call === null) {
    return Object.hasOwn(CALL_NEEDED, intent) ? { error: CALL_NEEDED[intent] } : { call: null };
  }
  if (typeof call !== "object" || Array.isArray(call) || !["offer", "confirm"].includes(call.action)) return { error: BAD_CALL };
  const allowed = Object.hasOwn(CALL_ACTIONS, intent) ? CALL_ACTIONS[intent] : [];
  if (!allowed.includes(call.action)) return { error: callNotHere(intent) };
  const slotText = typeof call.slot_at === "string" ? call.slot_at.trim() : "";
  const slot = SLOT_ISO.test(slotText) ? new Date(slotText) : null;
  const phone = typeof call.phone === "string" ? call.phone.replace(/\s+/g, " ").trim().slice(0, PHONE_MAX) : "";
  return { call: { action: call.action, slot: slot && !Number.isNaN(slot.getTime()) ? slot : null, phone: phone || null } };
}

// The canHold refusal Claude is shown: the reason, then the soonest slot that is free for them.
async function slotRefusal(DB, reason, placeId, at) {
  const free = nextFreeSlots(at, takenFrom(await liveCalls(DB, at), at, placeId));
  return refuse422(free.length ? `${reason} Offer ${slotLabel(free[0])} instead.` : `${reason} ${NO_FREE}`);
}

// A guarded INSERT of the reply row (plain ? placeholders: the row's values, then STILL_WAITING's two).
function insertReply(DB, row, messageId, placeId) {
  const cols = Object.keys(row);
  return DB.prepare(`INSERT INTO messages (${cols.join(", ")}) SELECT ${cols.map(() => "?").join(", ")} WHERE ${STILL_WAITING}`)
    .bind(...cols.map((c) => row[c]), messageId, placeId);
}

// Undo a reply whose call couldn't be written after all (another prospect took the day in between): the reply row
// goes, if it hasn't started sending, and only then do the messages wait again. → true when undone.
async function undoReply(DB, { replyId, ids, stamp }) {
  const [removed] = await DB.batch([
    DB.prepare("DELETE FROM messages WHERE id = ? AND status IN ('queued', 'cancelled')").bind(replyId),
    DB.prepare(`UPDATE messages SET needs_reply = 1, handled_at = NULL, intent = NULL
      WHERE id IN (SELECT value FROM json_each(?)) AND needs_reply = 0 AND handled_at = ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ?)`).bind(JSON.stringify(ids), stamp, replyId),
  ]);
  return removed.meta.changes > 0;
}

/**
 * Claude's reply to one waiting message (POST /api/agent/reply). Checks, in this order: unknown message 404, already
 * handled 409, a newer message waiting 409, Nik handling the thread 409 (a client's or an opted-out thread 409 too,
 * after its waiting mail is handed to Nik, and every post while Nik has paused Claude's replies),
 * an intent that isn't one of INTENTS or is an escalation 422, a missing body 422, replyGuard 422 ({error: "Reply
 * refused", reasons}, plus send_at and offer when the weekend deal starts or ends before it goes out), the call (its
 * shape, the slot's weekday named in the body, canHold with the next free slot) 422, proposes_time without asked_time
 * or without callTimeDue(send_at)'s promise 422, no mailbox 422. Every 422 has `reasons`.
 * Then one DB.batch: the reply queued in the thread (a drill's stored cancelled, "drill: not sent"; none for opt_out),
 * the earlier waiting messages and this one marked handled (this one with the intent). Then the call (offered or
 * booked), their open calls cancelled when they say no, not now or opt out, the intent's stage event (skipped with a
 * booking), its Todo (call_time due callTimeDue(send_at), or checkback +90 days), the
 * opt-out's suppression, and call_booked again when they have a confirmed call ahead.
 * → {status, body}; 200's body is {ok, reply_id, status, due_at, call}.
 */
export async function recordReply(DB, { message_id, intent, body, call, asked_time, now } = {}) {
  const at = inboxNow(now ?? new Date(), "recordReply");
  const id = typeof message_id === "string" ? message_id.trim() : "";
  if (!id) return refuse(404, NO_MESSAGE);
  const [rows, settingRows, waitingRows] = await DB.batch([
    DB.prepare(REPLY_MESSAGE_SQL).bind(id),
    DB.prepare(REPLY_SETTINGS_SQL),
    DB.prepare(REPLY_WAITING_SQL).bind(id),
  ]);
  const row = rows.results?.[0];
  if (!row || row.direction !== "in" || !row.place_id || row.prospect_id == null) return refuse(404, NO_MESSAGE);
  if (Number(row.needs_reply) !== 1) return refuse(409, ANSWERED);
  const waiting = (waitingRows.results ?? []).map((w) => w.id);
  if (waiting.length && waiting.at(-1) !== id) return refuse(409, `A newer message is waiting from them: reply to ${waiting.at(-1)}.`);
  if (row.stage === "needs_nik") return refuse(409, NIK_HANDLING);
  const nikOnly = await nikOnlyRefusal(DB, row, at);
  if (nikOnly) return nikOnly;
  const setting = Object.fromEntries((settingRows.results ?? []).map((r) => [r.key, r.value]));
  // Nik pressed Pause while a run was going: nothing more is queued (a session that missed the inbox's paused).
  if (setting["replies:paused"] === "1") return refuse(409, PAUSED);

  if (!INTENTS.includes(intent) || ESCALATE_INTENTS.includes(intent)) return refuse422(USE_ESCALATE);
  const effects = intentEffects(intent);
  const text = typeof body === "string" ? body.replace(/\r\n?/g, "\n").trim() : "";
  if (effects.bodyRequired && !text) return refuse422(WRITE_SOMETHING);

  const placeId = row.place_id;
  const senderName = setting["business:sender_name"] ?? "";
  const sendAt = sendTime(at);
  if (effects.bodyRequired) {
    const switches = { chatbot: setting["offer:chatbot_live"] === "1", reviews: setting["offer:review_booster_live"] === "1" };
    const offer = offerFacts(sendAt, switches);
    const checked = replyGuard(text, { offer, hosts: REPLY_HOSTS, slug: row.slug ?? null, signName: senderName });
    if (!checked.ok) {
      // The weekend deal starts or ends before this goes out (posted Sunday 23:31, sent Monday 07:00): the inbox Claude
      // read had the other offer, so the refusal carries the one that applies and says to rewrite from it.
      if (offerFacts(at, switches).weekend !== offer.weekend) {
        return refuse(422, REFUSED, [...checked.reasons, offerChanged(sendAt)], { send_at: iso(sendAt), offer });
      }
      return refuse(422, REFUSED, checked.reasons);
    }
  }

  const read = readCall(intent, call);
  if (read.error) return refuse422(read.error);
  const wanted = read.call;
  if (wanted) {
    if (wanted.slot) {
      const day = WEEKDAYS[ukParts(wanted.slot).weekday];
      if (!new RegExp(`(?<![a-z])${day}(?![a-z])`, "i").test(text)) {
        return refuse422(`Your reply doesn't mention ${day}, the day you're offering.`);
      }
    }
    if (!wanted.slot) return slotRefusal(DB, BAD_TIME, placeId, at);
    const [d1, d2] = ukDayRange(wanted.slot);
    const { results: dayCalls } = await DB.prepare(DAY_CALLS_SQL).bind(d1, d2).all();
    const counted = dayCalls.filter((c) => (wanted.action === "offer" ? c.place_id === placeId : false) || (c.place_id !== placeId && !isDrill(c.place_id)));
    const check = canHold(wanted.slot, placeId, counted, at, { confirm: wanted.action === "confirm" });
    if (!check.ok) return slotRefusal(DB, check.reason, placeId, at);
  }
  const booking = wanted?.action === "confirm";
  let asked = "";
  // What Claude promises for another time and when Nik's Todo is due both come from when the reply goes out (the
  // inbox's call_time_promise too), so a reply read at 16:58 and posted at 17:02 can't promise today for tomorrow's Todo.
  const callTime = callTimeDue(sendAt);
  if (effects.todo === "call_time" && !booking) {
    asked = typeof asked_time === "string" ? asked_time.replace(/\s+/g, " ").trim().slice(0, ASKED_MAX) : "";
    if (!asked) return refuse422(ASK_TIME);
    if (!text.replace(/\s+/g, " ").toLowerCase().includes(callTime.promise)) {
      const when = sendAt.getTime() > at.getTime() ? "at 7am UK" : callTime.tomorrow ? "after 5pm UK" : "before 5pm UK";
      return refuse422(`Your reply must say you'll confirm "${callTime.promise}" (it goes out ${when}).`);
    }
  }

  let reply = null;
  if (intent !== "opt_out") {
    if (row.box_id == null && !isDrill(placeId)) return refuse422(NO_MAILBOX);
    const built = buildReply({
      inbound: { place_id: placeId, from_addr: row.from_addr || row.email, subject: row.subject, message_id: row.message_id, refs: row.refs },
      prospect: { mailbox_id: row.mailbox_id, subject: row.prospect_subject },
      mailbox: row.box_id == null ? null : { id: row.box_id, address: row.box_address },
      senderName,
      body: text,
      author: "claude",
      now: at,
    });
    reply = { id: crypto.randomUUID(), ...built, ...(isDrill(placeId) ? { status: "cancelled", error: DRILL_NOT_SENT } : {}) };
  }

  // The reply, then the earlier waiting messages, then this one: all or nothing, and only while it still waits.
  const stamp = iso(at);
  const earlier = waiting.slice(0, waiting.indexOf(id));
  const written = await DB.batch([
    ...(reply ? [insertReply(DB, reply, id, placeId)] : []),
    DB.prepare(`UPDATE messages SET needs_reply = 0, handled_at = ?
      WHERE id IN (SELECT value FROM json_each(?)) AND needs_reply = 1 AND ${STILL_WAITING}`)
      .bind(stamp, JSON.stringify(earlier), id, placeId),
    DB.prepare(`UPDATE messages SET needs_reply = 0, handled_at = ?, intent = ?
      WHERE id = ? AND needs_reply = 1 AND NOT EXISTS (SELECT 1 FROM prospects WHERE place_id = ? AND stage = 'needs_nik')`)
      .bind(stamp, intent, id, placeId),
  ]);
  if (!(written.at(-1).meta.changes > 0)) {
    const stage = await DB.prepare("SELECT stage FROM prospects WHERE place_id = ?").bind(placeId).first("stage");
    return refuse(409, stage === "needs_nik" ? NIK_HANDLING : ANSWERED);
  }

  let booked = null;
  let warning;
  if (wanted) {
    const done = wanted.action === "offer"
      ? await holdSlot(DB, { place_id: placeId, slot_at: wanted.slot, now: at })
      : await confirmCall(DB, { place_id: placeId, slot_at: wanted.slot, phone: wanted.phone, now: at });
    if (done.ok) booked = { id: done.call.id, status: done.call.status, slot_at: done.call.slot_at, phone: done.call.phone ?? null };
    else if (await undoReply(DB, { replyId: reply.id, ids: [...earlier, id], stamp })) return slotRefusal(DB, done.reason, placeId, at);
    else warning = `The reply had already started sending, so the call wasn't saved: ${done.reason}`;
  }

  if (intent === "opt_out") {
    if (!isDrill(placeId)) {
      for (const address of new Set([row.from_addr, row.email].filter(Boolean).map((a) => String(a).trim().toLowerCase()))) {
        try {
          await suppress(DB, address, "email", "opt_out", at);
        } catch (err) {
          if (!(err instanceof TypeError)) throw err; // not an address we could ever write to
        }
      }
    }
    await DB.prepare(`UPDATE messages SET status = 'cancelled', error = 'Stopped: opt_out'
      WHERE place_id = ? AND direction = 'out' AND status = 'queued' AND kind = 'reply'`).bind(placeId).run();
  }

  // A proposed time that is a free slot is simply booked: no needs_nik and no call_time Todo.
  const event = booking && effects.event === "escalate" ? null : effects.event;
  // They said no, not now or opted out: a call they had booked or been offered is off, so Nik never rings them.
  if (event === "said_no" || event === "opt_out") {
    await cancelOpenCalls(DB, placeId, CALL_OFF_NOTE[intent], at);
  }
  if (event) {
    await applyStageEvent(DB, placeId, event, at, event === "said_no" ? { lost_reason: effects.lost_reason } : {});
  }
  const business = businessOf(row);
  if (effects.todo === "call_time" && !booking) {
    const { due_at, tomorrow } = callTime;
    await addTodo(DB, {
      kind: "call_time",
      title: `Confirm a time with ${whoOf(row.greet_name, business)} by 6pm${tomorrow ? " tomorrow" : ""} (they asked for ${asked})`,
      detail: theirWords(row, `They asked for ${asked}.`),
      link: threadLink(placeId),
      place_id: placeId,
      due_at,
      dedupe: `call_time:${id}`,
    });
  }
  if (effects.todo === "checkback") {
    // The day they said it (overnight mail is answered the next morning).
    const said = new Date(row.received_at ?? NaN);
    const { m, d } = ukParts(Number.isNaN(said.getTime()) || said > at ? at : said);
    await addTodo(DB, {
      kind: "pick",
      title: `Check back with ${business || "them"} (they said not now on ${d} ${MONTHS3[m - 1]})`,
      detail: theirWords(row, "They said not now."),
      link: `/#/lead/${encodeURIComponent(placeId)}`,
      place_id: placeId,
      due_at: new Date(at.getTime() + CHECKBACK_MS),
      dedupe: `checkback:${placeId}`,
    });
  }
  // They wrote before a booked call (inbound_human moved them to replied): it's still booked.
  if (!event && !booking && (await DB.prepare(FUTURE_CALL_SQL).bind(placeId, stamp).first("booked"))) {
    await applyStageEvent(DB, placeId, "call_confirmed", at);
  }

  return {
    status: 200,
    body: {
      ok: true,
      reply_id: reply?.id ?? null,
      status: reply?.status ?? null,
      due_at: reply?.due_at ?? null,
      call: booked,
      ...(warning ? { warning } : {}),
    },
  };
}

// ---------------------------------------------------------------- escalations, and Nik's own replies

const DRAFT_MAX = 4000; // characters of Claude's draft, stored as given
const REASON_MAX = 500; // characters of Claude's one-line reason
const NIK_BODY_MAX = 20000; // characters of a reply Nik writes himself
const NOT_ESCALATION = "Escalate only angry, legal, unclear or other: answer the rest with /api/agent/reply.";
const NO_REASON = "Say in reason, in one line, why Nik should look at it.";
const NO_DRAFT = "Write the draft reply Nik can edit and send.";
const WRITE_FIRST = "Couldn't save: write something first.";
const NIK_NO_MESSAGE = "Couldn't send: that email isn't there any more. Refresh the page and try again.";
const NIK_NO_ADDRESS = "Couldn't send: there's no address to reply to on that email.";
const NO_TODO = "That Todo isn't there any more. Refresh the page.";
const NOT_DISMISSABLE = "Only an escalation or a call-time Todo can be dismissed here.";
const TODO_CLOSED = "That Todo is already closed.";
// The do-not-email reasons in Nik's words (anything else is shown as stored).
const SUPPRESSED_WHY = { opt_out: "they opted out", bounce: "their address bounced" };
// The Todos that wait on Nik for a lead: while any is open the stage stays needs_nik.
const NIK_KINDS = ["escalation", "call_time"];
const fmtCount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// The Todos about one inbound message: Claude's escalation and call_time ones, and the read-it-yourself ones (stage 7's
// client-mail / optout-mail, stage 0's escalation:client / escalation:unknown). Exact keys, never a prefix: closeTodos
// would also catch "escalation:m20" for "escalation:m2", and frees the dedupe, which a Todo Nik handled keeps.
const messageTodoKeys = (messageId) => [
  `escalation:${messageId}`, `call_time:${messageId}`, `client-mail:${messageId}`, `optout-mail:${messageId}`,
  `escalation:client:${messageId}`, `escalation:unknown:${messageId}`,
];
// The message a Todo's dedupe is about (the reverse of messageTodoKeys), or null.
function messageOfTodo(dedupe) {
  const m = /^(?:escalation:(?:client:|unknown:)?|call_time:|client-mail:|optout-mail:)(.+)$/.exec(String(dedupe ?? ""));
  return m ? m[1] : null;
}

// Claude's escalation Todo, added in the same batch that marks the message handled and only while it still waits, so
// two sessions (or a reply and an escalation) racing on one message leave one outcome. addTodo's columns and rules.
const ESCALATION_TODO_SQL = `INSERT OR IGNORE INTO todos
    (id, kind, place_id, client_id, title, detail, link, draft, due_at, status, dedupe, created_at)
  SELECT ?, 'escalation', ?, NULL, ?, ?, ?, ?, ?, 'open', ?, ?
  WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND needs_reply = 1)`;
// The message Nik answers, its prospect, and the mailbox to send from: the thread's (prospects.mailbox_id), else the
// one their email came in on. ?1 = message id.
const NIK_MESSAGE_SQL = `SELECT m.id, m.place_id, m.direction, m.needs_reply, m.from_addr, m.subject, m.message_id, m.refs,
    p.place_id AS prospect_id, p.email, p.subject AS prospect_subject,
    COALESCE(b.id, b2.id) AS box_id, CASE WHEN b.id IS NOT NULL THEN b.address ELSE b2.address END AS box_address
  FROM messages m
  LEFT JOIN prospects p ON p.place_id = m.place_id
  LEFT JOIN mailboxes b ON b.id = p.mailbox_id
  LEFT JOIN mailboxes b2 ON b2.id = m.mailbox_id
  WHERE m.id = ?1`;
const SENDER_SQL = "SELECT value FROM settings WHERE key = 'business:sender_name'";
// The same words from Nik to the same email in the last few minutes (a double press of Send, or a retry after an
// error once it was already queued): that reply is the answer, and nothing is queued twice. A cancelled or failed one
// doesn't count, so pressing Send again after Cancel sends it.
const NIK_DUPLICATE_SQL = `SELECT id, status, due_at FROM messages
  WHERE direction = 'out' AND kind = 'reply' AND author = 'nik' AND place_id IS ? AND to_addr = ? AND in_reply_to IS ?
    AND body = ? AND status IN ('queued', 'sending', 'sent') AND created_at >= ?
  ORDER BY created_at DESC LIMIT 1`;
const NIK_DUPLICATE_MS = 10 * 60_000;
const OPEN_NIK_TODOS_SQL = `SELECT COUNT(*) AS n FROM todos
  WHERE place_id = ? AND status = 'open' AND kind IN (${NIK_KINDS.map(() => "?").join(", ")})`;

// Close the open Todos about this message (status 'done' for a send, 'dismissed' for Dismiss), dedupes kept.
function closeMessageTodos(DB, messageId, status, stamp) {
  const keys = messageTodoKeys(messageId);
  return DB.prepare(`UPDATE todos SET status = ?, done_at = ?
    WHERE status = 'open' AND dedupe IN (${keys.map(() => "?").join(", ")})`).bind(status, stamp, ...keys);
}

// Nik has dealt with it: when the lead has no other open escalation or call_time Todo, needs_nik → replied
// (nik_handled), and back to call_booked when a confirmed call is still ahead.
async function nikHandled(DB, placeId, at) {
  if (!placeId) return;
  const open = Number(await DB.prepare(OPEN_NIK_TODOS_SQL).bind(placeId, ...NIK_KINDS).first("n")) || 0;
  if (open) return;
  const moved = await applyStageEvent(DB, placeId, "nik_handled", at);
  if (moved && (await DB.prepare(FUTURE_CALL_SQL).bind(placeId, iso(at)).first("booked"))) {
    await applyStageEvent(DB, placeId, "call_confirmed", at);
  }
}

/**
 * Claude hands a message to Nik (POST /api/agent/escalate): an `escalation` Todo (dedupe escalation:<message_id>, due
 * now, link the thread) titled by escalationTitle, with Claude's reason and their words as the detail and the draft
 * as given (≤ 4,000 characters); the thread's waiting messages up to this one handled (this one with the intent); the
 * stage → needs_nik (event escalate). Nothing is sent. Allowed in a needs_nik thread (new mail there is escalated too).
 * 404 unknown message; 409 already handled, a newer message waiting, a client's or an opted-out thread; 422 {error,
 * reasons} for a wrong intent, no reason, no draft or one too long. → {status, body}; 200's body is {ok, todo_id}.
 */
export async function escalateMessage(DB, { message_id, intent, reason, draft, now } = {}) {
  const at = inboxNow(now ?? new Date(), "escalateMessage");
  const id = typeof message_id === "string" ? message_id.trim() : "";
  if (!id) return refuse(404, NO_MESSAGE);
  const [rows, waitingRows] = await DB.batch([
    DB.prepare(REPLY_MESSAGE_SQL).bind(id),
    DB.prepare(REPLY_WAITING_SQL).bind(id),
  ]);
  const row = rows.results?.[0];
  if (!row || row.direction !== "in" || !row.place_id || row.prospect_id == null) return refuse(404, NO_MESSAGE);
  if (Number(row.needs_reply) !== 1) return refuse(409, ANSWERED);
  const waiting = (waitingRows.results ?? []).map((w) => w.id);
  if (waiting.length && waiting.at(-1) !== id) return refuse(409, `A newer message is waiting from them: escalate ${waiting.at(-1)}.`);
  const nikOnly = await nikOnlyRefusal(DB, row, at);
  if (nikOnly) return nikOnly;

  if (!ESCALATE_INTENTS.includes(intent)) return refuse422(NOT_ESCALATION);
  const why = clip(typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "", REASON_MAX);
  if (!why) return refuse422(NO_REASON);
  if (typeof draft !== "string" || !draft.trim()) return refuse422(NO_DRAFT);
  if (draft.length > DRAFT_MAX) {
    return refuse422(`The draft is too long: ${fmtCount(draft.length)} characters (${fmtCount(DRAFT_MAX)} max).`);
  }

  const placeId = row.place_id;
  const stamp = iso(at);
  const todoId = crypto.randomUUID();
  const earlier = waiting.slice(0, waiting.indexOf(id));
  const written = await DB.batch([
    DB.prepare(ESCALATION_TODO_SQL).bind(
      todoId, placeId, escalationTitle(intent, businessOf(row)), theirWords(row, why), threadLink(placeId), draft,
      stamp, `escalation:${id}`, stamp, id,
    ),
    DB.prepare(`UPDATE messages SET needs_reply = 0, handled_at = ?
      WHERE id IN (SELECT value FROM json_each(?)) AND needs_reply = 1
        AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND needs_reply = 1)`).bind(stamp, JSON.stringify(earlier), id),
    DB.prepare("UPDATE messages SET needs_reply = 0, handled_at = ?, intent = ? WHERE id = ? AND needs_reply = 1")
      .bind(stamp, intent, id),
  ]);
  if (!(written.at(-1).meta.changes > 0)) return refuse(409, ANSWERED);
  await applyStageEvent(DB, placeId, "escalate", at);
  return { status: 200, body: { ok: true, todo_id: written[0].meta.changes > 0 ? todoId : null } };
}

/**
 * Nik's own reply to any inbound message ("Send as me" on an escalation, "Reply as me" on a thread; also file 11's
 * POST /api/todo/:id/send). His words: no guard, and due now at any hour (buildReply, author nik). Same thread and
 * mailbox as Claude's replies (the thread's, else the one their email came in on); a drill thread's is stored
 * cancelled, never sent. The message and the earlier waiting ones are handled, its Todos closed (done), and the stage
 * goes back to replied (nik_handled) when no other escalation or call_time Todo is open for the lead. The same words
 * to the same email again within 10 minutes (a double press, a retry) return the reply already queued, never a second.
 * 422 empty body / no mailbox / no address / a do-not-email address, 404 not an inbound message. → {status, body};
 * 200's body is {ok, reply_id, status, due_at}.
 */
export async function sendAsNik(DB, { message_id, body, now } = {}) {
  const at = inboxNow(now ?? new Date(), "sendAsNik");
  const text = typeof body === "string" ? body.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) return refuse(422, WRITE_FIRST);
  if (text.length > NIK_BODY_MAX) {
    return refuse(422, `Couldn't save: that's too long (${fmtCount(text.length)} characters, ${fmtCount(NIK_BODY_MAX)} max).`);
  }
  const id = typeof message_id === "string" ? message_id.trim() : "";
  if (!id) return refuse(404, NIK_NO_MESSAGE);
  const [rows, senderRows, waitingRows] = await DB.batch([
    DB.prepare(NIK_MESSAGE_SQL).bind(id),
    DB.prepare(SENDER_SQL),
    DB.prepare(REPLY_WAITING_SQL).bind(id),
  ]);
  const row = rows.results?.[0];
  if (!row || row.direction !== "in") return refuse(404, NIK_NO_MESSAGE);
  const placeId = row.place_id ?? null;
  const drill = isDrill(placeId);
  const to = String(row.from_addr || row.email || "").trim();
  if (!to) return refuse(422, NIK_NO_ADDRESS);
  if (!drill) {
    if (row.box_id == null) return refuse(422, NO_MAILBOX);
    const why = await isSuppressed(DB, to);
    if (why) {
      return refuse(422, `Couldn't send: ${to} is on the do-not-email list (${SUPPRESSED_WHY[why] ?? why}). Nothing was sent.`);
    }
  }

  const built = buildReply({
    inbound: { place_id: placeId, from_addr: to, subject: row.subject, message_id: row.message_id, refs: row.refs },
    prospect: { mailbox_id: row.box_id, subject: row.prospect_subject },
    mailbox: row.box_id == null ? null : { id: row.box_id, address: row.box_address },
    senderName: senderRows.results?.[0]?.value ?? "",
    body: text,
    author: "nik",
    now: at,
  });
  const fresh = { id: crypto.randomUUID(), ...built, ...(drill ? { status: "cancelled", error: DRILL_NOT_SENT } : {}) };
  const twin = drill ? null : await DB.prepare(NIK_DUPLICATE_SQL)
    .bind(placeId, fresh.to_addr, fresh.in_reply_to, fresh.body, iso(new Date(at.getTime() - NIK_DUPLICATE_MS))).first();
  const reply = twin ?? fresh;
  if (!twin) await queueMessage(DB, fresh);

  // This message and the earlier ones still waiting are answered; a newer one keeps waiting (for Claude).
  const waiting = (waitingRows.results ?? []).map((w) => w.id);
  const idx = waiting.indexOf(id);
  const answered = idx >= 0 ? waiting.slice(0, idx + 1) : Number(row.needs_reply) === 1 ? [id] : [];
  const stamp = iso(at);
  await DB.batch([
    DB.prepare(`UPDATE messages SET needs_reply = 0, handled_at = ?
      WHERE id IN (SELECT value FROM json_each(?)) AND needs_reply = 1`).bind(stamp, JSON.stringify(answered)),
    closeMessageTodos(DB, id, "done", stamp),
  ]);
  await nikHandled(DB, placeId, at);
  return { status: 200, body: { ok: true, reply_id: reply.id, status: reply.status, due_at: reply.due_at } };
}

/**
 * Nik dealt with an escalation or call_time Todo elsewhere (Dismiss): it and the other Todos about the same message
 * are dismissed (dedupes kept, so they never come back), that message stops waiting if it still was, and the stage
 * goes back to replied (nik_handled) when no other escalation or call_time Todo is open for the lead. Nothing is sent.
 * 404 unknown Todo, 422 another kind, 409 already closed. → {status, body}; 200's body is {ok}.
 */
export async function dismissTodo(DB, { todo_id, now } = {}) {
  const at = inboxNow(now ?? new Date(), "dismissTodo");
  const id = typeof todo_id === "string" ? todo_id.trim() : "";
  if (!id) return refuse(404, NO_TODO);
  const todo = await DB.prepare("SELECT id, kind, place_id, dedupe, status FROM todos WHERE id = ?").bind(id).first();
  if (!todo) return refuse(404, NO_TODO);
  if (!NIK_KINDS.includes(todo.kind)) return refuse(422, NOT_DISMISSABLE);
  if (todo.status !== "open") return refuse(409, TODO_CLOSED);
  const stamp = iso(at);
  const messageId = messageOfTodo(todo.dedupe);
  const [dismissed] = await DB.batch([
    DB.prepare("UPDATE todos SET status = 'dismissed', done_at = ? WHERE id = ? AND status = 'open'").bind(stamp, id),
    ...(messageId
      ? [
        closeMessageTodos(DB, messageId, "dismissed", stamp),
        DB.prepare("UPDATE messages SET needs_reply = 0, handled_at = ? WHERE id = ? AND direction = 'in' AND needs_reply = 1")
          .bind(stamp, messageId),
      ]
      : []),
  ]);
  if (!(dismissed.meta.changes > 0)) return refuse(409, TODO_CLOSED);
  await nikHandled(DB, todo.place_id, at);
  return { status: 200, body: { ok: true } };
}
