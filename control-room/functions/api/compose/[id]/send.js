// POST /api/compose/<place_id>/send {to, subject, body} → 200 {id, due_at} | 400/409 {error, issues} (stage 5–6,
// docs/rebuild/06-email-followups.md Part A §A3, Task 10). Nik pressed Send: sendFirst re-runs every check and queues
// his first email (the lead stays `ready` until it has actually gone). Refused: 409 when a first email is already
// waiting to go out (queued_already: a double-click or a second tab), else 400; `error` is issues[0].message, in plain
// English, and `issues` the full list [{code, message}].
//
// Once queued, the route nudges the tick through context.waitUntil, so the email usually goes within seconds rather
// than at the next cron tick (the composer's toast still says "within 5 minutes"). The nudge runs only the send step,
// not the whole tick Part A names (runTick(env, "compose")): D1 allows 50 queries per invocation (overview §2) and
// waitUntil work shares this request's, but runTick counts only its own, so Send's ~14 plus a full tick (59 measured on
// a quiet database) would run past the limit, and the write that marks an email sent could fail after it went (shown
// as "Didn't send", and Try again would send it twice). The send step is also given what this whole request has left
// (Send's queries count, and one is kept for the tick's lease release), so it never starts with fewer than 10 or sends
// more than fit. It's skipped when this request's db() created tables (the migration has used the queries; the tick
// does the same, "migrated"). A nudge turned away (too_soon, locked, deferred) or one that fails never changes the
// answer: the email is queued either way and the next cron tick sends it.
// Behind the login (_middleware.js). Tested in tests/compose-routes.test.mjs.
import { countingDB } from "../../../_lib/d1count.js";
import { sendFirst } from "../../../_lib/first-email.js";
import { sendStep } from "../../../_lib/mail/outbox.js";
import { TICK_BUDGET, errorText, runTick } from "../../../_lib/tick.js";
import { db, json } from "../../../_lib/util.js";

// After the send step the tick runner makes the lease release and its heartbeat; sendStep keeps one back for the
// heartbeat, this is the release.
const RELEASE = 1;

const idOf = (params) => (typeof params?.id === "string" ? params.id : "");

// The send step as the nudge runs it: its budget is the smaller of the tick's own and what this request has left
// (`used` counts every query on env.DB, Send's and the tick's). With fewer than 10 it doesn't start ("deferred", as
// runTick reports a step it can't start).
function nudgeStep(used) {
  return Object.freeze({
    name: sendStep.name,
    everyMinutes: sendStep.everyMinutes,
    run(ctx) {
      const left = () => Math.min(ctx.budget.left(), TICK_BUDGET.total - used() - RELEASE);
      if (left() < TICK_BUDGET.minToStart) return "deferred";
      return sendStep.run({ ...ctx, budget: Object.freeze({ left }) });
    },
  });
}

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env, params } = context;
  const at = context.now ?? new Date();
  const input = await request.json().catch(() => null); // sendFirst refuses anything unreadable with bad_request
  const counter = env?.DB ? countingDB(env.DB) : null; // without a DB, db() gives its plain-English error
  const counted = counter ? { ...env, DB: counter.DB } : env;
  const schema = {};
  const DB = await db(counted, schema);
  const result = await sendFirst(DB, idOf(params), input, at);
  if (!result.ok) return json({ error: result.issues[0].message, issues: result.issues }, result.status);

  if (typeof context.waitUntil === "function" && !(schema.created > 0)) {
    context.waitUntil(runTick(counted, "compose", at, { steps: [nudgeStep(counter.used)] }).catch((err) => {
      console.error(`The tick (compose) couldn't run: ${errorText(err, env)}`);
    }));
  }
  return json({ id: result.id, due_at: result.due_at });
}
