// GET /d/:slug → the lead's demo site (public: prospects open it from our emails). Expired → a polite "preview ended".
import { renderDemo, renderExpired } from "../../_lib/demo.js";
import { demoBySlug } from "../../_lib/demo-db.js";
import { db } from "../../_lib/util.js";
import { page } from "../../_lib/page.js";

export async function onRequestGet({ env, params }) {
  const found = await demoBySlug(await db(env), params.slug);
  if (!found) return page(renderExpired(null), 404);
  if (Date.parse(found.demo.expires_at) < Date.now()) return page(renderExpired(found.lead), 410);
  return page(renderDemo(found.lead, found.demo));
}
