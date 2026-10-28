// Money page maths. Run: node --test control-room/tests/money.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addMonths, googleCosts, ledger, loadMoney, packageNote, PACKAGES, summarise, toPence } from "../functions/_lib/money.js";
import { formatPounds, MONTHLY_PENCE } from "../functions/_lib/offer.js";
import * as offerRoute from "../functions/api/offer.js";
import { fakeD1 as makeD1 } from "./helpers/fakeD1.mjs";

// 2 prospects call_booked, 1 replied, 1 needs_nik (plus drill/test rows and other stages, which never count).
async function fakeD1() {
  const DB = makeD1();
  const at = "2026-10-20T09:00:00Z";
  const rows = [
    ["p1", "call_booked"], ["p2", "call_booked"], ["p3", "replied"], ["p4", "needs_nik"], ["p5", "emailed"], ["p6", "won"],
    ["drill:r1", "call_booked"], ["test:t1", "replied"], ["test:t2", "needs_nik"],
  ];
  await DB.batch(rows.map(([id, stage]) => DB.prepare(
    "INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, stage, at, `${id.replace(":", "-")}@example.com`, at, at)));
  return DB;
}

const smith = { id: "a", name: "Smith Roofing", package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60, paid_on: "2026-07-10" };

test("month arithmetic clamps to the end of short months", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-10-03", 3), "2027-01-03");
});

test("retainer starts after the free days and stops when cancelled", () => {
  const items = ledger({ clients: [{ ...smith, cancelled_on: "2026-11-01" }], until: "2027-03-01" });
  assert.deepEqual(items.map((i) => [i.date, i.category]), [
    ["2026-07-10", "Website builds"], ["2026-09-08", "Monthly retainers"], ["2026-10-08", "Monthly retainers"],
  ]);
});

test("Google only costs money past each SKU's free monthly allowance; ID-only searches are free", () => {
  const g = googleCosts([
    { month: "2026-10", sku: "text_search_enterprise", calls: 1200 },
    { month: "2026-10", sku: "text_search_ids", calls: 50000 },
    { month: "2026-09", sku: "text_search_enterprise", calls: 900 },
  ]);
  assert.equal(g["2026-10"].pence, 525); // 200 billable × $35/1000 × 0.75
  assert.equal(g["2026-10"].calls, 1200);
  assert.equal(g["2026-09"].pence, 0);
});

test("summary: profit to date, MRR vs free period, forecast and pipeline", () => {
  const jones = { ...smith, id: "b", name: "Jones", package: "weekend", build_fee_pence: 175000, free_days: 90, paid_on: "2026-09-20" };
  const s = summarise({
    today: "2026-10-03", clients: [smith, jones],
    entries: [{ kind: "out", category: "Mailboxes", label: "Workspace", amount_pence: 1800, on_date: "2026-06-05", monthly: 1 }],
    pipeline: { callsBooked: 2, replied: 1 },
  });
  assert.equal(s.mrr, 24900);
  assert.equal(s.mrrSoon, 24900);
  assert.equal(s.thisMonth.in, 0); // Smith's October payment is on the 8th
  assert.equal(s.thisMonth.out, 0); // mailbox bills on the 5th
  assert.equal(s.thisMonth.expectedProfit, 24900 - 1800);
  assert.equal(s.months.length, 12);
  assert.equal(s.upcoming[0].date, "2026-10-08");
  assert.equal(s.pipeline.value, 390000);
});

test("summary carries packages", () => {
  assert.equal(summarise({ today: "2026-10-19" }).packages.full.build, 195000);
});

test("Money and Setup pages: no payment links, no browser copy of the prices", () => {
  const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), "utf8");
  const money = read("money.js");
  const setup = read("setup.js");
  assert.doesNotMatch(money, /paymentLinks|linksCard|\/api\/stripe\/setup/);
  // Setup's Payments (Stripe) card (Task 11) reads /api/stripe/setup for Connect Stripe; the old links card is gone.
  assert.doesNotMatch(setup, /paymentLinks|linksCard|Set up Stripe|stripeCard/);
  assert.doesNotMatch(money, /const PACKAGES|build: 1950|build: 1750/);
  assert.match(money, /summary\?\.packages/);
  assert.ok(money.includes("To take an order, send them their order page (their demo → Order this site)."));
});

test("package notes use offer.js", () => {
  assert.equal(packageNote(PACKAGES.full), `${formatPounds(PACKAGES.full.build)} + ${formatPounds(MONTHLY_PENCE)}/mo, first 60 days free`);
  assert.equal(packageNote(PACKAGES.full), "£1,950 + £249/mo, first 60 days free");
  assert.equal(packageNote(PACKAGES.website), "£1,750 one-off, no monthly");
});

test("pipeline counts prospects", async () => {
  const DB = await fakeD1();  // 2 prospects call_booked, 1 replied, 1 needs_nik
  const { summary } = await loadMoney(DB, "2026-10-22");
  assert.deepEqual([summary.pipeline.callsBooked, summary.pipeline.replied, summary.pipeline.value], [2, 2, 2 * PACKAGES.full.build]);
});

test("pipeline on a database with no prospects is all 0, never null", async () => {
  const { summary } = await loadMoney(makeD1(), "2026-10-22");
  assert.deepEqual(summary.pipeline, { callsBooked: 0, replied: 0, value: 0, monthlyValue: 0 });
});

test("the weekend deal's note shows its own build price and free days", () => {
  assert.equal(packageNote(PACKAGES.weekend), "£1,750 + £249/mo, first 90 days free");
});

test("/api/offer serves the packages", async () => {
  assert.deepEqual(await (await offerRoute.onRequestGet({})).json(), { packages: PACKAGES });
});

test("amounts typed in pounds become pence", () => {
  assert.equal(toPence("£1,950"), 195000);
  assert.equal(toPence("18.90"), 1890);
  assert.ok(Number.isNaN(toPence("abc")));
  assert.ok(Number.isNaN(toPence("-5")));
});
