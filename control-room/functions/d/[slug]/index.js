// GET /d/:slug → the lead's demo site (public: prospects open it from our emails), drawn on every request by the
// template engine (_lib/demo/) from their lead and research rows; nothing but the slug is stored. An ended demo is the
// 410 "This preview has ended" page (a won prospect's never ends: demoBySlug's `expired`), and an unknown or bad slug
// the 404 page, which never says whose. Every response carries the demo page's headers (05-demo.md Part A §6).
// D1: the schema check on an isolate's first request, then demoBySlug's one batch of 4 reads; nothing is written.
// Tested in control-room/tests/demo-routes.test.mjs.
import { buildDemoData } from "../../_lib/demo/data.js";
import { renderExpired, renderNotFound, renderSite } from "../../_lib/demo/render.js";
import { demoBySlug } from "../../_lib/demo-db.js";
import { offerFor } from "../../_lib/offer.js";
import { DEMO_HEADERS, page } from "../../_lib/page.js";
import { db } from "../../_lib/util.js";

export async function onRequestGet({ env, params }) {
  const now = new Date(); // one clock for the expiry, the weekend offer and the © year
  const found = await demoBySlug(await db(env), params.slug, now);
  if (!found) return page(renderNotFound(), 404, DEMO_HEADERS);
  const { demo, lead, research, expired, contact_email } = found;
  if (expired) return page(renderExpired({ name: lead.name, contact_email }), 410, DEMO_HEADERS);
  const data = buildDemoData({ lead, research, demo, offer: offerFor(now), now });
  return page(renderSite(data, { now }), 200, DEMO_HEADERS);
}

// HEAD (link checkers, some mail filters): GET's status and headers, no body, as the public site's pages do. Pages
// matches a route's method exactly, so without this a HEAD on a live demo would reach d/[[path]].js's 404.
export async function onRequestHead(context) {
  return new Response(null, await onRequestGet(context));
}
