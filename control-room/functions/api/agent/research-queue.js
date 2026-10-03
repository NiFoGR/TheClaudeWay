// GET /api/agent/research-queue?limit=20 → leads for Claude to research (no email first, then best score),
// skipping any already researched. For the lead-research Routine on the owner's subscription (bearer token).
import { agentDenied } from "../../_lib/agent.js";
import { db, json, leadRow } from "../../_lib/util.js";

export async function onRequestGet({ request, env }) {
  const denied = agentDenied(request, env);
  if (denied) return denied;
  const limit = Math.min(50, Math.max(1, Number(new URL(request.url).searchParams.get("limit")) || 20));
  const DB = await db(env);
  const { results } = await DB.prepare(
    `SELECT * FROM leads WHERE excluded = 0 AND json_extract(audit, '$.ai_research') IS NULL
     ORDER BY (email IS NULL OR email = '' OR json_extract(audit, '$.email_source') = 'guessed') DESC, quality_score DESC
     LIMIT ?`
  ).bind(limit).all();
  const leads = results.map(leadRow).map((l) => ({
    place_id: l.place_id, name: l.name, trade: l.trade, town: l.town || l.search_town, address: l.address, phone: l.phone,
    website: l.website, google_maps: l.maps_url, rating: l.rating, reviews: l.review_count,
    emails_so_far: l.emails, email_source: l.audit?.email_source || "", socials_so_far: l.socials,
    owner_so_far: l.director_name ? { name: l.director_name, source: l.audit?.owner_source || "" } : null,
    automated_findings: l.issues,
  }));
  const left = await DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE excluded = 0 AND json_extract(audit, '$.ai_research') IS NULL").first();
  return json({ leads, remaining: left.n });
}
