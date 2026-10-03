import { SCHEMA } from "./schema.js";

let schemaReady = false;

/** Create tables on first use, so a fresh D1 database needs no manual setup. */
export async function db(env) {
  if (!env.DB) {
    throw new Error("The database isn't connected. In Cloudflare: your Pages project → Settings → Bindings → add D1 database, variable name DB, then redeploy.");
  }
  if (!schemaReady) {
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    schemaReady = true;
  }
  return env.DB;
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const bad = (message, status = 400) => json({ error: message }, status);

const JSON_COLUMNS = ["emails", "socials", "issues", "audit"];

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
  return out;
}

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export const LEAD_STATUSES = ["new", "contacted", "replied", "call booked", "won", "lost", "not interested"];
