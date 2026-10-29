// POST /api/sites/<client_id>/check → Check now (stage 10, docs/rebuild/09-build.md sections 7 and 13, Task 24),
// behind the login: the tick step's DNS check for this one site, at once (checkSite in _lib/sites/tick.js: stores
// host_check, ticks ns_wait, and puts an approved, opened site live with its email). → {ok, detail, live}, where
// detail is plain English ("www.x.co.uk points at us ✓", "Not yet: …"). 404 for an unknown client.
// `context.fetchImpl` (or env.__fetch) is for tests. Tested in control-room/tests/sites-api.test.mjs.
import { checkSite } from "../../../_lib/sites/tick.js";
import { bad, db, json } from "../../../_lib/util.js";
import { clientIdOf, NO_CLIENT, nowOf } from "../[client_id].js";

export async function onRequestPost(context) {
  const now = nowOf(context);
  const DB = await db(context.env);
  const fetchImpl = context.fetchImpl ?? context.env?.__fetch; // tests only; live both are undefined, so it uses fetch
  const id = clientIdOf(context.params);
  const result = id ? await checkSite(DB, id, fetchImpl ? { fetchImpl, now } : { now }) : null;
  if (!result) return bad(NO_CLIENT, 404);
  return json({ ok: result.ok, detail: result.detail, live: result.live });
}
