// POST /onboard/<token>/save → the form's autosave (stage 10, docs/rebuild/09-build.md section 4): the whole form as
// JSON, at most 32 KB (413 over it), 1.5 s after the client's last change. 200 {ok: true}; 409 once the form has been
// sent (the page reloads into the thanks page); 404 for an unknown token. Public like the form itself.
// The work is _lib/sites/onboard.js; tested in control-room/tests/sites-onboard.test.mjs.
import { readFormBody, saveOnboarding } from "../../_lib/sites/onboard.js";
import { bad, db, json } from "../../_lib/util.js";

export async function onRequestPost({ request, env, params }) {
  try {
    const body = await readFormBody(request);
    if (!body.ok) return bad(body.error, body.status);
    const out = await saveOnboarding(await db(env), String(params.token ?? ""), body.form);
    return out.status === 200 ? json({ ok: true }) : bad(out.error, out.status);
  } catch (err) {
    console.error(`An onboarding save failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    return bad("We couldn't save just now. Your answers are still on the page: we'll try again.", 500);
  }
}
