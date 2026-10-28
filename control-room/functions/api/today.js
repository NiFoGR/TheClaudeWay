// GET /api/today → the owner's "What to do" checklist (Home). POST {key, done} ticks a one-time setup step by hand.
// Until stage 11's Todo page, Home also shows the calls Claude or Nik booked (from 30 minutes ago to the end of
// tomorrow, UK) and how many replies need him (the Replies page's Needs you: open escalation and call_time Todos).
import { upcomingCalls } from "../_lib/calls-db.js";
import { researchFacts } from "../_lib/research-db.js";
import { isHot } from "../_lib/shortlist.js";
import { getSetting, putSetting } from "../_lib/stripe.js";
import { steps } from "../_lib/today.js";
import { addUkDays, ukDate, ukToUtc } from "../_lib/ukTime.js";
import { bad, db, iso, json } from "../_lib/util.js";

const MANUAL = ["domain", "mailboxes", "funnel"];
const DAY_MS = 86_400_000;
const CALL_GRACE_MS = 30 * 60_000; // a call stays on Home until its "How did it go?" Todo (30 minutes after) takes over

// Home's hot count is the board's isHot (stage 3's _lib/shortlist.js, the app's only hot rule; never copied here),
// so it matches the `hot` todos the tick raises (_lib/hot.js), until stage 11 removes Home. The prospects that may be
// hot, in one statement shaped like hot.js's: the view window is an hour wider than isHot's 24 hours, so the text
// compare can't drop one, and isHot decides. ? = 25 hours ago.
const MAYBE_HOT_SQL = `SELECT stage, views, last_view_at, last_inbound_at FROM prospects
  WHERE stage IN ('emailed', 'viewed') AND COALESCE(trim(last_inbound_at), '') = ''
    AND (views >= 2 OR last_view_at >= ?)`;

// The Replies page's Needs you count (api/replies.js NEEDS_YOU_SQL's filter) and the reply Routine's last check-in.
const REPLIES_SQL = `SELECT
    (SELECT COUNT(*) FROM todos WHERE status = 'open' AND kind IN ('escalation', 'call_time')) AS need_you,
    (SELECT last_at FROM heartbeats WHERE name = 'routine:reply') AS reply_beat`;

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, now: at }) {
  const DB = await db(env);
  const now = at ?? new Date();
  const callsTo = ukToUtc(addUkDays(ukDate(now), 2), "00:00");
  const [maybeHot, research, calls, replies] = await Promise.all([
    DB.prepare(MAYBE_HOT_SQL).bind(iso(now.getTime() - DAY_MS - 3_600_000)).all(),
    // Claude's research lives in its own table (stage 2); leads.audit.ai_research is no longer written. The research
    // light's own facts (1 statement), so Home's step and Setup's light agree.
    researchFacts(DB),
    upcomingCalls(DB, new Date(now.getTime() - CALL_GRACE_MS), callsTo),
    DB.prepare(REPLIES_SQL).first(),
  ]);
  const [stripe, territory, manual] = await Promise.all([getSetting(DB, "stripe"), getSetting(DB, "territory"), getSetting(DB, "setup_done")]);
  const hot = (maybeHot?.results || []).filter((p) => isHot(p, now)).length;
  return json(steps({
    hot, waitingClaude: research.queued, lastResearchAt: research.lastPostAt, oldestQueuedAt: research.oldestQueuedAt,
    stripeLive: stripe?.mode === "live", autopilotOn: territory ? !!territory.on : true,
    calls, needYou: Number(replies?.need_you || 0), replyRoutineAt: replies?.reply_beat || null,
  }, manual || {}, now.getTime()));
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
