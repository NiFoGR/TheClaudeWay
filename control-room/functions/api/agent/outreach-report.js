// GET /api/agent/outreach-report → the weekly report as Markdown, for the Claude Routine (bearer token).
import { agentDenied } from "../../_lib/agent.js";
import { loadOutreach } from "../../_lib/outreach-db.js";
import { featureBreakdown, report } from "../../_lib/outreach-report.js";
import { db } from "../../_lib/util.js";

export async function onRequestGet({ request, env }) {
  const denied = agentDenied(request, env);
  if (denied) return denied;
  const DB = await db(env);
  const text = report(await loadOutreach(DB), await featureBreakdown(DB));
  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
}
