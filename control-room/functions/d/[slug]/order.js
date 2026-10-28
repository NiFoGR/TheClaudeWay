// GET /d/:slug/order → the lead's order page (Full Package vs Website Only at today's price, docs/rebuild/08-order-pay.md
// Part A): public, like the demo itself (_middleware.js lets /d/* through without a login). ?back=1 is Stripe's cancel
// link ("No payment was taken."). 404 for an unknown slug, 410 once the demo has ended. Its forms post to
// d/[slug]/checkout.js. The work is _lib/checkout.js's orderPage; tested in control-room/tests/checkout-route.test.mjs.
import { orderPage } from "../../_lib/checkout.js";
import { page } from "../../_lib/page.js";
import { db } from "../../_lib/util.js";

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const { status, html } = await orderPage(await db(env), env, {
    slug: params.slug, back: url.searchParams.get("back") === "1", now: new Date(),
  });
  return page(html, status);
}

// HEAD (link checkers): GET's status and headers, no body. Pages matches a route's method exactly, so without this
// a HEAD would reach d/[[path]].js's 404.
export async function onRequestHead(context) {
  return new Response(null, await onRequestGet(context));
}
