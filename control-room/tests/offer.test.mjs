// The offer: prices, the weekend deal, the checkout grace, pounds formatting and the exact guarantee wording.
// Run: node --test control-room/tests/offer.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILD_GUARANTEE, GUARANTEE, MONTHLY_PENCE, NO_CONTRACT, PACKAGES, WEEKEND_BANNER,
  checkoutWeekend, formatPounds, offerFor, termsFor,
} from "../functions/_lib/offer.js";

const FUNCTIONS = fileURLToPath(new URL("../functions/", import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("offerFor: the weekend deal from Saturday 00:00 UK (Friday 23:30 UTC in BST is Saturday)", () => {
  const sat = offerFor(new Date("2026-10-23T23:30:00Z")); // Sat 00:30 UK
  assert.equal(sat.full.freeDays, 90);
  assert.equal(sat.full.wasBuild, 195000);
  assert.equal(sat.banner, WEEKEND_BANNER);
  assert.equal(sat.weekend, true);
  assert.equal(sat.full, PACKAGES.weekend);
  assert.equal(sat.website, PACKAGES.website);

  const fri = offerFor(new Date("2026-10-23T22:30:00Z")); // Fri 23:30 UK
  assert.equal(fri.full.build, 195000);
  assert.equal(fri.banner, null);
  assert.equal(fri.weekend, false);
  assert.equal(fri.full, PACKAGES.full);
  assert.equal(fri.full.wasBuild, undefined);
  assert.equal(fri.website, PACKAGES.website);
});

test("offerFor: Sunday 23:59 UK is still the weekend, Monday 00:00 UK isn't (after the October clock change)", () => {
  assert.equal(offerFor(new Date("2026-10-25T23:59:00Z")).weekend, true);  // Sun 23:59 GMT
  assert.equal(offerFor(new Date("2026-10-26T00:00:00Z")).weekend, false); // Mon 00:00 GMT
  assert.equal(offerFor(new Date("2026-10-18T22:59:00Z")).weekend, true);  // Sun 23:59 BST
  assert.equal(offerFor(new Date("2026-10-18T23:00:00Z")).banner, null);   // Mon 00:00 BST
});

test("offerFor: the weekend starts at Saturday 00:00 UK in GMT, and follows the March clock change", () => {
  assert.equal(offerFor(new Date("2026-10-30T23:59:00Z")).weekend, false); // Fri 23:59 GMT
  assert.equal(offerFor(new Date("2026-10-31T00:00:00Z")).full, PACKAGES.weekend); // Sat 00:00 GMT
  assert.equal(offerFor(new Date("2026-03-28T00:00:00Z")).weekend, true);  // Sat 00:00 GMT, before the change
  assert.equal(offerFor(new Date("2026-03-29T01:30:00Z")).weekend, true);  // Sun 02:30 BST, just after it
  assert.equal(offerFor(new Date("2026-03-29T22:59:00Z")).weekend, true);  // Sun 23:59 BST
  assert.equal(offerFor(new Date("2026-03-29T23:00:00Z")).full, PACKAGES.full); // Mon 00:00 BST
});

test("offerFor and checkoutWeekend refuse a bad date instead of quietly picking a price", () => {
  assert.throws(() => offerFor(new Date("not a date")), /valid date/);
  assert.throws(() => offerFor(undefined), /valid date/);
  assert.throws(() => offerFor("2026-10-24"), /valid date/);
  assert.throws(() => checkoutWeekend(new Date("not a date"), true), /valid date/);
});

test("PACKAGES carry the decided prices; MONTHLY_PENCE is the Full Package's monthly fee", () => {
  assert.deepEqual(PACKAGES, {
    full: { key: "full", label: "Full Package", build: 195000, monthly: 24900, freeDays: 60 },
    weekend: { key: "weekend", label: "Weekend deal", build: 175000, wasBuild: 195000, monthly: 24900, freeDays: 90 },
    website: { key: "website", label: "Website Only", build: 175000, monthly: 0, freeDays: 0 },
  });
  // Key order is part of the contract: Stripe links and the Money page's package picker list them in this order.
  assert.deepEqual(Object.keys(PACKAGES), ["full", "weekend", "website"]);
  assert.deepEqual(Object.keys(PACKAGES.full), ["key", "label", "build", "monthly", "freeDays"]);
  assert.deepEqual(Object.keys(PACKAGES.weekend), ["key", "label", "build", "wasBuild", "monthly", "freeDays"]);
  assert.deepEqual(Object.keys(PACKAGES.website), ["key", "label", "build", "monthly", "freeDays"]);
  for (const [k, p] of Object.entries(PACKAGES)) assert.equal(p.key, k);
  // The struck-through weekend price is the real weekday price, never a price we don't charge (truth rule).
  assert.equal(PACKAGES.weekend.wasBuild, PACKAGES.full.build);
  assert.equal(MONTHLY_PENCE, 24900);
  assert.equal(MONTHLY_PENCE, PACKAGES.full.monthly);
});

test("PACKAGES can't be changed by a caller", () => {
  assert.throws(() => { PACKAGES.full.build = 1; }, TypeError);
  assert.throws(() => { PACKAGES.extra = {}; }, TypeError);
  assert.throws(() => { GUARANTEE.headline = "x"; }, TypeError);
  assert.equal(PACKAGES.full.build, 195000);
});

test("termsFor picks the package a checkout is charged at", () => {
  assert.equal(termsFor("full", true).key, "weekend");
  assert.equal(termsFor("full", false).build, 195000);
  assert.equal(termsFor("website", true).build, 175000);
  assert.equal(termsFor("full", true), PACKAGES.weekend);
  assert.equal(termsFor("full", false), PACKAGES.full);
  assert.equal(termsFor("website", true), PACKAGES.website);
  assert.equal(termsFor("website", false), PACKAGES.website);
});

test("termsFor refuses a package that doesn't exist, in plain English", () => {
  assert.throws(() => termsFor("weekend", true), /Unknown package "weekend": it must be "full" or "website"/);
  assert.throws(() => termsFor(undefined, false), /Unknown package/);
  assert.throws(() => termsFor("x".repeat(100), false), /^Error: Unknown package "x{40}": it must be/);
});

test("checkoutWeekend: 30 minutes' grace after Sunday midnight UK, only for a page seen on the weekend", () => {
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:25:00Z"), true), true);
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:31:00Z"), true), false);
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:25:00Z"), false), false);
  assert.equal(checkoutWeekend(new Date("2026-10-24T12:00:00Z"), false), true);
});

test("checkoutWeekend: the grace follows UK midnight in BST too, and Friday has none", () => {
  assert.equal(checkoutWeekend(new Date("2026-10-18T23:29:00Z"), true), true);   // Mon 00:29 BST
  assert.equal(checkoutWeekend(new Date("2026-10-18T23:31:00Z"), true), false);  // Mon 00:31 BST
  assert.equal(checkoutWeekend(new Date("2026-10-23T22:59:00Z"), true), false);  // Fri 23:59 BST, before the weekend
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:25:00Z"), undefined), false); // always a real boolean
});

test("checkoutWeekend: the grace follows UK midnight after the March clock change", () => {
  assert.equal(checkoutWeekend(new Date("2026-03-29T23:29:00Z"), true), true);   // Mon 00:29 BST
  assert.equal(checkoutWeekend(new Date("2026-03-29T23:30:00Z"), true), false);  // Mon 00:30 BST
  assert.equal(checkoutWeekend(new Date("2026-03-29T23:10:00Z"), false), false); // Mon 00:10 BST, weekday page
});

test("checkoutWeekend: the grace ends at 00:30 Monday UK, and a weekend page seen later gets the weekday price", () => {
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:29:59.999Z"), true), true);
  assert.equal(checkoutWeekend(new Date("2026-10-26T00:30:00Z"), true), false);
  assert.equal(checkoutWeekend(new Date("2026-10-26T09:00:00Z"), true), false);  // Monday morning
  assert.equal(checkoutWeekend(new Date("2026-10-25T23:59:00Z"), false), true);  // still Sunday (GMT)
  assert.equal(termsFor("full", checkoutWeekend(new Date("2026-10-26T00:10:00Z"), true)).build, 175000);
  assert.equal(termsFor("full", checkoutWeekend(new Date("2026-10-26T00:10:00Z"), false)).build, 195000);
});

test("formatPounds: whole pounds without pennies, otherwise two decimals, negatives with a leading minus", () => {
  assert.equal(formatPounds(195000), "£1,950");
  assert.equal(formatPounds(24900), "£249");
  assert.equal(formatPounds(24950), "£249.50");
  assert.equal(formatPounds(-24900), "-£249");
});

test("formatPounds: zero, pennies, big numbers, and bad input", () => {
  assert.equal(formatPounds(0), "£0");
  assert.equal(formatPounds(-0), "£0");
  assert.equal(formatPounds(5), "£0.05");
  assert.equal(formatPounds(-1250), "-£12.50");
  assert.equal(formatPounds(100), "£1");
  assert.equal(formatPounds(123456789), "£1,234,567.89");
  assert.equal(formatPounds(100000000), "£1,000,000");
  assert.throws(() => formatPounds(NaN), /formatPounds needs an amount in pence/);
  assert.throws(() => formatPounds("24900"), /formatPounds needs an amount in pence/);
  assert.throws(() => formatPounds(null), /formatPounds needs an amount in pence/);
  assert.throws(() => formatPounds(Infinity), /formatPounds needs an amount in pence/);
  assert.throws(() => formatPounds(1e30), /formatPounds needs an amount in pence/); // never "£1e+28"
});

test("the guarantee, weekend banner and no-contract line are word for word", () => {
  assert.equal(GUARANTEE.headline, "Top 3 in Google search results in 90 days. GUARANTEED.");
  assert.equal(GUARANTEE.section, "The guarantee: we will work for FREE if you aren't in the top 3 of Google results within 90 days.");
  assert.equal(BUILD_GUARANTEE, "Website live in 7 days, GUARANTEED.");
  assert.equal(WEEKEND_BANNER, "Weekend price — ends Sunday midnight");
  assert.equal(NO_CONTRACT, "No contract. No cancellation fees. If we're not making you money, we don't want your money.");
});

test("money.js re-exports the same PACKAGES", async () => {
  assert.equal((await import("../functions/_lib/money.js")).PACKAGES, PACKAGES);
});

test("no other module hard-codes a price", () => {
  // functions/_lib as the plan says, and the routes beside it too (overview §9: nothing else hard-codes a price).
  const files = walk(FUNCTIONS).map((f) => relative(FUNCTIONS, f).split(sep).join("/"));
  assert.ok(files.includes("_lib/money.js"), "the scan should see _lib/money.js");
  assert.ok(files.some((f) => f.startsWith("api/")), "the scan should see the routes too");
  for (const f of files) {
    if (f === "_lib/offer.js") continue;
    const src = readFileSync(join(FUNCTIONS, f), "utf8");
    assert.doesNotMatch(src, /\b(195000|175000|24900)\b/, f);
    // The same prices written with numeric separators (195_000, 1_950_00) are still hard-coded prices.
    assert.doesNotMatch(src.replace(/(?<=\d)_(?=\d)/g, ""), /\b(195000|175000|24900)\b/, `${f} (numeric separators)`);
  }
});
