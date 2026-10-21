// POST /d/:slug/e {kind} → the demo page's beacon: a real view (after 4 seconds), the order page opened, an order click.
import { demoBySlug, recordEvent } from "../../_lib/demo-db.js";
import { db } from "../../_lib/util.js";

export async function onRequestPost({ request, env, params }) {
  const DB = await db(env);
  const found = await demoBySlug(DB, params.slug);
  if (found) {
    const body = await request.text().catch(() => "");
    let kind = "";
    try { kind = JSON.parse(body).kind; } catch { /* ignore */ }
    if (kind !== "ordered") await recordEvent(DB, found.demo, String(kind)); // "ordered" only comes from Stripe
  }
  return new Response(null, { status: 204 });
}
