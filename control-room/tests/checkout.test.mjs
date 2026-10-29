// Checkout Session parameters (pure). Run: node --test control-room/tests/checkout.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { checkoutParams } from "../functions/_lib/checkout.js";
import { encode } from "../functions/_lib/stripe.js";

const lead = { place_id: "p1", name: "Smith Roofing" };
const base = { lead, slug: "smith-roofing", email: null, origin: "https://x.test" };

// What Stripe receives, decoded so the brackets and braces read as written.
const sent = (args) =>
  decodeURIComponent(encode(checkoutParams({ ...base, ...args })).toString().replace(/\+/g, " "));
// Each part is a whole key=value pair, or the end of one when the spec gives only the key's tail ("currency]=gbp",
// which has a "]" but no "["). A whole key must match exactly, so metadata[weekend] can't be met by a nested one.
const isTail = (part) => /^[^[=]*\]=/.test(part);
const has = (s, part) =>
  assert.ok(
    s.split("&").some((kv) => kv === part || (isTail(part) && kv.endsWith(`[${part}`))),
    `missing ${part} in ${s}`,
  );

test("full weekday", () => {
  const s = sent({ pkg: "full", weekend: false });
  for (const part of [
    "mode=subscription",
    "payment_method_collection=always",
    "line_items[0][price_data][unit_amount]=24900",
    "line_items[0][price_data][recurring][interval]=month",
    "line_items[1][price_data][unit_amount]=195000",
    "subscription_data[trial_period_days]=60",
    "client_reference_id=p1",
    "metadata[package]=full",
    "metadata[weekend]=0",
    "metadata[slug]=smith-roofing",
    "success_url=https://x.test/d/smith-roofing/thanks?session_id={CHECKOUT_SESSION_ID}",
    "cancel_url=https://x.test/d/smith-roofing/order?back=1",
    "currency]=gbp",
    "locale=en-GB",
  ]) has(s, part);
  // Task 7 reads these back off the session.
  has(s, "metadata[place_id]=p1");
  has(s, "metadata[origin]=https://x.test");
});

test("full weekend", () => {
  const s = sent({ pkg: "full", weekend: true });
  has(s, "line_items[1][price_data][unit_amount]=175000");
  has(s, "trial_period_days]=90");
  has(s, "metadata[weekend]=1");
  has(s, "subscription_data[metadata][weekend]=1");
  has(s, "line_items[0][price_data][unit_amount]=24900");
  assert.ok(!s.includes("195000"), "no weekday build price on the weekend");
});

test("exactly the Part A object (full weekday)", () => {
  assert.deepEqual(checkoutParams({ ...base, pkg: "full", weekend: false, email: "a@b.co.uk" }), {
    client_reference_id: "p1",
    customer_email: "a@b.co.uk",
    locale: "en-GB",
    payment_method_types: ["card"],
    phone_number_collection: { enabled: true },
    metadata: { place_id: "p1", package: "full", weekend: "0", slug: "smith-roofing", origin: "https://x.test" },
    success_url: "https://x.test/d/smith-roofing/thanks?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://x.test/d/smith-roofing/order?back=1",
    mode: "subscription",
    payment_method_collection: "always",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "gbp", unit_amount: 24900, recurring: { interval: "month" },
          product_data: { name: "Monthly plan: Google top 3 work, hosting and report" },
        },
      },
      { quantity: 1, price_data: { currency: "gbp", unit_amount: 195000, product_data: { name: "Website build: Smith Roofing" } } },
    ],
    subscription_data: { trial_period_days: 60, metadata: { place_id: "p1", package: "full", weekend: "0" } },
  });
});

test("exactly the Part A object (website)", () => {
  assert.deepEqual(checkoutParams({ ...base, pkg: "website", weekend: false }), {
    client_reference_id: "p1",
    locale: "en-GB",
    payment_method_types: ["card"],
    phone_number_collection: { enabled: true },
    metadata: { place_id: "p1", package: "website", weekend: "0", slug: "smith-roofing", origin: "https://x.test" },
    success_url: "https://x.test/d/smith-roofing/thanks?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://x.test/d/smith-roofing/order?back=1",
    mode: "payment",
    customer_creation: "always",
    // the build invoice is tagged, so invoice.paid knows it from any later one-off invoice for the same customer
    invoice_creation: { enabled: true, invoice_data: { metadata: { aetos_build: "1" } } },
    line_items: [
      { quantity: 1, price_data: { currency: "gbp", unit_amount: 175000, product_data: { name: "Website build: Smith Roofing" } } },
    ],
    payment_intent_data: { metadata: { place_id: "p1", package: "website" } },
  });
});

test("unknown package is refused in plain English", () => {
  assert.throws(() => checkoutParams({ ...base, pkg: "gold", weekend: false }), /must be "full" or "website"/);
});

test("website", () => {
  const s = sent({ pkg: "website", weekend: false });
  has(s, "mode=payment");
  has(s, "customer_creation=always");
  has(s, "invoice_creation[enabled]=true");
  has(s, "invoice_creation[invoice_data][metadata][aetos_build]=1");
  has(s, "line_items[0][price_data][unit_amount]=175000");
  assert.ok(!s.includes("line_items[1]"), "one line item only");
  assert.ok(!s.includes("subscription_data"), "no subscription_data");
  assert.ok(!s.includes("recurring"), "no recurring");
  // The weekend never changes Website Only, and its metadata never claims the weekend deal.
  const wk = sent({ pkg: "website", weekend: true });
  has(wk, "line_items[0][price_data][unit_amount]=175000");
  has(wk, "metadata[weekend]=0");
  has(wk, "payment_intent_data[metadata][place_id]=p1");
  has(wk, "payment_intent_data[metadata][package]=website");
});

test("no email", () => {
  const params = checkoutParams({ ...base, pkg: "full", weekend: false, email: null });
  assert.equal("customer_email" in params, false);
  assert.ok(!sent({ pkg: "full", weekend: false, email: null }).includes("customer_email"));
  assert.ok(!sent({ pkg: "full", weekend: false, email: "" }).includes("customer_email"));
  has(sent({ pkg: "full", weekend: false, email: "a@b.co.uk" }), "customer_email=a@b.co.uk");
  // Stripe would refuse the whole session over a bad address, so it's trimmed or left out.
  has(sent({ pkg: "full", weekend: false, email: " a@b.co.uk " }), "customer_email=a@b.co.uk");
  assert.ok(!sent({ pkg: "full", weekend: false, email: "not an email" }).includes("customer_email"));
});

test("product name", () => {
  has(sent({ pkg: "full", weekend: false }), "line_items[1][price_data][product_data][name]=Website build: Smith Roofing");
  has(sent({ pkg: "website", weekend: false }), "line_items[0][price_data][product_data][name]=Website build: Smith Roofing");
});
