// Money page maths. Run: node --test control-room/tests/money.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, googleCosts, ledger, summarise, toPence } from "../functions/_lib/money.js";

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

test("amounts typed in pounds become pence", () => {
  assert.equal(toPence("£1,950"), 195000);
  assert.equal(toPence("18.90"), 1890);
  assert.ok(Number.isNaN(toPence("abc")));
  assert.ok(Number.isNaN(toPence("-5")));
});
