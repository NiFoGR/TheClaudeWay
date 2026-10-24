// GET /api/today → the owner's "What to do" checklist (Home). POST {key, done} ticks a one-time setup step by hand.
import { researchFacts } from "../_lib/research-db.js";
import { getSetting, putSetting } from "../_lib/stripe.js";
import { steps } from "../_lib/today.js";
import { bad, db, json } from "../_lib/util.js";

const MANUAL = ["domain", "mailboxes", "funnel"];

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const one = (sql, ...b) => DB.prepare(sql).bind(...b).first();
  const [hot, research] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM (SELECT e.place_id FROM demo_events e JOIN leads l ON l.place_id = e.place_id
         WHERE e.kind IN ('view', 'order_page') AND e.at > ? AND l.status NOT IN ('won', 'lost', 'not interested')
         GROUP BY e.place_id HAVING COUNT(*) >= 2)`, week),
    // Claude's research lives in its own table (stage 2); leads.audit.ai_research is no longer written. The research
    // light's own facts (1 statement), so Home's step and Setup's light agree.
    researchFacts(DB),
  ]);
  const [stripe, territory, manual] = await Promise.all([getSetting(DB, "stripe"), getSetting(DB, "territory"), getSetting(DB, "setup_done")]);
  return json(steps({
    hot: hot.n, waitingClaude: research.queued, lastResearchAt: research.lastPostAt, oldestQueuedAt: research.oldestQueuedAt,
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
