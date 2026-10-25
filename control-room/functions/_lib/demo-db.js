// Demo sites in D1 (stage 4, docs/rebuild/05-demo.md). The page itself is drawn on every request by the pure engine
// in _lib/demo/ from the lead and its research; only the slug and its dates are stored (`demos`).
//
// ensureDemo (Task 8) makes a lead's demo and its `ready` prospect once the lead qualifies (Part A §1): stage 2's
// research route calls it right after saving the research, and the tick's `hot` step (Task 12) for leads that missed
// it. demoBySlug finds a demo with everything its page needs. recordEvent (kept for stage 9) stores what a prospect did,
// and countView (Task 11, the beacon's) counts a real view: one per 30 minutes, prospects.views, emailed → viewed.
// templateApproval and approveTemplate (Task 9) are Nik's OK for a look (Part A §7, decision D-5), and demoReady is
// what stages 5/6 ask before an email links to a demo. syncDemoExpiry and missingDemos (Task 12) are the tick's `hot`
// step's (_lib/hot.js). latestDemo is the one rule for a lead's current demo (it can have several rows): the newest by
// created_at DESC, slug DESC. Tested in tests/demo-db.test.mjs and tests/demo-hot.test.mjs.
//
// D1 budget: ensureDemo reads everything it needs in ONE select, so the usual new demo costs 4 statements (the read,
// the demo insert, applyStageEvent's read and insert) and a lead that is already right costs 1. The first demo of a
// look adds its setup todo (+1); a ready prospect's better email is one UPDATE (+1, none once its first email is
// queued); a slug clash retries once (+1).
// demoReady is that same one select (plus a whole ensureDemo for a lead that missed its demo or prospect);
// templateApproval is 1 statement, approveTemplate 2 (the setting, then closing the look's setup todos);
// syncDemoExpiry, missingDemos and latestDemo 1 each.
import { templateIdFor } from "./demo/data.js";
import { TEMPLATES } from "./demo/render.js";
import { slugFor } from "./demo/text.js";
import { applyStageEvent, suppressionKeys } from "./prospects.js";
import { getSetting, setSetting } from "./settings.js";
import { addTodo, closeTodos } from "./todo.js";
import { iso, parseJson } from "./util.js";

/** Days a demo stays up after it's made (the hot step extends it to 180 days after the latest email we sent). */
export const DEMO_DAYS = 180;
/** Our own domain: the only link in the first email. */
export const DEMO_BASE = "https://aetoswebsites.com";

/** The link a prospect gets: https://aetoswebsites.com/d/<slug>. */
export const demoLink = (slug) => `${DEMO_BASE}/d/${slug}`;

const DAY_MS = 86_400_000;
const SLUG_RE = /^[a-z0-9-]{3,60}$/;
const DEMO_GRADES = ["A+", "A", "B"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/; // what applyStageEvent accepts for a new prospect's email

// Part A §1, word for word, plus `skipped` (research skipped: Nik's Not a fit, the do-not-contact list, an excluded
// lead, the purge), so such a lead never reads "Not researched yet" beside a research card saying "Skipped: …"
// (overview: errors say what's wrong in plain English).
const REASONS = {
  missing: "Lead not found",
  excluded: (why) => `Excluded: ${why}`,
  skipped: "Taken off the list (the research card says why)",
  notDone: "Not researched yet",
  tooBig: "Too big for us",
  grade: (grade) => `Grade ${grade}: only A+, A and B get a demo`,
  noEmail: "No email found",
  suppressed: "On the do-not-contact list",
};
const CLASH = "Couldn't make a demo link for this lead: two random links in a row were already taken. Try again.";
// Part A §7 and "Errors in plain English", word for word: stages 5/6 and the Demo page show them.
const NOT_READY = {
  noDemo: (reason) => `No demo yet: ${reason}`,
  expired: "Their demo has expired: a new one is being made",
  waiting: (label) => `Waiting for you to approve the ${label} look on the Demo page`,
};
const CHANGED = "This look changed since you opened the page. Refresh and check it again before approving.";

/** The setting holding Nik's OK for a look: {"version": <n>, "at": "<ISO>"}. */
const approvalKey = (id) => `demo:template:${id}:approved`;
/** The "Approve the <Label> look on the Demo page" todo's dedupe: one per look and version. */
const setupDedupe = (t) => `setup:demo-template:${t.id}:v${t.version}`;
/** What every version of a look's setup todo starts with: approving the look closes them all. Nothing else starts with
 * it (the ":" ends the id), so closeTodos by this prefix is safe (overview §6). */
const setupPrefix = (t) => `setup:demo-template:${t.id}:`;
const LOOKS = Object.values(TEMPLATES).map((t) => t.TEMPLATE);
const LOOK_IDS = Object.keys(TEMPLATES).join(", ");

// TEMPLATES[id].TEMPLATE for a real look id, else a plain error. Own keys only, so "constructor" or "__proto__" is no
// look; the id isn't echoed (it comes from a request body).
function lookById(id) {
  if (typeof id !== "string" || !Object.hasOwn(TEMPLATES, id)) {
    throw new Error(`That look doesn't exist. The looks are: ${LOOK_IDS}.`);
  }
  return TEMPLATES[id].TEMPLATE;
}

// The address Claude found as suppressionKeys reads it (trimmed, lower-cased) and the part after its last "@", in SQL,
// so the do-not-contact rows can be read in the same select (rtrim strips everything after the last "@").
const ADDRESS_SQL = "lower(trim(r.best_email))";
const DOMAIN_SQL = `substr(${ADDRESS_SQL}, length(rtrim(${ADDRESS_SQL}, replace(${ADDRESS_SQL}, '@', ''))) + 1)`;

// Whether the lead has a first email queued, sending, sent or failed: stage 6 wrote the To Nik picked and its greeting
// into the prospect when it queued it (the stage stays `ready` until the send succeeds), its follow-ups go to
// prospects.email, stage 0 matches replies by it and "Try again" re-sends to the old to_addr, so ensureDemo leaves
// that prospect's email and greet_name alone. A cancelled first email frees them again. The unary + keeps SQLite on
// messages_place (place_id) rather than messages_due (status): with no ANALYZE statistics it could pick the latter.
const FIRST_EMAIL_SQL = (placeId) => `EXISTS (SELECT 1 FROM messages m WHERE m.place_id = ${placeId}
      AND m.direction = 'out' AND m.kind = 'first' AND +m.status IN ('queued', 'sending', 'sent', 'failed'))`;

// THE rule for a lead's current demo. A lead can have several `demos` rows: the old system's, and a new one ensureDemo
// made when its demo ended before any email went out (the old row stays: its link may be out). The current one is the
// newest by created_at DESC, slug DESC. ensureDemo's subquery (ENSURE_SQL), SYNC_EXPIRY_SQL, api/demo's PREVIEW_COLUMNS
// and DEMOS_SQL and api/demo/lead/[id].js's CARD_SQL inline this same ORDER BY (one statement each); anything else
// reading a lead's demo calls latestDemo, and nothing joins `demos` on place_id.
const LATEST_SQL = "SELECT * FROM demos WHERE place_id = ? ORDER BY created_at DESC, slug DESC LIMIT 1";

/**
 * The lead's current demo, {slug, place_id, created_at, expires_at}, or null when it has none: its newest `demos` row
 * (created_at DESC, slug DESC), the one ensureDemo reuses, demoReady judges and syncDemoExpiry extends. No expiry
 * filter (an ended demo is still the latest: stage 7 keeps its link in a reply, which makes syncDemoExpiry extend it)
 * and no writes, unlike demoReady (which can make a demo and gives no link for an ended one). 1 D1 statement.
 */
export async function latestDemo(DB, place_id) {
  const row = await DB.prepare(LATEST_SQL).bind(String(place_id ?? "")).first();
  return row ? { slug: row.slug, place_id: row.place_id, created_at: row.created_at, expires_at: row.expires_at } : null;
}

// Everything ensureDemo needs, in one select: the lead, its research, its latest demo (newest created_at, then slug:
// latestDemo's rule, as stage 3's shortlist picks it), its prospect and whether its first email is out of ensureDemo's
// hands (FIRST_EMAIL_SQL), the do-not-contact rows for that address and its domain, every look's approval setting and
// which looks' setup todos exist (open, done by hand or dismissed: closeTodos frees the dedupe only once the look is
// approved).
// ?1 = place_id, ?2 = JSON list of the approval keys, ?3 = JSON list of the todo dedupes. No row = no such lead.
const ENSURE_SQL = `SELECT l.place_id, l.name, l.trade, l.excluded, l.exclude_reason,
    r.status AS research_status, r.grade, r.too_big, r.best_email, r.owner,
    d.slug AS demo_slug, d.created_at AS demo_created_at, d.expires_at AS demo_expires_at,
    p.stage AS prospect_stage, p.email AS prospect_email, p.greet_name AS prospect_greet_name,
    ${FIRST_EMAIL_SQL("l.place_id")} AS first_email,
    (SELECT json_group_array(json_object('kind', s.kind, 'value', s.value)) FROM suppression s
      WHERE s.kind IN ('email', 'domain') AND s.value IN (${ADDRESS_SQL}, ${DOMAIN_SQL})) AS suppression,
    (SELECT json_group_object(st.key, st.value) FROM settings st
      WHERE st.key IN (SELECT value FROM json_each(?2))) AS approvals,
    (SELECT json_group_array(t.dedupe) FROM todos t WHERE t.dedupe IN (SELECT value FROM json_each(?3))) AS setup_todos
  FROM leads l
  LEFT JOIN research r ON r.place_id = l.place_id
  LEFT JOIN prospects p ON p.place_id = l.place_id
  LEFT JOIN demos d ON d.slug = (SELECT d2.slug FROM demos d2 WHERE d2.place_id = l.place_id
    ORDER BY d2.created_at DESC, d2.slug DESC LIMIT 1)
  WHERE l.place_id = ?1`;
// INSERT OR IGNORE: a slug another demo already has changes nothing, and ensureDemo tries a new one.
const INSERT_DEMO_SQL = "INSERT OR IGNORE INTO demos (slug, place_id, created_at, expires_at) VALUES (?, ?, ?, ?)";
// Re-research found a better address or owner: only while the prospect is `ready` and no first email is queued,
// sending, sent or failed (FIRST_EMAIL_SQL, checked here too so a first email queued since ensureDemo's read still
// wins), never a stage change.
const UPDATE_READY_SQL = `UPDATE prospects SET email = ?, greet_name = ?, updated_at = ?
  WHERE place_id = ? AND stage = 'ready' AND NOT ${FIRST_EMAIL_SQL("prospects.place_id")}`;

// ENSURE_SQL for one lead (1 statement): its row, or null when there's no such lead.
const readLead = (DB, place_id) => DB.prepare(ENSURE_SQL)
  .bind(String(place_id ?? ""), JSON.stringify(LOOKS.map((t) => approvalKey(t.id))), JSON.stringify(LOOKS.map(setupDedupe)))
  .first();

// Milliseconds of `now` (a Date or ISO text), or a plain error. Stored times are util.iso text.
function msOf(now, fn) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  if (Number.isNaN(ms)) throw new TypeError(`${fn} needs the time now, as a Date or an ISO time.`);
  return ms;
}

// A stored time read as milliseconds. Old demos carry toISOString text with milliseconds, new ones util.iso text;
// both read the same. Unreadable text counts as the distant past, so a broken row is treated as ended.
const storedMs = (text) => {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? -Infinity : ms;
};

// Nik's OK for `look` as its setting's text holds it ({"version": <n>, "at": "<ISO>"}) → {approved, version, at}:
// approved only when the stored version is the look's current one, so a redesign needs a fresh OK (pure). The one
// rule for approval: ensureDemo and demoReady read the setting's text in their one select and pass it here;
// templateApproval passes getSetting's text here too, so they can never disagree.
function approvalFrom(settingText, look) {
  const v = parseJson(settingText, null);
  const isObject = v !== null && typeof v === "object" && !Array.isArray(v);
  const version = isObject && Number.isInteger(v.version) ? v.version : null;
  const at = isObject && typeof v.at === "string" ? v.at : null;
  return { approved: version !== null && version === look.version, version, at };
}

/**
 * Whether Nik has approved look `id`'s current version: {approved, version, at}, where version and at are what the
 * setting demo:template:<id>:approved holds (null when unset or unreadable) and approved is version ===
 * TEMPLATES[id].TEMPLATE.version, so an OK of an older version (the Demo page's "This look changed since you approved
 * version <n>.") doesn't count. 1 statement. Throws a plain error for an id that isn't a look.
 * ensureDemo and demoReady don't call it: they read the setting in their own one select (one statement fewer per
 * demo, which the hot step's budget of 4 per ensureDemo needs) and apply the same approvalFrom.
 */
export async function templateApproval(DB, id) {
  const look = lookById(id);
  return approvalFrom(await getSetting(DB, approvalKey(look.id)), look);
}

/**
 * Nik pressed "Approve this look" for look `id` at the `version` his page showed. Stores
 * demo:template:<id>:approved = {"version", "at"} (at in util.now() format), then closes every open setup todo of that
 * look, whatever version it asked about (dedupe prefix setup:demo-template:<id>:). 2 statements. Throws, writing
 * nothing, when `version` isn't the look's current one ("This look changed since you opened the page. Refresh and
 * check it again before approving."), for an id that isn't a look, or when `now` isn't a time.
 */
export async function approveTemplate(DB, id, version, now = new Date()) {
  const look = lookById(id);
  if (version !== look.version) throw new Error(CHANGED);
  const at = iso(msOf(now, "approveTemplate"));
  // The setting first: ensureDemo adds a look's todo only while it isn't approved, so once this is stored nothing can
  // re-add what the close below takes away.
  await setSetting(DB, approvalKey(look.id), JSON.stringify({ version: look.version, at }));
  await closeTodos(DB, setupPrefix(look));
}

// Part A §1's checks on readLead's row, in its order (pure): {reason, email}, where reason is the exact reason the
// lead gets no demo ("" when it qualifies) and email its address as the prospect row holds it. ensureDemo and
// demoReady share it, so demoReady's "No demo yet: <reason>" is always what ensureDemo says.
function qualify(row) {
  const no = (reason) => ({ reason, email: "" });
  if (!row) return no(REASONS.missing);
  if (Number(row.excluded)) return no(REASONS.excluded(String(row.exclude_reason ?? "").trim() || "not a fit"));
  if (row.research_status === "skipped") return no(REASONS.skipped);
  if (row.research_status !== "done") return no(REASONS.notDone);
  if (Number(row.too_big)) return no(REASONS.tooBig);
  if (!DEMO_GRADES.includes(row.grade)) return no(REASONS.grade(row.grade || "not set"));
  // An address the prospect row can't hold (stage 2 never stores one) counts as none, so nothing is half made.
  const email = typeof row.best_email === "string" ? row.best_email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return no(REASONS.noEmail);
  const keys = suppressionKeys(email);
  const listed = parseJson(row.suppression, []);
  const suppressed = Array.isArray(listed) && listed.some((s) =>
    (s?.kind === "email" && s.value === keys.address) || (s?.kind === "domain" && s.value === keys.domain));
  if (suppressed) return no(REASONS.suppressed);
  return { reason: "", email };
}

// Whether readLead's row has a latest demo that is still up at `ms`: before its expires_at, or forever once the
// prospect is won (Part A §2, as demoBySlug reads it).
const liveDemo = (row, ms) => Boolean(row.demo_slug) && (row.prospect_stage === "won" || storedMs(row.demo_expires_at) > ms);

// The look (TEMPLATE {id, version, label}) the lead's demo uses, and whether Nik approved its current version, as
// readLead's row has them.
const lookOf = (row) => (TEMPLATES[templateIdFor(row.trade)] ?? TEMPLATES.generic).TEMPLATE;
const approvedIn = (row, look) => approvalFrom(parseJson(row.approvals, {})?.[approvalKey(look.id)], look).approved;

/**
 * Make the lead's demo site and its prospect when the lead qualifies (Part A §1). Returns
 * {ok, reason, demo: {slug, place_id, created_at, expires_at} | null, created}: `reason` is "" when ok, else the exact
 * Part A reason and nothing is written. When ok: the lead's latest demo is reused while it's live (a won prospect's
 * always), else a new one is made (created: true) for DEMO_DAYS; a lead with no prospect gets one in stage `ready`
 * through applyStageEvent "demo_ready" (email = research.best_email lower-cased, greet_name = research.owner.first
 * only when confident);
 * a `ready` prospect gets the newest email and greet_name, unless its first email is queued, sending, sent or failed
 * (stage 6 wrote the address Nik picked; a cancelled one frees it again); any later stage is never touched; and a look
 * Nik hasn't approved adds its setup todo once. Throws only on a database error (or two slug clashes in a row).
 */
export async function ensureDemo(DB, place_id, now = new Date()) {
  const ms = msOf(now, "ensureDemo");
  const at = iso(ms);
  const row = await readLead(DB, place_id);
  // Part A §1, in its order.
  const { reason, email } = qualify(row);
  if (reason) return { ok: false, reason, demo: null, created: false };

  // 1. The demo: the latest while it's live, else a new one (a slug clash tries one new slug). A won prospect's demo
  // never ends (Part A §2, as demoBySlug reads it), so a client never gets a second one.
  let demo = null;
  let created = false;
  if (liveDemo(row, ms)) {
    demo = { slug: row.demo_slug, place_id: row.place_id, created_at: row.demo_created_at, expires_at: row.demo_expires_at };
  } else {
    const fresh = { slug: "", place_id: row.place_id, created_at: at, expires_at: iso(ms + DEMO_DAYS * DAY_MS) };
    for (let attempt = 0; attempt < 2 && !demo; attempt++) {
      fresh.slug = slugFor(row.name);
      const { meta } = await DB.prepare(INSERT_DEMO_SQL).bind(fresh.slug, fresh.place_id, fresh.created_at, fresh.expires_at).run();
      if (meta?.changes > 0) demo = fresh;
    }
    if (!demo) throw new Error(CLASH);
    created = true;
  }

  // 2–3. The prospect: made in stage ready, or a ready one brought up to date while its first email isn't queued,
  // sending, sent or failed. Later stages are left alone.
  const owner = parseJson(row.owner, null);
  const greet = owner?.confident === true && typeof owner.first === "string" && owner.first.trim() ? owner.first.trim() : null;
  if (!row.prospect_stage) {
    await applyStageEvent(DB, row.place_id, "demo_ready", at, { email, greet_name: greet });
  } else if (row.prospect_stage === "ready" && !Number(row.first_email)
    && (row.prospect_email !== email || (row.prospect_greet_name ?? null) !== greet)) {
    await DB.prepare(UPDATE_READY_SQL).bind(email, greet, at, row.place_id).run();
  }

  // 4. A look Nik hasn't approved (this version) asks him once, on Todo.
  const look = lookOf(row);
  const todos = parseJson(row.setup_todos, []);
  if (!approvedIn(row, look) && !(Array.isArray(todos) && todos.includes(setupDedupe(look)))) {
    await addTodo(DB, {
      kind: "setup",
      title: `Approve the ${look.label} look on the Demo page`,
      detail: "Check the previews on the Demo page, then press Approve this look. First emails linking to this look wait until you do.",
      link: "/#/demo",
      dedupe: setupDedupe(look),
    });
  }

  return { ok: true, reason: "", demo, created };
}

/**
 * Whether the lead's demo can go in an email now (Part A §7): what stages 5/6 ask before a first email or a follow-up
 * links to it (stage 6's gate: never send a dead link), and what stage 3's shortlist and the lead drawer show.
 * → {ok, reason, url, slug}: ok with reason "", the link (demoLink) and its slug; else url and slug are null and reason
 * is exactly one of "No demo yet: <ensureDemo's reason>", "Their demo has expired: a new one is being made" (the hot
 * step's safety net replaces it; demoReady doesn't), or "Waiting for you to approve the <Label> look on the Demo page".
 * Judged on the lead's latest demo, in that order. One statement (ensureDemo's select).
 *
 * A lead already emailed (prospect past `ready`) whose latest demo is live is judged on the demo and the look only: a
 * re-grade to C, Not a fit or an opt-out after the link went out leaves the demo up (Part A edge cases: "Demo stays
 * (link may already be out)"), so its follow-ups never read "No demo yet". Who may still be emailed then is stage 3's
 * picks, stage 6's stop rules and stage 0's outbox (do-not-contact). Every other lead, a `ready` prospect included
 * (nothing has been sent, and stage 5/6's first-email gate relies on this answer for grade, too-big and excluded), is
 * checked against Part A §1 first, and that reason follows "No demo yet: "; its demo row is never touched. One that
 * qualifies but has no demo or no prospect (graded before this stage shipped, or the research route's ensureDemo
 * call failed) gets them now through ensureDemo, as the hot step would.
 */
export async function demoReady(DB, place_id, now = new Date()) {
  const ms = msOf(now, "demoReady");
  const notReady = (reason) => ({ ok: false, reason, url: null, slug: null });
  const row = await readLead(DB, place_id);
  let slug = row?.demo_slug;
  const emailed = Boolean(row?.prospect_stage) && row.prospect_stage !== "ready"; // the link may be out
  if (!(emailed && slug && liveDemo(row, ms))) {
    const { reason } = qualify(row);
    if (reason) return notReady(NOT_READY.noDemo(reason));
    if (!slug || !row.prospect_stage) {
      const made = await ensureDemo(DB, row.place_id, now);
      if (!made.ok) return notReady(NOT_READY.noDemo(made.reason));
      slug = made.demo.slug;
    } else if (!liveDemo(row, ms)) {
      return notReady(NOT_READY.expired);
    }
  }
  const look = lookOf(row);
  if (!approvedIn(row, look)) return notReady(NOT_READY.waiting(look.label));
  return { ok: true, reason: "", url: demoLink(slug), slug };
}

// demoBySlug's reads, one batch keyed on the slug: the demo, its lead, research and prospect (with the address of the
// thread's mailbox). Whole rows, as buildDemoData takes them (JSON columns as stored text).
const BY_SLUG_SQL = [
  "SELECT * FROM demos WHERE slug = ?",
  "SELECT l.* FROM demos d JOIN leads l ON l.place_id = d.place_id WHERE d.slug = ?",
  "SELECT r.* FROM demos d JOIN research r ON r.place_id = d.place_id WHERE d.slug = ?",
  `SELECT p.*, m.address AS mailbox_address FROM demos d JOIN prospects p ON p.place_id = d.place_id
    LEFT JOIN mailboxes m ON m.id = p.mailbox_id WHERE d.slug = ?`,
];

/**
 * A demo by its slug with what its page needs: {demo, lead, research, prospect, expired, contact_email}, or null for a
 * slug not matching ^[a-z0-9-]{3,60}$, an unknown slug or a demo whose lead is gone. research and prospect are null
 * when there's no row. expired = expires_at <= now, except a prospect in stage won never sees "ended".
 * contact_email = the address of the prospect's mailbox (the thread's), else "". 4 D1 statements in one batch.
 */
export async function demoBySlug(DB, slug, now = new Date()) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  const ms = msOf(now, "demoBySlug");
  const [demoRes, leadRes, researchRes, prospectRes] = await DB.batch(BY_SLUG_SQL.map((sql) => DB.prepare(sql).bind(slug)));
  const demo = demoRes?.results?.[0] ?? null;
  const lead = leadRes?.results?.[0] ?? null;
  if (!demo || !lead) return null;
  const research = researchRes?.results?.[0] ?? null;
  const found = prospectRes?.results?.[0] ?? null;
  let prospect = null;
  let contact_email = "";
  if (found) {
    const { mailbox_address, ...rest } = found;
    prospect = rest;
    contact_email = typeof mailbox_address === "string" ? mailbox_address : "";
  }
  const expired = prospect?.stage !== "won" && storedMs(demo.expires_at) <= ms;
  return { demo, lead, research, prospect, expired, contact_email };
}

export const EVENT_KINDS = ["view", "order_page", "order_click", "ordered"];

/** A demo counts one view per this long (Part A §8). */
const VIEW_DEDUPE_MS = 30 * 60_000;
// One statement for any event. A view is stored only when its demo has no view after ?5 (30 minutes ago), checked in
// the same INSERT, so two beacons arriving together can't both count. ?1 slug, ?2 place_id, ?3 kind, ?4 at.
// The check names the demo's place_id too (a slug's events always carry its demo's place_id), so it reads through the
// demo_events_place (place_id, kind) index instead of scanning every event of every demo on each beacon.
const INSERT_EVENT_SQL = `INSERT INTO demo_events (slug, place_id, kind, at) SELECT ?1, ?2, ?3, ?4
  WHERE ?3 <> 'view' OR NOT EXISTS (SELECT 1 FROM demo_events
    WHERE place_id = ?2 AND kind = 'view' AND slug = ?1 AND at > ?5)`;
const PROSPECT_STAGE_SQL = "SELECT stage FROM prospects WHERE place_id = ?";
const COUNT_VIEW_SQL = "UPDATE prospects SET views = views + 1, last_view_at = ?, updated_at = ? WHERE place_id = ?";

/**
 * Record what a prospect did (`kind` one of EVENT_KINDS, at util.now() format); repeat views within 30 minutes count
 * once. Nothing but an order is stored once the demo has ended (expires_at <= now, as demoBySlug's `expired` reads it).
 * → true when a row was stored. 1 D1 statement (none for an unknown kind or an ended demo).
 */
export async function recordEvent(DB, demo, kind, now = new Date()) {
  if (!EVENT_KINDS.includes(kind)) return false;
  const ms = msOf(now, "recordEvent");
  if (kind !== "ordered" && storedMs(demo.expires_at) <= ms) return false;
  const { meta } = await DB.prepare(INSERT_EVENT_SQL)
    .bind(demo.slug, demo.place_id, kind, iso(ms), iso(ms - VIEW_DEDUPE_MS))
    .run();
  return meta?.changes > 0;
}

/**
 * A real person's view of `demo` (Part A §8): the beacon calls it once its own checks pass (not a bot, not Nik, demo
 * live). Counted only when the lead's prospect exists and is past stage `ready` (an email went out, so it can't be Nik
 * or a leak) and recordEvent stores the view (the demo is live, no view of it in the last 30 minutes). Then one UPDATE
 * adds 1 to prospects.views and sets last_view_at and updated_at to now, and applyStageEvent "demo_view" moves emailed
 * → viewed (every other stage stays where it is). → true when counted.
 * D1: 1 statement for a missing or ready prospect, 2 for a repeat view, 4 for a counted view (5 when emailed → viewed).
 */
export async function countView(DB, demo, now = new Date()) {
  const at = iso(msOf(now, "countView"));
  const stage = await DB.prepare(PROSPECT_STAGE_SQL).bind(demo.place_id).first("stage");
  if (!stage || stage === "ready") return false;
  if (!(await recordEvent(DB, demo, "view", now))) return false;
  await DB.prepare(COUNT_VIEW_SQL).bind(at, at, demo.place_id).run();
  await applyStageEvent(DB, demo.place_id, "demo_view", at);
  return true;
}

// ---------------------------------------------------------------- the tick's hot step (Task 12, _lib/hot.js)

// The day the last email we sent the lead plus DEMO_DAYS, as util.now() text (NULL when we've sent them nothing).
// The unary + on m.status keeps SQLite off messages_due (status, due_at): with no ANALYZE statistics it would pick
// that index and read every sent message of every lead for each demo, every 5 minutes (D1 bills rows read). With it,
// each demo reads only its own lead's messages through messages_place (tests/demo-hot.test.mjs checks the plan).
const SENT_UNTIL_SQL = `(SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(m.sent_at), '+${DEMO_DAYS} days') FROM messages m
    WHERE m.place_id = demos.place_id AND m.direction = 'out' AND +m.status = 'sent')`;
// Only each lead's latest demo (newest created_at, then slug: latestDemo's rule, as ensureDemo and stage 3 pick it),
// and only when that day is later than its expires_at (read through strftime, so the old system's times with
// milliseconds compare right).
const SYNC_EXPIRY_SQL = `UPDATE demos SET expires_at = ${SENT_UNTIL_SQL}
  WHERE slug = (SELECT d2.slug FROM demos d2 WHERE d2.place_id = demos.place_id
      ORDER BY d2.created_at DESC, d2.slug DESC LIMIT 1)
    AND ${SENT_UNTIL_SQL} > COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', demos.expires_at), '')`;

/**
 * Part A §2: each lead's latest demo stays up until DEMO_DAYS after the latest email we sent them (messages out and
 * sent), never earlier than it already ends. → how many demos were extended. 1 D1 statement.
 */
export async function syncDemoExpiry(DB) {
  const { meta } = await DB.prepare(SYNC_EXPIRY_SQL).run();
  return Number(meta?.changes) || 0;
}

// Every whitespace character JS's \s matches, for SQL's GLOB: an address holding one is no address to ensureDemo.
// Written with GLOB ranges (\t-\r is 9 to 13, \u2000-\u200a the 11 en/em spaces) because D1 refuses LIKE/GLOB
// patterns over 50 bytes ("LIKE or GLOB pattern too complex"): the bound `*[\u2026]*` is 38 (tests/demo-hot.test.mjs).
const SPACES = "\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
// Part A §1 in SQL, as strict as ensureDemo's qualify() (so a lead given here is one ensureDemo makes, and the safety
// net never sticks on one it would refuse): not excluded, research done, not too big, graded A+/A/B, an address with
// one "@", something either side of it and no whitespace (EMAIL_RE), and neither it nor its domain on the do-not-contact
// list (email and domain only, read as ensureDemo's one select reads them). Then: no prospect yet, or a `ready` one
// whose lead has no live demo (never one already emailed). Best grade first, then score, as stage 3 sorts.
// ?1 = now (util.now() text), ?2 = the limit, ?3 = the GLOB for an address with whitespace in it.
const MISSING_SQL = `SELECT l.place_id FROM leads l
  JOIN research r ON r.place_id = l.place_id
  LEFT JOIN prospects p ON p.place_id = l.place_id
  WHERE l.excluded = 0 AND r.status = 'done' AND r.too_big = 0 AND r.grade IN (${DEMO_GRADES.map((g) => `'${g}'`).join(", ")})
    AND instr(${ADDRESS_SQL}, '@') > 1
    AND instr(substr(${ADDRESS_SQL}, instr(${ADDRESS_SQL}, '@') + 1), '@') = 0
    AND length(${ADDRESS_SQL}) > instr(${ADDRESS_SQL}, '@')
    AND ${ADDRESS_SQL} NOT GLOB ?3
    AND NOT EXISTS (SELECT 1 FROM suppression s
      WHERE s.kind IN ('email', 'domain') AND s.value IN (${ADDRESS_SQL}, ${DOMAIN_SQL}))
    AND (p.place_id IS NULL
      OR (p.stage = 'ready' AND NOT EXISTS (SELECT 1 FROM demos d WHERE d.place_id = l.place_id AND d.expires_at > ?1)))
  ORDER BY CASE r.grade WHEN 'A+' THEN 0 WHEN 'A' THEN 1 ELSE 2 END, l.quality_score DESC, l.place_id
  LIMIT ?2`;

/**
 * The safety net's list (Part A "Trigger"): place_ids of leads that qualify for a demo (Part A §1) but have no live
 * demo or no prospect, and whose prospect (if any) is still `ready`: leads graded before this stage shipped, a failed
 * ensureDemo in stage 2's route, and expired demos of leads not yet emailed. At most `limit` (3), best grade first.
 * 1 D1 statement (none for a limit of 0).
 */
export async function missingDemos(DB, now, limit = 3) {
  const at = iso(msOf(now, "missingDemos"));
  const n = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 3;
  if (n === 0) return [];
  const { results } = await DB.prepare(MISSING_SQL).bind(at, n, `*[${SPACES}]*`).all();
  return results.map((row) => row.place_id);
}
