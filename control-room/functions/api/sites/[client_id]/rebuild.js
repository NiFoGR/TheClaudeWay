// POST /api/sites/<client_id>/rebuild → Build again (stage 10, docs/rebuild/09-build.md sections 13 and 15, Task 24),
// behind the login: fires the build Routine with "build: client <client_id>" for a site Claude hasn't built (after a
// failed fire, or content refused four times). Accepted → onboarding building and the stuck todo closes (it comes
// back 3 h later if Claude still hasn't posted); not accepted → 502 "Claude couldn't be reached: …". 409 before the
// onboarding form is sent, or once the site has content (Ask Claude for changes then); 404 for an unknown client.
// Tested in control-room/tests/sites-api.test.mjs.
import { closeTodos } from "../../../_lib/todo.js";
import { bad, db, json } from "../../../_lib/util.js";
import { clientIdOf, fireBuild, fireError, loadSite, NO_CLIENT, nowOf } from "../[client_id].js";

const NOT_SENT = "The onboarding form hasn't been sent yet: there's nothing to build.";
const BUILT = "Claude has already built this site: use Ask Claude for changes instead.";

export async function onRequestPost(context) {
  const now = nowOf(context);
  const DB = await db(context.env);
  const site = await loadSite(DB, clientIdOf(context.params));
  if (!site) return bad(NO_CLIENT, 404);
  if (!site.submitted_at) return bad(NOT_SENT, 409);
  if (site.content) return bad(BUILT, 409);
  const id = site.client_id;
  const fired = await fireBuild(context, DB, `build: client ${id}`, now);
  if (fired?.ok !== true) return bad(fireError(fired, "Build again"), 502);
  await DB.prepare("UPDATE onboarding SET status = 'building' WHERE client_id = ? AND status IN ('submitted', 'building')")
    .bind(id)
    .run();
  await closeTodos(DB, `build:${id}:stuck`);
  return json({ ok: true });
}
