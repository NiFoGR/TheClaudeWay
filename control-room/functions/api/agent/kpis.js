// GET /api/agent/kpis?week=2026-W43 (agent token) → what the weekly-kpis Routine reviews: the KPIs page's payload
// (kpiPayload) plus `samples` (up to 20 of Nik's first emails and of Claude's replies that week, with outcomes, emails
// and phone numbers removed), `followup_templates` (the approved wording) and `previous` (up to 4 earlier reviews,
// newest first). It also saves the week's numbers snapshot in kpi_reports. With no week: the current UK week.
// 400 for a bad or future week. Tested in tests/kpis-api.test.mjs.
import { requireAgent } from "../../_lib/agentAuth.js";
import { agentExtras, checkWeek, currentWeek, kpiFrom, kpiPayload, kpiSamples, loadKpiRows, saveSnapshot } from "../../_lib/kpis-db.js";
import { bad, db, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;
  const at = now ?? new Date();
  const asked = new URL(request.url).searchParams.get("week");
  const checked = checkWeek(asked ? asked : currentWeek(at), at);
  if (checked.error) return bad(checked.error);

  // Only the 4 weeks shown, and sample bodies only from the reviewed week: the cost follows the weeks, not the history.
  const rows = await loadKpiRows(DB, { from: kpiFrom(checked.week), bodiesFrom: checked.start });
  const payload = await kpiPayload(DB, checked.week, at, rows);
  await saveSnapshot(DB, checked.week, payload.numbers, at);
  return json({ ...payload, samples: kpiSamples(rows, checked.start), ...(await agentExtras(DB, checked.week)) });
}
