// PATCH /api/money/clients/:id {cancelled_on: "YYYY-MM-DD" | null, notes?} → stop (or restart) their monthly.
// Stopping a client who pays through Stripe also cancels their Stripe subscription, so the card stops being charged.
// DELETE /api/money/clients/:id → remove a client added by mistake.
import { isDate } from "../../../_lib/money.js";
import { stripe } from "../../../_lib/stripe.js";
import { bad, db, json } from "../../../_lib/util.js";

export async function onRequestPatch({ request, env, params }) {
  const body = await request.json().catch(() => ({}));
  const DB = await db(env);
  const client = await DB.prepare("SELECT * FROM clients WHERE id = ?").bind(params.id).first();
  if (!client) return bad("Client not found", 404);
  if ("cancelled_on" in body) {
    if (body.cancelled_on !== null && !isDate(body.cancelled_on)) return bad("Pick the date they stopped paying");
    const link = await DB.prepare("SELECT stripe_subscription FROM client_links WHERE client_id = ?").bind(params.id).first();
    if (body.cancelled_on && link?.stripe_subscription) {
      try {
        await stripe(env, "DELETE", `subscriptions/${link.stripe_subscription}`);
      } catch (e) {
        if (!/No such subscription|canceled/i.test(e.message)) return bad(`Couldn't cancel their card payments in Stripe: ${e.message}`, 502);
      }
    }
    await DB.prepare("UPDATE clients SET cancelled_on = ? WHERE id = ?").bind(body.cancelled_on, params.id).run();
  }
  if (typeof body.notes === "string") {
    await DB.prepare("UPDATE clients SET notes = ? WHERE id = ?").bind(body.notes.slice(0, 2000), params.id).run();
  }
  return json({ client: await DB.prepare("SELECT * FROM clients WHERE id = ?").bind(params.id).first() });
}

export async function onRequestDelete({ env, params }) {
  const DB = await db(env);
  await DB.batch([
    DB.prepare("DELETE FROM clients WHERE id = ?").bind(params.id),
    DB.prepare("DELETE FROM client_links WHERE client_id = ?").bind(params.id),
  ]);
  return json({ ok: true });
}
