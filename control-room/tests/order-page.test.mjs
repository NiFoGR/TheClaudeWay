// Stage 9 (Order and pay) Task 4: the order page and the thanks page (docs/rebuild/08-order-pay.md Part A, "Order page
// /d/:slug/order" and "Thanks page"). The copy is Part A's word for word, prices come from offer.js only, extras are
// listed only when they're live, notices that block ordering hide the buttons, and every lead string is escaped.
// Run: node --test control-room/tests/order-page.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILD_GUARANTEE, BUILD_GUARANTEE_NOTE, GUARANTEE, NO_CONTRACT, offerFor, termsFor,
} from "../functions/_lib/offer.js";
import { ORDER_NOTICES, renderOrder, renderThanks, ukLongDate } from "../functions/_lib/order-page.js";

const LEAD = { place_id: "p1", name: "Smith Roofing" };
const SLUG = "smith-roofing";
const WEEKDAY = offerFor(new Date("2026-10-19T10:00:00Z")); // Monday
const WEEKEND = offerFor(new Date("2026-10-24T12:00:00Z")); // Saturday
const NO_EXTRAS = { chatbot: false, reviews: false };

const order = (o = {}) => renderOrder({ lead: LEAD, slug: SLUG, offer: WEEKDAY, extras: NO_EXTRAS, notice: null, trader: "", ...o });
const footerOf = (html) => {
  const m = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/);
  assert.ok(m, "the page has a footer");
  return m[1];
};
const textOf = (fragment) => fragment.replace(/<[^>]+>/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);

test("weekday page", () => {
  const html = order();
  for (const s of [
    "£1,950",
    "then £249/month. First 60 days free.",
    "Recommended",
    GUARANTEE.headline,
    GUARANTEE.section,
    `${BUILD_GUARANTEE} ${BUILD_GUARANTEE_NOTE}`,
    NO_CONTRACT,
    "Nothing more to pay until day 61. Cancel any time.",
    'name="package" value="full"',
    'name="seen" value="weekday"',
    'action="/d/smith-roofing/checkout"',
  ]) assert.ok(html.includes(s), `missing: ${s}`);
  assert.ok(!html.includes("Weekend price — ends"));
  assert.ok(!html.includes("Most popular"));
  // The rest of Part A's copy, exactly.
  for (const s of [
    "<title>Order your website · Smith Roofing</title>",
    '<meta name="robots" content="noindex,nofollow">',
    "Aetos Websites · for Smith Roofing",
    'href="/d/smith-roofing"',
    "← Back to your site",
    "Get your new website live in 7 days",
    "Pick a plan and pay securely by card. Straight after, we email you a short form. Your website goes live within 7 days of it being complete.",
    "Your new website, finished with your own logo, photos and details",
    "We work on it every month to get you into Google's top 3 for your main service and town",
    "Hosting included",
    "A plain-English report every month",
    "Order the Full Package",
    'name="package" value="website"',
    "Order Website Only",
    "£1,750",
    "one-off. Nothing monthly.",
    "Full Package only. Measured on Google's results for your main service and town, searched from your area. The map results at the top count.",
    "If you stop the monthly plan, you keep your website.",
    "What happens after I pay?",
    "We email you a short form for your logo, photos, services and the areas you cover. Your 7 days start when it's complete, and your website is live within 7 days of that. Guaranteed.",
    "Can I cancel?",
    "Yes, any time. Reply to any of our emails and we'll stop your monthly plan that day. No contract and no cancellation fees.",
    "Do I keep the website if I stop?",
    "What happens when the free days end?",
    "On day 61 we take £249 from the card you paid with, then the same each month. Don't want to carry on? Tell us before then and you won't be charged.",
    "How do you measure the top 3?",
    "Is paying online safe?",
    "Yes. Payments are taken by Stripe, which handles card payments for millions of businesses. We never see your card details.",
    "Payments are taken securely by Stripe. We count visits to this page so we know you've seen it.",
  ]) assert.ok(html.includes(s), `missing: ${s}`);
  // Questions in Part A's order.
  const qs = ["What happens after I pay?", "Can I cancel?", "Do I keep the website if I stop?",
    "What happens when the free days end?", "How do you measure the top 3?", "Is paying online safe?"];
  const at = qs.map((q) => html.indexOf(q));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "questions in order");
  assert.equal((html.match(/<details/g) ?? []).length, 6);
  // No weekend strike-through on a weekday, and the order_page beacon after 4 seconds.
  assert.ok(!html.includes("<s>"));
  assert.ok(html.includes(`navigator.sendBeacon("/d/smith-roofing/e", '{"kind":"order_page"}')`));
  assert.match(html, /setTimeout\([\s\S]*4000\)/);
  // The buttons carry no beacon: order_click is the server's.
  assert.ok(!html.includes("order_click"));
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});

test("FAQ 5 uses the guarantee wording", () => {
  for (const offer of [WEEKDAY, WEEKEND]) {
    const html = order({ offer });
    assert.ok(html.includes(`The map results at the top count. ${GUARANTEE.section}`));
    assert.ok(html.includes(`On Google's results for your main service and town (for example "roofer Leeds"), searched from your area. The map results at the top count. ${GUARANTEE.section}`));
    assert.doesNotMatch(html, /work for free until you are/);
  }
});

test("weekend page", () => {
  const html = order({ offer: WEEKEND });
  for (const s of [
    "Weekend price — ends Sunday midnight",
    "<s>£1,950</s>",
    "£1,750",
    "First 90 days free.",
    "until day 91",
    'value="weekend"',
    "then £249/month. First 90 days free.",
    "Nothing more to pay until day 91. Cancel any time.",
    "Weekend price",
    "On day 91 we take £249",
  ]) assert.ok(html.includes(s), `missing: ${s}`);
  assert.ok(!html.includes("Recommended"));
  assert.ok(!html.includes('value="weekday"'));
  assert.ok(!html.includes("Most popular"));
  // The banner comes before the cards.
  assert.ok(html.indexOf("Weekend price — ends Sunday midnight") < html.indexOf("Order the Full Package"));
});

test("extras only when live", () => {
  const off = order({ extras: { chatbot: false, reviews: false } });
  assert.ok(!off.includes("chat assistant"));
  assert.ok(!off.includes("Review booster"));
  assert.ok(off.includes("Yes. Your website stays live and it's yours. The monthly Google work and the report switch off."));

  const on = order({ extras: { chatbot: true, reviews: true } });
  assert.ok(on.includes("A chat assistant on your website that answers questions and passes enquiries to you, day and night"));
  assert.ok(on.includes("Review booster: your own Google review link, a QR card and ready-made messages to ask every customer for a review"));
  assert.ok(on.includes("The monthly Google work, the report, the chat assistant and the review booster switch off."));

  const chat = order({ extras: { chatbot: true, reviews: false } });
  assert.ok(chat.includes("The monthly Google work, the report and the chat assistant switch off."));
  assert.ok(!chat.includes("Review booster"));
  const reviews = order({ extras: { chatbot: false, reviews: true } });
  assert.ok(reviews.includes("The monthly Google work, the report and the review booster switch off."));
  assert.ok(!reviews.includes("chat assistant"));
  // Extras in Part A's place: after the monthly line, before "Hosting included".
  const i = (s) => on.indexOf(s);
  assert.ok(i("We work on it every month") < i("A chat assistant on your website"));
  assert.ok(i("A chat assistant on your website") < i("Review booster:"));
  assert.ok(i("Review booster:") < i("Hosting included"));
  // Only the string "1"-style switch values the caller turns into booleans count: truthy non-booleans aren't extras.
  const odd = order({ extras: { chatbot: "0", reviews: 1 } });
  assert.ok(!odd.includes("chat assistant"));
  assert.ok(!odd.includes("Review booster"));
});

test("notices hide buttons", () => {
  const already = order({ notice: "already_client" });
  assert.ok(already.includes("Smith Roofing is already with us."));
  assert.ok(already.includes("Smith Roofing is already with us. Check your email for your onboarding form, or reply to it with any questions."));
  assert.ok(!already.includes("<button"));
  assert.ok(!already.includes("<form"));

  const busy = order({ notice: "busy" });
  assert.ok(busy.includes(ORDER_NOTICES.busy));
  assert.ok(busy.includes("You've started a few payments in the last hour. Please wait a little and try again, or reply to our email and we'll help."));
  assert.ok(busy.includes("<button"));
  assert.ok(busy.includes("Order the Full Package"));
  // The notice is above the cards.
  assert.ok(busy.indexOf(ORDER_NOTICES.busy) < busy.indexOf("Order the Full Package"));

  const shown = { back: true, busy: true, failed: true, not_connected: false, already_client: false };
  for (const [key, buttons] of Object.entries(shown)) {
    const html = order({ notice: key });
    const text = ORDER_NOTICES[key].replace("{Business}", "Smith Roofing");
    assert.ok(html.includes(text), `${key} text`);
    assert.equal(html.includes("<button"), buttons, `${key} buttons`);
  }
  assert.equal(ORDER_NOTICES.back, "No payment was taken. Any questions? Just reply to our email.");
  assert.equal(ORDER_NOTICES.failed, "Sorry, the payment page didn't open. Please try again in a few minutes. If it keeps happening, reply to our email and we'll sort it.");
  assert.equal(ORDER_NOTICES.not_connected, "Online ordering is switching on shortly. Reply to our email and we'll send you a payment link.");
  assert.ok(Object.isFrozen(ORDER_NOTICES));
  // No notice, or one that isn't a key (also "toString"), shows no notice box and keeps the buttons.
  for (const notice of [null, undefined, "nope", "toString"]) {
    const html = order({ notice });
    assert.ok(html.includes("<button"));
    for (const key of Object.keys(ORDER_NOTICES)) assert.ok(!html.includes(ORDER_NOTICES[key].slice(0, 30)));
  }
});

test("escaping", () => {
  // Task 4's case as written: only the name changed, no notice, no trader.
  const plain = order({ lead: { ...LEAD, name: "<script>x</script>" } });
  assert.ok(!plain.includes("<script>x"));
  assert.ok(plain.includes("&lt;script&gt;"));
  assert.ok(plain.includes("<title>Order your website · &lt;script&gt;x&lt;/script&gt;</title>"));
  assert.equal((plain.match(/<script/g) ?? []).length, 1);
  // Bidi/control characters can't make the name read differently on screen.
  assert.ok(!order({ lead: { ...LEAD, name: "Smith\u202E gnifooR" } }).includes("\u202E"));
  const html = order({ lead: { ...LEAD, name: "<script>x</script>" }, notice: "already_client", trader: "<b>Nik</b>" });
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<b>Nik</b>"));
  assert.ok(html.includes("&lt;b&gt;Nik&lt;/b&gt;"));
  // A quote in the name can't break out of an attribute or the title, and the only script is the beacon.
  const quoted = order({ lead: { ...LEAD, name: `Bob's "Roofs" & Sons` } });
  assert.ok(quoted.includes("Bob&#39;s &quot;Roofs&quot; &amp; Sons"));
  assert.equal((quoted.match(/<script/g) ?? []).length, 1);
  // A slug that isn't one slugFor makes never reaches a link or the script.
  assert.throws(() => order({ slug: '"><script>alert(1)</script>' }), /slug/);
  assert.throws(() => renderThanks({ lead: LEAD, slug: "../x", outcome: "not_found" }), /slug/);
});

test("trader line", () => {
  const html = order({ trader: "Nik P, trading as Aetos Websites, 1 High St" });
  assert.ok(footerOf(html).includes("Nik P, trading as Aetos Websites, 1 High St"));
  const escaped = order({ trader: "O'Brien & Co <x>" });
  assert.ok(footerOf(escaped).includes("O&#39;Brien &amp; Co &lt;x&gt;"));
  const none = order({ trader: "" });
  assert.deepEqual(textOf(footerOf(none)), ["Payments are taken securely by Stripe. We count visits to this page so we know you've seen it."]);
  const missing = order({ trader: undefined });
  assert.deepEqual(textOf(footerOf(missing)), ["Payments are taken securely by Stripe. We count visits to this page so we know you've seen it."]);
});

test("thanks done (full)", () => {
  // Task 4's call exactly as written (no lead, no slug: "done" prints neither).
  const spec = renderThanks({ outcome: "done", onboardUrl: "https://x.test/onboard/T", terms: termsFor("full", false), amountPaid: 195000, firstChargeOn: "2026-12-18" });
  for (const s of ["Thank you, you're all set", "Your payment of £1,950 has gone through.", 'href="https://x.test/onboard/T"',
    "The first £249 is taken on Friday 18 December 2026."]) assert.ok(spec.includes(s), `missing: ${s}`);
  assert.ok(renderThanks({ outcome: "pending" }).includes("Your payment is being confirmed."));
  assert.throws(() => renderThanks({ outcome: "not_found" }), /slug/);
  assert.throws(() => renderThanks({ slug: "x<y>z", outcome: "done" }), /slug/);
  const html = renderThanks({
    lead: LEAD, slug: SLUG, outcome: "done", onboardUrl: "https://x.test/onboard/T",
    terms: termsFor("full", false), amountPaid: 195000, firstChargeOn: "2026-12-18",
  });
  for (const s of [
    "Thank you, you're all set",
    "Your payment of £1,950 has gone through.",
    'href="https://x.test/onboard/T"',
    "Fill in your onboarding form →",
    "Your 7 days start when the form is complete. Your website will be live within 7 days of that. GUARANTEED.",
    "Your first 60 days of the monthly plan are free. The first £249 is taken on Friday 18 December 2026. Cancel any time before then by replying to our email.",
    "The first £249 is taken on Friday 18 December 2026.",
    "We're also emailing you this link. Questions? Reply to any of our emails.",
    '<meta name="robots" content="noindex,nofollow">',
  ]) assert.ok(html.includes(s), `missing: ${s}`);
  // No beacon on the thanks page.
  assert.ok(!html.includes("sendBeacon"));
  // The weekend deal's 90 free days.
  const weekend = renderThanks({
    lead: LEAD, slug: SLUG, outcome: "done", onboardUrl: "https://x.test/onboard/T",
    terms: termsFor("full", true), amountPaid: 175000, firstChargeOn: "2027-01-17",
  });
  assert.ok(weekend.includes("Your payment of £1,750 has gone through."));
  assert.ok(weekend.includes("Your first 90 days of the monthly plan are free. The first £249 is taken on Sunday 17 January 2027."));
  // An onboarding link that isn't a plain http(s) URL never becomes a link.
  const bad = renderThanks({
    lead: LEAD, slug: SLUG, outcome: "done", onboardUrl: "javascript:alert(1)",
    terms: termsFor("full", false), amountPaid: 195000, firstChargeOn: "2026-12-18",
  });
  assert.ok(!bad.includes("javascript:"));
});

test("thanks website", () => {
  const html = renderThanks({
    lead: LEAD, slug: SLUG, outcome: "done", onboardUrl: "https://x.test/onboard/T",
    terms: termsFor("website", false), amountPaid: 175000, firstChargeOn: null,
  });
  assert.ok(html.includes("Thank you, you're all set"));
  assert.ok(html.includes("Your payment of £1,750 has gone through."));
  assert.ok(html.includes('href="https://x.test/onboard/T"'));
  assert.ok(!html.includes("monthly plan"));
  assert.ok(!html.includes("£249"));
});

test("thanks not_found", () => {
  const html = renderThanks({ lead: LEAD, slug: SLUG, outcome: "not_found" });
  assert.ok(html.includes("We couldn't find that payment"));
  assert.ok(html.includes('href="/d/smith-roofing/order"'));
  assert.ok(html.includes("If you've just paid, your onboarding form will arrive by email in the next few minutes. If you haven't paid yet, you can"));
  assert.ok(!html.includes("you're all set"));
});

test("thanks pending", () => {
  const html = renderThanks({ lead: LEAD, slug: SLUG, outcome: "pending" });
  assert.ok(html.includes("<h1>Thank you</h1>"));
  assert.ok(html.includes("Your payment is being confirmed."));
  assert.ok(html.includes("Your payment is being confirmed. Your onboarding form will arrive by email in the next few minutes."));
  assert.ok(!html.includes("you're all set"));
});

test("ukLongDate", () => {
  assert.equal(ukLongDate("2026-12-18"), "Friday 18 December 2026");
  assert.equal(ukLongDate("2026-10-19"), "Monday 19 October 2026");
  assert.equal(ukLongDate("2027-01-01"), "Friday 1 January 2027");
  assert.throws(() => ukLongDate("18/12/2026"), /YYYY-MM-DD/);
  assert.throws(() => ukLongDate("2026-02-30"), /YYYY-MM-DD/);
});
