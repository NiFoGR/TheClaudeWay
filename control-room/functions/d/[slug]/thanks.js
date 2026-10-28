// GET /d/:slug/thanks?session_id=… → where Stripe Checkout sends a prospect after paying (its success_url): "Thank you,
// you're all set" with their onboarding form link, made right here if Stripe's webhook hasn't arrived yet. Public like
// the order page (_middleware.js lets /d/* through). 404 "We couldn't find that payment" for a wrong, unpaid or other
// lead's session; 200 "being confirmed" when Stripe can't be reached. An ended demo still thanks them.
// The work is _lib/checkout.js's thanksPage; tested in control-room/tests/thanks.test.mjs.
import { thanksPage } from "../../_lib/checkout.js";
import { page } from "../../_lib/page.js";
import { db } from "../../_lib/util.js";

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const { status, html } = await thanksPage(await db(env), env, {
    slug: params.slug, sessionId: url.searchParams.get("session_id"), origin: url.origin, now: new Date(), fetchImpl: fetch,
  });
  return page(html, status);
}
