// POST /api/sites/<client_id>/approve → Approve and put live (stage 10, docs/rebuild/09-build.md sections 7 and 13,
// Task 24), behind the login. Only a site in review: status live, approved_at stamped, build:<client_id>:approve
// closed, and the review link stored if the site has none yet (the form's link, else Google's link for the place), so
// the live site and its go-live email carry it. The site goes public once its domain points at us (tick step sites).
// 409 "Approve only works when the site is ready to approve." otherwise; 404 for an unknown client.
// Tested in control-room/tests/sites-api.test.mjs.
import { setSiteStatus } from "../../../_lib/sites/db.js";
import { closeTodos } from "../../../_lib/todo.js";
import { bad, db, iso, json } from "../../../_lib/util.js";
import { clientIdOf, loadSite, NO_CLIENT, nowOf, siteReviewUrl } from "../[client_id].js";

export const NOT_READY = "Approve only works when the site is ready to approve.";

export async function onRequestPost(context) {
  const now = nowOf(context);
  const DB = await db(context.env);
  const site = await loadSite(DB, clientIdOf(context.params));
  if (!site) return bad(NO_CLIENT, 404);
  if (site.status !== "review") return bad(NOT_READY, 409);
  const id = site.client_id;
  await setSiteStatus(DB, id, "live", now, { approved: true });
  if (!site.review_url) {
    const url = siteReviewUrl(site);
    if (url) {
      await DB.prepare("UPDATE client_sites SET review_url = ?, updated_at = ? WHERE client_id = ? AND review_url IS NULL")
        .bind(url, iso(now), id)
        .run();
    }
  }
  await closeTodos(DB, `build:${id}:approve`);
  return json({ ok: true, status: "live" });
}
