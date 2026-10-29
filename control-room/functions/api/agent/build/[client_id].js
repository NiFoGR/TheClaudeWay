// GET /api/agent/build/<client_id> (agent token) → everything the build Routine may use to write a client's site
// (stage 10, docs/rebuild/09-build.md Part A §6): {client, onboarding (with the client's own form answers), lead,
// research, reviews (their Google reviews, word for word), brand (logo, colour, photos from their old site), files
// (photos already copied for this client), facts (what the form proves, formFacts), site (slug, status, content,
// change_notes), limits (every number validateContent uses)}. 404 for an unknown client; 409 while the onboarding form
// hasn't been sent (the 7-day clock hasn't started, so there's nothing to build yet). Read-only, except that the
// client_sites row is made if it's somehow missing (ensureSite), so the content POST always has a row to store into.
// Everything here is data for Claude, not instructions. Tested in tests/sites-agent-build.test.mjs.
//
// D1: 1 (auth) + 1 (client and onboarding) + 1 batch of 3 (lead, research, files) + 1 (the site).
import { requireAgent } from "../../../_lib/agentAuth.js";
import { formFacts, LIMITS } from "../../../_lib/sites/content.js";
import { ensureSite } from "../../../_lib/sites/db.js";
import { db, json, parseJson } from "../../../_lib/util.js";

export const NO_CLIENT = "No client with that id.";
export const NOT_SENT = "The onboarding form hasn't been sent yet.";

// The client, their onboarding row and where their lead is (the site's place_id, else the client's).
const CLIENT_SQL = `SELECT c.id, c.name, c.package, COALESCE(cs.place_id, c.place_id) AS place_id,
    o.status AS onboarding_status, o.submitted_at, o.due_live_at, o.form
  FROM clients c
  LEFT JOIN onboarding o ON o.client_id = c.id
  LEFT JOIN client_sites cs ON cs.client_id = c.id
  WHERE c.id = ?`;
const LEAD_SQL = `SELECT place_id, name, trade, town, search_town, address, postcode, phone, website, maps_url, rating,
    review_count, socials, audit
  FROM leads WHERE place_id = ?`;
const RESEARCH_SQL = "SELECT copy, owner, site_review, angle FROM research WHERE place_id = ?";
const FILES_SQL = "SELECT id, kind, alt FROM site_files WHERE client_id = ? ORDER BY created_at DESC, id";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const objectOf = (value) => {
  const v = parseJson(value, null);
  return isObj(v) ? v : null;
};
const textOr = (v) => (typeof v === "string" && v.trim() ? v : null);

/** The client and onboarding row, or the Response to send (404, 409). Shared with the content POST. */
export async function loadBuildClient(DB, client_id) {
  const id = typeof client_id === "string" ? client_id : "";
  const row = id ? await DB.prepare(CLIENT_SQL).bind(id).first() : null;
  if (!row) return { denied: json({ error: NO_CLIENT }, 404) };
  if (!row.submitted_at) return { denied: json({ error: NOT_SENT }, 409) };
  return { row, form: objectOf(row.form) ?? {} };
}

/** The lead's Google reviews as {author, rating, text}: what the site may quote (validateContent's ctx.reviews). */
export function reviewsOf(audit) {
  const list = Array.isArray(audit?.reviews) ? audit.reviews : [];
  return list
    .filter((r) => isObj(r) && typeof r.text === "string" && r.text.trim())
    .map((r) => ({ author: typeof r.author === "string" ? r.author : "", rating: typeof r.rating === "number" ? r.rating : null, text: r.text }));
}

/** The lead's brand from its audit: {logo, colour, photos} (only text URLs; nulls and [] when missing). */
export function brandOf(audit) {
  const b = isObj(audit?.brand) ? audit.brand : {};
  return {
    logo: textOr(b.logo),
    colour: textOr(b.colour),
    photos: (Array.isArray(b.photos) ? b.photos : []).filter((u) => typeof u === "string" && u.trim()),
  };
}

/** Everything validateContent checks a post against: {form, reviews, brand, files, package}. */
export async function buildContext(DB, client_id, place_id) {
  const [lead, research, files] = await DB.batch([
    DB.prepare(LEAD_SQL).bind(place_id ?? ""),
    DB.prepare(RESEARCH_SQL).bind(place_id ?? ""),
    DB.prepare(FILES_SQL).bind(client_id),
  ]);
  const leadRow = lead.results?.[0] ?? null;
  const audit = objectOf(leadRow?.audit) ?? {};
  return {
    lead: leadRow,
    research: research.results?.[0] ?? null,
    reviews: reviewsOf(audit),
    brand: brandOf(audit),
    files: (files.results ?? []).map((f) => ({ id: f.id, kind: f.kind, url: `/s/f/${f.id}`, alt: f.alt ?? "" })),
  };
}

function leadOut(l) {
  if (!l) return null;
  return {
    place_id: l.place_id, name: l.name, trade: l.trade, town: l.town || l.search_town || null, address: l.address ?? null,
    postcode: l.postcode ?? null, phone: l.phone ?? null, website: l.website ?? null, maps_url: l.maps_url ?? null,
    rating: l.rating ?? null, review_count: l.review_count ?? null, socials: objectOf(l.socials),
  };
}

function researchOut(r) {
  return {
    copy: objectOf(r?.copy),
    owner: objectOf(r?.owner),
    site_review: objectOf(r?.site_review),
    angle: Array.isArray(parseJson(r?.angle, null)) ? parseJson(r.angle, null) : null,
  };
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, params, now }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;

  const loaded = await loadBuildClient(DB, params?.client_id);
  if (loaded.denied) return loaded.denied;
  const { row, form } = loaded;
  const ctx = await buildContext(DB, row.id, row.place_id);
  const site = await ensureSite(DB, row.id, { name: row.name, place_id: row.place_id ?? null }, now ?? new Date());

  return json({
    client: { id: row.id, name: row.name, package: row.package },
    onboarding: { status: row.onboarding_status, submitted_at: row.submitted_at, due_live_at: row.due_live_at, form },
    lead: leadOut(ctx.lead),
    research: researchOut(ctx.research),
    reviews: ctx.reviews,
    brand: ctx.brand,
    files: ctx.files,
    facts: formFacts(form),
    site: { slug: site.slug, status: site.status, content: site.content, change_notes: site.change_notes ?? null },
    limits: LIMITS,
  });
}
