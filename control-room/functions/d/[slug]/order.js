// GET /d/:slug/order → the order page for that lead (Full Package vs Website Only, weekend deal, Stripe payment links).
import { renderExpired, renderOrder } from "../../_lib/demo.js";
import { demoBySlug } from "../../_lib/demo-db.js";
import { loadSiteSettings } from "../../_lib/site.js";
import { getSetting } from "../../_lib/stripe.js";
import { db } from "../../_lib/util.js";
import { page } from "../../_lib/page.js";

export async function onRequestGet({ env, params }) {
  const DB = await db(env);
  const found = await demoBySlug(DB, params.slug);
  if (!found) return page(renderExpired(null), 404);
  if (Date.parse(found.demo.expires_at) < Date.now()) return page(renderExpired(found.lead), 410);
  const stripe = (await getSetting(DB, "stripe")) || {};
  // The extras switches (one query, '1' = on, as on the landing page): nothing offers an extra that isn't live yet.
  const { extras } = await loadSiteSettings(DB);
  return page(renderOrder(found.lead, found.demo, stripe.links || {}, new Date(), extras));
}
