// POST /api/stripe/webhook ← Stripe calls this on every payment event. Public (no login): handleWebhook checks the
// signature first, answers a repeated event id with {duplicate: true}, and returns 500 on a handler error so Stripe
// retries (_lib/stripe-events.js).
import { handleWebhook } from "../../_lib/stripe-events.js";
import { db, json } from "../../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const body = await request.text();
  const DB = await db(env);
  const res = await handleWebhook(DB, env, { body, signature: request.headers.get("stripe-signature"), now: new Date() });
  return json(res.json, res.status);
}
