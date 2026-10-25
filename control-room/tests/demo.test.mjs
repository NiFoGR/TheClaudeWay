// Demo sites: the slug and the order page (stage 9 moves these). The demo page, ensureDemo and view counting are tested
// in demo-render, demo-db and demo-routes. Run: node --test control-room/tests/demo.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { isWeekendUK, renderExpired, renderOrder, slugFor } from "../functions/_lib/demo.js";
import { BUILD_GUARANTEE, GUARANTEE } from "../functions/_lib/offer.js";
// The shared D1 stand-in: demoBySlug reads with DB.batch, which this file's old hand-made one didn't answer as D1 does.
import { fakeD1 } from "./helpers/fakeD1.mjs";

const LEAD = { place_id: "p1", name: "DIAMOND KICKBOXING ACADEMY LTD", trade: "Kickboxing", town: "Warrington",
  phone: "07969 770905", rating: 4.7, review_count: 12 };
const DEMO = { slug: "diamond-kickboxing-academy-abc234", expires_at: "2026-10-18T12:00:00Z" };

test("slugs are readable and unguessable", () => {
  const s = slugFor("Smith & Sons Roofing Ltd");
  assert.match(s, /^smith-and-sons-roofing-[a-z2-9]{6}$/);
  assert.notEqual(slugFor("Smith"), slugFor("Smith"));
});

test("the order page follows the offer: weekday prices, weekend deal, links carry the lead", () => {
  const links = { full: { url: "https://buy.stripe.com/full" }, weekend: { url: "https://buy.stripe.com/wknd" }, website: { url: "https://buy.stripe.com/site" } };
  const weekday = renderOrder(LEAD, DEMO, links, new Date("2026-10-07T10:00:00Z"));
  assert.match(weekday, /£1,950/);
  assert.match(weekday, /first 60 days free/);
  assert.match(weekday, /buy\.stripe\.com\/full\?client_reference_id=p1/);
  assert.match(weekday, /No contract/);
  const weekend = renderOrder(LEAD, DEMO, links, new Date("2026-10-10T10:00:00Z"));
  assert.ok(isWeekendUK(new Date("2026-10-10T10:00:00Z")));
  assert.match(weekend, /£1,750/);
  // The struck-through price is the real weekday price, never £2,000 (truth rule: a false price comparison).
  assert.match(weekend, /<span class="was">£1,950<\/span>£1,750/);
  assert.doesNotMatch(weekend, /£2,000/);
  assert.doesNotMatch(weekday, /class="was"/);
  assert.match(weekend, /first 90 days free/);
  assert.match(weekend, /buy\.stripe\.com\/wknd/);
  assert.match(renderOrder(LEAD, DEMO, {}), /go off/); // no Stripe yet: buttons disabled, not broken
  assert.match(renderExpired(LEAD), /preview has ended/);
});

test("the order page offers no extra whose switch is off, and words the guarantee as overview §9 does", () => {
  const escaped = (t) => t.replace(/'/g, "&#39;");
  const EXTRAS = /receptionist|chatbot|chat assistant|review booster/i;
  const OLD_GUARANTEE = /work free until you are|working for free until you are|Front page of Google in 90 days/;
  for (const now of [new Date("2026-10-07T10:00:00Z"), new Date("2026-10-10T10:00:00Z")]) {
    // Both switches default off: nothing shows the chatbot or the review booster (truth rule).
    for (const html of [renderOrder(LEAD, DEMO, {}, now), renderOrder(LEAD, DEMO, {}, now, { chatbot: false, reviews: false })]) {
      assert.doesNotMatch(html, EXTRAS);
      assert.doesNotMatch(html, OLD_GUARANTEE);
      assert.ok(html.includes(GUARANTEE.headline), "the Full Package lists the guarantee headline");
      assert.ok(html.includes(escaped(GUARANTEE.section)), "the FAQ has the guarantee section");
      assert.ok(html.includes(BUILD_GUARANTEE), "Website Only lists the build guarantee");
    }
    // The review booster shows once its switch is on; the chatbot's line comes with stage 10, so never here.
    const reviews = renderOrder(LEAD, DEMO, {}, now, { chatbot: false, reviews: true });
    assert.match(reviews, /<li>Review booster<\/li>/);
    assert.doesNotMatch(reviews, /receptionist|chatbot|chat assistant/i);
    assert.doesNotMatch(renderOrder(LEAD, DEMO, {}, now, { chatbot: true, reviews: false }), EXTRAS);
  }
});

test("the order route reads the extras switches and passes them on", async () => {
  const { onRequestGet } = await import("../functions/d/[slug]/order.js");
  const DB = fakeD1();
  const later = new Date(Date.now() + 7 * 86400000).toISOString();
  DB.raw.prepare("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', 'x', 'x')").run();
  DB.raw.prepare("INSERT INTO demos (slug, place_id, created_at, expires_at) VALUES ('smith-roofing-abc234', 'p1', 'x', ?)").run(later);
  const html = async () => (await onRequestGet({ env: { DB }, params: { slug: "smith-roofing-abc234" } })).text();
  const off = await html();
  assert.match(off, /Make it yours/);
  assert.doesNotMatch(off, /review booster|receptionist/i);
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('offer:review_booster_live', '1')").run();
  assert.match(await html(), /<li>Review booster<\/li>/);
});
