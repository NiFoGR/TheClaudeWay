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
  if (pending.n >= 4) return bad("4 of Claude's proposals are already waiting for the owner. Wait for those first.", 429);
  const out = await createVersion(DB, await request.json().catch(() => ({})), "claude");
  return out.error ? bad(out.error) : json(out, 201);
}
