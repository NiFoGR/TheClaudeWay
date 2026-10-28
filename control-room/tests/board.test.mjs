// Todo board (pure): pipeline columns, last-event words, next follow-up line, card cap, client cards.
// Run: node --test control-room/tests/board.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_CAP, COLUMN_STAGES, LOST_WORDS, clientCards, futureWhen, guaranteeWords, lastEvent, leadLink, nextLine, pastWhen,
  pipelineColumns, rankWords, threadLink, ukDayDate, ukShortDate,
} from "../functions/_lib/board.js";
import { STAGE_LABELS } from "../functions/_lib/shortlist.js";
import { addUkDays, ukDate } from "../functions/_lib/ukTime.js";

const NOW = new Date("2026-10-22T12:00:00Z");

const rows = [
  { place_id: "pr", stage: "ready", stage_at: "2026-10-22T08:00:00Z" },
  { place_id: "pe", stage: "emailed", stage_at: "2026-10-20T08:00:00Z", last_out_at: "2026-10-20T08:00:00Z",
    last_out_kind: "first", last_out_author: "nik", followup_step: 0, next_followup_at: "2026-10-23T07:00:00Z" },
  { place_id: "pv", stage: "viewed", stage_at: "2026-10-20T09:00:00Z", views: 1, last_view_at: "2026-10-20T09:00:00Z",
    last_out_at: "2026-10-19T08:00:00Z", last_out_kind: "first", followup_step: 0, next_followup_at: "2026-10-24T07:00:00Z" },
  { place_id: "ph", stage: "viewed", stage_at: "2026-10-19T09:00:00Z", views: 3, last_view_at: "2026-10-21T20:00:00Z",
    last_out_at: "2026-10-21T07:00:00Z", last_out_kind: "followup", last_out_step: 2, followup_step: 2,
    next_followup_at: "2026-10-25T08:00:00Z" },
  { place_id: "prp", stage: "replied", stage_at: "2026-10-22T09:30:00Z", last_inbound_at: "2026-10-22T09:30:00Z" },
  { place_id: "pn", stage: "needs_nik", stage_at: "2026-10-21T16:05:00Z", last_inbound_at: "2026-10-21T16:00:00Z" },
  { place_id: "pc", stage: "call_booked", stage_at: "2026-10-21T11:00:00Z", call_at: "2026-10-23T10:00:00Z" },
  { place_id: "pw", stage: "won", stage_at: "2026-10-15T14:00:00Z" },
  { place_id: "pl", stage: "lost", lost_reason: "opt_out", stage_at: "2026-10-21T10:00:00Z" },
];

test("every stage lands in its column", () => {
  const b = pipelineColumns(rows, NOW);
  assert.deepEqual(b.columns.map((c) => c.stage), COLUMN_STAGES);
  assert.deepEqual(b.columns.map((c) => c.count), [1, 1, 2, 1, 1, 1, 1]);
  assert.equal(b.columns[2].label, STAGE_LABELS.viewed);
  assert.deepEqual(b.columns[2].cards.map((c) => [c.place_id, c.hot]), [["ph", true], ["pv", false]]);
  assert.deepEqual([b.lost.count, b.lost.cards[0].place_id], [1, "pl"]);
  const ev = Object.fromEntries(b.columns.flatMap((c) => c.cards).concat(b.lost.cards).map((c) => [c.place_id, c.event]));
  assert.deepEqual(ev, { pr: "Demo ready · today", pe: "You emailed · 2 days ago", pv: "Viewed site once · 2 days ago",
    ph: "Viewed site 3× · yesterday", prp: "Replied · today", pn: "Replied · yesterday", pc: "Call tomorrow 11:00",
    pw: "Paid · 15 Oct", pl: "Said no thanks · yesterday" });
  const lost = (r) => lastEvent({ place_id: "x", stage: "lost", lost_reason: r, stage_at: "2026-10-21T10:00:00Z" }, NOW);
  assert.deepEqual(["not_now", "not_interested", "call", null].map(lost),
    ["Not right now · yesterday", "Not interested · yesterday", "Said no on the call · yesterday", "Lost · yesterday"]);
});

test("next email line only while follow-ups run", () => {
  const b = pipelineColumns(rows, NOW); const card = (id) => b.columns.flatMap((c) => c.cards).find((c) => c.place_id === id);
  assert.equal(card("pe").next, "Next email tomorrow"); assert.equal(card("pv").next, "Next email Sat 24 Oct");
  assert.equal(card("prp").next, null);
  assert.deepEqual([card("pe").lead_link, card("pe").thread_link], ["/#/lead/pe", "/#/replies/pe"]);
  // After follow-up 9 (sent, or skipped with follow-up 8 the last one sent) next_followup_at is the close time.
  const closing = { place_id: "p9", stage: "emailed", stage_at: "2026-08-20T08:00:00Z", followup_step: 9,
    next_followup_at: "2026-10-29T08:15:00Z", last_out_kind: "followup", last_out_step: 8 };
  assert.equal(nextLine(closing, NOW), "No more emails · closes Thu 29 Oct");
  assert.doesNotMatch(nextLine(closing, NOW), /^Next email/);
});

test("columns cap at 50 cards and report the rest", () => {
  const many = Array.from({ length: 53 }, (_, i) => ({ place_id: `x${i}`, stage: "emailed", stage_at: "2026-10-20T08:00:00Z", views: 0 }));
  const col = pipelineColumns(many, NOW).columns[1];
  assert.deepEqual([col.count, col.cards.length, col.more], [53, 50, 3]);
});

// Reviewer's extra tests: the Part A rules the spec's three tests don't reach.

test("constants are the spec's", () => {
  assert.deepEqual(COLUMN_STAGES, ["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked", "won"]);
  assert.equal(CARD_CAP, 50);
  assert.deepEqual(LOST_WORDS, { opt_out: "Said no thanks", bounce: "Email bounced", sequence_done: "No reply to any email",
    not_now: "Not right now", not_interested: "Not interested", call: "Said no on the call" });
  assert.deepEqual([leadLink("abc"), threadLink("abc")], ["/#/lead/abc", "/#/replies/abc"]);
  assert.deepEqual([leadLink("a b#c"), threadLink("a/b")], ["/#/lead/a%20b%23c", "/#/replies/a%2Fb"]);
});

test("when words: past and future, UK days", () => {
  const past = (iso) => pastWhen(iso, NOW);
  assert.deepEqual(["2026-10-22T00:30:00Z", "2026-10-21T23:30:00Z", "2026-10-20T12:00:00Z", "2026-10-16T12:00:00Z",
    "2026-10-15T22:00:00Z", "2026-10-15T23:30:00Z", "2025-12-25T10:00:00Z"].map(past),
  // 21 Oct 23:30 UTC is 00:30 BST on the 22nd; 15 Oct 23:30 UTC is 16 Oct in the UK (6 days ago).
  ["today", "today", "2 days ago", "6 days ago", "15 Oct", "6 days ago", "25 Dec"]);
  const future = (iso) => futureWhen(iso, NOW);
  assert.deepEqual(["2026-10-22T22:59:00Z", "2026-10-22T23:00:00Z", "2026-10-24T07:00:00Z", "2027-01-05T09:00:00Z"].map(future),
    ["today", "tomorrow", "Sat 24 Oct", "Tue 5 Jan"]);
  assert.deepEqual([past(null), past(""), past("not a date"), future(undefined)], ["", "", "", ""]);
  assert.deepEqual([ukShortDate("2026-10-15"), ukDayDate("2026-10-24"), ukShortDate("2026-02-31"), ukDayDate("x")],
    ["15 Oct", "Sat 24 Oct", "", ""]);
});

test("UK days match ukDate on both sides of both clock changes", () => {
  // 2026: clocks go forward 01:00 UTC 29 Mar, back 01:00 UTC 25 Oct. Every 15 minutes across both weekends.
  for (const [from, to] of [["2026-03-27T00:00:00Z", "2026-03-31T00:00:00Z"], ["2026-10-23T00:00:00Z", "2026-10-27T00:00:00Z"]]) {
    for (let t = Date.parse(from); t < Date.parse(to); t += 15 * 60000) {
      const at = new Date(t), uk = ukDate(at);
      const later = new Date(t + 10 * 86400000);
      assert.equal(pastWhen(at, later), ukShortDate(uk), at.toISOString());
      assert.equal(pastWhen(at, new Date(`${addUkDays(uk, 1)}T12:00:00Z`)), "yesterday", at.toISOString());
      assert.equal(futureWhen(at, new Date(`${addUkDays(uk, -1)}T12:00:00Z`)), "tomorrow", at.toISOString());
    }
  }
});

test("last event: the newest of view, reply and outbound, by kind", () => {
  const ev = (r) => lastEvent({ place_id: "x", stage: "emailed", stage_at: "2026-10-01T08:00:00Z", ...r }, NOW);
  assert.equal(ev({ last_out_at: "2026-10-21T07:00:00Z", last_out_kind: "followup", last_out_step: 4 }), "Follow-up 4 sent · yesterday");
  assert.equal(ev({ last_out_at: "2026-10-22T07:00:00Z", last_out_kind: "reply", last_out_author: "claude" }), "Claude replied · today");
  assert.equal(ev({ last_out_at: "2026-10-22T07:00:00Z", last_out_kind: "reply", last_out_author: "nik" }), "You replied · today");
  // A reply newer than our last email wins; our later email wins over an older reply and an older view.
  assert.equal(ev({ last_out_at: "2026-10-20T07:00:00Z", last_out_kind: "first", last_inbound_at: "2026-10-21T09:00:00Z",
    views: 2, last_view_at: "2026-10-19T09:00:00Z" }), "Replied · yesterday");
  assert.equal(ev({ last_out_at: "2026-10-22T10:00:00Z", last_out_kind: "reply", last_out_author: "claude",
    last_inbound_at: "2026-10-22T09:00:00Z", views: 2, last_view_at: "2026-10-21T09:00:00Z" }), "Claude replied · today");
  assert.equal(ev({ last_out_at: "2026-10-15T07:00:00Z", last_out_kind: "first", views: 5, last_view_at: "2026-10-17T09:00:00Z" }),
    "Viewed site 5× · 5 days ago");
  assert.equal(ev({}), "Demo ready · 1 Oct");
  // call_booked without a confirmed call falls back to the newest event; won and lost ignore everything else.
  assert.equal(lastEvent({ place_id: "x", stage: "call_booked", stage_at: "2026-10-21T08:00:00Z", last_inbound_at: "2026-10-21T07:00:00Z" }, NOW),
    "Replied · yesterday");
  assert.equal(lastEvent({ place_id: "x", stage: "call_booked", call_at: "2026-10-26T15:30:00Z" }, NOW), "Call Mon 26 Oct 15:30");
  assert.equal(lastEvent({ place_id: "x", stage: "call_booked", call_at: "2026-10-22T08:05:00Z" }, NOW), "Call today 09:05");
  assert.equal(lastEvent({ place_id: "x", stage: "won", stage_at: "2026-10-22T08:00:00Z", last_inbound_at: "2026-10-22T09:00:00Z" }, NOW),
    "Paid · today");
  assert.equal(lastEvent({ place_id: "x", stage: "lost", lost_reason: "bounce", stage_at: "2026-10-10T08:00:00Z" }, NOW), "Email bounced · 10 Oct");
  assert.equal(lastEvent({ place_id: "x", stage: "lost", lost_reason: "sequence_done", stage_at: "2026-10-20T08:00:00Z" }, NOW),
    "No reply to any email · 2 days ago");
  assert.equal(lastEvent({ place_id: "x", stage: "lost", lost_reason: "toString", stage_at: "2026-10-20T08:00:00Z" }, NOW), "Lost · 2 days ago");
});

test("next line only for emailed and viewed with a time set; a missing step is 0", () => {
  const nl = (r) => nextLine({ place_id: "x", stage: "emailed", ...r }, NOW);
  assert.equal(nl({ next_followup_at: "2026-10-23T07:00:00Z" }), "Next email tomorrow");
  assert.equal(nl({ followup_step: 8, next_followup_at: "2026-10-27T07:00:00Z" }), "Next email Tue 27 Oct");
  assert.equal(nl({ followup_step: 9, next_followup_at: "2026-10-22T15:00:00Z", last_out_step: 9 }), "No more emails · closes today");
  assert.equal(nl({ followup_step: 3, next_followup_at: null }), null);
  for (const stage of ["ready", "replied", "needs_nik", "call_booked", "won", "lost"]) {
    assert.equal(nextLine({ place_id: "x", stage, followup_step: 2, next_followup_at: "2026-10-23T07:00:00Z" }, NOW), null, stage);
  }
});

test("drill and test leads never show; cards carry name, grade and links", () => {
  const b = pipelineColumns([
    { place_id: "drill:1", stage: "ready", stage_at: "2026-10-22T08:00:00Z" },
    { place_id: "test:9", stage: "emailed", stage_at: "2026-10-22T08:00:00Z" },
    { place_id: "ok", stage: "ready", stage_at: "2026-10-22T08:00:00Z", name: "Ace Roofing", grade: "A+" },
    { place_id: "ng", stage: "ready", stage_at: "2026-10-21T08:00:00Z" },
    { place_id: "odd", stage: "none", stage_at: "2026-10-21T08:00:00Z" },
  ], NOW);
  assert.deepEqual(b.columns.map((c) => c.count), [2, 0, 0, 0, 0, 0, 0]);
  assert.equal(b.lost.count, 0);
  const [ok, ng] = b.columns[0].cards;
  assert.deepEqual(ok, { place_id: "ok", business: "Ace Roofing", grade: "A+", hot: false, event: "Demo ready · today",
    next: null, lead_link: "/#/lead/ok", thread_link: null });
  assert.deepEqual([ng.business, ng.grade], [null, "–"]);
  assert.deepEqual(b.columns.map((c) => c.label), COLUMN_STAGES.map((s) => STAGE_LABELS[s]));
});

test("hot cards come first even past the cap; lost is capped too", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ place_id: `v${i}`, stage: "viewed", views: 1,
    stage_at: `2026-10-${String(10 + (i % 12)).padStart(2, "0")}T08:00:00Z`, last_view_at: "2026-10-01T08:00:00Z" }));
  many.push({ place_id: "oldhot", stage: "viewed", views: 4, stage_at: "2026-09-01T08:00:00Z", last_view_at: "2026-10-21T08:00:00Z" });
  const col = pipelineColumns(many, NOW).columns[2];
  assert.deepEqual([col.count, col.cards.length, col.more, col.cards[0].place_id, col.cards[0].hot], [61, 50, 11, "oldhot", true]);
  const at = col.cards.slice(1).map((c) => many.find((r) => r.place_id === c.place_id).stage_at);
  assert.deepEqual(at, [...at].sort().reverse());
  const lost = pipelineColumns(Array.from({ length: 70 }, (_, i) => ({ place_id: `l${i}`, stage: "lost", stage_at: "2026-10-01T08:00:00Z" })), NOW).lost;
  assert.deepEqual([lost.count, lost.cards.length], [70, 50]);
});

// ---------------------------------------------------------------- Task 2: client cards

// A `clients` row joined with onboarding, client_links.failed_on, lead_map_rank and the next care todo (Task 3's shape).
const client = (id, name, pkg, paid_on, free_days, extra = {}) => ({
  id, name, place_id: `lp${id.slice(1)}`, package: pkg, build_fee_pence: 195000, monthly_pence: 24900, free_days, paid_on,
  cancelled_on: null, ob_status: null, ob_created_at: null, due_live_at: null, live_at: null, failed_on: null,
  scan_id: null, top3_pct: null, avg_rank: null, rank_updated_at: null, care_title: null, care_due_at: null, ...extra,
});

const clientRows = [
  client("c1", "Green Leaf", "full", "2026-10-15", 60, { ob_status: "building", ob_created_at: "2026-10-15T10:00:00Z",
    due_live_at: "2026-10-24T16:00:00Z" }),
  client("c2", "Diamond Kickboxing", "full", "2026-07-01", 60, { ob_status: "live", ob_created_at: "2026-07-01T10:00:00Z",
    due_live_at: "2026-08-30T16:00:00Z", live_at: "2026-09-01T10:00:00Z", scan_id: "s1", top3_pct: 64, avg_rank: 2.8,
    rank_updated_at: "2026-10-20T06:00:00Z", care_title: "Approve Diamond Kickboxing's monthly report",
    care_due_at: "2026-11-01T08:47:00Z" }),
  client("c3", "Ace Roofing", "weekend", "2026-10-10", 90, { build_fee_pence: 175000, ob_status: "review",
    ob_created_at: "2026-10-10T10:00:00Z", due_live_at: "2026-10-20T16:00:00Z" }),
  client("c4", "Old Client", "full", "2026-03-01", 60, { ob_status: "live", live_at: "2026-03-10T10:00:00Z",
    cancelled_on: "2026-10-01" }),
  client("c5", "Bright Sparks", "full", "2026-07-20", 60, { ob_status: "live", live_at: "2026-09-27T09:00:00Z",
    failed_on: "2026-10-21" }),
  client("c6", "Quick Locks", "website", "2026-10-01", 0, { build_fee_pence: 175000, monthly_pence: 0, ob_status: "live",
    live_at: "2026-10-08T09:00:00Z" }),
];

test("client cards: countdown, guarantee, rank, monthly, care, order", () => {
  const { cards, past } = clientCards(clientRows, NOW);
  assert.deepEqual(cards.map((c) => c.client_id), ["c3", "c5", "c1", "c2", "c6"]);
  assert.equal(past, 1);
  const c = Object.fromEntries(cards.map((x) => [x.client_id, x]));
  assert.deepEqual([c.c1.phase, c.c1.build, c.c1.guarantee, c.c1.rank, c.c1.monthly, c.c1.care],
    ["building", "Live by Sat 24 Oct · 2 days left", null, "No Map Rank scan yet", "Free until 14 Dec", null]);
  assert.deepEqual([c.c2.guarantee, c.c2.rank, c.c2.rank_link, c.c2.monthly, c.c2.care],
    ["Guarantee day 52 of 90", "Top 3 in 64% of their area · average position 2.8 · checked 2 days ago",
     "/#/maprank?scan=s1&biz=lp2", "£249 a month", "Approve Diamond Kickboxing's monthly report · Sun 1 Nov"]);
  assert.deepEqual([c.c3.build, c.c3.late, c.c3.monthly], ["2 days late", true, "Free until 8 Jan"]);
  assert.deepEqual([c.c5.monthly, c.c5.card_failed, c.c5.guarantee], ["Card failed 21 Oct", true, "Guarantee day 26 of 90"]);
  assert.deepEqual([c.c6.monthly, c.c6.guarantee], ["Website only", null]);
});

test("guarantee ends after day 90", () => {
  assert.equal(guaranteeWords("2026-07-01T10:00:00Z", "2026-10-22"), "90-day guarantee ended 28 Sep");
});

test("onboarding wording", () => {
  // no onboarding row → "Onboarding form not sent yet"; ob_status 'sent' created 2026-10-19 → "Waiting for their onboarding form · sent 3 days ago"
  const { cards } = clientCards([
    client("c7", "No Form Yet", "full", "2026-10-21", 60),
    client("c8", "Form Sent", "full", "2026-10-19", 60, { ob_status: "sent", ob_created_at: "2026-10-19T09:00:00Z" }),
  ], NOW);
  const c = Object.fromEntries(cards.map((x) => [x.client_id, x]));
  assert.deepEqual([c.c7.phase, c.c7.build, c.c7.late, c.c7.attention], ["onboarding", "Onboarding form not sent yet", false, false]);
  assert.deepEqual([c.c8.phase, c.c8.build, c.c8.late], ["onboarding", "Waiting for their onboarding form · sent 3 days ago", false]);
  assert.deepEqual([c.c7.guarantee, c.c8.guarantee], [null, null]);
});

// Extra Task 2 checks: the Part A rules the spec's tests don't reach.

test("build countdown: tomorrow, today, a day late; live has no build line", () => {
  const build = (due, status = "building") => clientCards([client("c9", "X", "full", "2026-10-15", 60,
    { ob_status: status, due_live_at: due, live_at: status === "live" ? "2026-10-20T09:00:00Z" : null })], NOW).cards[0];
  assert.equal(build("2026-10-23T16:00:00Z").build, "Live by tomorrow");
  assert.equal(build("2026-10-22T22:30:00Z").build, "Due live today"); // 23:30 BST is still the 22nd in the UK
  assert.equal(build("2026-10-22T23:30:00Z").build, "Live by tomorrow"); // 00:30 BST on the 23rd
  assert.deepEqual([build("2026-10-21T16:00:00Z").build, build("2026-10-21T16:00:00Z").late], ["1 day late", true]);
  assert.deepEqual([build("2026-10-22T16:00:00Z", "submitted").phase, build("2026-10-30T16:00:00Z").build],
    ["building", "Live by Fri 30 Oct · 8 days left"]);
  const live = build("2026-10-20T16:00:00Z", "live");
  assert.deepEqual([live.phase, live.build, live.late, live.guarantee], ["live", null, false, "Guarantee day 3 of 90"]);
});

test("guarantee day 1 to 90, in UK days", () => {
  assert.equal(guaranteeWords("2026-10-22T09:00:00Z", "2026-10-22"), "Guarantee day 1 of 90");
  // 23:30 BST on 24 Jul is UK day 24 Jul (day 91 today); 00:30 BST on 25 Jul is day 90.
  assert.equal(guaranteeWords("2026-07-24T22:30:00Z", "2026-10-22"), "90-day guarantee ended 21 Oct");
  assert.equal(guaranteeWords("2026-07-24T23:30:00Z", "2026-10-22"), "Guarantee day 90 of 90");
});

test("rank words and link", () => {
  assert.deepEqual(rankWords({ place_id: "lp1" }, NOW), { rank: "No Map Rank scan yet", rank_link: "/#/maprank" });
  assert.deepEqual(rankWords({ place_id: "a b&c", scan_id: "s/2", top3_pct: 0, avg_rank: 11, rank_updated_at: "2026-10-01T06:00:00Z" }, NOW),
    { rank: "Top 3 in 0% of their area · average position 11.0 · checked 1 Oct", rank_link: "/#/maprank?scan=s%2F2&biz=a%20b%26c" });
});

test("clients: stopped only in past, failed card needs attention, empty input", () => {
  assert.deepEqual(clientCards([], NOW), { cards: [], past: 0 });
  assert.deepEqual(clientCards(null, NOW), { cards: [], past: 0 });
  // `now` as an ISO string works like a Date, as it does for the pipeline.
  assert.deepEqual(clientCards(clientRows, NOW.toISOString()), clientCards(clientRows, NOW));
  const { cards, past } = clientCards([
    client("c1", "Zed", "full", "2026-01-01", 60, { cancelled_on: "2026-05-01" }),
    client("c2", "Yew", "full", "2026-01-01", 60, { cancelled_on: "2026-11-30", ob_status: "live", live_at: "2026-02-01T09:00:00Z" }),
    client("c3", "Ash", "full", "2026-01-01", 60, { ob_status: "live", live_at: "2026-02-01T09:00:00Z", failed_on: "2026-10-20" }),
  ], NOW);
  assert.equal(past, 1);
  assert.deepEqual(cards.map((c) => [c.client_id, c.attention, c.card_failed, c.monthly]),
    [["c3", true, true, "Card failed 20 Oct"], ["c2", false, false, "£249 a month"]]);
  assert.deepEqual([cards[0].name, cards[0].place_id], ["Ash", "lp3"]);
});
