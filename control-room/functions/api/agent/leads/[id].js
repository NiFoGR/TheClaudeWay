// POST /api/agent/leads/:place_id → Claude's research for one lead (fields: docs/lead-research-routine.md).
// Emails and the owner need a source URL; Claude's website rating replaces the automated Website score.
import { agentDenied } from "../../../_lib/agent.js";
import { cleanResearch, mergeResearch } from "../../../_lib/research.js";
import { bad, db, json, leadRow, now } from "../../../_lib/util.js";

export async function onRequestPost({ request, env, params }) {
  const denied = agentDenied(request, env);
  if (denied) return denied;
  const { error, clean } = cleanResearch(await request.json().catch(() => ({})));
  if (error) return bad(error);
  const DB = await db(env);
  const row = await DB.prepare("SELECT * FROM leads WHERE place_id = ?").bind(params.id).first();
  if (!row) return bad("Lead not found", 404);
  const m = mergeResearch(leadRow(row), clean);
  await DB.prepare(
    `UPDATE leads SET email = ?, emails = ?, socials = ?, director_first_name = ?, director_name = ?, audit = ?, issues = ?,
       quality_score = ?, excluded = ?, exclude_reason = ?, updated_at = ?
     WHERE place_id = ?`
  ).bind(m.email || null, JSON.stringify(m.emails), JSON.stringify(m.socials), m.director_first_name, m.director_name,
    JSON.stringify(m.audit), JSON.stringify(m.issues), m.quality_score, m.excluded, m.exclude_reason || null, now(), params.id).run();
  return json({ ok: true, email: m.email, owner: m.director_name, score: m.quality_score, excluded: !!m.excluded });
}
