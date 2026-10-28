// Stage 9 (Order and pay) relies on these parts of the offer: today's prices, the weekend boundaries either side of
// the October clock change, the 30-minute checkout grace, and the exact wording the order page prints, including the
// build guarantee's note this stage adds (BUILD_GUARANTEE_NOTE).
// Run: node --test control-room/tests/offer-order.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILD_GUARANTEE, BUILD_GUARANTEE_NOTE, GUARANTEE, NO_CONTRACT, PACKAGES, WEEKEND_BANNER,
  checkoutWeekend, formatPounds, offerFor, termsFor,
} from "../functions/_lib/offer.js";

test("offerFor weekday", () => {
  const o = offerFor(new Date("2026-10-19T10:00:00Z"));
  assert.equal(o.weekend, false);
  assert.equal(o.banner, null);
  assert.equal(o.full.build, 195000);
  assert.equal(o.full.freeDays, 60);
  assert.equal(o.full.monthly, 24900);
  assert.equal(o.website.build, 175000);
  assert.equal(o.full.wasBuild, undefined);
});

test("offerFor weekend boundaries (BST change)", () => {
  assert.equal(offerFor(new Date("2026-10-23T22:59:00Z")).weekend, false); // Fri 23:59 BST
  const sat = offerFor(new Date("2026-10-23T23:00:00Z")); // Sat 00:00 BST
  assert.equal(sat.weekend, true);
  assert.equal(sat.banner, "Weekend price — ends Sunday midnight");
  assert.equal(sat.full, PACKAGES.weekend);
  assert.equal(sat.full.build, 175000);
  assert.equal(sat.full.freeDays, 90);
  assert.equal(sat.full.wasBuild, 195000);
  assert.equal(offerFor(new Date("2026-10-25T23:59:00Z")).weekend, true); // Sun 23:59 GMT
  assert.equal(offerFor(new Date("2026-10-26T00:00:00Z")).weekend, false); // Mon 00:00 GMT
});

test("checkoutWeekend grace", () => {
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:25:00Z"), true), true);
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:31:00Z"), true), false);
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:25:00Z"), false), false);
  assert.equal(checkoutWeekend(new Date("2026-10-24T12:00:00Z"), false), true);
});

test("termsFor", () => {
  assert.equal(termsFor("full", true).key, "weekend");
  assert.equal(termsFor("website", true).build, 175000);
});

test("formatPounds", () => {
  assert.equal(formatPounds(195000), "£1,950");
  assert.equal(formatPounds(24950), "£249.50");
  assert.equal(formatPounds(-24900), "-£249");
});

test("exact wording", () => {
  assert.equal(GUARANTEE.headline, "Top 3 in Google search results in 90 days. GUARANTEED.");
  assert.equal(GUARANTEE.section, "The guarantee: we will work for FREE if you aren't in the top 3 of Google results within 90 days.");
  assert.equal(BUILD_GUARANTEE, "Website live in 7 days, GUARANTEED.");
  assert.equal(BUILD_GUARANTEE_NOTE, "(clock starts when your onboarding form is complete)");
  assert.equal(`${BUILD_GUARANTEE} ${BUILD_GUARANTEE_NOTE}`,
    "Website live in 7 days, GUARANTEED. (clock starts when your onboarding form is complete)");
  assert.equal(WEEKEND_BANNER, "Weekend price — ends Sunday midnight");
  assert.equal(NO_CONTRACT, "No contract. No cancellation fees. If we're not making you money, we don't want your money.");
});
