// Demo sites: the slug, the weekend rule and the old ended page left in _lib/demo.js, and the order page (stage 9
// moved it to _lib/order-page.js, drawn by _lib/checkout.js's orderPage; its own tests are order-page.test.mjs and
// checkout-route.test.mjs). The demo page, ensureDemo and view counting are tested in demo-render, demo-db and
// demo-routes. Run: node --test control-room/tests/demo.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import * as oldDemo from "../functions/_lib/demo.js";
import { isWeekendUK, renderExpired, slugFor } from "../functions/_lib/demo.js";
import { BUILD_GUARANTEE, GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { renderOrder } from "../functions/_lib/order-page.js";
// The shared D1 stand-in: demoBySlug reads with DB.batch, which this file's old hand-made one didn't answer as D1 does.
import { fakeD1 } from "./helpers/fakeD1.mjs";

const LEAD = { place_id: "p1", name: "DIAMOND KICKBOXING ACADEMY LTD", trade: "Kickboxing", town: "Warrington",
  phone: "07969 770905", rating: 4.7, review_count: 12 };
const SLUG = "diamond-kickboxing-academy-abc234";
const WEDNESDAY = new Date("2026-10-07T10:00:00Z");
const SATURDAY = new Date("2026-10-10T10:00:00Z");
const order = (now, extras = { chatbot: false, reviews: false }) =>
  renderOrder({ lead: LEAD, slug: SLUG, offer: offerFor(now), extras, notice: null, trader: "" });

test("slugs are readable and unguessable", () => {
  const s = slugFor("Smith & Sons Roofing Ltd");
  assert.match(s, /^smith-and-sons-roofing-[a-z2-9]{6}$/);
  assert.notEqual(slugFor("Smith"), slugFor("Smith"));
});

test("the old order page is gone from _lib/demo.js; what's kept stays", () => {
  assert.equal("renderOrder" in oldDemo, false, "the order page lives in _lib/order-page.js now");
  assert.ok(isWeekendUK(SATURDAY));
  assert.ok(!isWeekendUK(WEDNESDAY));
  assert.match(renderExpired(LEAD), /preview has ended/);
});

test("the order page follows the offer: weekday prices, weekend deal, forms post to this demo's checkout", () => {
  const weekday = order(WEDNESDAY);
  assert.match(weekday, /£1,950/);
  assert.match(weekday, /First 60 days free/);
  assert.ok(weekday.includes(`action="/d/${SLUG}/checkout"`));
  assert.ok(weekday.includes('name="seen" value="weekday"'));
  assert.match(weekday, /No contract/);
  assert.doesNotMatch(weekday, /buy\.stripe\.com|client_reference_id/, "no payment links any more");
  const weekend = order(SATURDAY);
  assert.match(weekend, /£1,750/);
  // The struck-through price is the real weekday price, never £2,000 (truth rule: a false price comparison).
  assert.match(weekend, /<s>£1,950<\/s> £1,750/);
  assert.doesNotMatch(weekend, /£2,000/);
  assert.doesNotMatch(weekday, /<s>/);
  assert.match(weekend, /First 90 days free/);
  assert.ok(weekend.includes('name="seen" value="weekend"'));
});

test("the order page offers no extra whose switch is off, and words the guarantee as overview §9 does", () => {
  const EXTRAS = /receptionist|chatbot|chat assistant|review booster/i;
  const OLD_GUARANTEE = /work free until you are|working for free until you are|Front page of Google in 90 days/;
  for (const now of [WEDNESDAY, SATURDAY]) {
    // Both switches default off: nothing shows the chatbot or the review booster (truth rule).
    for (const html of [renderOrder({ lead: LEAD, slug: SLUG, offer: offerFor(now) }), order(now)]) {
      assert.doesNotMatch(html, EXTRAS);
      assert.doesNotMatch(html, OLD_GUARANTEE);
      assert.ok(html.includes(GUARANTEE.headline), "the Full Package lists the guarantee headline");
      assert.ok(html.includes(GUARANTEE.section), "the FAQ has the guarantee section");
      assert.ok(html.includes(BUILD_GUARANTEE), "Website Only lists the build guarantee");
    }
    // Each extra shows once its own switch is on, and only that one.
    const reviews = order(now, { chatbot: false, reviews: true });
    assert.match(reviews, /<li>Review booster: /);
    assert.doesNotMatch(reviews, /receptionist|chatbot|chat assistant/i);
    const chat = order(now, { chatbot: true, reviews: false });
    assert.match(chat, /<li>A chat assistant on your website/);
    assert.doesNotMatch(chat, /review booster/i);
  }
});

test("the order route reads the extras switches and passes them on", async () => {
  const { onRequestGet } = await import("../functions/d/[slug]/order.js");
  const DB = fakeD1();
  const later = new Date(Date.now() + 7 * 86400000).toISOString();
  DB.raw.prepare("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', 'x', 'x')").run();
  DB.raw.prepare("INSERT INTO demos (slug, place_id, created_at, expires_at) VALUES ('smith-roofing-abc234', 'p1', 'x', ?)").run(later);
  const request = new Request("https://aetoswebsites.com/d/smith-roofing-abc234/order");
  const html = async () => (await onRequestGet({ request, env: { DB }, params: { slug: "smith-roofing-abc234" } })).text();
  const off = await html();
  assert.match(off, /Get your new website live in 7 days/);
  assert.doesNotMatch(off, /review booster|receptionist/i);
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('offer:review_booster_live', '1')").run();
  assert.match(await html(), /<li>Review booster: /);
});
