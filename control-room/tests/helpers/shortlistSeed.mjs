// Seed helpers for the Shortlist tests (stage 3) and the stages built on it (4, 6, 8): one row each into leads,
// research, prospects, demos, mailboxes, messages and suppression, with every required column filled by a default.
// `o` overrides any column; an object or array value is stored as JSON text; undefined means "use the default".
// Each helper returns the row as inserted (JSON columns as their stored text).
//
// The defaults make a lead that is ready to email once it has a done A research row, a `ready` prospect and a live
// demo (docs/rebuild/04-shortlist.md, the ready rule), from a cold mailbox m1 started 2026-08-01, so its cap is 10
// on 2026-10-21 (the tests' day). Messages are outgoing first emails from m1; a `sent` one gets sent_at that morning,
// so sentToday counts it.

/** The time every default timestamp uses: Wed 21 Oct 2026, 08:00 UK (BST). */
export const SEED_AT = "2026-10-21T07:00:00Z";
/** A demo made before SEED_AT that is still live long after it. */
export const LIVE_UNTIL = "2027-01-01T00:00:00Z";

let serial = 0;
const next = () => ++serial;

// Stored as JSON text: objects and arrays. Everything else as given (D1 refuses undefined, Dates and the like).
const stored = (value) => (value !== null && typeof value === "object" ? JSON.stringify(value) : value);

// Defaults, then every override that isn't undefined, with JSON values as text.
function rowOf(defaults, o = {}) {
  const row = { ...defaults };
  for (const [key, value] of Object.entries(o ?? {})) if (value !== undefined) row[key] = value;
  for (const key of Object.keys(row)) row[key] = stored(row[key]);
  return row;
}

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...Object.values(row))
    .run();
  return row;
}

/** A lead (the scraper's row): a landscaper in Warrington, score 50, rating 4.8, not excluded. */
export function seedLead(DB, o = {}) {
  const place_id = o.place_id ?? `L${next()}`;
  return insert(DB, "leads", rowOf({
    place_id, name: `Lead ${place_id}`, trade: "landscaper", search_town: "Warrington", town: "Warrington",
    phone: null, website: null, rating: 4.8, review_count: 20, email: null, emails: [], socials: {},
    issues: [], audit: {}, company_number: null, excluded: 0, quality_score: 50, notes: "",
    first_seen_at: SEED_AT, updated_at: SEED_AT,
  }, { ...o, place_id }));
}

/** Claude's research for a lead (`o.place_id` required): done, grade A, not too big. */
export function seedResearch(DB, o = {}) {
  if (!o.place_id) throw new Error("seedResearch needs o.place_id");
  return insert(DB, "research", rowOf({
    place_id: o.place_id, status: "done", grade: "A", too_big: 0, notes: "", queued_at: SEED_AT, researched_at: SEED_AT,
  }, o));
}

/** A prospect (`o.place_id` required): stage ready, writing to <place_id>@example.com. */
export function seedProspect(DB, o = {}) {
  if (!o.place_id) throw new Error("seedProspect needs o.place_id");
  return insert(DB, "prospects", rowOf({
    place_id: o.place_id, stage: "ready", stage_at: SEED_AT, email: `${String(o.place_id).toLowerCase()}@example.com`,
    greet_name: null, mailbox_id: null, followup_step: 0, next_followup_at: null, views: 0, last_view_at: null,
    last_inbound_at: null, created_at: SEED_AT, updated_at: SEED_AT,
  }, o));
}

/** A demo site (`o.place_id` required): made at SEED_AT, live until LIVE_UNTIL. */
export function seedDemo(DB, o = {}) {
  if (!o.place_id) throw new Error("seedDemo needs o.place_id");
  return insert(DB, "demos", rowOf({
    slug: `demo-${String(o.place_id).toLowerCase()}-${next()}`, place_id: o.place_id, created_at: SEED_AT,
    expires_at: LIVE_UNTIL,
  }, o));
}

/** A sending mailbox: id m1 (the first one), cold, active, started 2026-08-01 (cap 10 from 5 Sep). */
export function seedMailbox(DB, o = {}) {
  const id = o.id ?? "m1";
  return insert(DB, "mailboxes", rowOf({
    id, address: `${id}@aetoswebsites.com`, display_name: "Nik", role: "cold", started_on: "2026-08-01",
    cap_override: null, status: "active", paused_reason: null, created_at: SEED_AT,
  }, { ...o, id }));
}

const AUTHOR = { first: "nik", followup: "system", reply: "claude", system: "system", inbound: "them" };

/**
 * A message: an outgoing first email from mailbox m1, queued. `sent` ones get sent_at = SEED_AT unless given,
 * `received` ones received_at; the author follows the kind (first nik, followup system, reply claude, inbound them).
 */
export function seedMessage(DB, o = {}) {
  const kind = o.kind ?? "first";
  const status = o.status ?? (kind === "inbound" ? "received" : "queued");
  const inbound = kind === "inbound";
  return insert(DB, "messages", rowOf({
    id: `msg-${next()}`, place_id: null, mailbox_id: "m1", direction: inbound ? "in" : "out", kind,
    step: kind === "followup" ? 1 : null, author: AUTHOR[kind] ?? "system",
    to_addr: inbound ? "m1@aetoswebsites.com" : "owner@example.com",
    from_addr: inbound ? "owner@example.com" : "m1@aetoswebsites.com",
    subject: "Your new website", body: "Hi,\n\nI made you a website.", status, due_at: SEED_AT,
    sent_at: status === "sent" ? SEED_AT : null, received_at: status === "received" ? SEED_AT : null,
    created_at: SEED_AT,
  }, { ...o, kind, status }));
}

// Stored as prospects.js suppress() stores it: addresses and domains lower-cased (a domain without a leading "@"),
// company numbers upper-cased.
function suppressionValue(value, kind) {
  const text = String(value ?? "").trim();
  return kind === "company" ? text.toUpperCase() : text.toLowerCase().replace(kind === "domain" ? /^@/ : /^$/, "");
}

/** A do-not-contact row: kind email (when the value has an "@"), else domain, or as given; reason opt_out. */
export function seedSuppression(DB, value, kind) {
  const k = kind ?? (String(value ?? "").includes("@") ? "email" : "domain");
  return insert(DB, "suppression", { value: suppressionValue(value, k), kind: k, reason: "opt_out", created_at: SEED_AT });
}
