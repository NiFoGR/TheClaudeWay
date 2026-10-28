// Reply rules (pure; stage 7, docs/rebuild/07-replies-calls.md). Reply hours, when to wake the reply Routine, the
// Replies health light, quoted history, threading a reply in the thread's mailbox, escalation titles and the median
// reply time. The database side is replies-db.js; the checks on Claude's words are replyGuard.js.
// Times are Dates or stored UTC text; every hour/day rule is UK time through ukTime.js.
import { makeMessageId } from "./mail/compose.js";
import { businessName } from "./mail/rules.js";
import { inUkWindow, nextUkWindowStart, ukDate, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

const MINUTE_MS = 60000;

/** 07:00 to 23:30 UK, every day: 07:00 is inside, 23:30 is outside. */
export const REPLY_HOURS = Object.freeze({ start: "07:00", end: "23:30", days: Object.freeze([0, 1, 2, 3, 4, 5, 6]) });

export const INTENTS = Object.freeze([
  "interested", "question", "price", "more_info", "call_request", "proposes_time", "confirms_slot",
  "not_now", "not_interested", "opt_out", "angry", "legal", "unclear", "other",
]);

/** Intents Claude never answers: they go to Nik as an escalation with Claude's draft. */
export const ESCALATE_INTENTS = Object.freeze(["angry", "legal", "unclear", "other"]);

const FIRE_GAP_MIN = 2; // at most one reply fire every 2 minutes (bursts coalesce into one run)
const REFIRE_MIN = 10; // re-fire for old mail only when the last run is 10 minutes old (it didn't clear it)
const RED_AFTER_MIN = 20; // the Replies light is red when a reply has waited longer than this inside hours
const QUOTED_MAX = 4000; // characters of their text Claude is shown per message
const AUTHORS = ["claude", "nik"];
const FAILED_ERROR_MAX = 300; // characters of the send error the light shows
const FAILED_FIX = "Check the mailbox password on Setup → Mailboxes, then open the thread on the Replies page and send it " +
  "again with Reply as me. If the error says it may have gone, check the Sent folder first.";

// What the server does for each intent (Part A "Intents and what happens"). Call bookings (offer/confirm) are written
// by calls-db.js, which fires call_confirmed itself, so call_request and confirms_slot have no stage event here.
const NONE = { event: null, lost_reason: null, bodyRequired: true, todo: null };
const ESCALATE = { event: "escalate", lost_reason: null, bodyRequired: true, todo: null }; // the body is Claude's draft
const EFFECTS = {
  interested: NONE,
  question: NONE,
  price: NONE,
  more_info: NONE,
  call_request: NONE,
  proposes_time: { event: "escalate", lost_reason: null, bodyRequired: true, todo: "call_time" },
  confirms_slot: NONE,
  not_now: { event: "said_no", lost_reason: "not_now", bodyRequired: true, todo: "checkback" },
  not_interested: { event: "said_no", lost_reason: "not_interested", bodyRequired: true, todo: null },
  opt_out: { event: "opt_out", lost_reason: "opt_out", bodyRequired: false, todo: null },
  angry: ESCALATE,
  legal: ESCALATE,
  unclear: ESCALATE,
  other: ESCALATE,
};

const TITLES = {
  angry: (b) => `Angry reply from ${b}: Claude's draft is ready`,
  legal: (b) => `Legal question from ${b}: Claude's draft is ready`,
  unclear: (b) => `Unclear reply from ${b}: Claude's draft is ready`,
  other: (b) => `${b} needs you: Claude's draft is ready`,
};

// A Date or stored UTC text → ms, or null when there's no time.
function ms(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(t)) throw new Error(`Reply rules need a valid time, got ${JSON.stringify(String(value))}`);
  return t;
}

const asDate = (value) => (value instanceof Date ? value : new Date(ms(value)));

/**
 * {event, lost_reason, bodyRequired, todo} for one of INTENTS (a fresh copy), or null for anything else.
 * event goes through applyStageEvent; todo is "checkback" (kind pick, +90 days) or "call_time".
 */
export function intentEffects(intent) {
  const e = Object.hasOwn(EFFECTS, intent) ? EFFECTS[intent] : null;
  return e ? { ...e } : null;
}

/** When a reply Claude posts at `now` goes out: `now` inside reply hours, else the next 07:00 UK. */
export function sendTime(now) {
  return nextUkWindowStart(asDate(now), REPLY_HOURS);
}

/**
 * Whether the tick's reply_fire step wakes the reply Routine: inside reply hours, not paused, something waiting, the
 * last fire 2 minutes ago or more, and either mail newer than that fire or the fire 10 minutes old or more.
 */
export function shouldFireReply({ waiting, newestAt, lastFireAt, now, paused = false }) {
  const at = asDate(now);
  if (paused || !(Number(waiting) > 0) || !inUkWindow(at, REPLY_HOURS)) return false;
  const last = ms(lastFireAt);
  if (last === null) return true;
  const since = at.getTime() - last;
  if (since < FIRE_GAP_MIN * MINUTE_MS) return false;
  const newest = ms(newestAt);
  return (newest !== null && newest > last) || since >= REFIRE_MIN * MINUTE_MS;
}

/**
 * The Replies health light {name: "replies", level, detail, fix}. Grey while paused; red when a reply didn't send
 * (`failed` of them in the last 7 days, the newest's error `failedError`), at any hour; else grey outside reply hours;
 * red when the oldest waiting message has waited more than 20 minutes, counted from the later of its arrival (or the next
 * 07:00 UK, if it came outside hours) and this morning's 07:00 UK; green otherwise. This morning's 07:00 counts
 * because mail from 23:25 to 23:29 is often first seen after 23:30, when nothing is fired: it is answered by the first
 * run after 07:00, and the light only goes red if that run doesn't come.
 */
export function replyLight({ waiting, oldestAt, now, paused = false, failed = 0, failedError = null }) {
  const n = Math.max(0, Math.floor(Number(waiting) || 0));
  const at = asDate(now);
  const light = (level, detail, fix = "") => ({ name: "replies", level, detail, fix });
  if (paused) return light("grey", `Claude's replies are paused (${n} waiting).`, "Reply yourself on the Replies page.");
  // A reply the send step failed is final (nothing retries it) and the email it answered no longer waits, so it would
  // otherwise go unseen: red at any hour until a later email goes in that thread (waitingStats counts 7 days).
  const lost = Math.max(0, Math.floor(Number(failed) || 0));
  if (lost > 0) {
    const error = String(failedError ?? "").replace(/\s+/g, " ").trim().slice(0, FAILED_ERROR_MAX).replace(/[.\s]+$/, "");
    const what = lost === 1 ? "A reply didn't send" : `${lost} replies didn't send`;
    return light("red", error ? `${what}: ${error}.` : `${what}.`, FAILED_FIX);
  }
  if (!inUkWindow(at, REPLY_HOURS)) return light("grey", `Replies start again at 7am (${n} waiting).`);
  const oldest = ms(oldestAt);
  if (n > 0 && oldest !== null) {
    const opened = ukToUtc(ukDate(at), REPLY_HOURS.start).getTime(); // this morning's 07:00 UK (now is inside hours)
    const from = Math.max(nextUkWindowStart(new Date(oldest), REPLY_HOURS).getTime(), opened);
    const waited = at.getTime() - from;
    if (waited > RED_AFTER_MIN * MINUTE_MS) {
      return light(
        "red",
        // Rounded up, so a red light never says "20 minutes" (20½ minutes is past the limit).
        `A reply has waited ${Math.ceil(waited / MINUTE_MS)} minutes.`,
        "Check the aetos-reply Routine is switched on (routines/README.md) and its URL and token are saved on Setup → Claude.",
      );
    }
  }
  if (n === 0) return light("green", "No replies waiting.");
  return light("green", n === 1 ? "1 reply waiting." : `${n} replies waiting.`);
}

/**
 * Their words without the quoted history: cut at the first "On … wrote:" line (also when the mail app wrapped it onto
 * two lines), "-----Original Message" line, Outlook's "_____" rule, or "From:" line after a blank line, then drop
 * "> " lines. At most 4,000 characters (never half an emoji).
 */
export function stripQuoted(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const kept = [];
  let size = 0; // characters kept since the first line with text in it
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^On .+wrote:$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^_{10,}$/.test(line)) break;
    const next = (lines[i + 1] ?? "").trim();
    if (/^On .+/.test(line) && /wrote:$/.test(next) && !next.startsWith(">") && line.length + next.length < 300) break;
    if (/^From:/i.test(line) && i > 0 && lines[i - 1].trim() === "") break;
    if (line.startsWith(">")) continue;
    kept.push(lines[i].trimEnd());
    // Enough text already: the rest would be cut anyway (keeps a huge email cheap on the 10 ms CPU limit). `size` is
    // the length the trimmed result has so far, and this line has text, so the final trim can't shorten it.
    if (size) size += lines[i].trimEnd().length + 1;
    else size = line.length;
    if (line && size >= QUOTED_MAX) break;
  }
  let out = kept.join("\n").trim();
  if (out.length > QUOTED_MAX) {
    out = out.slice(0, QUOTED_MAX);
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  }
  return out;
}

/** "Re: " + their subject, never doubled ("RE: x" stays "RE: x"). */
export function reSubject(subject) {
  const s = String(subject ?? "").replace(/[\r\n]+/g, " ").trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** The lines under every reply: "<senderName>\nAetos Websites" (senderName = the business:sender_name setting). */
export function signature(senderName) {
  const name = String(senderName ?? "").trim();
  return name ? `${name}\nAetos Websites` : "Aetos Websites";
}

/**
 * The messages row (no id) for a reply to `inbound` from the thread's mailbox: to the address that wrote, "Re: "
 * their subject (the thread's when theirs is blank), In-Reply-To their Message-ID, References theirs + it, body +
 * signature, queued. Claude's go at sendTime(now); Nik's ("Send as me") go at once, any hour.
 */
export function buildReply({ inbound, prospect, mailbox, senderName, body, author, now }) {
  if (!AUTHORS.includes(author)) throw new Error(`buildReply: author must be claude or nik, got ${JSON.stringify(author)}`);
  const at = asDate(now);
  const theirId = String(inbound?.message_id ?? "").trim() || null;
  const refs = String(inbound?.refs ?? "").trim();
  const chain = theirId && !refs.split(/\s+/).includes(theirId) ? [refs, theirId].filter(Boolean).join(" ") : refs;
  const address = String(mailbox?.address ?? "").trim() || null;
  const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
  const subject = String(inbound?.subject ?? "").trim() ? inbound.subject : prospect?.subject;
  return {
    place_id: inbound?.place_id ?? null,
    mailbox_id: mailbox?.id ?? prospect?.mailbox_id ?? null,
    direction: "out",
    kind: "reply",
    author,
    to_addr: inbound?.from_addr ?? null,
    from_addr: address,
    subject: reSubject(subject),
    body: `${text}\n\n${signature(senderName)}`,
    // A thread whose mailbox is gone gets one from the send step, which then fails it in plain English.
    message_id: address ? makeMessageId(address) : null,
    in_reply_to: theirId,
    refs: chain || null,
    status: "queued",
    due_at: iso(author === "nik" ? at : sendTime(at)),
    created_at: iso(at),
  };
}

/** The escalation Todo's title for angry, legal, unclear or other. */
export function escalationTitle(intent, business) {
  const title = Object.hasOwn(TITLES, intent) ? TITLES[intent] : null;
  if (!title) throw new Error(`escalationTitle: intent must be angry, legal, unclear or other, got ${JSON.stringify(intent)}`);
  const name = businessName(business);
  return title(name || (intent === "other" ? "A lead" : "a lead"));
}

/**
 * The median minutes from each message's arrival (or that morning's 07:00 UK, if it came overnight) to its reply
 * going out; pairs not sent yet are skipped. null when there are none.
 */
export function medianReplyMinutes(pairs) {
  const mins = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const received = ms(p?.received_at);
    const sent = ms(p?.sent_at);
    if (received === null || sent === null) continue;
    const from = nextUkWindowStart(new Date(received), REPLY_HOURS).getTime();
    mins.push(Math.max(0, (sent - from) / MINUTE_MS));
  }
  if (!mins.length) return null;
  mins.sort((a, b) => a - b);
  const mid = Math.floor(mins.length / 2);
  return mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
}
