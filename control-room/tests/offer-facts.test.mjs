// offerFacts: the offer in whole pounds for Claude's replies (built from PACKAGES, no second copy of any price).
// Run: node --test control-room/tests/offer-facts.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { BUILD_GUARANTEE, GUARANTEE, offerFacts } from "../functions/_lib/offer.js";

test("weekday offer", () => {
  const o = offerFacts(new Date("2026-10-21T10:00:00Z"));
  assert.equal(o.weekend, false);
  assert.equal(o.weekend_ends_at, null);
  assert.deepEqual(o.full, { build: 1950, anchor: 1950, monthly: 249, free_days: 60 });
  assert.deepEqual(o.website_only, { build: 1750 });
  assert.deepEqual([...o.amounts].sort((a, b) => a - b), [249, 1750, 1950]);
  assert.ok(o.guarantees.includes(GUARANTEE.headline));
  assert.ok(o.guarantees.includes(GUARANTEE.section));
  assert.ok(o.terms.some((t) => /no contract/i.test(t)));
});

test("weekend offer ends Monday 00:00 UK, across the clock change", () => {
  const o = offerFacts(new Date("2026-10-24T10:00:00Z"));
  assert.equal(o.weekend, true);
  assert.deepEqual(o.full, { build: 1750, anchor: 1950, monthly: 249, free_days: 90 });
  assert.equal(o.weekend_ends_at, "2026-10-26T00:00:00Z");
});

test("extras are listed only when switched on", () => {
  const off = offerFacts(new Date("2026-10-21T10:00:00Z"));
  assert.ok(!off.included.some((l) => /chat assistant|Google reviews/i.test(l)));
  const on = offerFacts(new Date("2026-10-21T10:00:00Z"), { chatbot: true, reviews: true });
  assert.ok(on.included.includes("A chat assistant on your website."));
  assert.ok(on.included.some((l) => /Google reviews/.test(l)));
});

test("Sunday in BST and Sunday 23:59 UK both end at the same Monday 00:00 UK", () => {
  // Sat 00:30 BST (Fri 23:30 UTC) and Sun 23:59 GMT (after the clocks went back).
  assert.equal(offerFacts(new Date("2026-10-23T23:30:00Z")).weekend_ends_at, "2026-10-26T00:00:00Z");
  assert.equal(offerFacts(new Date("2026-10-25T23:59:00Z")).weekend_ends_at, "2026-10-26T00:00:00Z");
  // A summer weekend: Monday 00:00 BST is Sunday 23:00 UTC.
  assert.equal(offerFacts(new Date("2026-07-04T12:00:00Z")).weekend_ends_at, "2026-07-05T23:00:00Z");
  assert.equal(offerFacts(new Date("2026-10-26T00:00:00Z")).weekend, false);
});

test("exact terms, guarantees and included lines, in order", () => {
  const o = offerFacts(new Date("2026-10-21T10:00:00Z"), { chatbot: true, reviews: true });
  assert.deepEqual(o.terms, [
    "No contract and no cancellation fees.",
    "If we're not making you money, we don't want your money.",
    "If you stop paying, you keep the website; the monthly work stops.",
    "Your card is taken at checkout and charged automatically when the free days end.",
  ]);
  assert.deepEqual(o.included, [
    "A new website, live within 7 days of you sending us your details.",
    "Monthly work to get you into the top 3 on Google for your main service in your town.",
    "Getting more Google reviews from your customers: your review link, QR card and messages.",
    "A chat assistant on your website.",
    "A monthly report.",
    "If you haven't got a domain, we buy one in your name and you keep it.",
  ]);
  assert.deepEqual(o.guarantees, [GUARANTEE.headline, GUARANTEE.section, BUILD_GUARANTEE]);
  assert.equal(offerFacts(new Date("2026-10-21T10:00:00Z"), { reviews: true }).included.length, 5);
  // A caller changing its copy never changes the next call's facts.
  o.terms.push("x"); o.guarantees.length = 0; o.full.build = 1;
  const again = offerFacts(new Date("2026-10-21T10:00:00Z"));
  assert.equal(again.terms.length, 4); assert.equal(again.guarantees.length, 3); assert.equal(again.full.build, 1950);
  assert.equal(new Set(o.amounts).size, o.amounts.length);
  for (const n of [...o.amounts, o.full.build, o.full.monthly, o.website_only.build]) assert.ok(Number.isInteger(n));
});

test("rejects a bad date", () => {
  assert.throws(() => offerFacts(new Date("nope")), /valid date/);
});
