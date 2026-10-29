// POST /onboard/<token>/submit → Send (stage 10, docs/rebuild/09-build.md section 4 and Task 12): the whole form as
// JSON (at most 32 KB). 400 {ok: false, errors: {field: message}} when something needs fixing; 200 {ok: true,
// due_live_at} once the 7-day clock has started (the build Routine is fired once, todos filed; the page reloads into
// the thanks page); 409 when it was already sent (a second press never fires twice); 404 for an unknown token.
// The work is _lib/sites/onboard.js's submitOnboarding; tested in control-room/tests/sites-onboard.test.mjs.
import { readFormBody, submitOnboarding } from "../../_lib/sites/onboard.js";
import { bad, db, json } from "../../_lib/util.js";

export async function onRequestPost({ request, env, params }) {
  try {
    const body = await readFormBody(request);
    if (!body.ok) return bad(body.error, body.status);
    const out = await submitOnboarding(await db(env), env, String(params.token ?? ""), body.form, new Date());
    if (out.status === 200) return json({ ok: true, due_live_at: out.due_live_at });
    if (out.status === 400) return json({ ok: false, errors: out.errors }, 400);
    return bad(out.error, out.status);
  } catch (err) {
    console.error(`An onboarding Send failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    return bad("We couldn't send your form just now. Your answers are still on the page: please press Send again in a minute.", 500);
  }
}
