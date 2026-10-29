// KPIs (pure): ISO weeks in UK time (Monday 00:00 to Sunday 23:59 UK, across the clock change and the year end)
// and sample-aware rates; computeWeek's last-touch crediting on the hand-checked week (fixtures/kpi-week.mjs).
// Run: node --test control-room/tests/kpis.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_SAMPLE, POSITIVE_INTENTS, computeWeek, credit, inWeek, isoWeekOf, lastWeeks, rate, trendRow, weekLabel, weekStartOf,
} from "../functions/_lib/kpis.js";
import { rows } from "./fixtures/kpi-week.mjs";

test("weeks across the clock change and new year", () => {
  assert.equal(isoWeekOf("2026-10-19"), "2026-W43"); assert.equal(weekStartOf("2026-W43"), "2026-10-19");
  assert.equal(isoWeekOf("2027-01-01"), "2026-W53"); assert.equal(weekStartOf("2026-W53"), "2026-12-28");
  assert.equal(inWeek("2026-10-18T23:30:00Z", "2026-10-19"), true);   // Mon 00:30 BST
  assert.equal(inWeek("2026-10-18T22:30:00Z", "2026-10-19"), false);  // Sun 23:30 BST
  assert.equal(inWeek("2026-10-25T23:30:00Z", "2026-10-19"), true);   // Sun 23:30 GMT
  assert.equal(inWeek("2026-10-26T00:00:00Z", "2026-10-19"), false);  // Mon 00:00 GMT
  assert.equal(weekLabel("2026-W43"), "19–25 Oct"); assert.equal(weekLabel("2026-W40"), "28 Sep – 4 Oct");
  assert.deepEqual(lastWeeks("2026-W02", 4), ["2025-W51", "2025-W52", "2026-W01", "2026-W02"]);
});

test("rates round to one decimal and flag small samples", () => {
  assert.deepEqual(rate(2, 3), { k: 2, n: 3, pct: 66.7, early: true });
  assert.deepEqual(rate(0, 0), { k: 0, n: 0, pct: null, early: true });
  assert.equal(rate(9, 30).early, false);
  assert.equal(MIN_SAMPLE, 30);
});

test("week edges: year end, week 53, the March clock change and stored-time formats", () => {
  assert.equal(isoWeekOf("2021-01-03"), "2020-W53"); assert.equal(isoWeekOf("2024-12-30"), "2025-W01");
  assert.equal(weekStartOf("2025-W01"), "2024-12-30"); assert.equal(weekLabel("2026-W53"), "28 Dec – 3 Jan");
  assert.deepEqual(lastWeeks("2027-W01", 3), ["2026-W52", "2026-W53", "2027-W01"]);
  for (const bad of ["2025-W53", "2026-W00", "2026-W54", "2026-W1", "2026-43", "", null]) {
    assert.throws(() => weekStartOf(bad), /Week should look like 2026-W43/);
  }
  assert.equal(inWeek("2026-03-29T22:59:00Z", "2026-03-23"), true);   // Sun 23:59 BST
  assert.equal(inWeek("2026-03-29T23:00:00Z", "2026-03-23"), false);  // Mon 00:00 BST
  assert.equal(inWeek("2026-03-22T23:30:00Z", "2026-03-23"), false);  // Sun 23:30 GMT, the week before
  assert.equal(inWeek("2026-10-25 23:30:00", "2026-10-19"), true);    // no zone: UTC, whatever the machine's zone
  assert.equal(inWeek("2026-10-25", "2026-10-19"), true);             // a paid_on date
  assert.equal(inWeek(null, "2026-10-19"), false); assert.equal(inWeek("not a time", "2026-10-19"), false);
  assert.deepEqual([rate(0, undefined).early, rate(0, undefined).pct, rate(3, NaN).early], [true, null, true]);
  assert.deepEqual([rate(1, 3).pct, rate(1, 8).pct, rate(30, 30).pct, rate(29, 29).early], [33.3, 12.5, 100, true]);
});

test("hand-checked week 2026-W43", () => {
  const n = computeWeek(rows, "2026-10-19");
  const g = Object.fromEntries(n.groups.map((x) => [x.key, [x.sent, x.bounced, x.viewed, x.replied, x.positive, x.opted_out]]));
  assert.deepEqual(g, { "first:nik": [5, 1, 1, 3, 2, 0], "followup:system": [1, 0, 1, 0, 0, 1], "reply:claude": [3, 0, 1, 1, 1, 0] });
  assert.deepEqual([n.steps[0].sent, n.steps[1].sent, n.steps[1].opted_out, n.steps[2].sent], [5, 1, 1, 0]);
  assert.deepEqual(n.nik, { first_sent: 5, view_rate: rate(2, 5), reply_rate: rate(3, 5), positive_rate: rate(2, 5) });
  assert.deepEqual(n.claude, { replies_sent: 3, moved_forward: rate(2, 3), median_minutes: 12, escalated: 1 });
  assert.deepEqual(n.totals, { sent: 9, bounced: 1, human_replies: 4, positive_replies: 3, opt_outs: 1, calls_booked: 1, orders: 1, revenue_pence: 175000 });
  assert.deepEqual(n.grades.map((x) => [x.grade, x.emailed, x.viewed.pct, x.replied.pct, x.won.pct]),
    [["A+", 1, 100, 100, 0], ["A", 3, 66.7, 66.7, 33.3], ["B", 2, 0, 0, 0], ["C", 0, null, null, null], ["D", 0, null, null, null]]);
  // wrong_flags: p9's "[Nik 2026-10-22] wrong owner" counts; p10's "[Nik 2026-10-21] Not a fit: Wrong trade" doesn't.
  assert.deepEqual(n.research, { researched: 3, with_email: 2, hit_rate: rate(2, 3), wrong_flags: 1, too_big: 0 });
  assert.deepEqual(["2026-W40", "2026-W41", "2026-W42", "2026-W43"].map((w) => trendRow(computeWeek(rows, weekStartOf(w))).first_sent), [0, 0, 1, 5]);
});

test("empty week is all zeros", () => {
  const n = computeWeek({ messages: [], views: [], calls: [], orders: [], grades: {}, research: [], escalations: [] }, "2026-10-19");
  assert.deepEqual([n.groups, n.nik.view_rate.pct, n.claude.median_minutes, n.totals.revenue_pence], [[], null, null, 0]);
});

test("last-touch crediting, the week's frame and the trend row", () => {
  const c = credit(rows);
  const no = { viewed: false, replied: false, positive: false, bounced: false, opted_out: false };
  assert.deepEqual(c.get("m4"), { ...no, bounced: true });
  assert.deepEqual(c.get("m6"), { ...no, viewed: true, opted_out: true });        // p2's view and opt-out: the follow-up
  assert.deepEqual(c.get("m2"), no);
  assert.deepEqual(c.get("m1"), { ...no, viewed: true, replied: true, positive: true }); // two views, counted once
  assert.deepEqual(c.get("m5"), { ...no, replied: true, positive: true });       // p5's view on the 27th went to c3
  assert.deepEqual(c.get("c3"), { ...no, viewed: true });
  assert.deepEqual(c.get("m3"), { ...no, replied: true });                       // not_interested: a reply, not positive
  assert.equal(c.has("m7") || c.has("m8"), false);                               // queued, and no lead: never credited
  assert.ok(POSITIVE_INTENTS.includes("proposes_time") && !POSITIVE_INTENTS.includes("not_interested"));

  const n = computeWeek(rows, "2026-10-19");
  assert.deepEqual([n.week, n.start, n.end, n.label], ["2026-W43", "2026-10-19", "2026-10-25", "19–25 Oct"]);
  assert.deepEqual(n.groups.map((x) => x.key), ["first:nik", "followup:system", "reply:claude"]);
  assert.deepEqual(n.groups[0].rates, { view: rate(1, 5), reply: rate(3, 5), positive: rate(2, 5) });
  assert.deepEqual(n.steps.map((s) => s.step), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(trendRow(n), {
    week: "2026-W43", label: "19–25 Oct", first_sent: 5, view_rate: rate(2, 5), reply_rate: rate(3, 5),
    positive: 3, moved_forward: rate(2, 3), calls_booked: 1, orders: 1,
  });

  // Insertion order never matters, and test/drill leads never count.
  const shuffled = { ...rows, messages: [...rows.messages].reverse(), views: [...rows.views].reverse() };
  assert.deepEqual(computeWeek(shuffled, "2026-10-19"), n);
  const drill = { ...rows, messages: [...rows.messages, { ...rows.messages[2], id: "d1", place_id: "drill:1" }] };
  assert.equal(computeWeek(drill, "2026-10-19").totals.sent, 9);
  assert.throws(() => computeWeek(rows, "2026-10-20"), /Monday/);
});

test("crediting edges: view windows, auto mail, escalations, even medians and reused rows", () => {
  const out = (id, place_id, kind, author, sent_at) => ({ id, place_id, direction: "out", kind, step: null, author, status: "sent", sent_at });
  const inn = (id, place_id, cls, intent, received_at) => ({ id, place_id, direction: "in", kind: "inbound", author: "them", status: "received", class: cls, intent, received_at });
  const base = {
    messages: [
      out("s1", "q1", "system", "system", "2026-10-19T08:30:00Z"), out("f1", "q1", "first", "nik", "2026-10-19T09:00:00Z"),
      out("g1", "q2", "first", "nik", "2026-10-19T09:00:00Z"),
      inn("x0", "q3", "human", "interested", "2026-10-19T08:00:00Z"),   // before any email to q3: credited to nothing
      out("h1", "q3", "first", "nik", "2026-10-19T09:00:00Z"), inn("a1", "q3", "auto", null, "2026-10-19T10:00:00Z"),
      out("k1", "q4", "first", "nik", "2026-10-19T09:00:00Z"), inn("i4", "q4", "human", "not_interested", "2026-10-20T10:00:00Z"),
      out("r1", "q4", "reply", "claude", "2026-10-20T10:10:00Z"),
      out("k2", "q5", "first", "nik", "2026-10-19T09:00:00Z"), inn("i5", "q5", "human", "not_interested", "2026-10-20T10:00:00Z"),
      out("r2", "q5", "reply", "claude", "2026-10-20T10:25:00Z"), out("n1", "q5", "reply", "nik", "2026-10-21T09:00:00Z"),
      out("k3", "q6", "first", "nik", "2026-10-26T09:00:00Z"),
    ],
    views: [{ place_id: "q1", at: "2026-10-26T09:00:00Z" }, { place_id: "q2", at: "2026-10-27T09:00:00Z" }], // 7 days on; 8 days on
    calls: [
      { place_id: "q4", status: "offered", created_at: "2026-10-21T09:00:00Z" },
      { place_id: "q5", status: "confirmed", created_at: "2026-10-27T10:30:00Z" },   // 7 days and 5 minutes after r2
    ],
    orders: [{ place_id: "q4", paid_on: "2026-10-28", build_fee_pence: 175000 }],    // 8 UK days after r1
    grades: { q1: "A+", q2: "A+", q6: "A" },
    research: [
      { place_id: "q1", status: "done", best_email: "  ", too_big: 1, researched_at: "2026-10-20T07:00:00Z",
        notes: "[Nik 2026-10-20] Wrong owner\n[Nik 2026-10-18] older\n[Nik 2026-10-21] not a fit" },
      { place_id: "drill:2", status: "done", best_email: "a@b.example", too_big: 0, researched_at: "2026-10-20T07:00:00Z", notes: "[Nik 2026-10-20] x" },
    ],
    escalations: ["escalation:x1", "escalation:unknown:x2", "escalation:client:x3", "client-mail:x4", "optout-mail:x5"]
      .map((dedupe) => ({ place_id: "q4", dedupe, created_at: "2026-10-20T10:00:00Z" }))
      .concat([{ place_id: "drill:1", dedupe: "escalation:x6", created_at: "2026-10-20T10:00:00Z" }]),
  };
  const c = credit(base);
  assert.equal(c.get("f1").viewed, true);   // exactly 7 days after: still within
  assert.equal(c.get("g1").viewed, false);  // 8 days after: not credited, and never to an earlier email instead
  assert.deepEqual(c.get("h1"), { viewed: false, replied: false, positive: false, bounced: false, opted_out: false }); // auto mail is nothing
  // "Sent before it" is strictly before: an opt-out stamped the same second as a follow-up goes to the email before.
  const tie = credit({ messages: [out("t0", "q9", "first", "nik", "2026-10-19T09:00:00Z"),
    { ...out("t1", "q9", "followup", "system", "2026-10-20T09:00:00Z"), step: 1 }, inn("t2", "q9", "opt_out", null, "2026-10-20T09:00:00Z")] });
  assert.deepEqual([tie.get("t0").opted_out, tie.get("t1").opted_out], [true, false]);

  const n = computeWeek(base, "2026-10-19");
  assert.deepEqual(n.groups.map((x) => [x.key, x.sent, x.viewed, x.replied]),
    [["first:nik", 5, 1, 2], ["reply:claude", 2, 0, 0], ["reply:nik", 1, 0, 0], ["system:system", 1, 0, 0]]);
  assert.deepEqual(n.nik, { first_sent: 5, view_rate: rate(1, 5), reply_rate: rate(2, 5), positive_rate: rate(0, 5) });
  assert.deepEqual(n.claude, { replies_sent: 2, moved_forward: rate(0, 2), median_minutes: 18, escalated: 1 }); // (10 + 25) / 2
  assert.deepEqual(n.totals, { sent: 9, bounced: 0, human_replies: 3, positive_replies: 1, opt_outs: 0, calls_booked: 0, orders: 0, revenue_pence: 0 });
  assert.deepEqual(n.grades.slice(0, 2).map((x) => [x.grade, x.emailed, x.viewed.pct]), [["A+", 2, 100], ["A", 0, null]]);
  assert.deepEqual(n.research, { researched: 1, with_email: 0, hit_rate: rate(0, 1), wrong_flags: 1, too_big: 1 });

  const next = computeWeek(base, "2026-10-26");
  assert.deepEqual([next.grades[1].emailed, next.totals.calls_booked, next.totals.orders, next.totals.revenue_pence, next.research.wrong_flags], [1, 1, 1, 175000, 0]);

  // Rows are prepared once per rows object, but a rows object that gains rows is prepared again.
  const grow = { ...base, messages: [...base.messages] };
  assert.equal(computeWeek(grow, "2026-10-19").totals.sent, 9);
  grow.messages.push(out("k7", "q7", "first", "nik", "2026-10-22T09:00:00Z"));
  assert.equal(computeWeek(grow, "2026-10-19").totals.sent, 10);
  assert.deepEqual(computeWeek({}, "2026-10-19").totals, { sent: 0, bounced: 0, human_replies: 0, positive_replies: 0, opt_outs: 0, calls_booked: 0, orders: 0, revenue_pence: 0 });
});

test("moved forward by a booked call or an order alone, at the window's edges, and calibration rows replace grades", () => {
  const out = (id, place_id, kind, author, sent_at) => ({ id, place_id, direction: "out", kind, step: null, author, status: "sent", sent_at });
  const inn = (id, place_id, intent, received_at) => ({ id, place_id, direction: "in", kind: "inbound", author: "them", status: "received", class: "human", intent, received_at });
  const base = {
    messages: [
      out("f1", "z1", "first", "nik", "2026-10-19T09:00:00Z"), inn("h1", "z1", "not_interested", "2026-10-20T10:00:00Z"),
      out("r1", "z1", "reply", "claude", "2026-10-20T10:05:00Z"),
      out("f2", "z2", "first", "nik", "2026-10-19T09:00:00Z"), inn("h2", "z2", "question", "2026-10-20T09:40:00Z"), // before the reply
      out("r2", "z2", "reply", "claude", "2026-10-20T10:00:00Z"),
      out("f3", "z3", "first", "nik", "2026-10-19T09:00:00Z"), inn("h3", "z3", "not_interested", "2026-10-20T09:30:00Z"),
      out("r3", "z3", "reply", "claude", "2026-10-20T10:00:00Z"), inn("h4", "z3", "interested", "2026-10-27T10:00:01Z"), // 7 days and 1 s on
    ],
    views: [],
    calls: [
      { place_id: "z1", status: "no_show", created_at: "2026-10-26T10:00:00Z" },   // booked, within 7 days of r1
      { place_id: "z3", status: "done", created_at: "2026-10-20T09:00:00Z" },      // booked, but before r3
    ],
    orders: [{ place_id: "z2", paid_on: "2026-10-27", build_fee_pence: 175000 }], // the 7th UK day after r2
    grades: { z1: "A+", z2: "A+", z3: "A+" },
    research: [],
    escalations: [],
  };
  const n = computeWeek(base, "2026-10-19");
  assert.deepEqual(n.claude, { replies_sent: 3, moved_forward: rate(2, 3), median_minutes: 20, escalated: 0 }); // 5, 20, 30
  assert.deepEqual(n.groups.find((g) => g.key === "reply:claude").replied, 1);   // h4 counts for r3's week, though it came later
  assert.deepEqual([n.totals.human_replies, n.totals.positive_replies, n.totals.calls_booked, n.totals.orders], [3, 1, 1, 0]);
  const next = computeWeek(base, "2026-10-26");
  assert.deepEqual([next.totals.positive_replies, next.totals.calls_booked, next.totals.orders, next.totals.revenue_pence], [1, 1, 1, 175000]);
  assert.deepEqual(n.grades[0].emailed, 3);

  // loadKpiRows' all-time calibration rows replace `grades` (an empty list too); a lead first emailed after the week ended is left out.
  const cal = {
    ...base,
    calibration: [
      { grade: "C", first_ms: Date.parse("2026-10-20T08:00:00Z"), viewed: 1, replied: 0, won: 0 },
      { grade: "C", first_ms: Date.parse("2026-10-25T23:59:00Z"), viewed: 0, replied: 1, won: 1 },   // Sun 23:59 GMT: in
      { grade: "A", first_ms: Date.parse("2026-10-26T00:00:00Z"), viewed: 1, replied: 1, won: 1 },   // Mon 00:00: after
      { grade: "Z", first_ms: Date.parse("2026-10-20T08:00:00Z"), viewed: 1, replied: 1, won: 1 },   // not a grade
    ],
  };
  assert.deepEqual(computeWeek(cal, "2026-10-19").grades.map((x) => [x.grade, x.emailed, x.viewed.pct, x.replied.pct, x.won.pct]),
    [["A+", 0, null, null, null], ["A", 0, null, null, null], ["B", 0, null, null, null], ["C", 2, 50, 50, 50], ["D", 0, null, null, null]]);
  assert.equal(computeWeek({ ...base, calibration: [] }, "2026-10-19").grades[0].emailed, 0);
});
