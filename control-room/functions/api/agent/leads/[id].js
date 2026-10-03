// POST /api/agent/leads/:place_id {emails:[{email, source_url, where}], owner:{first, full, source_url}, socials, website,
//   review:{verdict, summary, problems[], good[]}, notes, searched[]} → Claude's research for one lead.
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
    `UPDATE leads SET email = ?, emails = ?, socials = ?, director_first_name = ?, director_name = ?, audit = ?, updated_at = ?
     WHERE place_id = ?`
  ).bind(m.email || null, JSON.stringify(m.emails), JSON.stringify(m.socials), m.director_first_name, m.director_name,
    JSON.stringify(m.audit), now(), params.id).run();
  return json({ ok: true, email: m.email, owner: m.director_name });
}
