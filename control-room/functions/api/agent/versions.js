// POST /api/agent/versions {step, name, hypothesis, subject, body, parent_id?} → Claude's proposed challenger.
// It lands as "proposed": the owner sees it rendered on real leads and approves or rejects it.
import { agentDenied } from "../../_lib/agent.js";
import { bad, db, json } from "../../_lib/util.js";
import { createVersion } from "../outreach/versions.js";

export async function onRequestPost({ request, env }) {
  const denied = agentDenied(request, env);
  if (denied) return denied;
  const DB = await db(env);
  const pending = await DB.prepare("SELECT COUNT(*) AS n FROM outreach_versions WHERE status = 'proposed' AND author = 'claude'").first();
  if (pending.n >= 8) return bad("8 of Claude's proposals are already waiting for the owner. Wait for those first.", 429);
  const body = await request.json().catch(() => ({}));
  const out = await createVersion(DB, { ...body, hypothesis: body.hypothesis || (body.brief_id ? "From the owner's own wording" : "") }, "claude");
  if (out.error) return bad(out.error);
  if (body.brief_id) {
    await DB.prepare("UPDATE outreach_briefs SET status = 'done', done_at = ? WHERE id = ?").bind(new Date().toISOString(), body.brief_id).run();
  }
  return json(out, 201);
}
