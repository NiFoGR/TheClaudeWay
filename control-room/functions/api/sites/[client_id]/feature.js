// POST /api/sites/<client_id>/feature {feature: "chatbot" | "review_booster", on: boolean} → the Site page's
// per-client switches (stage 10, docs/rebuild/09-build.md sections 11–13, Task 24), behind the login. The work is
// setSiteFeature (_lib/sites/db.js): off stores {feature: false}, on removes the key. 400 for an unknown feature or a
// non-boolean `on`; 404 for an unknown client. Tested in control-room/tests/sites-api.test.mjs.
import { getSite, setSiteFeature, SITE_FEATURES } from "../../../_lib/sites/db.js";
import { bad, db, json } from "../../../_lib/util.js";
import { clientIdOf, NO_CLIENT, NOT_JSON, nowOf, readBody } from "../[client_id].js";

const UNKNOWN = "Unknown switch: pick chatbot or review_booster.";
const ON_OFF = "Say whether it's on or off (on: true or false).";

export async function onRequestPost(context) {
  const now = nowOf(context);
  const body = await readBody(context.request);
  if (!body) return bad(NOT_JSON);
  if (!SITE_FEATURES.includes(body.feature)) return bad(UNKNOWN);
  if (typeof body.on !== "boolean") return bad(ON_OFF);
  const DB = await db(context.env);
  const site = await getSite(DB, clientIdOf(context.params));
  if (!site) return bad(NO_CLIENT, 404);
  await setSiteFeature(DB, site.client_id, body.feature, body.on, now);
  const after = await getSite(DB, site.client_id);
  return json({ ok: true, features: after?.features ?? {} });
}
