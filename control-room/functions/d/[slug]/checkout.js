// POST /d/:slug/checkout {package: full|website, seen: weekend|weekday} (the order page's form, or JSON) → 303 to
// Stripe Checkout, or the order page with a notice and its status (400 bad package, 404/410, 409 already a client,
// 429 five tries this hour, 502 Stripe refused, 503 Stripe not connected). Public like the order page. The links
// Stripe gets back (thanks, cancel) use the host the prospect ordered on. The work is _lib/checkout.js's
// startCheckout; tested in control-room/tests/checkout-route.test.mjs.
import { startCheckout } from "../../_lib/checkout.js";
import { page } from "../../_lib/page.js";
import { db } from "../../_lib/util.js";

const MAX_BODY = 2000; // bytes: the form is about 30

// The body as text when it is at most `max` bytes, else null: reads no more than `max` bytes plus the chunk that
// crosses it, then cancels the rest (a huge body is never held in memory).
async function smallBody(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// {package, seen} from a form-encoded or JSON body; empty strings for anything unreadable or too big (→ the 400 page).
async function orderForm(request) {
  const text = await smallBody(request, MAX_BODY).catch(() => null);
  if (text === null) return { pkg: "", seen: "" };
  const type = String(request.headers.get("content-type") || "").toLowerCase();
  let fields = {};
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed;
    } catch {
      fields = {};
    }
  } else {
    fields = Object.fromEntries(new URLSearchParams(text));
  }
  const str = (v) => (typeof v === "string" ? v : "");
  return { pkg: str(fields.package), seen: str(fields.seen) };
}

export async function onRequestPost({ request, env, params }) {
  const { pkg, seen } = await orderForm(request);
  const out = await startCheckout(await db(env), env, {
    slug: params.slug, pkg, seen, origin: new URL(request.url).origin, now: new Date(), fetchImpl: fetch,
  });
  if (out.redirect) return new Response(null, { status: 303, headers: { location: out.redirect, "cache-control": "no-store" } });
  return page(out.html, out.status);
}
