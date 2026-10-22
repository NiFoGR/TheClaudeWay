// Prospects and suppression (db). applyStageEvent is the only code that changes prospects.stage (overview §5): every
// stage calls it with an event, and stages.js's nextStage says where that event goes. The suppression list holds the
// addresses and domains cold email must never go to again (opt-outs, bounces, manual blocks).
import { nextStage } from "./stages.js";

const STOPPED = new Set(["won", "lost"]); // no more cold email: follow-ups end and queued first/follow-ups are cancelled
const SAID_NO_REASONS = ["not_now", "not_interested", "call"];
// The do-not-contact reasons. They outrank any other lost_reason, so a lost prospect who later opts out or bounces is
// never reopened by stage 7 (it only reopens not_now, not_interested, sequence_done and call).
const NO_CONTACT = ["opt_out", "bounce"];
// Overview §5: reopen moves lost → replied only when the prospect was lost for one of these. Stage 7's onHumanInbound
// checks it before firing reopen; it's checked here too, on the row as it is when written, so an opt-out or bounce
// that lands in between is never undone.
const REOPENABLE = ["not_now", "not_interested", "sequence_done", "call"];
const SUPPRESSION_KINDS = ["email", "domain", "company"];
const ATTEMPTS = 3; // reads of a row another request keeps changing, before giving up
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/; // an address we will write to
// An address to stop writing to: any local part (quoted ones can hold spaces), never a line break. Looser than
// EMAIL_RE on purpose, so an opt-out or bounce from an odd but real address is never lost.
const SUPPRESS_EMAIL_RE = /^[^\r\n]+@[^\s@]+$/;
const DOMAIN_RE = /^[^\s@]+\.[^\s@]+$/;

// Stored times are UTC ISO text without milliseconds, like util.now().
function isoText(now, fn) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  if (Number.isNaN(ms)) throw new TypeError(`${fn} needs the time now, as a Date or an ISO time.`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// A short, single-line picture of a bad value for an error message.
function describe(value) {
  if (value === undefined) return "nothing";
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 80);
  } catch {
    return typeof value;
  }
}

// Leaving `email` out, or passing null or a blank, means no email was given.
const emailGiven = (email) => !(email === undefined || email === null || (typeof email === "string" && !email.trim()));

// The address a new prospect row is written to: trimmed and lower-cased. Checked only when a row is really made, so
// an address that would be ignored (the row already exists) can never stop a stage change.
function newRowEmail(email) {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(address)) {
    throw new TypeError(`applyStageEvent: ${describe(email)} isn't an email address, so no prospect was made.`);
  }
  return address;
}

// First name only when confident, else NULL (the email then says "Hi,").
function greetName(name) {
  if (name === undefined || name === null) return null;
  if (typeof name !== "string") throw new TypeError(`applyStageEvent: greet_name must be text or null, got ${describe(name)}.`);
  return name.trim() || null;
}

// Cancels the lead's queued cold email, but only once the prospect really is won or lost, so a write that lost a race
// (see applyStageEvent) never stops email for a prospect that is still open.
const cancelColdMail = (DB, placeId, event) =>
  DB.prepare(
    `UPDATE messages SET status = 'cancelled', error = ?
     WHERE place_id = ? AND direction = 'out' AND status = 'queued' AND kind IN ('first', 'followup')
       AND EXISTS (SELECT 1 FROM prospects WHERE place_id = ? AND stage IN ('won', 'lost'))`,
  ).bind(`Stopped: ${event}`, placeId, placeId);

/**
 * Move a prospect on by `event` (overview §5). Returns {from, to}, or null when the stage doesn't change (then nothing
 * is written, with one exception below). With no prospect row, an `email` makes one when the event starts one
 * (demo_ready → ready, paid → won); without an `email` nothing happens, and on an existing row `email` and
 * `greet_name` are ignored. `lost_reason` becomes the event's name for opt_out, bounce and sequence_done, the
 * caller's `lost_reason` for said_no (not_now, not_interested or call), and NULL for any stage but lost. Becoming
 * won or lost ends the follow-ups (next_followup_at = NULL) and cancels the lead's queued first/follow-up emails.
 *
 * The exception: opt_out or bounce on a prospect that is already lost for another reason (e.g. not_now) keeps it
 * lost, returns null, and records the opt-out or bounce as its lost_reason (Part A: opt_out → lost with lost_reason
 * opt_out), so they are never reopened and written to again.
 *
 * reopen (lost → replied) only applies when lost_reason is not_now, not_interested, sequence_done or call (overview
 * §5); otherwise it's a no-op (null).
 *
 * The write only lands if the row still has the stage and lost_reason it read, so two requests can't overwrite each
 * other's change: the loser reads the row again and applies its event to that. Costs 1 D1 query for a no-op, 2 for a
 * move, 3 for a stop.
 */
export async function applyStageEvent(DB, placeId, event, now, { lost_reason, email, greet_name } = {}) {
  if (typeof placeId !== "string" || !placeId) throw new TypeError("applyStageEvent needs the lead's place_id.");
  if (typeof event !== "string" || !event) throw new TypeError('applyStageEvent needs an event, e.g. "demo_view".');
  if (event === "said_no" && !SAID_NO_REASONS.includes(lost_reason)) {
    throw new TypeError(`said_no needs a lost_reason of not_now, not_interested or call, got ${describe(lost_reason)}.`);
  }
  const at = isoText(now, "applyStageEvent");
  const given = emailGiven(email);

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await DB.prepare("SELECT stage, lost_reason FROM prospects WHERE place_id = ?").bind(placeId).first();
    if (!row && !given) return null;
    const from = row ? row.stage : null;
    const to = event === "reopen" && !REOPENABLE.includes(row?.lost_reason) ? from : nextStage(from, event);
    if (to === from) {
      if (to !== "lost" || !NO_CONTACT.includes(event) || NO_CONTACT.includes(row.lost_reason)) return null;
      // already lost for a reason that can be reopened: the opt-out or bounce now outranks it
      const marked = await DB.prepare(
        "UPDATE prospects SET lost_reason = ?, updated_at = ? WHERE place_id = ? AND stage = 'lost' AND lost_reason IS ?",
      ).bind(event, at, placeId, row.lost_reason).run();
      if (marked.meta.changes > 0) return null;
      continue; // another request changed the row since we read it: read it again
    }

    const stopped = STOPPED.has(to);
    const reason = to === "lost" ? (event === "said_no" ? lost_reason : event) : null;
    const write = row
      ? DB.prepare(
        `UPDATE prospects SET stage = ?, stage_at = ?, updated_at = ?, lost_reason = ?${stopped ? ", next_followup_at = NULL" : ""}
         WHERE place_id = ? AND stage = ? AND lost_reason IS ?`,
      ).bind(to, at, at, reason, placeId, from, row.lost_reason ?? null)
      : DB.prepare(
        `INSERT INTO prospects (place_id, stage, stage_at, email, greet_name, lost_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (place_id) DO NOTHING`,
      ).bind(placeId, to, at, newRowEmail(email), greetName(greet_name), reason, at, at);
    const [written] = await DB.batch(stopped ? [write, cancelColdMail(DB, placeId, event)] : [write]);
    if (written.meta.changes > 0) return { from, to };
    // another request changed (or made) the row since we read it: read it again
  }
  throw new Error(`The prospect ${placeId} kept changing while "${event}" was being applied, so it wasn't applied. Try again.`);
}

// The address in `text`, trimmed and lower-cased: "Bob <Bob@X.com>" gives "bob@x.com", so a suppression can't be
// stored under, or missed for, a display-name form of the address (composeEmail sends To as it's given). Only a
// plain address in the final <...> is taken; anything else is used whole, exactly as before.
function bareAddress(text) {
  const s = typeof text === "string" ? text.trim() : "";
  const angle = /<([^<>\s@]+@[^<>\s@]+)>$/.exec(s);
  return (angle ? angle[1] : s).toLowerCase();
}

// The value a suppression row is stored under: addresses and domains lower-cased, a domain without a leading "@", a
// company number upper-cased (as Companies House writes it, and so as leads.company_number holds it).
function suppressionValue(value, kind) {
  if (kind === "company") {
    const number = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (number) return number;
    throw new TypeError(`A company suppression needs a company number, got ${describe(value)}.`);
  }
  const lower = bareAddress(value);
  if (kind === "email" && SUPPRESS_EMAIL_RE.test(lower)) return lower;
  const domain = lower.replace(/^@/, "");
  if (kind === "domain" && DOMAIN_RE.test(domain)) return domain;
  throw new TypeError(`${describe(value)} isn't ${kind === "email" ? "an email address" : "a domain, e.g. spam.com"}.`);
}

/** Never cold-email `value` again. kind is email, domain or company. A value already on the list keeps its first reason. */
export async function suppress(DB, value, kind, reason, now) {
  if (!SUPPRESSION_KINDS.includes(kind)) {
    throw new TypeError(`A suppression's kind is email, domain or company, got ${describe(kind)}.`);
  }
  const stored = suppressionValue(value, kind);
  if (typeof reason !== "string" || !reason.trim()) throw new TypeError('A suppression needs a reason, e.g. "opt_out".');
  await DB.prepare("INSERT OR IGNORE INTO suppression (value, kind, reason, created_at) VALUES (?, ?, ?, ?)")
    .bind(stored, kind, reason, isoText(now, "suppress"))
    .run();
}

/**
 * What a suppression check looks up for `email`: {address, domain}, the bare address lower-cased and the part after
 * its last "@" (address "" when there's nothing to check). Pure; isSuppressed, suppressionReasons and the outbox's
 * claim all use it, so they always agree.
 */
export function suppressionKeys(email) {
  const address = bareAddress(email);
  return { address, domain: address.slice(address.lastIndexOf("@") + 1) };
}

/**
 * The suppression reason for each of `emails` that may not be emailed, as isSuppressed reads it (the exact address,
 * ignoring case, or its domain; the address's own reason first): a Map from the address exactly as given to its
 * reason; addresses that may be emailed aren't in it. One D1 query for any number of addresses, none for an empty
 * list (dispatchDue reads every due row's this way, before any hold check).
 */
export async function suppressionReasons(DB, emails) {
  const reasons = new Map();
  const keys = new Map(); // address as given → its lookup keys
  for (const email of emails ?? []) {
    const k = suppressionKeys(email);
    if (k.address) keys.set(email, k);
  }
  if (!keys.size) return reasons;
  const addresses = [...new Set([...keys.values()].map((k) => k.address))];
  const domains = [...new Set([...keys.values()].map((k) => k.domain))];
  const { results } = await DB.prepare(
    `SELECT kind, value, reason FROM suppression
     WHERE (kind = 'email' AND value IN (SELECT value FROM json_each(?1)))
        OR (kind = 'domain' AND value IN (SELECT value FROM json_each(?2)))`,
  ).bind(JSON.stringify(addresses), JSON.stringify(domains)).all();
  const byAddress = new Map();
  const byDomain = new Map();
  for (const r of results) (r.kind === "email" ? byAddress : byDomain).set(r.value, r.reason);
  for (const [given, { address, domain }] of keys) {
    const reason = byAddress.get(address) ?? byDomain.get(domain);
    if (reason != null) reasons.set(given, reason);
  }
  return reasons;
}

/**
 * The suppression reason for `email` (the exact address, ignoring case, or its domain; the address's own reason
 * first), or null when it may be emailed. "Name <address>" is checked as the address. A subdomain is a different
 * domain. One D1 query.
 */
export async function isSuppressed(DB, email) {
  const { address, domain } = suppressionKeys(email);
  if (!address) return null;
  return DB.prepare(
    `SELECT reason FROM suppression
     WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?)
     ORDER BY kind = 'email' DESC LIMIT 1`,
  ).bind(address, domain).first("reason");
}
