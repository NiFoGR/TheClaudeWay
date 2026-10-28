// POST /api/agent/kpis/2026-W43 (agent token) {analysis} → {ok: true, suggestions}: the weekly-kpis Routine's review
// of that week (markdown, 1–6,000 characters, at most 3 numbered suggestions under "## Suggestions"). It's saved with
// the week's numbers and becomes the week's one `kpi` todo for Nik (_lib/kpis-db.js saveAnalysis). 400 with plain
// words for a bad or future week, an empty or too long review, or too many suggestions. Tested in
// tests/kpis-api.test.mjs.
import { requireAgent } from "../../../_lib/agentAuth.js";
import { analysisProblem, checkWeek, saveAnalysis } from "../../../_lib/kpis-db.js";
import { bad, db, json } from "../../../_lib/util.js";

const NOT_OBJECT = "Body must be a JSON object with analysis.";

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, params, now }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;
  const at = now ?? new Date();
  const checked = checkWeek(typeof params?.week === "string" ? params.week : "", at);
  if (checked.error) return bad(checked.error);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(NOT_OBJECT);
  const problem = analysisProblem(body.analysis);
  if (problem) return bad(problem);
  const { suggestions } = await saveAnalysis(DB, checked.week, body.analysis, at);
  return json({ ok: true, suggestions });
}
