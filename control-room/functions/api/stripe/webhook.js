// POST /api/stripe/webhook ← Stripe calls this on every payment. Public (no login), so the signature is checked first.
import { handleEvent } from "../../_lib/stripe-events.js";
import { getSetting, verifySignature } from "../../_lib/stripe.js";
import { db, json } from "../../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const body = await request.text();
  const DB = await db(env);
  const saved = await getSetting(DB, "stripe");
  if (!saved?.webhook?.secret || !(await verifySignature(body, request.headers.get("stripe-signature"), saved.webhook.secret))) {
    return json({ error: "Bad signature" }, 400);
  }
  const result = await handleEvent(DB, env, JSON.parse(body));
  return json({ received: true, result });
}
