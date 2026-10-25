// GET /api/demo → the Demo page (stage 4, docs/rebuild/05-demo.md Part A §7 and "What Nik sees"):
//   {templates: [{id, label, version, approved, approved_at, approved_version, waiting, previews: [{place_id, name,
//    town, photos, problems}]}], demos: [{place_id, name, grade, stage, slug, url, views, last_view_at, expires_at}]}
// One card per look (Landscaper, then Everything else) with Nik's OK as the setting holds it (approved only for the
// current version; approved_version/approved_at are what was approved, so a redesign can say "This look changed since
// you approved version <n>."), the ready leads whose first email waits for it (0 once approved), and 3 previews drawn
// for real graded leads (pickPreviews), each with checkDemoHtml's problems. Then the demo sites table: each lead's
// latest demo, last viewed first, then newest, max 200. Behind the login (_middleware.js: /api/demo/* isn't public).
//
// The other demo routes share what's here: how a lead's preview is drawn (previewOf, also framed by ./preview.js),
// which leads a look can be previewed with (lookTrades, also ./approve.js's check) and the columns that drawing needs
// (PREVIEW_COLUMNS, also ./check.js). ./lead/[id].js is the lead drawer's Demo site card.
// D1: the schema check on an isolate's first request, then at most 6 statements: the trades (1), each look's approval
// (2), each look's preview candidates (at most 2: none for a look with no graded lead) and the demos table (1).
// Tested in control-room/tests/demo-api.test.mjs.
import { checkDemoHtml } from "../../_lib/demo/check.js";
import { TRADE_DEFAULT } from "../../_lib/demo/colour.js";
import { buildDemoData, templateIdFor } from "../../_lib/demo/data.js";
import { renderSite, TEMPLATES } from "../../_lib/demo/render.js";
import { cleanText, shortName } from "../../_lib/demo/text.js";
import { demoLink, templateApproval } from "../../_lib/demo-db.js";
import { offerFor } from "../../_lib/offer.js";
import { db, json, parseJson } from "../../_lib/util.js";

/** The looks in the Demo page's order: each look's own trades first, "Everything else" (generic) last. */
export const LOOK_IDS = Object.freeze(Object.keys(TEMPLATES).sort((a, b) => (a === "generic") - (b === "generic")));
/** A look id that isn't one (as demo-db.js words it for approveTemplate). */
export const NO_LOOK = `That look doesn't exist. The looks are: ${Object.keys(TEMPLATES).join(", ")}.`;
/** Whether `id` is a look: TEMPLATES' own keys only, so "constructor" or "__proto__" never is. */
export const isLook = (id) => typeof id === "string" && Object.hasOwn(TEMPLATES, id);

const PREVIEW_GRADES = ["A+", "A", "B"];
const GRADE_RANK = Object.freeze({ "A+": 0, A: 1, B: 2 });
const PREVIEWS = 3;
// The newest graded leads per look that pickPreviews chooses from. Each costs a buildDemoData (about 0.05 ms), and the
// free plan allows 10 ms of CPU per request, shared with the 6 previews drawn and checked (about 0.5 to 1 ms each).
const CANDIDATES_MAX = 24;
// Also the newest this many with 2+ https photos and the newest this many without, however old, so a look is never
// previewed without its photo layout (or its photo-free one) just because the newest leads all lack (or all have)
// photos. Counted in SQL from the raw list, so the exact count (logo and repeats removed) is still buildDemoData's.
// At most CANDIDATES_MAX + 2 × KIND_CANDIDATES = 30 candidates per look.
const KIND_CANDIDATES = 3;
const DEMOS_MAX = 200;
const SLUG = /^[a-z0-9-]{3,60}$/;

// A lead a look can be previewed with: researched, graded A+, A or B (too big caps a grade at D anyway), not excluded.
// Aliases l (leads) and r (research).
const GRADED_SQL = "r.status = 'done' AND r.grade IN ('A+', 'A', 'B') AND r.too_big = 0 AND l.excluded = 0";

/**
 * What a lead's demo page is drawn from, and no more (aliases l and r; r may be a LEFT JOIN): the lead columns
 * buildDemoData reads, the audit's brand and reviews only (not its map rank or findings; a broken audit reads as none
 * instead of failing the query), the research grade, time and copy, and the slug of the lead's latest demo (newest
 * created_at, then slug: demo-db.js's latestDemo is the one rule, inlined here). demoSources turns a row into
 * buildDemoData's input.
 * Reviews only when they are a list: json_extract gives a JSON string's own text, which parseJson could read as a list
 * that buildDemoData, given the whole audit, would ignore (nested CASE: SQLite then never reads a broken audit).
 */
export const PREVIEW_COLUMNS = `l.place_id, l.name, l.trade, l.town, l.search_town, l.phone, l.rating, l.review_count,
    CASE WHEN json_valid(l.audit) THEN json_extract(l.audit, '$.brand') END AS audit_brand,
    CASE WHEN json_valid(l.audit) THEN CASE WHEN json_type(l.audit, '$.reviews') = 'array'
      THEN json_extract(l.audit, '$.reviews') END END AS audit_reviews,
    r.grade, r.researched_at, r.copy,
    (SELECT d.slug FROM demos d WHERE d.place_id = l.place_id ORDER BY d.created_at DESC, d.slug DESC LIMIT 1) AS demo_slug`;

// Every trade among the leads with its ready prospects and the leads a look can be previewed with. The look of a trade
// is decided in JS (templateIdFor), so SQL never holds a second copy of that rule.
const TRADES_SQL = `SELECT COALESCE(l.trade, '') AS trade,
    SUM(CASE WHEN p.stage = 'ready' THEN 1 ELSE 0 END) AS ready,
    SUM(CASE WHEN ${GRADED_SQL} THEN 1 ELSE 0 END) AS graded
  FROM leads l
  LEFT JOIN prospects p ON p.place_id = l.place_id
  LEFT JOIN research r ON r.place_id = l.place_id
  GROUP BY COALESCE(l.trade, '')`;

// The https photos in a lead's raw audit.brand.photos list (0 when there's no list).
const PHOTOS_SQL = `COALESCE(CASE WHEN json_valid(l.audit) THEN CASE WHEN json_type(l.audit, '$.brand.photos') = 'array'
    THEN (SELECT COUNT(*) FROM json_each(l.audit, '$.brand.photos') ph WHERE ph.type = 'text' AND ph.value LIKE 'https://%')
    END END, 0)`;
const NEWEST = "r.researched_at DESC, l.place_id";
// A look's preview candidates: graded leads of its trades (?1 = JSON list), newest research first: the newest
// CANDIDATES_MAX, plus the newest KIND_CANDIDATES with 2+ photos and without. One statement.
const CANDIDATES_SQL = `SELECT * FROM (
  SELECT ${PREVIEW_COLUMNS},
    ROW_NUMBER() OVER (ORDER BY ${NEWEST}) AS nth,
    ROW_NUMBER() OVER (PARTITION BY ${PHOTOS_SQL} >= 2 ORDER BY ${NEWEST}) AS nth_of_kind
  FROM research r
  JOIN leads l ON l.place_id = r.place_id
  WHERE ${GRADED_SQL} AND COALESCE(l.trade, '') IN (SELECT value FROM json_each(?1)))
  WHERE nth <= ${CANDIDATES_MAX} OR nth_of_kind <= ${KIND_CANDIDATES}
  ORDER BY nth`;

// The demo sites table: each lead's latest demo (latestDemo's rule, inlined: a lead can have several rows, so never a
// plain join on place_id) with its grade and prospect, last viewed first, then newest.
const DEMOS_SQL = `SELECT d.place_id, l.name, r.grade, p.stage, d.slug, COALESCE(p.views, 0) AS views, p.last_view_at,
    d.expires_at
  FROM demos d
  JOIN leads l ON l.place_id = d.place_id
  LEFT JOIN research r ON r.place_id = d.place_id
  LEFT JOIN prospects p ON p.place_id = d.place_id
  WHERE d.slug = (SELECT d2.slug FROM demos d2 WHERE d2.place_id = d.place_id ORDER BY d2.created_at DESC, d2.slug DESC LIMIT 1)
  ORDER BY p.last_view_at IS NULL, p.last_view_at DESC, d.created_at DESC, d.slug DESC
  LIMIT ${DEMOS_MAX}`;

/**
 * Per look id: {trades: the leads' trades that get it, ready: its ready prospects, graded: its leads a preview can be
 * drawn for}. 1 statement.
 */
export async function lookTrades(DB) {
  const { results } = await DB.prepare(TRADES_SQL).all();
  const looks = Object.fromEntries(LOOK_IDS.map((id) => [id, { trades: [], ready: 0, graded: 0 }]));
  for (const row of results ?? []) {
    const trade = String(row.trade ?? "");
    const look = looks[templateIdFor(trade)] ?? looks.generic;
    look.trades.push(trade);
    look.ready += Number(row.ready) || 0;
    look.graded += Number(row.graded) || 0;
  }
  return looks;
}

/** A PREVIEW_COLUMNS row as buildDemoData's {lead, research} (the audit only as far as the page reads it). */
export function demoSources(row) {
  const lead = {
    place_id: row.place_id, name: row.name, trade: row.trade, town: row.town, search_town: row.search_town,
    phone: row.phone, rating: row.rating, review_count: row.review_count,
    audit: { brand: parseJson(row.audit_brand, null), reviews: parseJson(row.audit_reviews, []) },
  };
  return { lead, research: { copy: row.copy } };
}

/** The business name as a page shows it (for a row whose page couldn't be drawn). */
export const shownName = (name) => shortName(cleanText(typeof name === "string" ? name : ""));

/**
 * A lead's demo page as the Control Room previews it, from a PREVIEW_COLUMNS row: demo mode in look `templateId`
 * (validated by the caller), with the preview bar and their latest demo's Order button, but no view beacon
 * (count_views false), so opening a preview never counts as a view. In a look that isn't their own, a lead with no
 * colour of their own gets that look's default colour (their own colour is the same in every look). → {data, html}.
 * `now` sets the offer line and the © year.
 */
export function previewOf(row, templateId, now) {
  const { lead, research } = demoSources(row);
  const slug = typeof row.demo_slug === "string" && SLUG.test(row.demo_slug) ? row.demo_slug : "";
  let data = buildDemoData({ lead, research, demo: slug ? { slug, count_views: false } : null, offer: offerFor(now), now });
  if (data.template !== templateId) {
    const own = data.brand.colour_source !== "trade" || !Object.hasOwn(TRADE_DEFAULT, templateId);
    data = { ...data, template: templateId, brand: own ? data.brand : { ...data.brand, colour: TRADE_DEFAULT[templateId] } };
  }
  return { data, html: renderSite(data, { now }) };
}

// How much of their own content a page has: services, reviews, photos and a logo.
const contentOf = (r) => count(r.services) + count(r.reviews) + count(r.photos) + (r.logo ? 1 : 0);
function count(v) {
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// Newest research first; rows without a time last.
const byNewest = (a, b) => {
  const x = typeof a.researched_at === "string" ? a.researched_at : "";
  const y = typeof b.researched_at === "string" ? b.researched_at : "";
  return x === y ? 0 : x < y ? 1 : -1;
};

/**
 * The (at most) 3 leads a look is previewed with (pure; Part A §7): from rows {place_id, grade, researched_at, photos,
 * services, reviews, logo} (counts; logo truthy when they have one) of leads graded A+, A or B, taken newest research
 * first: the first with 2+ photos, the first with none, and the one with the least of {services, reviews, photos,
 * logo} (ties: the newest), then filled to 3 by best grade (newest first within a grade). No lead twice (one place_id
 * is one lead: its newest row). Returns the given row objects, in that order; rows of other grades are never picked.
 */
export function pickPreviews(rows) {
  const seen = new Set();
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === "object" && typeof r.place_id === "string" && r.place_id && PREVIEW_GRADES.includes(r.grade))
    .sort(byNewest) // stable: equal times keep their order
    .filter((r) => !seen.has(r.place_id) && seen.add(r.place_id));

  const picked = [];
  const take = (r) => {
    if (r && picked.length < PREVIEWS && !picked.includes(r)) picked.push(r);
  };
  take(list.find((r) => count(r.photos) >= 2));
  take(list.find((r) => count(r.photos) === 0));
  take(list.reduce((least, r) => (least === undefined || contentOf(r) < contentOf(least) ? r : least), undefined));
  for (const r of [...list].sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade])) take(r);
  return picked;
}

const message = (err) => String(err?.message ?? err).split("\n")[0].slice(0, 300);

/** A look's previews: pickPreviews over its candidates (CANDIDATES_SQL), each drawn as the preview frame shows
 * it and checked. A preview that can't be drawn says why in its problems. */
async function previewsFor(DB, id, trades, now) {
  const { results } = await DB.prepare(CANDIDATES_SQL).bind(JSON.stringify(trades)).all();
  const rows = (results ?? []).map((row) => {
    const { lead, research } = demoSources(row);
    const data = buildDemoData({ lead, research, offer: offerFor(now), now });
    return {
      place_id: row.place_id, grade: row.grade, researched_at: row.researched_at, row,
      photos: data.brand.photos.length, services: data.business.services.length, reviews: data.reviews.length,
      logo: Boolean(data.brand.logo),
    };
  });
  return pickPreviews(rows).map(({ row, photos }) => {
    try {
      const { data, html } = previewOf(row, id, now);
      return {
        place_id: row.place_id, name: data.business.name, town: data.business.town, photos: data.brand.photos.length,
        problems: checkDemoHtml(html, data, { now }),
      };
    } catch (err) {
      const town = cleanText(typeof row.town === "string" && row.town ? row.town : row.search_town);
      return { place_id: row.place_id, name: shownName(row.name), town, photos, problems: [`Couldn't draw this preview: ${message(err)}`] };
    }
  });
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  const looks = await lookTrades(DB);
  const templates = await Promise.all(LOOK_IDS.map(async (id) => {
    const { TEMPLATE } = TEMPLATES[id];
    const approval = await templateApproval(DB, id);
    const look = looks[id];
    return {
      id,
      label: TEMPLATE.label,
      version: TEMPLATE.version,
      approved: approval.approved,
      approved_at: approval.at,
      approved_version: approval.version,
      waiting: approval.approved ? 0 : look.ready,
      previews: look.graded ? await previewsFor(DB, id, look.trades, at) : [],
    };
  }));
  const { results } = await DB.prepare(DEMOS_SQL).all();
  const demos = (results ?? []).map((r) => ({
    place_id: r.place_id,
    name: r.name,
    grade: r.grade ?? null,
    stage: r.stage ?? null,
    slug: r.slug,
    url: demoLink(r.slug),
    views: Number(r.views) || 0,
    last_view_at: r.last_view_at ?? null,
    expires_at: r.expires_at,
  }));
  return json({ templates, demos });
}
