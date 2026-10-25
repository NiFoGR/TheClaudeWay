// GET /api/voice → the Voice page (stage 5–6, docs/rebuild/06-email-followups.md Part A §A7, Task 12):
//   {templates: [{step, day_offset, body, status, approved_at, issues, preview}],
//    examples: [{id, kind, situation, body, source, created_at}], has_price_reply}
// The 9 follow-up emails (seeded as drafts by ensureTemplates on the way), each with checkFollowup's issues and a
// preview: the text as it would go to the newest prospect with a live demo (their greeting "Hi <First>," title-cased as
// Send stores it, cleaned business name and demo link), else Part A's sample "Hi Mark," / "Green Leaf Landscapes" /
// https://aetoswebsites.com/d/green-leaf-landscapes.
// The preview is the body only: the cold footer goes after it when a follow-up is queued, as on the first email.
// Then Nik's own examples and rules (source nik_written, newest first) followed by the first emails he sent (nik_sent,
// newest first), which the reply Routine reads (stage 7), and has_price_reply: whether he has written his own reply for
// "they ask the price" (decision D-3), which hides the Voice page's "How much is it?" card.
// Stage 7 adds its seedVoice(DB, now) call after ensureTemplates and widens only hasPriceReply's match (situation or
// body /price|how much|cost/i); it keeps the source and kind filters, so a sent first email ("costing you jobs") never
// counts. Nothing else changes.
//
// The other Voice routes share what's here: the step in a route (stepOf), a template as the page shows it
// (templateView, with the preview lead from previewRead + previewFrom), and the text limit (tooLong).
// ./followups/[step]/index.js saves a template (PUT), ./followups/[step]/approve.js approves one,
// ./examples/index.js adds an example or rule, ./examples/[id].js deletes one. Behind the login (_middleware.js).
// D1: the schema check on an isolate's first request, then 4 statements: ensureTemplates (1) and one batch of 3 reads
// (the templates, the examples, the preview lead). Tested in control-room/tests/voice.test.mjs.
import { demoLink } from "../../_lib/demo-db.js";
import { checkFollowup, ensureTemplates, FOLLOWUP_DAYS, renderFollowup } from "../../_lib/followups.js";
import { businessName, greetingFor } from "../../_lib/mail/rules.js";
import { db, iso, json } from "../../_lib/util.js";

/** Part A §A7's preview, for when no prospect has a live demo. */
export const SAMPLE = Object.freeze({
  greeting: "Hi Mark,",
  business: "Green Leaf Landscapes",
  demoUrl: demoLink("green-leaf-landscapes"),
});

/** The situation of Nik's own price answer (decision D-3), as the Voice page's "Write it" button fills it in. */
export const PRICE_SITUATION = "they ask the price";

/** A step in a route that isn't one of the 9. */
export const NO_STEP = `That follow-up doesn't exist: they're numbered 1 to ${FOLLOWUP_DAYS.length}.`;
/** The most text a follow-up or an example may have, in characters. */
export const TEXT_MAX = 2000;

const SLUG = /^[a-z0-9-]{3,60}$/;
// The newest prospects a preview may use: the first whose business name cleans to something is the one.
const PREVIEW_CANDIDATES = 5;
// How many examples the page gets: Nik's own always come first, so only the oldest sent first emails drop off. The
// reply Routine reads only the newest few sent ones anyway.
const EXAMPLES_MAX = 500;

/** "2,001" (Workers' Intl isn't needed for a thousands comma). */
const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Characters as people count them: an emoji is one. */
export const chars = (text) => [...text].length;

/** "Too long: 2,001 characters. Keep it to 2,000." for text over TEXT_MAX characters, else "". */
export function tooLong(text) {
  const n = chars(text);
  return n > TEXT_MAX ? `Too long: ${withCommas(n)} characters. Keep it to ${withCommas(TEXT_MAX)}.` : "";
}

/** Line endings as a browser's textarea may send them (\r\n) stored as \n. */
export const lf = (text) => text.replace(/\r\n?/g, "\n");

/** The follow-up step in a route's params, 1 to 9 written plainly ("4", not "04" or "4.0"), else null. */
export function stepOf(params) {
  const raw = params?.step;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const step = Number(raw);
  return step <= FOLLOWUP_DAYS.length ? step : null;
}

// The newest prospects whose lead's current demo is still up (latestDemo's rule in demo-db.js, inlined: a lead can
// have several demos rows, so never a plain join on place_id; an ended latest demo means none, even if an older row
// is still up). ?1 = now as stored text.
const PREVIEW_SQL = `SELECT p.greet_name, l.name, d.slug
  FROM prospects p
  JOIN leads l ON l.place_id = p.place_id
  JOIN demos d ON d.slug = (SELECT d2.slug FROM demos d2 WHERE d2.place_id = p.place_id
    ORDER BY d2.created_at DESC, d2.slug DESC LIMIT 1)
  WHERE d.expires_at > ?1
  ORDER BY p.created_at DESC, p.place_id DESC
  LIMIT ${PREVIEW_CANDIDATES}`;

/** The read for the preview lead (one statement, for a batch); previewFrom turns its rows into renderFollowup's values. */
export const previewRead = (DB, now) => DB.prepare(PREVIEW_SQL).bind(iso(now));

/**
 * renderFollowup's {greeting, business, demoUrl} for the first row whose values it would take: "Hi <First>," with the
 * first name title-cased as Send stores it (greetingFor: a `ready` prospect's greet_name is research's raw owner.first,
 * e.g. Companies House's "MARK", and the follow-up says "Hi Mark,"; a name Send stored comes out the same), or "Hi,"
 * without a confident first name, as the follow-up itself says; the cleaned business name and the demo link; else
 * SAMPLE.
 */
export function previewFrom(rows) {
  for (const row of rows ?? []) {
    if (typeof row?.slug !== "string" || !SLUG.test(row.slug)) continue;
    // greet_name is only ever a confident first name (NULL for "Hi,"): stage 4 and Send both store it that way
    const greeting = greetingFor({ first: row.greet_name, confident: true }).line;
    const values = { greeting, business: businessName(row.name), demoUrl: demoLink(row.slug) };
    try {
      renderFollowup("{greeting}{business}{demo_link}", values); // a name that cleans to nothing is refused here
      return values;
    } catch {
      // the next one
    }
  }
  return SAMPLE;
}

/** A followup_templates row as the Voice page shows it: its checks, and its text filled in with `values` (previewFrom). */
export function templateView(row, values) {
  const body = typeof row.body === "string" ? row.body : String(row.body ?? "");
  let preview = null;
  try {
    preview = renderFollowup(body, values);
  } catch {
    preview = null; // renderFollowup only refuses a missing value, and previewFrom never gives one
  }
  return {
    step: Number(row.step),
    day_offset: Number(row.day_offset),
    body,
    status: row.status === "approved" ? "approved" : "draft",
    approved_at: row.approved_at ?? null,
    issues: checkFollowup(body),
    preview,
  };
}

/** A style_examples row as the page shows it. */
export const exampleView = (row) => ({
  id: row.id, kind: row.kind, situation: row.situation, body: row.body, source: row.source, created_at: row.created_at,
});

/** "  They ask  the PRICE " → "they ask the price". */
const situationKey = (situation) => String(situation ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Whether Nik has written his own price answer (decision D-3): an example reply he wrote on the Voice page (source
 * nik_written; a rule isn't one, nor is a first email he sent, nik_sent) for "they ask the price", in any case or
 * spacing. Until then the page shows the "How much is it?" card and Claude answers from the price list.
 */
export const hasPriceReply = (examples) =>
  examples.some((e) => e.source === "nik_written" && e.kind === "example" && situationKey(e.situation) === PRICE_SITUATION);

const TEMPLATES_SQL = `SELECT step, day_offset, body, status, approved_at FROM followup_templates
  WHERE step BETWEEN 1 AND ${FOLLOWUP_DAYS.length} ORDER BY step`;
const EXAMPLES_SQL = `SELECT id, kind, situation, body, source, created_at FROM style_examples
  ORDER BY source = 'nik_sent', created_at DESC, id DESC LIMIT ${EXAMPLES_MAX}`;

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  await ensureTemplates(DB);
  const [templates, examples, lead] = await DB.batch([
    DB.prepare(TEMPLATES_SQL),
    DB.prepare(EXAMPLES_SQL),
    previewRead(DB, at),
  ]);
  const values = previewFrom(lead.results);
  const list = (examples.results ?? []).map(exampleView);
  return json({
    templates: (templates.results ?? []).map((row) => templateView(row, values)),
    examples: list,
    has_price_reply: hasPriceReply(list),
  });
}
