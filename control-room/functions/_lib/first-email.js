// First email (db; docs/rebuild/06-email-followups.md Part A §A3, Part B Task 9): what the composer in the lead drawer
// needs (composeContext), its live preview with every check (previewFirst, pure on that context), the checks only Send
// makes (sendChecks: the do-not-email list, an address another lead is being emailed at) and Send itself (sendFirst).
// The browser side is public/js/compose.js; the routes are api/compose/[id]/*.
//
// Nik writes the subject and the body. The system adds the greeting ("Hi Mark," only for a confident first name, else
// "Hi,"), fills in {demo_link} and adds the cold footer under the business:sender_name setting (never the mailbox's
// display name, which is only the From line), all in mail/rules.js, so the preview is exactly the email.
//
// Send re-runs every check, then claims the lead and queues the email in ONE D1 batch (a transaction). The prospect
// gets the address, greeting, mailbox and subject at once and stays `ready` until the send succeeds (the followups
// step marks it emailed); the email is a `queued` messages row, due now inside the cold window, else at the next window
// start. Both statements carry the same condition (prospect `ready`, never emailed, no first email queued, sending or
// sent), so a double-click or a second tab queues one email, and the prospect row always matches the email queued.
// (queueMessage can't be part of a batch, so the row is written here with the columns it would write.)
//
// Issues come in one order everywhere: the lead's state (no_prospect, already_emailed, queued_already), the text checks
// (firstEmailIssues), the To (not_in_list, then Send's suppressed and shared_address), then the demo and the mailboxes
// (demo_not_ready, no_mailbox, warming_up, no_room), then no_sender_name (overview §9: every cold email ends with Nik's
// name, from business:sender_name; with none set the footer would have no name). Send refuses with 409 when the first
// is queued_already, else 400.
//
// D1: composeContext makes 9 statements (stage 4's demoReady 1, one batch of 3, planFirsts' batch of 3, the follow-up
// approvals 1, the sender name 1); sendFirst 13 (+ sendChecks' batch of 2, the claim's batch of 2), 14 when the claim
// loses a race.
import { demoReady as stageFourDemoReady } from "./demo-db.js";
import { COLD_WINDOW, followupsApproved, planFirsts } from "./followups.js";
import { mailboxCap, pickMailbox } from "./mail/capacity.js";
import { makeMessageId } from "./mail/compose.js";
import { businessName, firstEmailIssues, greetingFor, renderFirstEmail } from "./mail/rules.js";
import { suppressionKeys } from "./prospects.js";
import { parseResearch } from "./research.js";
import { getSetting } from "./settings.js";
import { STAGE_LABELS, warmupFrom } from "./shortlist.js";
import { nextUkWindowStart, ukParts } from "./ukTime.js";
import { iso } from "./util.js";

const SENDER_NAME = "business:sender_name";
// The codes about where the lead is (they come first, and the composer shows the thread instead).
const STATE_CODES = new Set(["no_prospect", "already_emailed", "queued_already"]);

// Part A §A3's messages, word for word, plus three of the same codes for cases its table doesn't name (a mailbox that is
// set up but paused, one that never reaches a cap, a lead past `ready` with no first email), no_sender_name (the
// overview's footer rule) and bad_request.
const MSG = Object.freeze({
  noProspect: "This lead isn't ready to email yet: it needs a grade, an email and a demo first.",
  alreadyEmailed: (business, day) => `You've already emailed ${business}${day ? ` on ${day}` : ""}. The thread is below.`,
  pastReady: (business, label) => `You can't send ${business} a first email: it's marked "${label}".`,
  queuedAlready: (business) => `A first email to ${business} is already waiting to go out. Cancel it below to write a new one.`,
  demoNotReady: (reason) => `Their demo isn't ready: ${reason}. Fix it on the Demo card first.`,
  noMailbox: "No mailbox is set up for cold email yet. Add one on Setup → Mailboxes.",
  paused: (reason) => `Sending is paused: ${reason}. Fix it on Setup → Mailboxes.`,
  warmingUp: (day) => `Your mailbox is still warming up: cold emails can start on ${day}.`,
  neverWarm: "Your mailbox can't send cold email in the next 60 days: check its start date and daily limit on Setup → Mailboxes.",
  noRoom: (day) => `Your mailboxes are full on ${day} (follow-ups already booked that day). Send this one tomorrow.`,
  notInList: "Pick an address from the list.",
  suppressed: (who, why, day) => `${who} is on your do-not-email list (${why}${day ? ` on ${day}` : ""}). You can't email it.`,
  shared: (address, other) => `${address} is already being emailed as ${other}.`,
  noSenderName: "Add your name on Setup → Business details first: every email is signed with it.",
  badRequest: "This page sent the email in a shape the Control Room can't read (it needs the To address, the subject and "
    + "the text, each as text). Refresh the page and try again.",
});

const issue = (code, message) => ({ code, message });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const blank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());

// Text on one line, as the subject and every name are shown: invisible characters (bidi marks and overrides, zero-width
// spaces, the soft hyphen: mail/rules.js drops the same ones) are dropped, then every run of spaces, line breaks and
// control characters becomes one space. Written as \u escapes: literal ones hide in code.
const INVISIBLE = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const oneLine = (value) => (typeof value === "string"
  ? value.replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "");

// An address as it is compared and stored: trimmed and lower-cased.
const addressOf = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
// research.js's email rule, on a lower-cased address: plain ASCII, so the outbox's composeEmail always takes it.
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
// A source link Nik can open (the composer still puts it through safeUrl), else null.
const URL_MAX = 2000;
const httpUrl = (value) => {
  const url = typeof value === "string" ? value.trim() : "";
  return url.length <= URL_MAX && /^https?:\/\/[^\s<>"]+$/i.test(url) ? url : null;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Oct": the UK day of a stored time (UTC ISO text), or null when it can't be read.
function dayMonth(value) {
  const ms = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  const { d, m } = ukParts(new Date(ms));
  return `${d} ${MONTHS[m - 1]}`;
}

// "Tue 3 Nov" for a UK day "YYYY-MM-DD" (as planFirsts and warmupFrom give them).
function shortDay(ukDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ukDay ?? ""));
  if (!m) return String(ukDay ?? "");
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function toDate(now, fn) {
  const date = now instanceof Date ? now : typeof now === "string" ? new Date(now) : null;
  if (!date || Number.isNaN(date.getTime())) throw new TypeError(`${fn} needs the time now, as a Date or UTC ISO text.`);
  return date;
}

// ---- Reads (?1 = place_id)

// The prospect and where its first email is: the newest one not cancelled (the thread's), whether one is waiting to go
// (queued or sending), and whether one went (sent: the followups step may not have marked the lead emailed yet). No row
// = no prospect.
const STATE_SQL = `SELECT p.stage, p.first_sent_at,
    (SELECT m.id FROM messages m WHERE m.place_id = p.place_id AND m.kind = 'first' AND m.status <> 'cancelled'
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS first_message_id,
    EXISTS (SELECT 1 FROM messages m WHERE m.place_id = p.place_id AND m.kind = 'first'
      AND m.status IN ('queued', 'sending')) AS first_waiting,
    EXISTS (SELECT 1 FROM messages m WHERE m.place_id = p.place_id AND m.kind = 'first' AND m.status = 'sent') AS first_sent,
    (SELECT MIN(m.sent_at) FROM messages m WHERE m.place_id = p.place_id AND m.kind = 'first' AND m.status = 'sent') AS first_sent_on
  FROM prospects p WHERE p.place_id = ?1`;
const LEAD_SQL = "SELECT name FROM leads WHERE place_id = ?1";
const RESEARCH_SQL = "SELECT * FROM research WHERE place_id = ?1";
// The cold mailboxes, with what the From line and the paused message need (planFirsts' mailbox read).
const MAILBOXES_SQL = `SELECT id, address, display_name, role, started_on, cap_override, status, paused_reason
  FROM mailboxes WHERE role = 'cold' ORDER BY created_at, id`;

// sendChecks. ?1 = the address, ?2 = its domain (suppressionKeys), ?3 = place_id: the do-not-email row for the address,
// its domain or the lead's company number (stage 3's ready rule, which the outbox's claim also applies, checks all
// three), the address's own first.
const SUPPRESSED_SQL = `SELECT kind, reason, created_at FROM suppression
  WHERE (kind = 'email' AND value = ?1) OR (kind = 'domain' AND value = ?2)
     OR (kind = 'company' AND value = (SELECT company_number FROM leads WHERE place_id = ?3))
  ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'domain' THEN 1 ELSE 2 END LIMIT 1`;
// Another lead being emailed at this address (?1, lower-cased; ?2 = this lead's place_id): its prospect is past `ready`
// and not lost (Part A), or still `ready` with its own first email queued, sending or sent (both would go otherwise).
// It's named as the Leads page lists it (leads.name as stored, not businessName's short form), so Nik can find the
// duplicate listing.
const SHARED_SQL = `SELECT l.name FROM prospects p LEFT JOIN leads l ON l.place_id = p.place_id
  WHERE lower(trim(p.email)) = ?1 AND p.place_id <> ?2
    AND (p.stage NOT IN ('ready', 'lost')
      OR (p.stage = 'ready' AND EXISTS (SELECT 1 FROM messages m WHERE m.place_id = p.place_id AND m.kind = 'first'
            AND m.status IN ('queued', 'sending', 'sent'))))
  ORDER BY p.stage_at DESC, p.place_id LIMIT 1`;

// ---- The claim (one batch). ?1 place_id, ?2 to, ?3 greet_name, ?4 mailbox_id, ?5 subject, ?6 now, ?7 the new
// message's id, ?8 from_addr, ?9 body, ?10 message_id, ?11 due_at.

// The lead can take a first email: no first email of its queued, sending or sent. With the prospect `ready` and never
// emailed (first_sent_at blank, as stateIssues reads it), it's the condition on both statements, so they both apply or
// neither does.
const CLAIMABLE = `NOT EXISTS (SELECT 1 FROM messages WHERE place_id = ?1 AND kind = 'first'
      AND status IN ('queued', 'sending', 'sent'))`;
const NEVER_EMAILED = "stage = 'ready' AND trim(COALESCE(first_sent_at, '')) = ''";
const CLAIM_SQL = `UPDATE prospects SET email = ?2, greet_name = ?3, mailbox_id = ?4, subject = ?5, updated_at = ?6
  WHERE place_id = ?1 AND ${NEVER_EMAILED} AND ${CLAIMABLE}`;
const QUEUE_SQL = `INSERT INTO messages (id, place_id, mailbox_id, direction, kind, step, author, to_addr, from_addr,
    subject, body, message_id, status, due_at, created_at)
  SELECT ?7, ?1, ?4, 'out', 'first', NULL, 'nik', ?2, ?8, ?5, ?9, ?10, 'queued', ?11, ?6
  WHERE EXISTS (SELECT 1 FROM prospects WHERE place_id = ?1 AND ${NEVER_EMAILED})
    AND ${CLAIMABLE}`;

// ---- The context, piece by piece (pure)

// research.emails plus research.best_email, lower-cased, each address once (the first time it's found wins), only real
// addresses; the best one first, marked best.
function toOptions(research) {
  const seen = new Map();
  for (const e of Array.isArray(research?.emails) ? research.emails : []) {
    if (!isObj(e)) continue;
    const email = addressOf(e.email);
    if (!EMAIL.test(email) || seen.has(email)) continue;
    seen.set(email, { email, where: oneLine(e.where), source_url: httpUrl(e.source_url), best: false });
  }
  const options = [...seen.values()];
  const best = addressOf(research?.best_email);
  if (EMAIL.test(best)) {
    const found = seen.get(best);
    if (found) options.splice(options.indexOf(found), 1);
    options.unshift({ ...(found ?? { email: best, where: "", source_url: null }), best: true });
  }
  return options;
}

// "Why them": research.angle's facts (at most 3), each with its source link when it has a real one.
function angleOf(research) {
  const out = [];
  for (const a of Array.isArray(research?.angle) ? research.angle : []) {
    const fact = isObj(a) ? oneLine(a.fact) : "";
    if (fact) out.push({ fact, source_url: httpUrl(a.source_url) });
  }
  return out.slice(0, 3);
}

const openerOf = (research) => (typeof research?.opener === "string" ? research.opener.replace(/\r\n?/g, "\n").trim() : "");

// demoReady's answer as the context carries it: ok only with a whole http(s) link to put in the email.
function demoOf(answer) {
  const url = typeof answer?.url === "string" ? answer.url.trim() : "";
  if (answer?.ok === true && /^https?:\/\/\S+$/i.test(url)) return { ok: true, url, reason: "" };
  return { ok: false, url: null, reason: oneLine(answer?.reason) || "it isn't available" };
}

const demoIssues = (demo) =>
  (demo.ok ? [] : [issue("demo_not_ready", MSG.demoNotReady(demo.reason.replace(/[.\s]+$/, "")))]);

// Where the lead is (STATE_SQL's row, or null for no prospect): [] when a first email may be written.
function stateIssues(state, business) {
  if (!state) return [issue("no_prospect", MSG.noProspect)];
  if (!blank(state.first_sent_at) || Number(state.first_sent)) {
    const day = dayMonth(blank(state.first_sent_at) ? state.first_sent_on : state.first_sent_at);
    return [issue("already_emailed", MSG.alreadyEmailed(business, day))];
  }
  if (state.stage !== "ready") {
    return [issue("already_emailed", MSG.pastReady(business, STAGE_LABELS[state.stage] ?? oneLine(String(state.stage))))];
  }
  if (Number(state.first_waiting)) return [issue("queued_already", MSG.queuedAlready(business))];
  return [];
}

// A paused mailbox's reason inside a sentence (the stored reasons end with a full stop).
const pausedReason = (m) => oneLine(m?.paused_reason).replace(/\.+$/, "").trim() || "no reason was saved";

// The mailbox that sends it and the mailbox checks, from planFirsts' answer (planned for the day the email goes): the
// active cold mailbox with the most room that day (pickMailbox) among those with room on that day and on all 9
// follow-up days (roomFor > 0), else null and why.
function mailboxPlan({ mailboxes, load, room }) {
  const day = room.day;
  const cold = (mailboxes ?? []).filter((m) => m && m.id !== null && m.id !== undefined && m.role === "cold");
  const active = cold.filter((m) => m.status === "active");
  const withRoom = active.filter((m) => (Number(room.byMailbox?.[m.id]?.room) || 0) > 0);
  const booked = Object.fromEntries(withRoom.map((m) => [m.id, Number(load?.[m.id]?.[day]) || 0]));
  const picked = pickMailbox(withRoom, booked, day);
  if (picked) return { mailbox: { id: picked.id, address: picked.address, display_name: picked.display_name }, issues: [] };

  if (!active.length) {
    const paused = cold.find((m) => m.status === "paused") ?? cold[0];
    return { mailbox: null, issues: [issue("no_mailbox", paused ? MSG.paused(pausedReason(paused)) : MSG.noMailbox)] };
  }
  const sending = active.filter((m) => mailboxCap(m, day) > 0);
  if (!sending.length) {
    const from = warmupFrom(active, day);
    return { mailbox: null, issues: [issue("warming_up", from ? MSG.warmingUp(shortDay(from)) : MSG.neverWarm)] };
  }
  const full = sending.map((m) => room.byMailbox?.[m.id]?.fullDay).filter(Boolean).sort()[0] ?? day;
  return { mailbox: null, issues: [issue("no_room", MSG.noRoom(shortDay(full)))] };
}

/**
 * Everything the composer needs for one lead, as of `now` (a Date or UTC ISO text):
 * {place_id, business, to_options: [{email, where, source_url, best}], greeting: {line, name}, angle: [{fact,
 * source_url}], opener, demo: {ok, url, reason}, due_at, mailbox: {id, address, display_name}|null, sender_name,
 * blocking: [{code, message}], followups_approved, stage, first_message_id}.
 * business = the cleaned name ("Green Leaf Landscapes"); greeting from research.owner (greetingFor); due_at = now inside
 * the cold window, else the next window start (UTC ISO text); mailbox = the cold mailbox that will send it, null when
 * none can; sender_name = the business:sender_name setting (the footer), never the mailbox's display_name (the From
 * line); blocking = the db-side checks of Part A §A3 (no_prospect alone when there's no prospect; else already_emailed
 * or queued_already, demo_not_ready, then one of no_mailbox, warming_up, no_room, then no_sender_name while the
 * business:sender_name setting is blank: overview §9's footer has Nik's name); stage = the prospect's (null: none);
 * first_message_id = its newest first email that isn't cancelled (queued, sending, sent or failed), else null.
 * Stage 4's demoReady runs first (`options.demoReady`, injected by tests): it makes a qualifying lead's missing demo or
 * prospect, as the drawer's demo card does, so they're read after it. 9 D1 statements.
 */
export async function composeContext(DB, placeId, now, { demoReady = stageFourDemoReady } = {}) {
  const at = toDate(now, "composeContext");
  const id = typeof placeId === "string" ? placeId : String(placeId ?? "");
  const answer = await demoReady(DB, id, at);
  const [[stateRes, leadRes, researchRes], plan, approved, sender] = await Promise.all([
    DB.batch([STATE_SQL, LEAD_SQL, RESEARCH_SQL].map((sql) => DB.prepare(sql).bind(id))),
    planFirsts(DB, at, DB.prepare(MAILBOXES_SQL)),
    followupsApproved(DB),
    getSetting(DB, SENDER_NAME, ""),
  ]);
  const state = stateRes.results[0] ?? null;
  const name = leadRes.results[0]?.name;
  const research = parseResearch(researchRes.results[0] ?? null);
  const business = oneLine(businessName(name)) || oneLine(name) || "this lead";
  const demo = demoOf(answer);
  const send = mailboxPlan(plan);
  const senderName = oneLine(sender);
  const signed = senderName ? [] : [issue("no_sender_name", MSG.noSenderName)];
  const blocking = state
    ? [...stateIssues(state, business), ...demoIssues(demo), ...send.issues, ...signed]
    : stateIssues(null, business);
  return {
    place_id: id,
    business,
    to_options: toOptions(research),
    greeting: greetingFor(research?.owner ?? null),
    angle: angleOf(research),
    opener: openerOf(research),
    demo,
    due_at: iso(nextUkWindowStart(at, COLD_WINDOW)),
    mailbox: send.mailbox,
    sender_name: senderName,
    blocking,
    followups_approved: approved?.all === true,
    stage: state?.stage ?? null,
    first_message_id: state?.first_message_id ?? null,
  };
}

// ---- Preview and Send

// {to, subject, body} as text (null or missing = blank), or null when any of them isn't text or the input isn't an
// object: the routes pass the request body straight in.
function readInput(input) {
  if (!isObj(input)) return null;
  const out = {};
  for (const key of ["to", "subject", "body"]) {
    const value = input[key];
    if (value === undefined || value === null) out[key] = "";
    else if (typeof value === "string") out[key] = value;
    else return null;
  }
  return out;
}

const badRequest = () => [issue("bad_request", MSG.badRequest)];
const inList = (ctx, to) => {
  const address = addressOf(to);
  return !!address && (Array.isArray(ctx?.to_options) ? ctx.to_options : []).some((o) => o?.email === address);
};
const fromLine = (mailbox) => {
  if (!mailbox?.address) return "";
  const name = oneLine(mailbox.display_name);
  return name ? `${name} <${mailbox.address}>` : mailbox.address;
};

// Every issue in the one order (see the top of the file): the state, the text, the To (not_in_list, then
// `toChecks`, sendChecks' answer), then the rest of `blocking`.
function issuesFor(ctx, fields, toChecks) {
  const blocking = Array.isArray(ctx?.blocking) ? ctx.blocking.filter(isObj) : [];
  const issues = blocking.filter((i) => STATE_CODES.has(i.code));
  issues.push(...firstEmailIssues({
    subject: oneLine(fields.subject), body: fields.body, demoUrl: ctx?.demo?.ok ? ctx.demo.url : null,
    greetingLine: ctx?.greeting?.line,
  }));
  if (!inList(ctx, fields.to)) issues.push(issue("not_in_list", MSG.notInList));
  issues.push(...toChecks, ...blocking.filter((i) => !STATE_CODES.has(i.code)));
  return issues;
}

// {demo_link} while there's no demo address: renderFirstEmail refuses to send one, and the preview shows it as written.
// A private-use character no one types; any in Nik's text are dropped first.
const KEPT = "\uE010";

// The email's text exactly as they'll get it (renderFirstEmail); while there's no demo, {demo_link} stays as written.
function emailText(ctx, body) {
  const greetingLine = oneLine(ctx?.greeting?.line) || "Hi,";
  const nikName = typeof ctx?.sender_name === "string" ? ctx.sender_name : "";
  const url = ctx?.demo?.ok && typeof ctx.demo.url === "string" && /^https?:\/\/\S+$/i.test(ctx.demo.url) ? ctx.demo.url : null;
  if (url) return renderFirstEmail({ greetingLine, body, demoUrl: url, nikName });
  const kept = body.split(KEPT).join("").replace(/\{demo_link\}/g, KEPT);
  return renderFirstEmail({ greetingLine, body: kept, demoUrl: null, nikName }).split(KEPT).join("{demo_link}");
}

/**
 * The live preview (pure on composeContext's answer, `ctx`): {text, from, issues}. text = the email exactly as they'll
 * get it (greeting, Nik's body with {demo_link} filled in, the cold footer); from = "display_name <address>" of the
 * mailbox that will send it ("" when none can); issues = the lead's state, the text checks of Part A §A3, not_in_list,
 * then the rest of ctx.blocking ([] when Send would go, bar Send's own suppressed and shared_address checks). Input that
 * isn't {to, subject, body} as text gives one bad_request issue and no text.
 */
export function previewFirst(ctx, input) {
  const from = fromLine(ctx?.mailbox);
  const fields = readInput(input);
  if (!fields) return { text: "", from, issues: badRequest() };
  return { text: emailText(ctx, fields.body), from, issues: issuesFor(ctx, fields, []) };
}

/**
 * The checks only Send makes, for the address `to` on the lead of `ctx` (composeContext's answer): suppressed (the
 * address, its domain or the lead's company number is on the do-not-email list: "(opted out / bounced / <reason> on
 * <3 Nov>)") and shared_address (another lead is being emailed at it). [] when neither. 2 D1 statements in one batch.
 */
export async function sendChecks(DB, ctx, to) {
  const address = addressOf(to);
  if (!address) return [];
  const placeId = String(ctx?.place_id ?? "");
  const { address: key, domain } = suppressionKeys(address);
  const [listed, shared] = await DB.batch([
    DB.prepare(SUPPRESSED_SQL).bind(key, domain, placeId),
    DB.prepare(SHARED_SQL).bind(key, placeId),
  ]);
  const issues = [];
  const row = listed.results[0];
  if (row) {
    const why = row.reason === "opt_out" ? "opted out" : row.reason === "bounce" ? "bounced" : oneLine(row.reason) || "blocked";
    const who = row.kind === "company" ? oneLine(ctx?.business) || "This lead" : address;
    issues.push(issue("suppressed", MSG.suppressed(who, why, dayMonth(row.created_at))));
  }
  const other = shared.results[0];
  if (other) issues.push(issue("shared_address", MSG.shared(address, oneLine(other.name) || "another lead")));
  return issues;
}

const refuse = (issues) => ({ ok: false, status: issues[0]?.code === "queued_already" ? 409 : 400, issues });

/**
 * Nik pressed Send: {to, subject, body} for lead `placeId` at `now`. Every check runs again here (composeContext,
 * previewFirst's, sendChecks). Then, in one batch: the prospect gets email = to (lower-cased), greet_name (NULL for
 * "Hi,"), mailbox_id and subject (on one line), its stage staying `ready`; and the first email is queued (author nik,
 * from the picked mailbox, body exactly as previewed, a new Message-ID at the mailbox's domain, due_at as
 * composeContext's). → {ok: true, id, due_at} | {ok: false, status: 400|409, issues}: 409 when a first email is
 * already waiting to go (queued_already, also for the second of two Sends at once), else 400. `options.demoReady` is
 * stage 4's, injected by tests. 13 D1 statements.
 */
export async function sendFirst(DB, placeId, input, now, { demoReady } = {}) {
  const at = toDate(now, "sendFirst");
  const fields = readInput(input);
  if (!fields) return refuse(badRequest());
  const ctx = await composeContext(DB, placeId, at, demoReady ? { demoReady } : {});
  const to = addressOf(fields.to);
  const toChecks = ctx.stage !== null && inList(ctx, to) ? await sendChecks(DB, ctx, to) : [];
  const issues = issuesFor(ctx, fields, toChecks);
  if (issues.length) return refuse(issues);

  const { mailbox } = ctx; // set: without one, no_mailbox, warming_up or no_room is in ctx.blocking
  const id = crypto.randomUUID();
  const values = [
    ctx.place_id, to, ctx.greeting.name, mailbox.id, oneLine(fields.subject), iso(at),
    id, mailbox.address, emailText(ctx, fields.body), makeMessageId(mailbox.address), ctx.due_at,
  ];
  const [claim, queued] = await DB.batch([
    DB.prepare(CLAIM_SQL).bind(...values.slice(0, 6)),
    DB.prepare(QUEUE_SQL).bind(...values),
  ]);
  if (claim.meta.changes > 0 && queued.meta.changes > 0) return { ok: true, id, due_at: ctx.due_at };

  // Another Send (or the sync) got there between the checks and the batch: say why, from the lead as it is now.
  const why = stateIssues(await DB.prepare(STATE_SQL).bind(ctx.place_id).first(), ctx.business);
  return refuse(why.length ? why : [issue("queued_already", MSG.queuedAlready(ctx.business))]);
}
