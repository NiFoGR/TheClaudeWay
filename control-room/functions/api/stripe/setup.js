// GET  /api/stripe/setup → is Stripe connected, and the payment links to send clients.
// POST /api/stripe/setup → one press: create the products, payment links and webhook in Stripe.
import { getSetting, setUpStripe, stripeMode } from "../../_lib/stripe.js";
import { bad, db, json } from "../../_lib/util.js";

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const saved = await getSetting(DB, "stripe");
  const mode = stripeMode(env);
  return json({
    hasKey: !!env.STRIPE_SECRET_KEY,
    mode,
    ready: !!(env.STRIPE_SECRET_KEY && saved?.mode === mode && saved.links && saved.webhook),
    links: saved?.mode === mode ? saved.links : null,
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return bad("Add STRIPE_SECRET_KEY in Cloudflare first (Setup explains how), then redeploy.");
  const DB = await db(env);
  try {
    const saved = await setUpStripe(env, DB, new URL(request.url).origin);
    return json({ ready: true, mode: saved.mode, links: saved.links });
  } catch (e) {
    return bad(e.message, 502);
  }
}
