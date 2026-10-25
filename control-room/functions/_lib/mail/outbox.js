// Outbox (db): every outgoing email is a `messages` row, queued here and sent by the tick's `send` step.
//
// dispatchDue sends what's due, at most `limit` a call, and never the same row twice: a row is claimed with
// `UPDATE … SET status='sending' WHERE status='queued'` before it goes, and nothing is ever retried on its own (a send
// cut off half way may already have reached them). Cold email (first, followup) waits for the send window
// (Mon–Sat 07:00–19:00 UK), the mailbox's warm-up cap and an active mailbox; replies and system mail go any time.
// Suppression is checked for first, followup and reply, before any of those holds (a suppressed row is cancelled,
// never left waiting); system mail (paying clients) always goes. A first email also waits while its lead doesn't pass
// stage 3's ready rule (READY_SQL below), checked again in the claim: a lead a later search set aside after Send
// (06-email-followups.md Part A, "Set aside after Send") is never emailed, and Nik cancels the email from the thread.
// A follow-up tied to a lead waits unless the lead is still emailed or viewed (FOLLOWUP_OPEN_SQL), also checked again in
// the claim: a lead who has just replied is never sent the next follow-up, even on a tick (an inbound one, say) where
// the followups step, which cancels it (Part A §A5), hasn't run yet.
//
// D1 budget (Part A: 50 queries a tick, and the send step can be started with only 10 left): every check that can
// only hold a row back is pure or read once per call (suppression too: one batched read), so a held row costs no
// query. A call makes at most QUERIES_FIXED queries plus QUERIES_EACH for each row that leaves the queue, and sendStep
// picks `limit` to fit, keeping one query back for the tick's closing heartbeat.
import { OPT_OUT_LINE, composeEmail, makeMessageId } from "./compose.js";
import { mailboxCap, pickMailbox } from "./capacity.js";
import { INTERRUPTED_PREFIX, MAYBE_SENT, sendViaSmtp } from "./smtp.js";
import { inUkWindow, ukDate, ukDayStartUtc } from "../ukTime.js";
import { suppressionKeys, suppressionReasons } from "../prospects.js";
import { getSecret } from "../settings.js";

// Stage 6 imports the "may have gone" marker from here (its documented dependency); it's defined in smtp.js.
export { INTERRUPTED_PREFIX } from "./smtp.js";

/** When first emails and follow-ups may go: Monday to Saturday, 07:00 to 19:00 UK time (19:00 itself is outside). */
export const COLD_WINDOW = Object.freeze({ start: "07:00", end: "19:00", days: Object.freeze([1, 2, 3, 4, 5, 6]) });

const KINDS = ["first", "followup", "reply", "system"];
const COLD = new Set(["first", "followup"]); // count towards the cap, wait for the window, held by a paused mailbox
const SUPPRESSION_CHECKED = new Set(["first", "followup", "reply"]); // never system: a client's mail always goes
const QUEUE_STATUSES = ["queued", "sent", "failed", "cancelled"];
const DEFAULT_LIMIT = 2;
const SCAN_PER_LIMIT = 10; // rows looked at per mailbox (cold and other mail apart) for each send allowed
const STUCK_MS = 10 * 60 * 1000;
const MAX_ERROR = 1000;
// Per call: the stuck sweep, the due rows, the mailboxes (with which passwords are saved), sentToday and the
// suppression reasons of the due rows (one batched read).
const QUERIES_FIXED = 5;
// Per row that leaves the queue, at most: its mailbox's password, the claim, the prospect's mailbox, and the result.
// A row cancelled (suppressed) or failed before it's claimed costs 1.
const QUERIES_EACH = 4;
// Left for the tick runner: it always ends a tick by beating `tick`, after the last step (tick.js).
const QUERIES_AFTER = 1;

const COLUMNS = new Set([
  "id", "place_id", "client_id", "mailbox_id", "direction", "kind", "step", "author", "to_addr", "from_addr",
  "subject", "body", "message_id", "in_reply_to", "refs", "status", "due_at", "sent_at", "received_at", "error",
  "class", "needs_reply", "handled_at", "intent", "created_at",
]);
const REQUIRED = ["direction", "kind", "author", "to_addr", "body"];

// Part A's exact text for a row stuck in `sending`; like every "may have gone" error it starts with INTERRUPTED_PREFIX.
const INTERRUPTED = `${INTERRUPTED_PREFIX}. ${MAYBE_SENT}`;
const NO_FOOTER = 'Missing the "no thanks" line';
const MAILBOX_GONE =
  "The mailbox this email was meant to go from isn't on Setup → Mailboxes any more, so it wasn't sent. Send it again from another mailbox.";
const systemForCold = (address) =>
  `${address} is a System mailbox, and System mailboxes never send cold email, so this wasn't sent. Change its role back to Cold on Setup → Mailboxes, or send it from a Cold mailbox.`;

// Stored times are UTC ISO text without milliseconds, like util.now().
function isoText(value, what) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new TypeError(`${what} must be a time: a Date or UTC ISO text, got ${describe(value)}.`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function describe(value) {
  if (value === undefined) return "nothing";
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 80);
  } catch {
    return typeof value;
  }
}

const missing = (value) => value === undefined || value === null || (typeof value === "string" && !value.trim());

/**
 * Queue one outgoing email. `msg` holds messages columns: direction "out", kind (first, followup, reply or system),
 * author, to_addr and body are required. due_at defaults to now and status to 'queued'; the id is a new UUID unless
 * given. Dates are stored as UTC ISO text. Returns the id. Nothing is checked against suppression or caps here:
 * dispatchDue does that when it's due.
 */
export async function queueMessage(DB, msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new TypeError("queueMessage needs the message, as an object.");
  for (const field of REQUIRED) if (missing(msg[field])) throw new Error(`queueMessage: ${field} is required`);
  if (msg.direction !== "out") throw new Error('queueMessage: direction must be "out" (inbound mail is saved by the inbound step)');
  if (!KINDS.includes(msg.kind)) throw new Error(`queueMessage: kind must be first, followup, reply or system, got ${describe(msg.kind)}`);

  const row = {};
  for (const [key, value] of Object.entries(msg)) {
    if (!COLUMNS.has(key)) throw new Error(`queueMessage: ${key} isn't a column of messages`);
    if (value === undefined) continue;
    const stored = value instanceof Date ? isoText(value, `queueMessage: ${key}`) : value;
    const ok = stored === null || typeof stored === "string" || typeof stored === "boolean"
      || (typeof stored === "number" && Number.isFinite(stored));
    if (!ok) throw new TypeError(`queueMessage: ${key} must be text or a number, got ${describe(value)}`);
    row[key] = stored;
  }
  const at = isoText(new Date(), "now");
  row.id = missing(row.id) ? crypto.randomUUID() : String(row.id);
  row.to_addr = String(row.to_addr).trim();
  row.status ??= "queued";
  if (!QUEUE_STATUSES.includes(row.status)) {
    throw new Error(`queueMessage: status must be queued, sent, failed or cancelled, got ${describe(row.status)}`);
  }
  row.due_at = row.due_at == null ? at : isoText(row.due_at, "queueMessage: due_at");
  if (row.created_at == null) row.created_at = at;

  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO messages (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return row.id;
}

/**
 * Cold sends (first + followup) per mailbox today: those `sent` since UK midnight, plus any `sending` (they may be
 * going right now). {[mailbox_id]: number}; mailboxes with none aren't listed.
 */
export async function sentToday(DB, now) {
  const date = now instanceof Date ? now : new Date(isoText(now, "sentToday: now"));
  const since = isoText(ukDayStartUtc(date), "sentToday: UK midnight");
  const { results } = await DB.prepare(
    `SELECT mailbox_id, COUNT(*) AS n FROM messages
     WHERE direction = 'out' AND kind IN ('first', 'followup') AND mailbox_id IS NOT NULL
       AND (status = 'sending' OR (status = 'sent' AND sent_at >= ?))
     GROUP BY mailbox_id`,
  ).bind(since).all();
  return Object.fromEntries(results.map((r) => [r.mailbox_id, Number(r.n)]));
}

// Queued rows due by `at`, follow-ups first, then first emails, then the rest, oldest first. Each mailbox's cold
// rows, and its other rows, are looked at only up to `perGroup` at a time, so rows a paused (or full, or
// password-less) mailbox is holding can never crowd out other mailboxes' mail, or replies and client mail.
// thread_mailbox_id is the prospect's mailbox (the one that owns the thread); lead_ready is 0 for a first email whose
// lead doesn't pass stage 3's ready rule (it's held without costing a query or a send), else 1; thread_open is 0 for a
// follow-up whose lead is no longer emailed or viewed (held the same way), else 1.
// ?1 = at (also READY_SQL's now), ?2 = perGroup, ?3 = the kinds as a JSON list (only when given).
async function dueRows(DB, at, perGroup, kinds) {
  const onlyKinds = kinds ? "\n         AND m.kind IN (SELECT value FROM json_each(?3))" : "";
  const sql = `SELECT * FROM (
       SELECT m.*, p.mailbox_id AS thread_mailbox_id, p.place_id IS NOT NULL AS has_prospect,
         CASE WHEN m.kind = 'first' THEN ${leadReadySql("m.place_id", "?1")} ELSE 1 END AS lead_ready,
         CASE WHEN m.kind = 'followup' THEN ${followupOpenSql("m.place_id")} ELSE 1 END AS thread_open,
         ROW_NUMBER() OVER (
           PARTITION BY m.kind IN ('first', 'followup'), COALESCE(m.mailbox_id, p.mailbox_id)
           ORDER BY CASE m.kind WHEN 'followup' THEN 0 WHEN 'first' THEN 1 ELSE 2 END, m.due_at, m.id
         ) AS scan_rank
       FROM messages m LEFT JOIN prospects p ON p.place_id = m.place_id
       WHERE m.direction = 'out' AND m.status = 'queued' AND m.due_at <= ?1${onlyKinds}
     ) WHERE scan_rank <= ?2
     ORDER BY CASE kind WHEN 'followup' THEN 0 WHEN 'first' THEN 1 ELSE 2 END, due_at, id`;
  const binds = kinds ? [at, perGroup, JSON.stringify(kinds)] : [at, perGroup];
  return (await DB.prepare(sql).bind(...binds).all()).results;
}

// Every mailbox, by id, and the ids of those whose password is saved (a "secret:mailbox:<id>" setting that isn't
// empty, as getSecret reads it). One query: the password values themselves are read only for a mailbox about to send.
async function loadMailboxes(DB) {
  const { results } = await DB.prepare(
    `SELECT m.*, EXISTS (SELECT 1 FROM settings s WHERE s.key = 'secret:mailbox:' || m.id AND s.value <> '') AS has_password
     FROM mailboxes m ORDER BY m.id`,
  ).all();
  const mailboxes = [];
  const passwords = new Set();
  for (const { has_password, ...mailbox } of results) {
    mailboxes.push(mailbox);
    if (Number(has_password)) passwords.add(mailbox.id);
  }
  return { mailboxes, passwords };
}

// For reply and system mail that names no mailbox (and whose thread has none): any mailbox, ones with a saved password
// first (one without would hold the email while another could send it), then System ones first for system mail and
// Cold ones first for replies, active before paused (a paused mailbox still sends these), then by id.
function anyMailbox(mailboxes, kind, passwords) {
  const role = kind === "system" ? "system" : "cold";
  const rank = (m) => (passwords.has(m.id) ? 0 : 4) + (m.role === role ? 0 : 2) + (m.status === "active" ? 0 : 1);
  let best = null;
  for (const m of mailboxes) if (!best || rank(m) < rank(best)) best = m; // mailboxes come sorted by id
  return best;
}

// The mailbox a row goes from: {mailbox} | {mailbox: null} (wait) | {problem} (fail).
function mailboxFor(row, ctx) {
  const id = missing(row.mailbox_id) ? row.thread_mailbox_id : row.mailbox_id;
  if (!missing(id)) {
    const mailbox = ctx.byId.get(id);
    if (!mailbox) return { problem: MAILBOX_GONE };
    if (COLD.has(row.kind) && mailbox.role !== "cold") return { problem: systemForCold(mailbox.address) };
    return { mailbox };
  }
  if (COLD.has(row.kind)) {
    // Only mailboxes that can send: one without a saved password would hold the email while another has room.
    const usable = ctx.mailboxes.filter((m) => ctx.passwords.has(m.id));
    return { mailbox: pickMailbox(usable, ctx.sent, ctx.ukToday) };
  }
  return { mailbox: anyMailbox(ctx.mailboxes, row.kind, ctx.passwords) };
}

// The claim: only one request ever moves a row out of 'queued'. For cold mail it also re-counts the mailbox's cold
// sends today in the same statement (as sentToday does), so two dispatchers running at once (a tick whose lease ran
// out, say) can never take a mailbox past its cap between them. Same query count: it's the one UPDATE either way.
const CLAIM = "UPDATE messages SET status = 'sending', sent_at = ?, mailbox_id = ?, from_addr = ?, message_id = ? WHERE id = ? AND status = 'queued'";
// For first/followup/reply the claim also checks suppression again (no extra query): an opt-out stored since the
// batched read (while an earlier row was being sent, say) leaves the row queued, and the next call cancels it. A first
// email's claim also checks its lead against READY_SQL again (leadReadySql), so one set aside since the read stays
// queued and the next call holds it.
const NOT_SUPPRESSED = `
     AND NOT EXISTS (SELECT 1 FROM suppression s
                     WHERE (s.kind = 'email' AND s.value = ?) OR (s.kind = 'domain' AND s.value = ?))`;
const CAP_GUARD = `
     AND (SELECT COUNT(*) FROM messages
          WHERE direction = 'out' AND kind IN ('first', 'followup') AND mailbox_id = ?
            AND (status = 'sending' OR (status = 'sent' AND sent_at >= ?))) < ?`;

// Stage 3's ready rule, word for word as READY_SQL in shortlist-db.js (outbox.test.mjs checks it still is): it can't be
// imported, since shortlist-db.js imports this file and the string is built when the module loads. Aliases l (leads),
// r (research), p (prospects); ?1 is now. Cancelling or failing a row is never this rule's doing: a lead that stops
// passing it only holds its first email (stage 6, Part A "Set aside after Send").
const READY_SQL = `l.excluded = 0 AND r.status = 'done' AND r.too_big = 0
AND p.stage = 'ready' AND COALESCE(p.email, '') <> ''
AND EXISTS (SELECT 1 FROM demos d WHERE d.place_id = l.place_id AND d.expires_at > ?1)
AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.value IN
    (lower(p.email), lower(substr(p.email, instr(p.email, '@') + 1)), COALESCE(l.company_number, '')))`;

// Whether a first email may go as far as its lead is concerned (SQL, true or false): it's tied to no lead (only stage
// 0's own tests queue one like that: sendFirst always ties it), or its lead passes READY_SQL. `placeId` is the SQL for
// the row's place_id; `nowParam` the parameter holding now ("?1", "?11"). Exported so stage 6's capacity planning
// (followups.js, shortlist-db.js) and its held-first-email todo leave out, and name, exactly the rows this holds.
export const leadReadySql = (placeId, nowParam) => `(${placeId} IS NULL OR EXISTS (SELECT 1 FROM leads l
         JOIN research r ON r.place_id = l.place_id
         JOIN prospects p ON p.place_id = l.place_id
         WHERE l.place_id = ${placeId} AND ${READY_SQL.replace(/\?1(?!\d)/g, nowParam)}))`;

// Whether a follow-up may go as far as its lead is concerned (SQL, true or false): it's tied to no lead (only stage 0's
// own tests queue one like that: the followups step always ties it), or its lead is still emailed or viewed, the only
// stages whose follow-ups go on (Part A §A5: replied, needs_nik, call_booked, won and lost stop them; the followups
// step's sweep cancels what's left). A human reply moves the lead to replied at once (the inbound step), so this holds
// a follow-up queued before it, which the next followups run cancels. `placeId` is the SQL for the row's place_id.
const followupOpenSql = (placeId) => `(${placeId} IS NULL OR EXISTS (SELECT 1 FROM prospects fp
         WHERE fp.place_id = ${placeId} AND fp.stage IN ('emailed', 'viewed')))`;

const endsWithOptOut = (body) => String(body ?? "").replace(/\r\n?/g, "\n").trimEnd().endsWith(OPT_OUT_LINE);

// Error text as stored: never the password (belt and braces: sendViaSmtp already hides it), at most MAX_ERROR long.
function errorText(text, password) {
  let out = String(text ?? "").trim() || "The send failed and gave no reason.";
  if (typeof password === "string" && password.length >= 4) out = out.split(password).join("[hidden]");
  return out.length > MAX_ERROR ? `${out.slice(0, MAX_ERROR - 1)}…` : out;
}

function thrownText(err) {
  try {
    return typeof err?.message === "string" ? err.message : String(err);
  } catch {
    return "";
  }
}

// A queued row that won't be sent: failed or cancelled with the reason. false if another request already took it.
async function settle(DB, id, status, error) {
  const r = await DB.prepare("UPDATE messages SET status = ?, error = ? WHERE id = ? AND status = 'queued'")
    .bind(status, error, id)
    .run();
  return r.meta.changes > 0;
}

function checkOptions(limit, send, kinds) {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError(`dispatchDue: limit must be a whole number of sends (0 or more), got ${describe(limit)}.`);
  if (typeof send !== "function") throw new TypeError("dispatchDue: send must be a function, like sendViaSmtp.");
  if (kinds !== null && (!Array.isArray(kinds) || !kinds.every((k) => KINDS.includes(k)))) {
    throw new TypeError(`dispatchDue: kinds must be null (all) or a list of first, followup, reply and system, got ${describe(kinds)}.`);
  }
}

/**
 * Send the queued messages that are due (overview §8). At most `limit` rows leave the queue per call (sent, failed or
 * cancelled); rows held back (cold window, cap, paused mailbox, no password, no mailbox with room) don't count.
 * `kinds` limits it to those kinds (null = all). Returns {sent, failed, held}.
 *
 * First, rows stuck in `sending` for over 10 minutes are marked failed (never resent). Then, for each due row (Task
 * 13's order): footer (first/followup must end with the "no thanks" line) → suppression (first/followup/reply:
 * cancelled, so a suppressed row is never held) → a first email's lead (held while it doesn't pass stage 3's
 * READY_SQL, e.g. set aside by a later search; checked again in the claim) → a follow-up's lead (held unless it's still
 * emailed or viewed; checked again in the claim) → mailbox (the row's, else its thread's;
 * a cold row with neither gets pickMailbox's, which is also saved as prospects.mailbox_id when that's null) → paused,
 * window, cap (first/followup only) → password → compose → claim → send → record. The row's message_id, in_reply_to and refs are used; a
 * Message-ID is generated (and stored) only when it has none. An error that means the email may have gone starts with
 * INTERRUPTED_PREFIX; no other does.
 */
export async function dispatchDue(DB, env, now, { limit = DEFAULT_LIMIT, send = sendViaSmtp, kinds = null } = {}) {
  const at = isoText(now, "dispatchDue: now");
  const date = now instanceof Date ? now : new Date(at);
  checkOptions(limit, send, kinds);

  await DB.prepare(
    `UPDATE messages SET status = 'failed', error = ?, sent_at = NULL
     WHERE direction = 'out' AND status = 'sending' AND COALESCE(sent_at, created_at) < ?`,
  ).bind(INTERRUPTED, isoText(new Date(date.getTime() - STUCK_MS), "dispatchDue: now")).run();

  const tally = { sent: 0, failed: 0, held: 0 };
  if (limit === 0 || (kinds && !kinds.length)) return tally;
  const rows = await dueRows(DB, at, limit * SCAN_PER_LIMIT, kinds);
  if (!rows.length) return tally;

  // Every due row's suppression, in one read, before any hold check (none for system mail only).
  const checked = rows.filter((r) => SUPPRESSION_CHECKED.has(r.kind)).map((r) => r.to_addr);
  const suppressed = checked.length ? await suppressionReasons(DB, checked) : new Map();
  const { mailboxes, passwords } = await loadMailboxes(DB);
  const ctx = {
    mailboxes,
    passwords, // ids of the mailboxes whose password is saved
    byId: new Map(mailboxes.map((m) => [m.id, m])),
    sent: rows.some((r) => COLD.has(r.kind)) ? await sentToday(DB, date) : {},
    ukToday: ukDate(date),
    since: isoText(ukDayStartUtc(date), "dispatchDue: UK midnight"), // where today's cold sends are counted from
  };
  const passwordOf = new Map(); // mailbox id → password (read only for a mailbox about to send)
  const coldOpen = inUkWindow(date, COLD_WINDOW);
  let attempts = 0;

  for (const row of rows) {
    if (attempts >= limit) break;
    const cold = COLD.has(row.kind);

    if (cold && !endsWithOptOut(row.body)) {
      attempts++;
      if (await settle(DB, row.id, "failed", NO_FOOTER)) tally.failed++;
      continue;
    }

    // Suppressed means cancelled (Part A), even when a hold below would otherwise keep it waiting.
    const reason = SUPPRESSION_CHECKED.has(row.kind) ? suppressed.get(row.to_addr) : undefined;
    if (reason != null) {
      attempts++;
      await settle(DB, row.id, "cancelled", `Suppressed: ${reason}`);
      continue;
    }

    if (row.kind === "first" && !Number(row.lead_ready)) {
      tally.held++; // its lead was set aside (or stopped being ready) after Send: it waits, and Nik cancels it
      continue;
    }
    if (row.kind === "followup" && !Number(row.thread_open)) {
      tally.held++; // its lead replied (or booked, paid, closed) since it was queued: the followups step cancels it
      continue;
    }

    const { mailbox, problem } = mailboxFor(row, ctx);
    if (problem) {
      attempts++;
      if (await settle(DB, row.id, "failed", problem)) tally.failed++;
      continue;
    }
    if (!mailbox) {
      tally.held++; // no mailbox yet, or none with room today
      continue;
    }
    const cap = cold ? mailboxCap(mailbox, ctx.ukToday) : null;
    if (cold) {
      const room = cap - (Number(ctx.sent[mailbox.id]) || 0);
      if (mailbox.status !== "active" || !coldOpen || room <= 0) {
        tally.held++; // paused, outside Mon–Sat 07:00–19:00 UK, or today's cap reached
        continue;
      }
    }
    if (!ctx.passwords.has(mailbox.id)) {
      tally.held++; // goes once the password is saved on Setup
      continue;
    }

    // From here the row leaves the queue (or another request has just taken it).
    attempts++;
    if (!passwordOf.has(mailbox.id)) passwordOf.set(mailbox.id, await getSecret(DB, `mailbox:${mailbox.id}`));
    const password = passwordOf.get(mailbox.id);
    if (!password) {
      tally.held++; // removed since we looked
      continue;
    }

    const from = { name: mailbox.display_name, address: mailbox.address };
    let email;
    try {
      email = composeEmail({
        from, to: row.to_addr, subject: row.subject, body: row.body,
        messageId: missing(row.message_id) ? makeMessageId(mailbox.address) : row.message_id,
        inReplyTo: row.in_reply_to, references: row.refs, date,
      });
    } catch (err) {
      if (await settle(DB, row.id, "failed", errorText(thrownText(err), password))) tally.failed++;
      continue;
    }

    // The claim (see CLAIM). sent_at holds the claim time while it's 'sending' (the stuck sweep reads it) and the
    // send time once it's 'sent'.
    let claimSql = CLAIM;
    const binds = [at, mailbox.id, mailbox.address, email.headers["Message-ID"], row.id];
    if (SUPPRESSION_CHECKED.has(row.kind)) {
      const { address, domain } = suppressionKeys(row.to_addr);
      claimSql += NOT_SUPPRESSED;
      binds.push(address, domain);
    }
    if (cold) {
      claimSql += CAP_GUARD;
      binds.push(mailbox.id, ctx.since, cap);
    }
    if (row.kind === "first") {
      // Its lead still passes stage 3's ready rule, as of now (the lead_ready read can be a moment old). Every
      // parameter so far is a bare ?, numbered 1 to n in order, so now goes in as ?<n+1>, written out (READY_SQL
      // numbers its own).
      binds.push(at);
      claimSql += `\n     AND ${leadReadySql("messages.place_id", `?${binds.length}`)}`;
    }
    // A follow-up's lead is still emailed or viewed, as of now (a reply read since the due rows were, say).
    if (row.kind === "followup") claimSql += `\n     AND ${followupOpenSql("messages.place_id")}`;
    const claim = await DB.prepare(claimSql).bind(...binds).run();
    // Another request took it, it was cancelled since we read it, it was suppressed since the batched read (the next
    // call cancels it), or (cold) another request filled today's cap.
    if (!claim.meta.changes) continue;
    if (cold) ctx.sent[mailbox.id] = (Number(ctx.sent[mailbox.id]) || 0) + 1;
    if (cold && row.has_prospect && missing(row.thread_mailbox_id)) {
      // The thread now belongs to this mailbox (set before sending, so it's right even if the send is cut off).
      await DB.prepare("UPDATE prospects SET mailbox_id = ?, updated_at = ? WHERE place_id = ? AND mailbox_id IS NULL")
        .bind(mailbox.id, at, row.place_id)
        .run();
    }

    let result;
    try {
      result = await send(mailbox, password, { from, to: email.headers.To, subject: row.subject ?? "", text: email.text, headers: email.headers });
    } catch (err) {
      // It may have gone: the error starts with INTERRUPTED_PREFIX, which errorText's cap (it cuts the end) keeps.
      result = {
        ok: false,
        error: `${INTERRUPTED_PREFIX}: the send stopped with an error (${thrownText(err) || "no reason given"}). ${MAYBE_SENT}`,
      };
    }
    if (result?.ok === true) {
      await DB.prepare("UPDATE messages SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").bind(at, row.id).run();
      tally.sent++;
    } else {
      await DB.prepare("UPDATE messages SET status = 'failed', sent_at = NULL, error = ? WHERE id = ?")
        .bind(errorText(result?.error, password), row.id)
        .run();
      tally.failed++;
    }
  }
  return tally;
}

// The most sends that fit in the queries this tick has left, less the one the runner's closing heartbeat needs:
// 1 send when the step starts with the minimum 10 left, 2 from 14.
function sendLimit(budget) {
  const left = typeof budget?.left === "function" ? Number(budget.left()) : NaN;
  if (!Number.isFinite(left)) return DEFAULT_LIMIT;
  return Math.min(DEFAULT_LIMIT, Math.max(0, Math.floor((left - QUERIES_AFTER - QUERIES_FIXED) / QUERIES_EACH)));
}

/**
 * The tick's `send` step (every tick): dispatchDue, as many sends as the tick's D1 budget allows (up to 2), leaving a
 * query for the tick's heartbeat.
 */
export const sendStep = {
  name: "send",
  everyMinutes: 0,
  async run(ctx) {
    const { sent, failed, held } = await dispatchDue(ctx.DB, ctx.env, ctx.now, { limit: sendLimit(ctx.budget) });
    return `sent ${sent}, failed ${failed}, held ${held}`;
  },
};
