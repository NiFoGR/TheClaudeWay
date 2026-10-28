// GET  /api/stripe/setup → stripeStatus: is there a key (and its mode), is the webhook made and current, the newest
//      Stripe message. Never the key or the webhook secret.
// POST /api/stripe/setup {key?} → Connect Stripe (connectStripe: saves the key, makes the webhook), then the status.
//      With no key, the one already saved (or Cloudflare's STRIPE_SECRET_KEY) is used. Errors are 400 + {error} in
//      plain English (Part A's texts), so the Setup card can show them as they are.
import { connectStripe, stripeStatus } from "../../_lib/stripe.js";
import { bad, db, json } from "../../_lib/util.js";
import { readJson } from "../setup/mailboxes.js";

// A database fault as a plain-English 500 (db() says how to bind D1); never a key: none is ever in these errors.
const down = (err) => bad(String(err?.message || "The database isn't answering. Try again in a minute."), 500);

export async function onRequestGet({ env }) {
  try {
    return json(await stripeStatus(await db(env), env));
  } catch (err) {
    return down(err);
  }
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  if (!body) return bad("Send the key as JSON: {\"key\": \"sk_test_…\"}.", 400);
  if (body.key !== undefined && body.key !== null && typeof body.key !== "string") {
    return bad("That doesn't look like a Stripe secret key. It starts with sk_ or rk_ (Stripe → Developers → API keys).", 400);
  }
  let DB;
  try {
    DB = await db(env);
  } catch (err) {
    return down(err);
  }
  try {
    await connectStripe(DB, env, { key: body.key ?? "", origin: new URL(request.url).origin }, { fetchImpl: fetch });
  } catch (err) {
    return bad(String(err?.message || "Couldn't connect Stripe. Try again in a minute."), 400);
  }
  try {
    return json(await stripeStatus(DB, env));
  } catch (err) {
    return down(err);
  }
}
