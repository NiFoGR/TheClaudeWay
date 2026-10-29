// GET /d/:slug/thanks?session_id=… → where Stripe Checkout sends a prospect after paying (its success_url): "Thank you,
// you're all set" with their onboarding form link, made right here if Stripe's webhook hasn't arrived yet. Public like
// the order page (_middleware.js lets /d/* through). 404 "We couldn't find that payment" for a wrong, unpaid or other
// lead's session; 200 "being confirmed" when Stripe can't be reached. An ended demo still thanks them.
// If the database itself fails (not bound, a D1 outage), someone who has just paid still gets the 200 "being
// confirmed" page rather than Cloudflare's error page: the webhook does the work and the welcome email brings the link.
// The work is _lib/checkout.js's thanksPage; tested in control-room/tests/thanks.test.mjs.
import { SESSION_ID_RE, thanksPage } from "../../_lib/checkout.js";
import { renderNotFound } from "../../_lib/demo/render.js";
import { renderThanks } from "../../_lib/order-page.js";
import { page } from "../../_lib/page.js";
import { db } from "../../_lib/util.js";

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  try {
    const { status, html } = await thanksPage(await db(env), env, {
      slug: params.slug, sessionId, origin: url.origin, now: new Date(), fetchImpl: fetch,
    });
    return page(html, status);
  } catch (err) {
    console.error(`The thanks page couldn't load: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
    if (typeof sessionId === "string" && SESSION_ID_RE.test(sessionId)) {
      return page(renderThanks({ outcome: "pending" }), 200);
    }
    return page(renderNotFound(), 404);
  }
}
