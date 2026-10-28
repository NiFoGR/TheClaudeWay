// The inbound tick step (db). The relay Worker saves every email it receives in inbound_raw. This step reads the
// waiting rows, oldest first, and uses inbound.js to sort each one into bounce, auto, opt_out or human. It links the
// email to the thread, lead or client it belongs to, stores it in messages, and applies what it means: a bounce or
// an opt-out stops cold email to that address, a human reply moves the prospect on, and an email we can't place
// becomes a todo for Nik. Every row gets an outcome, errors included, so one bad email never blocks the queue.
// Inbound text is untrusted: it's stored as plain text, and whatever shows it escapes it.
import { countingDB } from "../d1count.js";
import { applyStageEvent, suppress } from "../prospects.js";
import { cancelOpenCalls } from "../calls-db.js";
import { handOffWaiting, onHumanInbound } from "../replies-db.js";
import { getSetting } from "../settings.js";
import { addTodo } from "../todo.js";
import { bounceInfo, classifyInbound, extractText, parseHeaders } from "./inbound.js";

/** A mailbox is paused when `count` of its emails bounce within `days` (counted from its last Resume, if later). */
export const BOUNCE_PAUSE = Object.freeze({ count: 2, days: 7 });

const STEP_MAX_QUERIES = 30; // the inbound step's share of the tick's 50
// CPU: characters of raw MIME a call reads (parses) at most, besides its first row. Parsing is the step's CPU cost
// (a 100 KB html-only email takes several ms, the free plan gives 10 ms a request), so a tick parses about one big
// email or many small ones. The first row read always starts, so the queue always moves.
const STEP_MAX_RAW = 100000;
const DETAIL_CHARS = 300; // body characters in an escalation todo
// The note on a call their opt-out cancels (the same as stage 7's recordReply writes for an opt_out reply).
const OPT_OUT_CALL_NOTE = "Cancelled by their email: they asked not to be emailed again.";
const ERROR_CHARS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
// An address suppress() takes (prospects.js's own rule). Anything else (a bounce naming "nobody", a From of just
// "Bob") has nothing to suppress, and mustn't stop the rest of the bounce or opt-out from being applied.
const ADDRESS = /^[^\r\n]+@[^\s@]+$/;

// Stored times are UTC ISO text without milliseconds, like util.now().
const isoText = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function timeOf(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  if (Number.isNaN(ms)) throw new TypeError("processInbound needs the time now, as a Date or an ISO time.");
  return ms;
}

// How a row is read, stored and marked.
//
// The rows waiting are selected without their headers and raw MIME (up to 256 KB each), only the raw's length, which
// D1 works out. A row's text is loaded by its claim (RETURNING), so the rows the query cap or the size budget
// (STEP_MAX_RAW) leaves for the next tick are never loaded, and ten big emails can't use up the tick's CPU before a
// single row has been claimed (no claim, no second try: every tick would die the same way). The size budget is
// decided before a row is claimed: a row claimed and then left would stay marked READING and use up its second try.
//
// The claim sets the row's outcome to READING (READING_AGAIN on a second try) while processed_at stays NULL. Only the
// run whose claim changed the row gets its text back, so two runs never read the same row at once. The email is then
// stored, applied, and only then marked with its real outcome and processed_at.
//
// A second try happens when the first was cut off. Either Cloudflare stopped the tick part-way (Error 1102: over the
// CPU limit) and the mark was left behind, or a D1 query failed while the email was being linked, stored or applied
// (D1 has brief outages, and a real reply or an opt-out must not be lost to one), and the mark was left on purpose.
// The next tick reads that email again, first. Every write is safe to repeat: the message is stored under its
// inbound_raw row's id, so a second try finds it stored and applies it again (suppression, stage events, the last
// reply time and the todos all ignore a repeat). A second try that is cut off too gets INTERRUPTED from the tick after;
// one that fails again gets its error. Either way the queue moves on. An email that can't be read at all (headers that
// aren't JSON, no From address) gets its error at once: reading it again would fail the same way.
const READING = "reading";
const READING_AGAIN = "reading again";
const RETRY = "retry"; // processInbound's count of rows left for a second try
const SELECT_SQL =
  "SELECT id, received_at, outcome, length(raw) AS size FROM inbound_raw WHERE processed_at IS NULL ORDER BY received_at LIMIT ?";
const CLAIM_SQL =
  "UPDATE inbound_raw SET outcome = ? WHERE id = ? AND processed_at IS NULL AND outcome IS ? RETURNING headers, raw";
const GIVE_UP_SQL = "UPDATE inbound_raw SET processed_at = ?, outcome = ? WHERE id = ? AND processed_at IS NULL AND outcome = ?";
const INTERRUPTED = "error: Reading this email was cut off part-way twice (most likely it's too big for Cloudflare's " +
  "time limit), so it was skipped. Look for it in your mailbox.";
// The real outcome (or an error), written last. The first run to finish a row marks it: a run that outlived its lease
// while a later run read the same row again never overwrites the outcome the other gave it.
//
// The raw MIME is cleared in the same write (no extra query): D1's free plan is 500 MB shared with the leads, and with
// every inbox email forwarded (D-1 option A) a few thousand big emails would fill it. Everything later stages read is
// in messages (the body up to 20,000 characters, from, to, subject, ids), and the original is still in the mailbox.
// An error row keeps its raw (raw stays NOT NULL, so '' when cleared): errors are rare, and the real email is what a
// regression test needs. The INTERRUPTED give-up keeps it for the same reason.
const MARK_SQL = `
  UPDATE inbound_raw SET processed_at = ?1, outcome = ?2, raw = CASE WHEN ?2 LIKE 'error:%' THEN raw ELSE '' END
  WHERE id = ?3 AND processed_at IS NULL`;
// A duplicate (another inbound_raw row's copy of this email is stored) stores nothing. Never written over a row whose
// own message is stored: that row is being finished by the run that stored it.
const DUPLICATE_SQL = `
  UPDATE inbound_raw SET processed_at = ?1, outcome = 'duplicate', raw = ''
  WHERE id = ?2 AND processed_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ?2)`;

// One query that finds everything a row needs:
// - stored: this row's message is already stored (an earlier try was cut off after storing it);
// - duplicate: an inbound message with this Message-ID (?4) came from another inbound_raw row;
// - thread: our outgoing message that the first of the ids in ?1 (a JSON list: the report's Message-ID for a
//   bounce, then In-Reply-To, then each References id) points at, with the address it went to;
// - prospect: the thread's prospect, else the one whose email is ?2 (From, or a bounce's Final-Recipient), any case;
// - client: the client_links row whose email is ?3 (From), any case, with its clients.place_id.
// ?5 is the row's id, which is also its message's id.
const LOOKUP_SQL = `
  WITH thread AS (
         SELECT m.place_id, m.mailbox_id, m.client_id, m.to_addr
         FROM json_each(?1) AS j JOIN messages AS m ON m.message_id = j.value AND m.direction = 'out'
         ORDER BY j.key LIMIT 1),
       prospect AS (
         SELECT place_id, stage, mailbox_id, email FROM (
           SELECT place_id, stage, mailbox_id, email, updated_at, 0 AS pick FROM prospects
           WHERE place_id = (SELECT place_id FROM thread)
           UNION ALL
           SELECT place_id, stage, mailbox_id, email, updated_at, 1 AS pick FROM prospects WHERE lower(email) = ?2)
         ORDER BY pick, updated_at DESC LIMIT 1),
       client AS (
         SELECT l.client_id, c.place_id FROM client_links AS l LEFT JOIN clients AS c ON c.id = l.client_id
         WHERE lower(l.email) = ?3 ORDER BY l.client_id LIMIT 1)
  SELECT EXISTS (SELECT 1 FROM messages WHERE id = ?5) AS stored,
         EXISTS (SELECT 1 FROM messages WHERE direction = 'in' AND message_id = ?4 AND id <> ?5) AS duplicate,
         t.place_id AS thread_place, t.mailbox_id AS thread_mailbox, t.client_id AS thread_client, t.to_addr AS thread_to,
         p.place_id AS prospect_place, p.stage AS prospect_stage, p.mailbox_id AS prospect_mailbox, p.email AS prospect_email,
         c.client_id AS link_client, c.place_id AS client_place
  FROM (SELECT 1) AS one
  LEFT JOIN thread AS t ON 1
  LEFT JOIN prospect AS p ON 1
  LEFT JOIN client AS c ON 1`;

// The message is stored under the row's id (?1), and only while no other row's copy of this email (same Message-ID,
// ?9) is stored and the row is still waiting. So the same email in two rows (forwarded and direct), or one row read by
// two overlapping runs, is stored once even when the email has no Message-ID: two stored copies of a reply would be
// two messages waiting for an answer. No change means another copy got there first.
const INSERT_SQL = `
  INSERT INTO messages (id, place_id, client_id, mailbox_id, direction, kind, author, to_addr, from_addr, subject, body,
                        message_id, in_reply_to, refs, status, received_at, class, needs_reply, created_at)
  SELECT ?1, ?2, ?3, ?4, 'in', 'inbound', 'them', ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'received', ?12, ?13, ?14, ?15
  WHERE NOT EXISTS (SELECT 1 FROM messages WHERE direction = 'in' AND message_id = ?9 AND id <> ?1)
    AND EXISTS (SELECT 1 FROM inbound_raw WHERE id = ?1 AND processed_at IS NULL)
  ON CONFLICT (id) DO NOTHING`;

// The first n characters, never cutting an emoji in half.
function clip(text, n) {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

const unique = (ids) => [...new Set(ids.filter(Boolean))];
const lowerAddress = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

function errorOutcome(err) {
  const text = String(err?.message ?? err ?? "").replace(/\s+/g, " ").trim();
  return `error: ${clip(text || "something went wrong reading this email", ERROR_CHARS)}`;
}

// Pause the mailbox once BOUNCE_PAUSE.count of its emails bounced within BOUNCE_PAUSE.days, counting only bounces
// received since its last Resume. One query to read the Resume, one to pause; a paused mailbox keeps its first reason.
async function pauseOnBounces(DB, mailboxId, recipient, now) {
  const nowMs = now.getTime();
  const resumed = Date.parse((await getSetting(DB, `mailbox:${mailboxId}:resumed_at`)) ?? "");
  const since = Math.max(nowMs - BOUNCE_PAUSE.days * DAY_MS, Number.isNaN(resumed) ? -Infinity : resumed);
  const reason = `${BOUNCE_PAUSE.count} emails bounced in ${BOUNCE_PAUSE.days} days (last: ${recipient ?? "an unknown address"}). ` +
    "Check your addresses are real, then press Resume.";
  await DB.prepare(
    `UPDATE mailboxes SET status = 'paused', paused_reason = ?
     WHERE id = ? AND status = 'active'
       AND (SELECT COUNT(*) FROM messages
            WHERE direction = 'in' AND class = 'bounce' AND mailbox_id = ? AND received_at >= ?) >= ?`,
  ).bind(reason, mailboxId, mailboxId, isoText(since), BOUNCE_PAUSE.count).run();
}

// Reading an email needs no database: its headers, the sender's own words, its class and (for a delivery report)
// what the report says. An email that can't be read throws here.
function readEmail(row) {
  const headers = parseHeaders(row.headers);
  const text = extractText(row.raw);
  const cls = classifyInbound({ headers, text, raw: row.raw });
  const from = headers.from.address;
  // All logic reads the header From, never the envelope (Namecheap rewrites it when forwarding).
  if (!from && cls !== "bounce") throw new Error("The email has no From address, so it can't be linked to anyone or answered.");
  // A delivery report (a bounce, or a delay notice classed auto) says which of our emails it's about.
  const report = cls === "bounce" || cls === "auto" ? bounceInfo(row.raw) : null;
  return { headers, text, cls, from, report };
}

// Link, store and apply one email that has been read, then mark its row. Returns the outcome (Part A's list).
async function storeAndApply(DB, row, { headers, text, cls: readAs, from, report }, now) {
  const at = isoText(now.getTime());
  let cls = readAs;
  const ids = unique([report?.messageId, headers.inReplyTo, ...headers.references]);
  const email = cls === "bounce" ? report.recipient : (report?.recipient ?? from);
  const link = await DB.prepare(LOOKUP_SQL)
    .bind(JSON.stringify(ids), email || null, from || null, headers.messageId, row.id)
    .first();
  if (!link.stored && link.duplicate) {
    await DB.prepare(DUPLICATE_SQL).bind(at, row.id).run();
    return "duplicate";
  }

  const prospect = link.prospect_place ? { place_id: link.prospect_place, stage: link.prospect_stage } : null;
  const clientId = link.thread_client ?? link.link_client ?? null;
  // A paying client is never opted out: a won prospect's or a client's "no thanks" goes to Nik as a human email.
  if (cls === "opt_out" && (prospect?.stage === "won" || (!prospect && clientId))) cls = "human";
  const outcome = cls !== "human" ? cls : prospect ? "human" : clientId ? "client" : "unknown_sender";

  const receivedMs = Date.parse(row.received_at);
  const msg = {
    id: row.id,
    place_id: prospect?.place_id ?? link.thread_place ?? link.client_place ?? null,
    client_id: clientId,
    mailbox_id: link.thread_mailbox ?? link.prospect_mailbox ?? null,
    direction: "in",
    kind: "inbound",
    author: "them",
    to_addr: headers.to || null,
    from_addr: from || null,
    subject: headers.subject || null,
    body: text,
    message_id: headers.messageId,
    in_reply_to: headers.inReplyTo,
    refs: headers.references.length ? headers.references.join(" ") : null,
    status: "received",
    received_at: Number.isNaN(receivedMs) ? at : isoText(receivedMs),
    class: cls,
    needs_reply: outcome === "human" ? 1 : 0,
    created_at: at,
  };
  if (!link.stored) {
    const stored = await DB.prepare(INSERT_SQL).bind(msg.id, msg.place_id, msg.client_id, msg.mailbox_id, msg.to_addr,
      msg.from_addr, msg.subject, msg.body, msg.message_id, msg.in_reply_to, msg.refs, msg.received_at, msg.class,
      msg.needs_reply, msg.created_at).run();
    if (!stored.meta.changes) {
      // Another copy got there first: another row's (this one is a duplicate), or this row's own, stored by an
      // overlapping run that applies and marks it. Nothing is applied twice.
      await DB.prepare(DUPLICATE_SQL).bind(at, row.id).run();
      return "duplicate";
    }
  }

  if (cls === "bounce") {
    // The address that bounced: the report's, else (a plain-text bounce that names none) the one our email went to.
    const bounced = report.recipient ?? link.thread_to ?? null;
    // Even for an email we can't find, the address that bounced is never written to again.
    if (bounced && ADDRESS.test(bounced)) await suppress(DB, bounced, "email", "bounce", at);
    if (prospect) {
      await applyStageEvent(DB, prospect.place_id, "bounce", at); // a won prospect stays won
      // Stage 7: their mail still waiting for Claude is Nik's now (Claude never writes to a bounced address).
      await handOffWaiting(DB, prospect.place_id, now);
    }
    // Only a bounce of mail we really sent counts towards a pause: backscatter for forged mail links to no mailbox.
    if (msg.mailbox_id) await pauseOnBounces(DB, msg.mailbox_id, bounced, now);
  } else if (cls === "opt_out") {
    if (ADDRESS.test(from)) await suppress(DB, from, "email", "opt_out", at); // even if unlinked
    if (prospect) {
      // They said no to the email we sent the prospect. If they wrote back from another address, the one we wrote to
      // is never written to again either (the privacy notice's do-not-contact promise).
      const wroteTo = lowerAddress(link.prospect_email);
      if (wroteTo && wroteTo !== from && ADDRESS.test(wroteTo)) await suppress(DB, wroteTo, "email", "opt_out", at);
      // Stage 8: a call they had booked or been offered is off, so Nik never rings someone who asked not to be
      // contacted (call_booked → replied, then opt_out → lost).
      await cancelOpenCalls(DB, prospect.place_id, OPT_OUT_CALL_NOTE, now);
      await applyStageEvent(DB, prospect.place_id, "opt_out", at);
      // Stage 7: their mail still waiting for Claude ("Who is this?", then "No thanks") is Nik's now.
      await handOffWaiting(DB, prospect.place_id, now);
    }
  } else if (cls === "human") {
    if (outcome === "human") {
      // Stage 6's stop rules read last_inbound_at; it never moves backwards.
      await DB.prepare(
        `UPDATE prospects SET last_inbound_at = ?, updated_at = ?
         WHERE place_id = ? AND (last_inbound_at IS NULL OR last_inbound_at < ?)`,
      ).bind(msg.received_at, at, prospect.place_id, msg.received_at).run();
      await applyStageEvent(DB, prospect.place_id, "inbound_human", at);
      // Stage 7's hook, only for mail linked to a prospect (outcome "human"; `now` is a Date, `msg` holds the
      // message's columns): a won prospect's or an opted-out one's email goes to Nik, a lead that said not now is
      // reopened, and the follow-ups stop. Client-only and unknown-sender mail is fully handled by the
      // escalation:client: and escalation:unknown: todos below: for it onHumanInbound would only return "unmatched",
      // or (a client writing from another address, whose place_id is a won prospect) file a second, client-mail todo
      // for the same email. A second try of a cut-off row runs the hook again for the same message, so like
      // everything above it is safe to repeat.
      await onHumanInbound(DB, msg, now);
    } else {
      const kind = outcome === "client" ? "client" : "unknown";
      const subject = `Subject: ${msg.subject ?? "(no subject)"}`;
      await addTodo(DB, {
        kind: "escalation",
        title: outcome === "client" ? `Email from your client: ${from}` : `Email from unknown sender: ${from}`,
        detail: text ? `${subject}\n\n${clip(text, DETAIL_CHARS)}` : subject,
        place_id: msg.place_id,
        client_id: msg.client_id,
        dedupe: `escalation:${kind}:${msg.id}`,
      });
    }
  }
  await DB.prepare(MARK_SQL).bind(at, outcome, row.id).run();
  return outcome;
}

// One claimed row: read, then store and apply. Returns its outcome, or RETRY when it's left for a second try.
async function handle(DB, row, now, lastTry) {
  const fail = async (err) => {
    const outcome = errorOutcome(err);
    await DB.prepare(MARK_SQL).bind(isoText(now.getTime()), outcome, row.id).run();
    return outcome;
  };
  let email;
  try {
    email = readEmail(row);
  } catch (err) {
    return fail(err); // it would fail the same way every time
  }
  try {
    return await storeAndApply(DB, row, email, now);
  } catch (err) {
    // A query failed part-way. Its READING mark stays, so the next tick reads it again first; a second failure is final.
    return lastTry ? fail(err) : RETRY;
  }
}

// The rows waiting, oldest first, up to `limit`; no row is started once `maxQueries` D1 queries have been made, and
// none is read once the next would take the raw MIME read past STEP_MAX_RAW (the first row read always goes).
async function processRows(DB, now, { limit = 10, maxQueries = STEP_MAX_QUERIES } = {}) {
  const nowDate = new Date(timeOf(now));
  const at = isoText(nowDate.getTime());
  const counted = countingDB(DB);
  const db = counted.DB;
  const counts = {};
  if (!(maxQueries > 0)) return { counts, waiting: 0 };
  const { results: rows } = await db.prepare(SELECT_SQL).bind(limit).all();
  let started = 0;
  let read = 0; // rows claimed and parsed
  let rawRead = 0; // their raw MIME, in characters
  for (const row of rows) {
    if (counted.used() >= maxQueries) break; // the rest wait for the next tick
    const size = row.outcome === READING_AGAIN ? 0 : Number(row.size) || 0; // a give-up reads nothing
    if (read > 0 && size > 0 && rawRead + size > STEP_MAX_RAW) break; // decided before the claim (see above)
    started++;
    let outcome;
    if (row.outcome === READING_AGAIN) {
      // Two runs were stopped part-way through this email: skip it for good, without reading it a third time.
      const gaveUp = await db.prepare(GIVE_UP_SQL).bind(at, INTERRUPTED, row.id, READING_AGAIN).run();
      if (!gaveUp.meta.changes) continue; // another run has dealt with it
      outcome = INTERRUPTED;
    } else {
      const lastTry = row.outcome === READING;
      const text = await db.prepare(CLAIM_SQL).bind(lastTry ? READING_AGAIN : READING, row.id, row.outcome ?? null).first();
      if (!text) continue; // an overlapping run has it
      read++;
      rawRead += size;
      outcome = await handle(db, { ...row, headers: text.headers, raw: text.raw }, nowDate, lastTry);
    }
    const key = outcome.startsWith("error:") ? "error" : outcome;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { counts, waiting: rows.length - started };
}

/**
 * Process up to `limit` waiting inbound_raw rows, oldest first, starting no row once `maxQueries` D1 queries have
 * been made (so it can go over by one row's worth), and reading no row that would take the raw MIME read past
 * 100,000 characters (the first row read always goes). Returns how many rows had each outcome, e.g. {human: 1, bounce: 2};
 * every error counts under "error", and a row left for a second try (a D1 query failed part-way) under "retry".
 */
export async function processInbound(DB, now, { limit = 10, maxQueries = STEP_MAX_QUERIES } = {}) {
  return (await processRows(DB, now, { limit, maxQueries })).counts;
}

/** The tick's first step: every tick, at most 30 of the tick's D1 queries (fewer when less is left). */
export const inboundStep = {
  name: "inbound",
  everyMinutes: 0,
  async run(ctx) {
    const { counts, waiting } = await processRows(ctx.DB, ctx.now, {
      maxQueries: Math.min(STEP_MAX_QUERIES, ctx.budget.left()),
    });
    const entries = Object.entries(counts);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const parts = entries.map(([outcome, n]) => `${n} ${outcome}`).join(", ");
    return `${total} processed${total ? `: ${parts}` : ""}${waiting ? `; ${waiting} wait for the next tick` : ""}`;
  },
};
