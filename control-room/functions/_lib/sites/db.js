// The client site store (stage 10, docs/rebuild/09-build.md Task 7): one `client_sites` row per client.
//
// ensureSite makes the row when the client first opens their onboarding form (unguessable slug for the /c/ preview
// and the /w/ temporary link); getSite, siteByHost (the host or its www twin) and siteBySlug read it with the JSON
// columns parsed and the client's name, package and 7-day clock alongside; saveContent stores content Claude posted
// (already checked by validateContent) and puts the site in review, or keeps a live one live (section 6);
// setSiteStatus moves it between draft | review | live | off; setHost claims a host once across all clients (host is
// UNIQUE, and its www twin counts as the same site); updateDomain merges a change into the domain plan; markSeen and
// markLive stamp the first visit on the canonical host and the go-live once each; listSites feeds the Sites list;
// setSiteFeature switches the chatbot or review booster off for one site (stage 11 calls it on cancellation).
// Tested in control-room/tests/sites-db.test.mjs.
//
// D1 budget: every function is 1 statement, except ensureSite (1 read when the row exists; else the read, the insert,
// a slug-clash retry at most, and the read back), saveContent and markLive (one batch of 2), and setHost (the clash
// read, then the update).
import { slugFor } from "../demo/text.js";
import { iso, parseJson } from "../util.js";
import { TEST_SITE_HOST, canonicalHost, isOurHost, normaliseHost, underOurDomain, wwwTwin } from "./hosts.js";

/**
 * SQL that is true for every client but Setup's test client (api/sites/test-client.js makes it: notes 'TEST' and an id
 * starting "cl_test_", which only that route makes; substr, not LIKE, so "_" isn't a wildcard). `a` is the clients
 * table's alias. The Todo board and Money skip it; the Sites page keeps showing it.
 */
export const NOT_TEST_CLIENT = (a) => `NOT (COALESCE(${a}.notes, '') = 'TEST' AND substr(${a}.id, 1, 8) = 'cl_test_')`;

/** client_sites.status words (section 3). */
export const SITE_STATUSES = ["draft", "review", "live", "off"];
/** Per-site switches in client_sites.features: a missing key means on. */
export const SITE_FEATURES = ["chatbot", "review_booster"];

const DAY_MS = 86_400_000;
const BAD_HOST = "That doesn't look like a web address. Type it like smithroofing.co.uk.";
const NO_SITE = "That client has no site yet.";
const OUR_HOST = "That's one of Aetos's own addresses, not the client's. Type their domain, like smithroofing.co.uk.";
const SLUG_RE = /^[a-z0-9-]{3,60}$/;

// Everything a site's readers need in one select: the row, the client's name and package (and whether they've
// cancelled), and the onboarding clock. Its own status/live_at keep their names; onboarding's are aliased.
const SITE_SELECT = `SELECT cs.*, c.name AS name, c.package AS package, c.cancelled_on AS cancelled_on,
    o.submitted_at AS submitted_at, o.due_live_at AS due_live_at, o.status AS onboarding_status
  FROM client_sites cs
  LEFT JOIN clients c ON c.id = cs.client_id
  LEFT JOIN onboarding o ON o.client_id = cs.client_id`;

// A JSON column that must be an object ({} when empty or broken).
const objectOf = (value) => {
  const v = parseJson(value, {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

/** A client_sites row as callers use it: content, domain, host_check, features and last_errors parsed (is_test stays 0/1). */
function siteRow(row) {
  if (!row) return null;
  const content = parseJson(row.content, null);
  const hostCheck = parseJson(row.host_check, null);
  const lastErrors = parseJson(row.last_errors, null);
  return {
    ...row,
    content: content && typeof content === "object" && !Array.isArray(content) ? content : null,
    domain: objectOf(row.domain),
    host_check: hostCheck && typeof hostCheck === "object" && !Array.isArray(hostCheck) ? hostCheck : null,
    features: objectOf(row.features),
    last_errors: Array.isArray(lastErrors) ? lastErrors : null,
  };
}

// Slug tails from crypto, not Math.random: the slug is the only key to the /c/ preview and the /w/ temporary link.
const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

const isUniqueSlug = (err) => /UNIQUE constraint failed: client_sites\.slug/.test(String(err?.message));

/**
 * The client's site row, made on first call (status draft, no content). A second call returns the same row (same
 * slug). `is_test` marks Setup's test client; `rand` is for tests. A random slug that's already taken is retried once.
 */
export async function ensureSite(DB, client_id, { name, place_id = null, is_test = false, rand = cryptoRand } = {}, now = new Date()) {
  const existing = await getSite(DB, client_id);
  if (existing) return existing;
  const at = iso(now);
  const insert = (slug) =>
    DB.prepare(
      `INSERT INTO client_sites (client_id, slug, place_id, is_test, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (client_id) DO NOTHING`,
    )
      .bind(client_id, slug, place_id ?? null, is_test ? 1 : 0, at, at)
      .run();
  try {
    await insert(slugFor(name, rand));
  } catch (err) {
    if (!isUniqueSlug(err)) throw err;
    await insert(slugFor(name, rand)); // a second clash in a row throws D1's own error
  }
  return getSite(DB, client_id);
}

/** The site for a client, or null. */
export async function getSite(DB, client_id) {
  return siteRow(await DB.prepare(`${SITE_SELECT} WHERE cs.client_id = ?`).bind(client_id).first());
}

/** The site served on a Host header: stored as that host or its www twin (any case, port, trailing dot). */
export async function siteByHost(DB, host) {
  const h = normaliseHost(host);
  if (!h) return null;
  const row = await DB.prepare(`${SITE_SELECT} WHERE cs.host IN (?, ?) ORDER BY cs.host = ? DESC LIMIT 1`)
    .bind(h, wwwTwin(h), h)
    .first();
  return siteRow(row);
}

/** The site for a preview (/c/<slug>/) or temporary (/w/<slug>/) link, or null. */
export async function siteBySlug(DB, slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  return siteRow(await DB.prepare(`${SITE_SELECT} WHERE cs.slug = ?`).bind(slug).first());
}

/**
 * Stores content Claude posted (already through validateContent): content_at, change_notes and last_errors cleared.
 * A live site stays live and serves the new content at once (section 6); any other site (draft, review, or one Nik
 * took offline: "site not live → status = review") goes to review, and its onboarding row to review unless that is
 * already live, so the Approve todo Task 14 files always has a working Approve button. Returns {status} (the site's
 * status now), or null when the client has no site.
 */
export async function saveContent(DB, client_id, content, now = new Date()) {
  const at = iso(now);
  const [site] = await DB.batch([
    DB.prepare(
      `UPDATE client_sites SET content = ?, content_at = ?, change_notes = NULL, last_errors = NULL,
         status = CASE WHEN status = 'live' THEN 'live' ELSE 'review' END, updated_at = ?
       WHERE client_id = ? RETURNING status`,
    ).bind(JSON.stringify(content), at, at, client_id),
    DB.prepare(
      `UPDATE onboarding SET status = 'review'
       WHERE client_id = ? AND status <> 'live' AND live_at IS NULL
         AND EXISTS (SELECT 1 FROM client_sites WHERE client_id = ? AND status = 'review')`,
    ).bind(client_id, client_id),
  ]);
  const row = site.results?.[0];
  return row ? { status: row.status } : null;
}

/**
 * Moves a site to draft | review | live | off. `approved` stamps approved_at (Approve and put live); `notes` sets
 * change_notes (Ask Claude for changes; null clears them). True when the client has a site.
 */
export async function setSiteStatus(DB, client_id, status, now = new Date(), { approved = false, notes } = {}) {
  if (!SITE_STATUSES.includes(status)) throw new Error(`Unknown site status: ${status}`);
  const at = iso(now);
  const setNotes = notes !== undefined;
  const r = await DB.prepare(
    `UPDATE client_sites SET status = ?, approved_at = CASE WHEN ? THEN ? ELSE approved_at END,
       change_notes = CASE WHEN ? THEN ? ELSE change_notes END, updated_at = ?
     WHERE client_id = ?`,
  )
    .bind(status, approved ? 1 : 0, at, setNotes ? 1 : 0, setNotes ? (notes ?? null) : null, at, client_id)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Sets the host a site is served on, as given but normalised (the Site page passes canonicalHost's www.<domain>; the
 * test client's host has no www). null or "" clears it. Refused when another client's site uses it or its www twin:
 * "www.x is already used by {name}'s site." Refused too: anything but a bare host, and Aetos's own hosts (OUR_HOSTS,
 * *.pages.dev, aetoswebsites.com and every host under it, such as control.aetoswebsites.com, the Control Room's own),
 * which must never become a client site. The one exception is the test client's site-test.aetoswebsites.com, and only
 * with `{test: true}` (api/sites/test-client.js). A different host forgets the old DNS check and first visit.
 * → {ok: true} | {ok: false, error}
 */
export async function setHost(DB, client_id, host, now = new Date(), { test = false } = {}) {
  const raw = typeof host === "string" ? host.trim() : host;
  let h = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    if (typeof raw !== "string" || /\s/.test(raw)) return { ok: false, error: BAD_HOST };
    h = normaliseHost(raw);
    // A bare host only: canonicalHost forgives "https://" and paths, but those must never be stored as the host.
    const c = h ? canonicalHost(h) : { ok: false };
    if (!c.ok || (h !== c.host && h !== c.domain)) return { ok: false, error: BAD_HOST };
    if (isOurHost(h) || isOurHost(wwwTwin(h))) return { ok: false, error: OUR_HOST };
    if (underOurDomain(h) && !(test && h === TEST_SITE_HOST)) return { ok: false, error: OUR_HOST };
    const taken = await DB.prepare(
      `SELECT c.name AS name FROM client_sites cs LEFT JOIN clients c ON c.id = cs.client_id
       WHERE cs.host IN (?, ?) AND cs.client_id <> ? LIMIT 1`,
    )
      .bind(h, wwwTwin(h), client_id)
      .first();
    if (taken) return { ok: false, error: usedBy(h, taken.name) };
  }
  const at = iso(now);
  try {
    const r = await DB.prepare(
      `UPDATE client_sites SET host = ?,
         host_check = CASE WHEN host IS ? THEN host_check ELSE NULL END,
         seen_at = CASE WHEN host IS ? THEN seen_at ELSE NULL END, updated_at = ?
       WHERE client_id = ?`,
    )
      .bind(h, h, h, at, client_id)
      .run();
    if (!(r.meta?.changes > 0)) return { ok: false, error: NO_SITE };
  } catch (err) {
    // Another client took it between the read and the write.
    if (/UNIQUE constraint failed: client_sites\.host/.test(String(err?.message))) return { ok: false, error: usedBy(h, null) };
    throw err;
  }
  return { ok: true };
}

const usedBy = (host, name) => `${host} is already used by ${name ? `${name}'s` : "another client's"} site.`;

/**
 * Merges `patch` into the site's domain plan (JSON merge patch: nested objects such as `steps` merge, a null value
 * removes its key, arrays are replaced). Returns the new plan, or null when the client has no site.
 */
export async function updateDomain(DB, client_id, patch, now = new Date()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("The domain change must be an object.");
  const row = await DB.prepare(
    `UPDATE client_sites SET domain = json_patch(CASE WHEN json_valid(domain) THEN domain ELSE '{}' END, ?), updated_at = ?
     WHERE client_id = ? RETURNING domain`,
  )
    .bind(JSON.stringify(patch), iso(now), client_id)
    .first();
  return row ? objectOf(row.domain) : null;
}

/** Stamps the first https visit on the canonical host. True only the first time. */
export async function markSeen(DB, client_id, now = new Date()) {
  const r = await DB.prepare("UPDATE client_sites SET seen_at = ?, updated_at = ? WHERE client_id = ? AND seen_at IS NULL")
    .bind(iso(now), iso(now), client_id)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Marks an approved site with a host live: client_sites.live_at, and onboarding live_at, status live and
 * site_url https://{host}/. True only on the call that set live_at (the go-live email is queued on that one).
 */
export async function markLive(DB, client_id, now = new Date()) {
  const at = iso(now);
  const [site] = await DB.batch([
    DB.prepare(
      `UPDATE client_sites SET live_at = ?, updated_at = ?
       WHERE client_id = ? AND live_at IS NULL AND status = 'live' AND host IS NOT NULL`,
    ).bind(at, at, client_id),
    // Runs after the line above in the same transaction: it finishes the onboarding row once the site has live_at.
    DB.prepare(
      `UPDATE onboarding SET live_at = (SELECT live_at FROM client_sites WHERE client_id = ?), status = 'live',
         site_url = 'https://' || (SELECT host FROM client_sites WHERE client_id = ?) || '/'
       WHERE client_id = ? AND live_at IS NULL
         AND EXISTS (SELECT 1 FROM client_sites WHERE client_id = ? AND live_at IS NOT NULL AND host IS NOT NULL)`,
    ).bind(client_id, client_id, client_id, client_id),
  ]);
  return site.meta?.changes === 1;
}

/**
 * The Sites list: one row per site (no content) with the client's name and package, the onboarding clock,
 * `has_content` and `enquiries_30d` (site_leads in the 30 days before `now`). Soonest due first; no due date last.
 */
export async function listSites(DB, now = new Date()) {
  const since = iso(new Date(new Date(now).getTime() - 30 * DAY_MS));
  const { results } = await DB.prepare(
    `SELECT cs.client_id, cs.slug, cs.place_id, cs.host, cs.status, cs.change_notes, cs.host_check, cs.seen_at,
        cs.is_test, cs.features, cs.approved_at, cs.live_at, cs.content_at, cs.created_at, cs.updated_at,
        cs.content IS NOT NULL AS has_content, c.name AS name, c.package AS package, c.cancelled_on AS cancelled_on,
        o.submitted_at AS submitted_at, o.due_live_at AS due_live_at, o.status AS onboarding_status,
        (SELECT COUNT(*) FROM site_leads sl WHERE sl.client_id = cs.client_id AND sl.created_at >= ?) AS enquiries_30d
     FROM client_sites cs
     LEFT JOIN clients c ON c.id = cs.client_id
     LEFT JOIN onboarding o ON o.client_id = cs.client_id
     ORDER BY o.due_live_at IS NULL, o.due_live_at, c.name, cs.client_id`,
  )
    .bind(since)
    .all();
  return (results ?? []).map((r) => {
    const hostCheck = parseJson(r.host_check, null);
    return {
      ...r,
      has_content: Number(r.has_content) === 1,
      features: objectOf(r.features),
      host_check: hostCheck && typeof hostCheck === "object" && !Array.isArray(hostCheck) ? hostCheck : null,
      enquiries_30d: Number(r.enquiries_30d) || 0,
    };
  });
}

/**
 * Switches the chatbot or the review booster on or off for one site. Off stores {feature: false}; on removes the key
 * (missing = on). A client with no site is a no-op. Throws "Unknown site feature: x" for anything else.
 */
export async function setSiteFeature(DB, client_id, feature, on, now = new Date()) {
  if (!SITE_FEATURES.includes(feature)) throw new Error(`Unknown site feature: ${feature}`);
  await DB.prepare(
    `UPDATE client_sites SET features = json_patch(CASE WHEN json_valid(features) THEN features ELSE '{}' END, ?),
       updated_at = ? WHERE client_id = ?`,
  )
    .bind(JSON.stringify({ [feature]: on ? null : false }), iso(now), client_id)
    .run();
}
