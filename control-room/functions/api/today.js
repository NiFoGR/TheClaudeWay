// GET /api/today → the owner's "What to do" checklist (Home). POST {key, done} ticks a one-time setup step by hand.
import { getSetting, putSetting } from "../_lib/stripe.js";
import { steps } from "../_lib/today.js";
import { bad, db, json } from "../_lib/util.js";

const MANUAL = ["domain", "mailboxes", "funnel"];
const READY = `excluded = 0 AND status = 'new' AND email IS NOT NULL AND email != ''
  AND COALESCE(json_extract(audit, '$.email_source'), '') != 'guessed' AND quality_score >= 35`;

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const one = (sql, ...b) => DB.prepare(sql).bind(...b).first();
  const [picks, proposals, questions, flagged, hot, waiting, last, live] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM leads WHERE ${READY}`),
    one("SELECT COUNT(*) AS n FROM outreach_versions WHERE status = 'proposed'"),
    one("SELECT COUNT(*) AS n FROM owner_questions WHERE answer IS NULL"),
    one("SELECT COUNT(*) AS n FROM outreach_replies WHERE owner_class IS NULL AND auto_class IS NULL"),
    one(`SELECT COUNT(*) AS n FROM (SELECT e.place_id FROM demo_events e JOIN leads l ON l.place_id = e.place_id
         WHERE e.kind IN ('view', 'order_page') AND e.at > ? AND l.status NOT IN ('won', 'lost', 'not interested')
         GROUP BY e.place_id HAVING COUNT(*) >= 2)`, week),
    one(`SELECT COUNT(*) AS n FROM leads WHERE excluded = 0 AND json_extract(audit, '$.ai_research') IS NULL
         AND json_array_length(COALESCE(json_extract(audit, '$.ai_needs'), '[]')) > 0`),
    one("SELECT MAX(json_extract(audit, '$.ai_research.done_at')) AS at FROM leads"),
    one("SELECT COUNT(*) AS n FROM outreach_versions WHERE step = 1 AND status = 'live'"),
  ]);
  const [stripe, territory, manual] = await Promise.all([getSetting(DB, "stripe"), getSetting(DB, "territory"), getSetting(DB, "setup_done")]);
  return json(steps({
    picks: picks.n, proposals: proposals.n, questions: questions.n, flaggedReplies: flagged.n, hot: hot.n,
    waitingClaude: waiting.n, lastResearchAt: last?.at || null, liveFirstEmails: live.n,
    stripeLive: stripe?.mode === "live", autopilotOn: territory ? !!territory.on : true,
  }, manual || {}));
}

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (!MANUAL.includes(b.key)) return bad("That step is ticked automatically");
  const DB = await db(env);
  const manual = (await getSetting(DB, "setup_done")) || {};
  manual[b.key] = !!b.done;
  await putSetting(DB, "setup_done", manual);
  return json({ ok: true });
}
