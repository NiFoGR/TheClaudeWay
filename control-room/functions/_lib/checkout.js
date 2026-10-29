// Order and pay: the Stripe Checkout Session for an order. checkoutParams is pure: prices come from termsFor
// (offer.js); nothing here writes one down. Sent form-encoded with stripe.js's encode.
// The db part (Task 5) is what the order page and checkout routes run (d/[slug]/order.js, d/[slug]/checkout.js):
// loadOrder reads everything a lead's order page needs, orderPage draws it, startCheckout opens Stripe Checkout,
// at most CHECKOUT_LIMIT times per slug per rolling hour (counted from demo_events kind order_click).
// thanksPage (Task 10) is the page Stripe sends them back to (d/[slug]/thanks.js): it fetches the session, checks it,
// and runs fulfilCheckout itself, so the onboarding link shows even when the webhook is late.
// Tested in control-room/tests/checkout.test.mjs (params), checkout-route.test.mjs and thanks.test.mjs (the rest).
import { renderExpired, renderNotFound } from "./demo/render.js";
import { demoBySlug } from "./demo-db.js";
import { checkoutWeekend, offerFor, termsFor } from "./offer.js";
import { renderOrder, renderThanks } from "./order-page.js";
import { beat } from "./routines.js";
import { loadSiteSettings, traderLine } from "./site.js";
import { stripeApi, stripeKey, webhookSecret } from "./stripe.js";
import { fulfilCheckout } from "./stripe-events.js";
import { addTodo } from "./todo.js";
import { iso } from "./util.js";

const MONTHLY_NAME = "Monthly plan: Google top 3 work, hosting and report";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The exact Checkout Session parameters for one order: "full" is a subscription (monthly plan on a free trial plus the
 * build charged today), "website" a one-off payment. `weekend` picks the weekend deal for "full". `customer_email` is
 * left out when there's no usable email.
 */
export function checkoutParams({ pkg, weekend, lead, slug, email, origin }) {
  const terms = termsFor(pkg, weekend);
  const place_id = lead.place_id;
  // "1" only when the weekend deal applies: Website Only has no weekend price, so it is always "0" (fulfilCheckout
  // reads weekend "1" as the weekend package).
  const weekendFlag = pkg === "full" && weekend ? "1" : "0";
  // Stripe refuses the whole session over a malformed customer_email, so a blank or odd one is left out (the
  // prospect types it on Stripe's page instead).
  const to = typeof email === "string" ? email.trim() : "";
  const prefill = EMAIL_RE.test(to) ? to : "";
  const build = {
    quantity: 1,
    price_data: { currency: "gbp", unit_amount: terms.build, product_data: { name: `Website build: ${lead.name}` } },
  };
  const common = {
    client_reference_id: place_id,
    ...(prefill ? { customer_email: prefill } : {}),
    locale: "en-GB",
    payment_method_types: ["card"],
    phone_number_collection: { enabled: true },
    metadata: { place_id, package: pkg, weekend: weekendFlag, slug, origin },
    success_url: `${origin}/d/${slug}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/d/${slug}/order?back=1`,
  };
  if (pkg === "full") {
    return {
      ...common,
      mode: "subscription",
      payment_method_collection: "always",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp", unit_amount: terms.monthly, recurring: { interval: "month" },
            product_data: { name: MONTHLY_NAME },
          },
        },
        build,
      ],
      subscription_data: { trial_period_days: terms.freeDays, metadata: { place_id, package: "full", weekend: weekendFlag } },
    };
  }
  return {
    ...common,
    mode: "payment",
    customer_creation: "always",
    // The build invoice is tagged, so invoice.paid records it as the build fee (build:<customer>) and any later
    // one-off invoice for the same customer as money of its own (stripe-events.js's invoicePaid).
    invoice_creation: { enabled: true, invoice_data: { metadata: { aetos_build: "1" } } },
    line_items: [build],
    payment_intent_data: { metadata: { place_id, package: "website" } },
  };
}

// ---------------------------------------------------------------- the order page and checkout (db, Task 5)

/** Checkouts a slug may start per rolling 60 minutes; the next one gets the `busy` notice (429). */
export const CHECKOUT_LIMIT = 5;
const LIMIT_WINDOW_MS = 60 * 60_000;
const PACKAGE_NAMES = new Set(["full", "website"]);

const CLIENT_SQL = "SELECT 1 AS yes FROM clients WHERE place_id = ? AND cancelled_on IS NULL LIMIT 1";
// The limit check and the order_click in one statement (stage 4's recordEvent, made conditional): stored only while the
// slug has fewer than ?5 order_clicks after ?4 (60 minutes ago), so a burst of POSTs arriving together can't all read
// "4 so far" and each open a checkout. place_id first, so the count reads through demo_events_place. It is written here
// rather than by recordEvent also because recordEvent stores nothing once a demo's expires_at has passed, while a won
// prospect's demo never ends (demoBySlug): a client who stopped paying can order again from it, and the limit holds.
// ?1 slug, ?2 place_id, ?3 at, ?4 window start, ?5 CHECKOUT_LIMIT.
const CLICK_SQL = `INSERT INTO demo_events (slug, place_id, kind, at) SELECT ?1, ?2, 'order_click', ?3
  WHERE (SELECT COUNT(*) FROM demo_events
    WHERE place_id = ?2 AND kind = 'order_click' AND slug = ?1 AND at > ?4) < ?5`;

function clock(now, fn) {
  const at = now instanceof Date ? now : new Date(now ?? NaN);
  if (Number.isNaN(at.getTime())) throw new TypeError(`${fn} needs the time now (a Date).`);
  return at;
}

// loadOrder's reads, plus the Stripe key for startCheckout (kept out of what loadOrder returns).
async function readOrder(DB, env, slug, now) {
  const found = await demoBySlug(DB, slug, now);
  if (!found) return null;
  const { demo, lead, prospect, expired, contact_email } = found;
  const { business, extras } = await loadSiteSettings(DB);
  const client = await DB.prepare(CLIENT_SQL).bind(lead.place_id).first();
  const key = await stripeKey(env, DB);
  const connected = Boolean(key) && Boolean(await webhookSecret(DB));
  return {
    order: {
      lead,
      demo,
      expired: Boolean(expired),
      prospect: prospect ? { email: prospect.email ?? null, greet_name: prospect.greet_name ?? null } : null,
      alreadyClient: Boolean(client),
      connected,
      extras: { chatbot: extras?.chatbot === true, reviews: extras?.reviews === true },
      trader: traderLine(business),
    },
    key: key?.key ?? null,
    contact_email: contact_email || "",
  };
}

/**
 * Everything a lead's order page needs, or null for a bad or unknown slug. `expired` follows the demo's rule
 * (demoBySlug: ended at expires_at, never for a won prospect); `alreadyClient` = a client row for the lead with no
 * cancelled_on; `connected` = a Stripe key (Setup's, else STRIPE_SECRET_KEY) and a webhook secret; `extras` from the
 * settings offer:chatbot_live / offer:review_booster_live ('1' = on); `trader` = traderLine of the business:* settings
 * ("" until both are filled in). The Stripe key itself is never in it.
 * D1: demoBySlug's batch of 4, then 1 settings read, 1 clients read and 2–3 secret reads.
 */
export async function loadOrder(DB, env, slug, now) {
  return (await readOrder(DB, env, slug, clock(now, "loadOrder")))?.order ?? null;
}

const orderHtml = (order, notice, now) => renderOrder({
  lead: order.lead, slug: order.demo.slug, offer: offerFor(now), extras: order.extras, notice, trader: order.trader,
});

// Stage 4's pages, as GET /d/:slug sends them (05-demo.md Part A): an unknown slug is the 404 "This page doesn't
// exist." page, which never says whose; an ended demo the 410 "This preview has ended" page, naming who it was made
// for and, like the demo page's, giving their thread's mailbox address when there is one.
const notFound = () => ({ status: 404, html: renderNotFound() });
const ended = (read) => ({ status: 410, html: renderExpired({ name: read.order.lead.name, contact_email: read.contact_email }) });

/**
 * GET /d/:slug/order → {status, html}: 404 for an unknown slug, 410 for an ended demo, else 200 with today's offer.
 * Notice: already_client, else not_connected (both hide the buttons), else `back` when Stripe sent them back.
 */
export async function orderPage(DB, env, { slug, back = false, now } = {}) {
  const at = clock(now, "orderPage");
  const read = await readOrder(DB, env, slug, at);
  if (!read) return notFound();
  const { order } = read;
  if (order.expired) return ended(read);
  const notice = order.alreadyClient ? "already_client" : !order.connected ? "not_connected" : back ? "back" : null;
  return { status: 200, html: orderHtml(order, notice, at) };
}

// Stripe's message for a todo title or a heartbeat: one line, no "Stripe: " prefix (the sentence already says it).
const refusal = (err) => String(err?.message ?? err ?? "").split("\n")[0].replace(/^Stripe: /, "").slice(0, 300)
  || "no reason given";

/**
 * POST /d/:slug/checkout → {redirect: Stripe Checkout's URL} or {status, html} (the order page with a notice).
 * In this order: a package other than full/website → 400 `failed`; unknown slug → 404; ended demo → 410; Stripe not
 * connected → 503 `not_connected` + todo setup:stripe; a client already → 409 `already_client`; CHECKOUT_LIMIT
 * order_clicks for the slug in the last 60 minutes → 429 `busy` (checked by the statement that records this
 * order_click, so racing POSTs can't get past it; a refused 6th isn't recorded). Then, with the order_click recorded
 * (failed attempts count), the Checkout Session is made: weekend price when checkoutWeekend(now, seen === "weekend"), the prospect's
 * email prefilled. Stripe refusing (or unreachable) → 502 `failed`, todo payment:checkout:<place_id> and a failed
 * `stripe` heartbeat (the red Payments light). Never a Stripe call before every check has passed.
 */
export async function startCheckout(DB, env, { slug, pkg, seen, origin, now, fetchImpl = fetch } = {}) {
  const at = clock(now, "startCheckout");
  const read = await readOrder(DB, env, slug, at);
  const order = read?.order ?? null;
  if (!PACKAGE_NAMES.has(pkg)) {
    const html = !order ? renderNotFound() : order.expired ? ended(read).html : orderHtml(order, "failed", at);
    return { status: 400, html };
  }
  if (!order) return notFound();
  if (order.expired) return ended(read);
  const { lead, demo } = order;
  if (!order.connected) {
    await addTodo(DB, {
      kind: "setup", title: `Connect Stripe: ${lead.name} tried to order`, link: "/#/setup", place_id: lead.place_id,
      dedupe: "setup:stripe",
    });
    return { status: 503, html: orderHtml(order, "not_connected", at) };
  }
  if (order.alreadyClient) return { status: 409, html: orderHtml(order, "already_client", at) };
  const since = iso(at.getTime() - LIMIT_WINDOW_MS);
  const { meta } = await DB.prepare(CLICK_SQL).bind(demo.slug, demo.place_id, iso(at), since, CHECKOUT_LIMIT).run();
  if (!(meta?.changes > 0)) return { status: 429, html: orderHtml(order, "busy", at) };

  const params = checkoutParams({
    pkg, weekend: checkoutWeekend(at, seen === "weekend"), lead, slug: demo.slug,
    email: order.prospect?.email ?? null, origin,
  });
  try {
    const session = await stripeApi(read.key, "POST", "checkout/sessions", params, fetchImpl);
    const url = typeof session?.url === "string" && /^https:\/\//.test(session.url) ? session.url : "";
    if (!url) throw new Error("Stripe made the checkout but sent back no payment page link.");
    return { redirect: url };
  } catch (err) {
    const why = refusal(err);
    await addTodo(DB, {
      kind: "payment", title: `${lead.name} tried to pay but Stripe refused: ${why}`, link: "/#/setup",
      place_id: lead.place_id, dedupe: `payment:checkout:${lead.place_id}`,
    });
    await beat(DB, "stripe", false, `Checkout refused: ${why}`, at);
    return { status: 502, html: orderHtml(order, "failed", at) };
  }
}

// ---------------------------------------------------------------- the thanks page (Task 10)

// A Checkout Session id as Stripe makes them (cs_test_… / cs_live_…, about 66 characters). Anything else never
// reaches Stripe: it goes into the request path. (Exported for d/[slug]/thanks.js's fallback page.)
export const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{1,250}$/;
const PAID = new Set(["paid", "no_payment_required"]);
const SLUG_RE = /^[a-z0-9-]{3,60}$/;

/**
 * GET /d/:slug/thanks?session_id=… → {status, html}. Fetches the Checkout Session from Stripe (its subscription
 * expanded, for the first charge date: Stripe's trial_end); it must be paid (or need
 * no payment) and its client_reference_id (and metadata.place_id, when set) must be this demo's lead. Then it runs
 * fulfilCheckout (idempotent, so the webhook arriving before or after changes nothing) and shows "you're all set" with
 * the onboarding link, origin + "/onboard/" + token (origin = the host they came back to).
 *  - a session id not shaped like cs_…, an unknown slug, a session Stripe doesn't know, an unpaid one or one for
 *    another lead → 404 "We couldn't find that payment" (no Stripe call for a bad id or slug; a slug that isn't a
 *    slug gets the plain 404 page, since there's no order page to link to);
 *  - Stripe unreachable, refusing, or not connected, or fulfilling failing → 200 "Your payment is being confirmed"
 *    (the webhook does the work and the welcome email brings the link).
 * The demo's live/expired rule doesn't apply: someone who paid is always thanked.
 */
export async function thanksPage(DB, env, { slug, sessionId, origin, now, fetchImpl = fetch } = {}) {
  const at = clock(now, "thanksPage");
  const found = await demoBySlug(DB, slug, at);
  if (!found) {
    const valid = typeof slug === "string" && SLUG_RE.test(slug);
    return { status: 404, html: valid ? renderThanks({ slug, outcome: "not_found" }) : renderNotFound() };
  }
  const { lead, demo } = found;
  const view = (status, outcome, extra = {}) => ({ status, html: renderThanks({ lead, slug: demo.slug, outcome, ...extra }) });
  const notFound = () => view(404, "not_found");
  const pending = () => view(200, "pending");
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return notFound();

  let session;
  try {
    const key = await stripeKey(env, DB);
    // the subscription expanded: its trial_end is the day Stripe takes the first monthly payment
    session = await stripeApi(key?.key ?? null, "GET", `checkout/sessions/${sessionId}?expand[]=subscription`, null, fetchImpl);
  } catch (err) {
    // 404: Stripe has no such session (a made-up or other-mode id). Anything else: we can't tell yet.
    return err?.status === 404 ? notFound() : pending();
  }
  const s = session && typeof session === "object" ? session : {};
  const metaPlace = typeof s.metadata?.place_id === "string" ? s.metadata.place_id : "";
  if (s.id !== sessionId || s.client_reference_id !== lead.place_id || (metaPlace && metaPlace !== lead.place_id)) {
    return notFound();
  }
  if (!PAID.has(s.payment_status)) return notFound();

  let res;
  try {
    res = await fulfilCheckout(DB, s, { now: at });
  } catch {
    return pending(); // the webhook retries until it works, and its welcome email carries the link
  }
  if (res.status !== "ok") return notFound();
  // No onboarding token to link to (it should always be there): "you're all set" without the form link would leave
  // them stuck, so they get the pending page, which is true (the welcome email carries the link).
  if (!res.token) return pending();
  return view(200, "done", {
    onboardUrl: `${origin}/onboard/${res.token}`,
    terms: res.terms, amountPaid: res.amountPaid, firstChargeOn: res.firstChargeOn,
  });
}
