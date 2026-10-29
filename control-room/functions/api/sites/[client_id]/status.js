// POST /api/sites/<client_id>/status {status: "off" | "on"} → Take offline / Put back online (stage 10,
// docs/rebuild/09-build.md section 13, Task 24), behind the login. Off: visitors see "This website isn't set up yet."
// and the DNS checks stop. On (only from off): back to live if Nik had approved it, else review when Claude's content
// is there, else draft. 400 for anything else; 409 "Put back online" on a site that isn't offline; 404 for an
// unknown client. Tested in control-room/tests/sites-api.test.mjs.
import { getSite, setSiteStatus } from "../../../_lib/sites/db.js";
import { bad, db, json } from "../../../_lib/util.js";
import { clientIdOf, NO_CLIENT, NOT_JSON, nowOf, readBody } from "../[client_id].js";

const PICK = "Send status \"off\" (take it offline) or \"on\" (put it back online).";
const NOT_OFF = "Put back online only works for a site that's offline.";

export async function onRequestPost(context) {
  const now = nowOf(context);
  const body = await readBody(context.request);
  if (!body) return bad(NOT_JSON);
  if (body.status !== "off" && body.status !== "on") return bad(PICK);
  const DB = await db(context.env);
  const site = await getSite(DB, clientIdOf(context.params));
  if (!site) return bad(NO_CLIENT, 404);
  let next = "off";
  if (body.status === "on") {
    if (site.status !== "off") return bad(NOT_OFF, 409);
    next = site.approved_at ? "live" : site.content ? "review" : "draft";
  }
  await setSiteStatus(DB, site.client_id, next, now);
  return json({ ok: true, status: next });
}
