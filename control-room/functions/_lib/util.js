import { SCHEMA, SCHEMA_VERSION } from "./schema.js";
import { townKey } from "./territory.js";

let schemaReady = false;

// The free plan allows 50 D1 queries per invocation, and each statement in a batch may count as one. A migration
// runs at most this many schema statements per call: with the version read, the sqlite_master read and the version
// write that's 43, which leaves room for the request's own queries. A brand-new database (52 statements) finishes on
// its next call; the live one (the old system's 29) needs only the 23 new ones, 26 queries in all.
export const MIGRATION_MAX = 40;

// Every SCHEMA statement is CREATE TABLE|INDEX IF NOT EXISTS <name> (schema.test.mjs checks), so what's missing can
// be read from sqlite_master.
const CREATES = /^\s*CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+["`[]?(\w+)/i;

/** "table:<name>" or "index:<name>" for a CREATE … IF NOT EXISTS statement, else null. */
export function schemaObject(sql) {
  const m = CREATES.exec(sql);
  return m ? `${m[1].toLowerCase()}:${m[2].toLowerCase()}` : null;
}

/**
 * Create tables on first use, so a fresh D1 database needs no manual setup. db() reads the setting schema:version
 * once per isolate (1 query). Only when it differs from SCHEMA_VERSION does it migrate: it reads sqlite_master (1),
 * creates just the tables and indexes that are missing, at most MIGRATION_MAX of them in one batch, and writes the
 * version once nothing is missing (1). So no call goes over the 50 queries an invocation may make.
 *
 * `report`, if given, gets `migrated` (the statements this call ran to migrate, 0 when the schema was current) and
 * `created` (the tables and indexes among them). The tick stops when `created` is above 0, so its own queries never
 * stack on top of a real migration; a version-only write (2 queries) just counts in its budget.
 */
export async function db(env, report = {}) {
  if (!env.DB) {
    throw new Error("The database isn't connected. In Cloudflare: your Pages project → Settings → Bindings → add D1 database, variable name DB, then redeploy.");
  }
  report.migrated = 0;
  report.created = 0;
  if (!schemaReady) {
    let version = null;
    try {
      version = await env.DB.prepare("SELECT value FROM settings WHERE key='schema:version'").first("value");
    } catch {
      version = null; // no settings table yet: a fresh database
    }
    if (version === SCHEMA_VERSION) schemaReady = true;
    else Object.assign(report, await migrate(env.DB));
  }
  return env.DB;
}

// Creates what's missing (at most MIGRATION_MAX statements) → {migrated: statements run, created: CREATEs among
// them}. schemaReady is set only once the version is written, so a partly migrated database carries on next call.
async function migrate(DB) {
  const { results } = await DB.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','index')").all();
  const have = new Set(results.map((row) => `${String(row.type).toLowerCase()}:${String(row.name).toLowerCase()}`));
  const missing = SCHEMA.filter((sql) => !have.has(schemaObject(sql)));
  const batch = missing.slice(0, MIGRATION_MAX);
  let ran = 1;
  if (batch.length) {
    await DB.batch(batch.map((sql) => DB.prepare(sql)));
    ran += batch.length;
  }
  const created = batch.length;
  // The rest next time: the version waits until nothing is missing.
  if (missing.length > batch.length) return { migrated: ran, created };
  await DB.prepare("INSERT INTO settings (key, value) VALUES ('schema:version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(SCHEMA_VERSION)
    .run();
  schemaReady = true;
  return { migrated: ran + 1, created };
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Any time (a Date, or anything new Date() reads) as stored: UTC "YYYY-MM-DDTHH:MM:SSZ", no milliseconds, the same
// text as now() and Python's _now(), so stored times compare as strings. Every stage imports it from here.
export const iso = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const bad = (message, status = 400) => json({ error: message }, status);

const JSON_COLUMNS = ["emails", "socials", "issues", "audit"];

// A finding from the Map Rank scan (scoring.maps_findings and scoring.reviews_finding in Python).
const MAPS_FINDING = /^(maps_|reviews_behind$)/;

/**
 * True when a lead's saved Map Rank part (audit.map_rank) is from a scan of another town: marked so (`home` false,
 * 02-find), or older rows saved before that whose `scan_town` isn't the lead's own town (its town, else the town
 * searched; compared with townKey, so "St. Helens" = "Saint Helens"). A Map Rank part without `scan_town` can't be
 * checked and counts as theirs.
 */
export function mapsFromAnotherTown(mapRank, lead) {
  const m = mapRank || {};
  return m.home === false || (!!m.scan_town && townKey(m.scan_town) !== townKey(lead?.town || lead?.search_town));
}

export function leadRow(row) {
  const out = { ...row, excluded: !!row.excluded };
  for (const c of JSON_COLUMNS) {
    try {
      out[c] = row[c] ? JSON.parse(row[c]) : c === "socials" || c === "audit" ? {} : [];
    } catch {
      out[c] = c === "socials" || c === "audit" ? {} : [];
    }
  }
  // findings, score breakdown and map rank ride inside the audit JSON
  out.findings = out.audit.findings || [];
  out.score_parts = out.audit.score || {};
  out.map_rank = out.audit.map_rank || {};
  // Another town's scan says nothing about this lead (false claim #7): the call script and the emails read these two,
  // so its Maps findings and numbers aren't handed out. `audit` and `issues` stay as saved (mergeResearch writes them
  // back), and map_rank is {} rather than null, which `lead.map_rank || lead.audit.map_rank` would read past.
  if (mapsFromAnotherTown(out.map_rank, out)) {
    if (Array.isArray(out.findings)) out.findings = out.findings.filter((f) => !MAPS_FINDING.test(f));
    out.map_rank = {};
  }
  return out;
}

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export const LEAD_STATUSES = ["new", "in outreach", "contacted", "replied", "call booked", "won", "lost", "not interested"];
