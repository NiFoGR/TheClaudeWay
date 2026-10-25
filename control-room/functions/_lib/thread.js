// The email thread in the lead drawer (stage 5–6, docs/rebuild/06-email-followups.md Part A §A8, Part B Task 11): the
// summary line (threadSummary, pure), every message of a lead oldest first (loadThread), Cancel on a queued outgoing
// email (cancelMessage) and Try again on a first email that didn't send (retryFirst). The routes are
// api/thread/[id].js, api/messages/[id]/cancel.js and api/messages/[id]/retry.js; the drawer side is
// public/js/compose.js.
//
// The summary is worked out from the prospect as the followups step's next sync will leave it (threadView): an email
// the send step has just sent is booked as syncSent will book it (a first email sent → follow-up 1 at schedule(); a
// follow-up sent → the next one at nextDue(), or the close time after step 9), and a follow-up already queued is the
// one shown. So for the up to 5 minutes between a send and the sync it never says "stopped" while nothing has. A
// follow-up whose latest send failed reads as retryFailed will leave it (booked again for 07:00 the next sending day,
// or stopped once it may have gone or has failed 3 times).
//
// Cancelling a first email leaves the lead `ready`: Nik writes it again. Cancelling follow-up k skips that step: the
// lead counts it as done (followup_step = k) and the next one is booked as normal (nextDue from now; after step 9 the
// close time, closeTime(now): 7 days on). The prospect write and the cancel go in one batch whose statements both need
// the row still queued, so an email the outbox has just claimed is never marked cancelled and never skipped; the
// prospect write also needs the lead behind that step, so a stray row never moves a sequence back.
//
// Try again queues a copy of the failed first email (same To, subject and text, a new Message-ID) after every check
// Send makes on the lead and the address, run again: composeContext's (the lead still `ready` and never emailed,
// nothing else waiting, the demo, a mailbox with room on the send day and all 9 follow-up days), the address still one
// of the lead's sourced ones, and sendChecks' (the do-not-email list, an address another lead is being emailed at);
// and the text must still link to the lead's demo as it is now (a replaced demo's link may be dead). The failed row
// stays as it is, so the thread keeps its error. The copy is written by one batch that claims it the way sendFirst
// does, so two presses (or two tabs) queue one copy, and puts the prospect's email, subject and greet_name back to
// this email's (follow-ups are written from them).
//
// D1: loadThread 3 statements; cancelMessage 2, 3 for a follow-up (a lost race reads the row once more); retryFirst 14
// (a lost race runs composeContext again: 23).
import { composeContext, sendChecks } from "./first-email.js";
import {
  COLD_WINDOW, FOLLOWUP_DAYS, STOP_STAGES, closeTime, followupsApproved, nextDue, schedule, stopReason,
} from "./followups.js";
import { makeMessageId } from "./mail/compose.js";
import { INTERRUPTED_PREFIX } from "./mail/outbox.js";
import { addUkDays, nextUkWindowStart, ukDate, ukParts, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

const LAST_STEP = FOLLOWUP_DAYS.length;
const MAX_ATTEMPTS = 3; // sends of one follow-up step before its sequence stops (followups.js retryFailed's)
const SEQUENCE_STAGES = Object.freeze(["emailed", "viewed"]); // only these get follow-ups
// first-email.js's codes about where the lead is: they come before the address checks, as Send orders them.
const STATE_CODES = new Set(["no_prospect", "already_emailed", "queued_already"]);
const MESSAGES_MAX = 200; // a thread's newest messages, shown oldest first
const DEMO_HOLD_TODO = "health:followup-demo:"; // + place_id: queueDue's todo while the demo isn't available
const FAIL_TODO = "health:followup-fail:"; // + place_id: retryFailed's todo once the follow-ups stopped failing

/** What Cancel and Try again refuse with, in plain English. */
export const THREAD_ERRORS = Object.freeze({
  gone: "That email isn't in the database any more. Refresh the page.",
  inbound: "That's an email they sent you, so there's nothing to cancel.",
  sent: "This email has already gone, so it can't be cancelled.",
  sending: "This email is being sent right now, so it can't be cancelled.",
  failed: "This email didn't send, so there's nothing to cancel.",
  notFirst: "Only a first email that didn't send can be tried again here.",
  retrySent: "This email has already gone, so there's nothing to try again.",
  retryQueued: "This email is already waiting to go out.",
  retrySending: "This email is being sent right now.",
  retryCancelled: "This email was cancelled, so it can't be tried again. Write a new one instead.",
  noLead: "This email isn't for a lead, so it can't be tried again here.",
  noAddress: "This email has no address to go to, so it can't be tried again. Write a new one instead.",
  notListed: (address) => `${address} isn't one of their addresses any more, so this email can't be tried again. Write a new one instead.`,
  oldDemo: "This email links to an older demo of theirs, which may not work any more, so it can't be tried again. Write a new one instead.",
  changed: "Something changed while it was being queued. Refresh the page and try again.",
});

// The summary lines (Part A §A8 word for word, and the same voice for the cases it doesn't name).
const LINES = Object.freeze({
  next: (step, when) => `Follow-up ${step} of ${LAST_STEP}: ${when}`,
  replied: "Follow-ups stopped: they replied",
  optOut: "Follow-ups stopped: they opted out",
  bounced: "Follow-ups stopped: the address bounced",
  callBooked: "Follow-ups stopped: they booked a call",
  paid: "Follow-ups stopped: they paid",
  notNow: "Follow-ups stopped: they said not now",
  notInterested: "Follow-ups stopped: they said they're not interested",
  noOnCall: "Follow-ups stopped: they said no on the call",
  lost: "Follow-ups stopped: marked lost",
  closing: (day) => `Follow-ups finished: marked lost on ${day} if no reply`,
  closed: (day) => (day ? `Follow-ups finished: marked lost on ${day} with no reply` : "Follow-ups finished: marked lost with no reply"),
  allGone: `Follow-ups finished: all ${LAST_STEP} have gone`,
  paused: "Follow-ups paused: approve your follow-up emails on the Voice page",
  demoHold: "Follow-ups on hold: their demo isn't available",
  failed: "Follow-ups stopped: a follow-up didn't send (the reason is below)",
  stopped: "Follow-ups stopped",
  starts: "Follow-ups start the day after your first email goes",
});

// stopReason's inbound reasons, and the line each one gives.
const STOPPED_BY = Object.freeze({ replied: LINES.replied, opt_out: LINES.optOut, bounce: LINES.bounced });
// A lost prospect's line, by lost_reason (sequence_done is the finished line).
const LOST_BY = Object.freeze({
  opt_out: LINES.optOut, bounce: LINES.bounced, not_now: LINES.notNow, not_interested: LINES.notInterested, call: LINES.noOnCall,
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const blank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());
const own = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);

// A stored time (UTC ISO text, or a Date) as a Date, or null when there's none or it can't be read.
function dateOf(value) {
  const date = value instanceof Date ? value : typeof value === "string" && value.trim() ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

// "Mon 26 Oct" and "Mon 26 Oct 09:15" in UK time, or null.
function ukDay(value) {
  const date = dateOf(value);
  if (!date) return null;
  const { d, m, weekday } = ukParts(date);
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}
function ukDayTime(value) {
  const date = dateOf(value);
  if (!date) return null;
  const { hh, mm } = ukParts(date);
  return `${ukDay(date)} ${pad(hh)}:${pad(mm)}`;
}

// followup_step as a whole number 0 to 9 (anything else counts as 0).
function stepsDone(value) {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= LAST_STEP ? n : 0;
}

function lostLine(prospect) {
  if (prospect.lost_reason === "sequence_done") return LINES.closed(ukDay(prospect.stage_at));
  return own(LOST_BY, prospect.lost_reason) ?? LINES.lost;
}

function stageLine(prospect) {
  switch (prospect.stage) {
    case "replied":
    case "needs_nik":
      return LINES.replied;
    case "call_booked":
      return LINES.callBooked;
    case "won":
      return LINES.paid;
    default:
      return lostLine(prospect);
  }
}

/**
 * The thread's summary line (pure), Part A §A8: "Follow-up 3 of 9: Mon 26 Oct 09:15", "Follow-ups stopped: they
 * replied", "Follow-ups stopped: they opted out", "Follow-ups finished: marked lost on Mon 28 Dec if no reply",
 * "Follow-ups paused: approve your follow-up emails on the Voice page", "Follow-ups on hold: their demo isn't
 * available", and lines in the same voice for the cases it doesn't name ("" with no prospect).
 * `prospect` = the prospects row ({stage, lost_reason, stage_at, first_sent_at, followup_step, next_followup_at}),
 * plus, as loadThread passes it, `inbound` (their messages, [{class, received_at}]: a reply, opt-out or bounce since
 * the first email stops it before the stage catches up, as stopReason says) and `queued` (true when next_followup_at
 * is a follow-up already queued: it goes whatever happens to the wording since). `approved` = all 9 follow-up
 * templates approved; `held` = "demo" (queueDue is holding the next one: the demo isn't available), "templates" (the
 * same as not approved), "failed" (stopped after sends failed) or null. Times in UK time.
 */
export function threadSummary(prospect, { approved = false, held = null } = {}) {
  if (!isObj(prospect)) return "";
  const { stage } = prospect;
  if (STOP_STAGES.includes(stage)) return stageLine(prospect);
  const waiting = approved === true && held !== "templates";
  if (!SEQUENCE_STAGES.includes(stage)) return waiting ? LINES.starts : LINES.paused; // ready: not gone yet

  if (dateOf(prospect.first_sent_at)) {
    const inbound = Array.isArray(prospect.inbound) ? prospect.inbound.filter(isObj) : [];
    const reason = stopReason({ stage, first_sent_at: prospect.first_sent_at }, inbound);
    const line = own(STOPPED_BY, reason);
    if (line) return line;
  }
  const done = stepsDone(prospect.followup_step);
  if (done >= LAST_STEP) {
    const day = ukDay(prospect.next_followup_at);
    return day ? LINES.closing(day) : LINES.allGone;
  }
  const when = ukDayTime(prospect.next_followup_at);
  if (when && prospect.queued === true) return LINES.next(done + 1, when);
  if (when) {
    if (!waiting) return LINES.paused;
    if (held === "demo") return LINES.demoHold;
    return LINES.next(done + 1, when);
  }
  return held === "failed" ? LINES.failed : LINES.stopped;
}

// ---- loadThread

// The prospect and the todos that say why its follow-ups wait or stopped (Task 8's, by their exact dedupes; closing one
// frees its dedupe). ?1 = place_id, ?2 = health:followup-demo:<place_id>: open while queueDue holds the next follow-up
// for the demo (a dismissed one is never closed again, so it says nothing). ?3 = health:followup-fail:<place_id>: held
// (open or dismissed) once retryFailed has stopped the follow-ups, until one is sent.
const PROSPECT_SQL = `SELECT p.stage, p.stage_at, p.lost_reason, p.first_sent_at, p.followup_step, p.next_followup_at,
    EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = ?2 AND t.status = 'open') AS demo_held,
    EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = ?3) AS failing
  FROM prospects p WHERE p.place_id = ?1`;
// The lead's newest MESSAGES_MAX messages, oldest first (rowid keeps the order of ones saved in the same second).
const MESSAGES_SQL = `SELECT id, direction, kind, step, author, subject, body, status, due_at, sent_at, received_at, error, class,
    created_at
  FROM (SELECT m.*, m.rowid AS seq FROM messages m WHERE m.place_id = ?1 ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT ${MESSAGES_MAX})
  ORDER BY created_at, seq`;

const stepOf = (m) => {
  const n = Number(m.step);
  return Number.isInteger(n) && n >= 1 && n <= LAST_STEP ? n : null;
};
const outgoing = (messages, kind, statuses) =>
  messages.filter((m) => m.direction === "out" && m.kind === kind && statuses.includes(m.status));
const highestStep = (rows) => rows.reduce((best, m) => (stepOf(m) && (!best || stepOf(m) > stepOf(best)) ? m : best), null);
// The newest send of follow-up `step` (retryFailed's order: due_at, then created_at), or null.
const newestOfStep = (messages, step) => outgoing(messages, "followup", ["queued", "sending", "sent", "failed", "cancelled"])
  .filter((m) => stepOf(m) === step)
  .sort((a, b) => String(b.due_at ?? "").localeCompare(String(a.due_at ?? "")) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0] ?? null;
// When retryFailed books a failed follow-up again: 07:00 UK on the next sending day after today's UK day.
const retryTime = (now) => nextUkWindowStart(ukToUtc(addUkDays(ukDate(now), 1), "00:00"), COLD_WINDOW);

// The prospect as the followups step's next sync will leave it (see the top of the file), with their inbound messages,
// and a time due already passed moved to when it can go: now inside the cold window, else the next window start. A
// follow-up whose latest send failed is shown as retryFailed's next run will leave it: booked again for 07:00 the next
// sending day, or stopped (failing) once it may have gone (INTERRUPTED_PREFIX) or failed MAX_ATTEMPTS times. Not once
// `stopped` (its health:followup-fail todo is there): retryFailed never books that lead again.
function threadView(prospect, messages, now, stopped = false) {
  const view = {
    ...prospect,
    inbound: messages.filter((m) => m.direction === "in").map((m) => ({ class: m.class, received_at: m.received_at })),
  };
  if (view.stage === "ready" && blank(view.first_sent_at)) {
    const sent = outgoing(messages, "first", ["sent"]).filter((m) => dateOf(m.sent_at))
      .sort((a, b) => dateOf(a.sent_at) - dateOf(b.sent_at))[0];
    if (sent) {
      Object.assign(view, {
        stage: "emailed", first_sent_at: sent.sent_at, followup_step: 0, next_followup_at: iso(schedule(sent.sent_at, 1)),
      });
    }
  }
  const done = stepsDone(view.followup_step);
  if (SEQUENCE_STAGES.includes(view.stage) && blank(view.next_followup_at) && dateOf(view.first_sent_at) && done < LAST_STEP) {
    const sent = highestStep(outgoing(messages, "followup", ["sent"]).filter((m) => stepOf(m) > done && dateOf(m.sent_at)));
    const waiting = highestStep(outgoing(messages, "followup", ["queued", "sending"]));
    if (sent) {
      const step = stepOf(sent);
      view.followup_step = step;
      view.next_followup_at = iso(step === LAST_STEP ? closeTime(sent.sent_at) : nextDue(view.first_sent_at, step + 1, sent.sent_at));
    } else if (waiting && dateOf(waiting.due_at)) {
      Object.assign(view, { followup_step: stepOf(waiting) - 1, next_followup_at: waiting.due_at, queued: true });
    } else if (!waiting && !stopped && newestOfStep(messages, done + 1)?.status === "failed") {
      const latest = newestOfStep(messages, done + 1);
      const failures = outgoing(messages, "followup", ["failed"]).filter((m) => stepOf(m) === done + 1).length;
      const interrupted = typeof latest.error === "string" && latest.error.startsWith(INTERRUPTED_PREFIX);
      if (interrupted || failures >= MAX_ATTEMPTS) view.failing = true;
      else view.next_followup_at = iso(retryTime(now));
    }
  }
  const next = dateOf(view.next_followup_at);
  if (next && next < now && stepsDone(view.followup_step) < LAST_STEP) {
    view.next_followup_at = iso(nextUkWindowStart(now, COLD_WINDOW));
  }
  return view;
}

const messageOut = (m) => ({
  id: m.id, direction: m.direction, kind: m.kind, step: m.step ?? null, author: m.author, subject: m.subject ?? null,
  body: m.body ?? "", status: m.status, due_at: m.due_at ?? null, sent_at: m.sent_at ?? null,
  received_at: m.received_at ?? null, error: m.error ?? null, class: m.class ?? null,
});

function toDate(now, fn) {
  const date = dateOf(now);
  if (!date) throw new TypeError(`${fn} needs the time now, as a Date or UTC ISO text.`);
  return date;
}

/**
 * Lead `placeId`'s thread, as of `now` (a Date or UTC ISO text): {summary, messages}. summary = threadSummary's line
 * for the prospect as the next sync will leave it ("" with no prospect); messages = its newest 200 messages, oldest
 * first, each {id, direction, kind, step, author, subject, body, status, due_at, sent_at, received_at, error, class}
 * as stored (bodies are untrusted text: the drawer escapes them). 3 D1 statements.
 */
export async function loadThread(DB, placeId, now) {
  const at = toDate(now, "loadThread");
  const id = typeof placeId === "string" ? placeId : "";
  if (!id) return { summary: "", messages: [] };
  const [[prospectRes, messageRes], approved] = await Promise.all([
    DB.batch([
      DB.prepare(PROSPECT_SQL).bind(id, DEMO_HOLD_TODO + id, FAIL_TODO + id),
      DB.prepare(MESSAGES_SQL).bind(id),
    ]),
    followupsApproved(DB),
  ]);
  const messages = messageRes.results.map(messageOut);
  const prospect = prospectRes.results[0] ?? null;
  if (!prospect) return { summary: "", messages };
  const { demo_held, failing, ...row } = prospect;
  let view;
  try {
    view = threadView(row, messageRes.results, at, Number(failing) > 0);
  } catch {
    view = row; // a stored time the schedule can't read: the summary goes by the row as it is, never a broken drawer
  }
  const held = Number(failing) || view.failing === true ? "failed" : Number(demo_held) ? "demo" : null;
  return { summary: threadSummary(view, { approved: approved.all === true, held }), messages };
}

// ---- cancelMessage

// The message, and its lead's prospect. ?1 = the message's id.
const MESSAGE_SQL = `SELECT m.id, m.place_id, m.direction, m.kind, m.step, m.status, m.to_addr, m.subject, m.body,
    p.stage, p.first_sent_at
  FROM messages m LEFT JOIN prospects p ON p.place_id = m.place_id
  WHERE m.id = ?1`;
// Only a queued outgoing row is cancelled (the outbox claims only a queued one, so it can't go after this).
const STILL_QUEUED = "id = ?1 AND direction = 'out' AND status = 'queued'";
const CANCEL_SQL = `UPDATE messages SET status = 'cancelled', error = ?2 WHERE ${STILL_QUEUED}`;
// A follow-up skipped: the step counts as done and the next one is booked (?3; only while the lead still gets
// follow-ups), in the same batch as CANCEL_SQL and on the same condition, so both apply or neither does. Only while
// the lead is behind that step: a stray queued row for a step already done never moves the sequence back (which
// would send the later steps again) or rebooks it.
const SKIP_SQL = `UPDATE prospects SET followup_step = ?2,
    next_followup_at = CASE WHEN stage IN ('emailed', 'viewed') THEN ?3 END, updated_at = ?4
  WHERE place_id = ?5 AND followup_step < ?2 AND EXISTS (SELECT 1 FROM messages WHERE ${STILL_QUEUED})`;
const CANCELLED_WHY = "Cancelled by you before it went.";

const refuse = (status, error) => ({ ok: false, status, error });

// Why a message that isn't queued can't be cancelled; null when it already is (nothing more to do).
function cancelRefusal(row) {
  if (!row) return refuse(404, THREAD_ERRORS.gone);
  if (row.direction !== "out") return refuse(409, THREAD_ERRORS.inbound);
  switch (row.status) {
    case "queued":
    case "cancelled":
      return null;
    case "sending":
      return refuse(409, THREAD_ERRORS.sending);
    case "failed":
      return refuse(409, THREAD_ERRORS.failed);
    default:
      return refuse(409, THREAD_ERRORS.sent);
  }
}

// When the next follow-up is due once follow-up `step` is skipped at `at`: nextDue for the one after it, or the close
// time after step 9. null when the thread has no first email time to go by (nothing is booked then).
function afterSkip(row, step, at) {
  if (!dateOf(row.first_sent_at)) return null;
  return iso(step === LAST_STEP ? closeTime(at) : nextDue(row.first_sent_at, step + 1, at));
}

/**
 * Cancel on a queued outgoing email (`id`), as of `now` (a Date or UTC ISO text). → {ok: true} | {ok: false, status:
 * 404|409, error}. Only a `queued` row with direction "out" is cancelled; one already cancelled answers {ok: true}
 * and changes nothing. A first email: the lead stays `ready` (Nik writes it again). Follow-up k: skipped, so
 * followup_step = k and next_followup_at = nextDue(first_sent_at, k+1, now), or the close time (closeTime(now), 7
 * days on) for k = 9; nothing is booked for a lead that no longer gets follow-ups. A reply or system email: just that
 * row. Sent: "This email has already gone, so it can't be cancelled." 2 D1 statements, 3 for a follow-up (one more
 * when the outbox claims it in between).
 */
export async function cancelMessage(DB, id, now) {
  const at = toDate(now, "cancelMessage");
  if (typeof id !== "string" || !id) return refuse(404, THREAD_ERRORS.gone);
  const row = await DB.prepare(MESSAGE_SQL).bind(id).first();
  const refusal = cancelRefusal(row);
  if (refusal || row.status === "cancelled") return refusal ?? { ok: true };

  const statements = [];
  const step = stepOf(row);
  if (row.kind === "followup" && step && !blank(row.place_id)) {
    statements.push(DB.prepare(SKIP_SQL).bind(id, step, afterSkip(row, step, at), iso(at), row.place_id));
  }
  statements.push(DB.prepare(CANCEL_SQL).bind(id, CANCELLED_WHY));
  const results = await DB.batch(statements);
  if (results.at(-1).meta.changes > 0) return { ok: true };
  // The outbox claimed it (or something else changed it) between the read and the write: say what it is now.
  const now2 = await DB.prepare(MESSAGE_SQL).bind(id).first();
  return cancelRefusal(now2) ?? { ok: true };
}

// ---- retryFirst

// Why this message can't be tried again (before any check Send makes), or null.
function retryRefusal(row) {
  if (!row) return refuse(404, THREAD_ERRORS.gone);
  if (row.direction !== "out" || row.kind !== "first") return refuse(400, THREAD_ERRORS.notFirst);
  switch (row.status) {
    case "failed":
      break;
    case "queued":
      return refuse(409, THREAD_ERRORS.retryQueued);
    case "sending":
      return refuse(409, THREAD_ERRORS.retrySending);
    case "cancelled":
      return refuse(409, THREAD_ERRORS.retryCancelled);
    default:
      return refuse(409, THREAD_ERRORS.retrySent);
  }
  if (blank(row.place_id)) return refuse(400, THREAD_ERRORS.noLead);
  if (blank(row.to_addr)) return refuse(400, THREAD_ERRORS.noAddress);
  return null;
}

// Every check Send makes, in Send's order (first-email.js): the lead's state, the address (still one of the lead's
// sourced addresses, then sendChecks), then the demo, the mailboxes and the sender name. 409 only for a first email
// already waiting to go (as Send), else 400.
function checksRefusal(ctx, toChecks, listed = []) {
  const blocking = Array.isArray(ctx?.blocking) ? ctx.blocking.filter(isObj) : [];
  const issues = [
    ...blocking.filter((i) => STATE_CODES.has(i.code)), ...listed, ...toChecks, ...blocking.filter((i) => !STATE_CODES.has(i.code)),
  ];
  if (!issues.length) return null;
  return refuse(issues[0].code === "queued_already" ? 409 : 400, issues[0].message);
}

// An address as first-email.js compares and stores it: trimmed and lower-cased.
const addressOf = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
// prospects.greet_name as Send set it for this email: its first line is the greeting renderFirstEmail wrote, "Hi Mark,"
// (→ "Mark") or "Hi," (→ null).
function greetNameOf(body) {
  const line = String(body ?? "").replace(/\r\n?/g, "\n").split("\n")[0].trim();
  const m = /^Hi (.+),$/.exec(line);
  return m && m[1].trim() ? m[1].trim() : null;
}
// Whether `body` links to `url` (the lead's demo now) as a whole link, not as the start of a longer one
// (…/d/green-leaf in …/d/green-leaf-2).
function linksTo(body, url) {
  if (typeof body !== "string" || typeof url !== "string" || !url) return false;
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9_-])`).test(body);
}

// The copy, claimed as sendFirst claims a first email: the lead `ready` and never emailed, no first email of its
// queued, sending or sent, and the failed row still failed; the same condition on both statements, so they both apply
// or neither does. ?1 place_id, ?2 the failed row's id, ?3 mailbox_id, ?4 now; RETRY_CLAIM_SQL: ?5 email, ?6 subject,
// ?7 greet_name; RETRY_QUEUE_SQL: ?5 the copy's id, ?6 from_addr, ?7 message_id, ?8 due_at.
const RETRYABLE = `EXISTS (SELECT 1 FROM prospects WHERE place_id = ?1 AND stage = 'ready'
      AND trim(COALESCE(first_sent_at, '')) = '')
    AND NOT EXISTS (SELECT 1 FROM messages WHERE place_id = ?1 AND kind = 'first' AND status IN ('queued', 'sending', 'sent'))
    AND EXISTS (SELECT 1 FROM messages WHERE id = ?2 AND kind = 'first' AND status = 'failed')`;
// The thread now belongs to the mailbox that will send it (follow-ups go from prospects.mailbox_id), and the prospect
// row matches the email being sent again, as Send's claim makes it (follow-ups go to prospects.email, "Re: " +
// prospects.subject, "Hi <greet_name>,"): a later Send to another address, cancelled since, may have changed them.
const RETRY_CLAIM_SQL = `UPDATE prospects SET email = ?5, subject = ?6, greet_name = ?7, mailbox_id = ?3, updated_at = ?4
  WHERE place_id = ?1 AND ${RETRYABLE}`;
const RETRY_QUEUE_SQL = `INSERT INTO messages (id, place_id, mailbox_id, direction, kind, step, author, to_addr, from_addr,
    subject, body, message_id, status, due_at, created_at)
  SELECT ?5, ?1, ?3, 'out', 'first', NULL, 'nik', old.to_addr, ?6, old.subject, old.body, ?7, 'queued', ?8, ?4
  FROM messages old WHERE old.id = ?2 AND ${RETRYABLE}`;

/**
 * Try again on a first email that didn't send (`id`, status `failed`), as of `now` (a Date or UTC ISO text). Every
 * check Send makes on the lead and the address runs again (composeContext's: the lead still `ready` and never emailed,
 * no first email waiting, the demo, a mailbox with room on the send day and all 9 follow-up days; the address still
 * one of the lead's sourced ones; sendChecks': the do-not-email list, an address another lead is being emailed at),
 * and the text must still link to the lead's demo as it is now (never a dead link). Then a copy is queued: the same
 * To, subject and text, from the mailbox composeContext picks (now the thread's, and the prospect's email, subject and
 * greet_name are this email's again), a new Message-ID at its domain, due now inside the cold window, else at the
 * next window start. The failed row stays failed. → {ok: true, id, due_at} | {ok: false, status: 400|404|409, error}.
 * `options.demoReady` is stage 4's, injected by tests. 14 D1 statements.
 */
export async function retryFirst(DB, id, now, { demoReady } = {}) {
  const at = toDate(now, "retryFirst");
  if (typeof id !== "string" || !id) return refuse(404, THREAD_ERRORS.gone);
  const row = await DB.prepare(MESSAGE_SQL).bind(id).first();
  const refusal = retryRefusal(row);
  if (refusal) return refusal;

  const options = demoReady ? { demoReady } : {};
  const ctx = await composeContext(DB, row.place_id, at, options);
  const to = addressOf(row.to_addr);
  const listed = ctx.stage !== null && !(Array.isArray(ctx.to_options) ? ctx.to_options : []).some((o) => o?.email === to)
    ? [{ code: "not_in_list", message: THREAD_ERRORS.notListed(to) }] : [];
  const toChecks = ctx.stage !== null ? await sendChecks(DB, ctx, to) : [];
  const blocked = checksRefusal(ctx, toChecks, listed);
  if (blocked) return blocked;
  if (!linksTo(row.body, ctx.demo?.url)) return refuse(400, THREAD_ERRORS.oldDemo);

  const { mailbox } = ctx; // set: without one, no_mailbox, warming_up or no_room is in ctx.blocking
  const copyId = crypto.randomUUID();
  const [, queued] = await DB.batch([
    DB.prepare(RETRY_CLAIM_SQL).bind(row.place_id, id, mailbox.id, iso(at), to, row.subject ?? null, greetNameOf(row.body)),
    DB.prepare(RETRY_QUEUE_SQL).bind(row.place_id, id, mailbox.id, iso(at), copyId, mailbox.address,
      makeMessageId(mailbox.address), ctx.due_at),
  ]);
  if (queued.meta.changes > 0) return { ok: true, id: copyId, due_at: ctx.due_at };

  // Another press (or Send, or the sync) got there between the checks and the batch: say why, from the lead as it is.
  const again = await composeContext(DB, row.place_id, at, options);
  return checksRefusal(again, []) ?? refuse(409, THREAD_ERRORS.changed);
}
