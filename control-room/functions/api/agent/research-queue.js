// GET /api/agent/research-queue?job=ID&limit=15 → the leads the scraper flagged for Claude (audit.ai_needs, set by
// lead-manager/aetos_leads/research.py), this run's first, best score first. Each comes with exactly what to do
// and everything already found, so Claude never redoes free work. For the lead-research Routine (bearer token).
import { agentDenied } from "../../_lib/agent.js";
import { db, json, leadRow } from "../../_lib/util.js";

const WAITING = `excluded = 0 AND json_extract(audit, '$.ai_research') IS NULL
  AND json_array_length(COALESCE(json_extract(audit, '$.ai_needs'), '[]')) > 0`;

export async function onRequestGet({ request, env }) {
  const denied = agentDenied(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 15));
  const job = url.searchParams.get("job") || "";
  const DB = await db(env);
  const { results } = await DB.prepare(
    `SELECT * FROM leads WHERE ${WAITING} ORDER BY (last_job_id = ?) DESC, quality_score DESC LIMIT ?`
  ).bind(job, limit).all();
  const leads = results.map(leadRow).map((l) => ({
    place_id: l.place_id, name: l.name, trade: l.trade, town: l.town || l.search_town, address: l.address, phone: l.phone,
    website: l.website, google_maps: l.maps_url, rating: l.rating, reviews: l.review_count,
    todo: l.audit.ai_needs,
    email_now: l.email || "", email_source: l.audit.email_source || "", emails_so_far: l.emails, socials_so_far: l.socials,
    owner_so_far: l.director_name ? { name: l.director_name, source: l.audit.owner_source || "" } : null,
    score: { total: l.quality_score, ...l.score_parts },
    automated_findings: l.issues,
    company: l.audit.company || null,
  }));
  const left = await DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${WAITING}`).first();
  return json({ leads, remaining: left.n - leads.length });
}
