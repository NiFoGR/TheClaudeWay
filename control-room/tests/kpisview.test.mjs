// The KPIs page's pure HTML (docs/rebuild/11-todo-kpis.md Part A "What Nik sees", Part B Task 9): public/js/kpisview.js.
// Rates as "3 of 5 (60%)" (grey and "too early to tell" under 30), Claude's review as escaped text (## headings, - and
// 1. lists, paragraphs), the section labels, the still-counting line, the empty week and the missing review. The payload
// is built from the hand-checked week (fixtures/kpi-week.mjs) through computeWeek, as GET /api/kpis builds it.
// Run: node --test control-room/tests/kpisview.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { computeWeek, lastWeeks, trendRow, weekStartOf } from "../functions/_lib/kpis.js";
import { kpisHtml, mdLite, rateHtml } from "../public/js/kpisview.js";
import { rows } from "./fixtures/kpi-week.mjs";

const payloadFor2026W43 = {
  week: "2026-W43", label: "19–25 Oct", prev: "2026-W42", next: null, still_counting: true,
  numbers: computeWeek(rows, "2026-10-19"), trend: [], analysis: null,
};
const emptyPayload = { ...payloadFor2026W43, numbers: computeWeek({}, "2026-10-19") };

test("rates read as counts, small samples grey", () => {
  assert.equal(rateHtml({ k: 3, n: 5, pct: 60, early: true }), '<span class="early" title="Fewer than 30 emails: too early to tell">3 of 5 (60%) · too early to tell</span>');
  assert.equal(rateHtml({ k: 12, n: 40, pct: 30, early: false }), "<span>12 of 40 (30%)</span>");
  assert.equal(rateHtml({ k: 0, n: 0, pct: null, early: true }), '<span class="early">–</span>');
});

test("analysis is text", () => {
  const h = mdLite("## Suggestions\n1. Try <b>this</b>\n- point");
  assert.ok(h.includes("<h3>Suggestions</h3>") && h.includes("<ol><li>Try &lt;b&gt;this&lt;/b&gt;</li></ol>") && h.includes("<ul><li>point</li></ul>"));
});

test("labels, empty week and missing review", () => {
  const html = kpisHtml(payloadFor2026W43);   // Task 5 numbers, analysis null
  assert.ok(html.includes("Your first emails") && html.includes("Get them to look at their demo") && html.includes("Claude writes its review on Sunday evening."));
  assert.ok(html.includes("still collecting views and replies"));
  assert.match(kpisHtml(emptyPayload), /No emails sent this week/);
});

// ---------------------------------------------------------------- beyond the plan's three tests

test("mdLite: paragraphs, lists across blank lines, nothing else becomes HTML", () => {
  const h = mdLite("## The week in one line\nFine week.\nStill fine.\n\n1. One\n\n2. Two\n<script>alert(1)</script>\n### Not a heading\n# Nor this");
  assert.ok(h.startsWith("<h3>The week in one line</h3><p>Fine week. Still fine.</p><ol><li>One</li><li>Two</li></ol>"), h);
  assert.ok(!h.includes("<script") && h.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(h.endsWith("<p>&lt;script&gt;alert(1)&lt;/script&gt; ### Not a heading # Nor this</p>"), h);   // a plain line ends the list
  assert.equal(mdLite(""), "");
  assert.equal(mdLite(null), "");
  assert.equal(mdLite('- <img src=x onerror="a">'), "<ul><li>&lt;img src=x onerror=&quot;a&quot;&gt;</li></ul>");
});

test("mdLite: a numbered list broken by a plain line keeps its numbers; indented lines stay in their item", () => {
  const h = mdLite("## Suggestions\n1. Shorter opener\n\n   Because 3 of 5 replied.\nA plain line.\n2. Send at 8am\n2026. was a year, not a list");
  assert.ok(h.includes("<ol><li>Shorter opener Because 3 of 5 replied.</li></ol><p>A plain line.</p>"), h);
  assert.ok(h.includes('<ol start="2"><li>Send at 8am</li></ol><p>2026. was a year, not a list</p>'), h);
});

test("the hand-checked week: week bar, tiles, cards, groups, steps, grades, research", () => {
  const html = kpisHtml(payloadFor2026W43);
  // Week bar: ‹ back to W42, no › on the current week.
  assert.ok(html.includes('href="/#/kpis?week=2026-W42"') && html.includes("19–25 Oct 2026"));
  assert.ok(!html.includes("›"));
  // Tiles.
  for (const t of ["First emails", "Opened demo", "Replied", "Calls booked", "Orders", "£1,750"]) assert.ok(html.includes(t), t);
  // Nik's card and Claude's card.
  assert.ok(html.includes("2 of 5 (40%) · too early to tell") && html.includes("3 of 5 (60%) · too early to tell"));
  assert.ok(html.includes("2 of 3 (66.7%) · too early to tell"));
  assert.ok(html.includes("12 min") && html.includes("Handed to you"));
  // Every kind of email: the labels and goals.
  for (const t of ["Follow-ups", "Get a look or a reply", "Claude's replies", "Move them to a call or an order", "Opened demo after", "No thanks"]) assert.ok(html.includes(t), t);
  // Follow-up steps: step 0, follow-up 1 on day 1, follow-up 9 on day 60, and "–" for an empty step.
  assert.ok(html.includes("First email") && html.includes("Follow-up 1 · day 1") && html.includes("Follow-up 9 · day 60"));
  // Grades and research.
  assert.ok(html.includes("Do the grades predict sales?") && html.includes("If A+ isn't doing better than B, the grading needs a tweak."));
  // Email found: 2 of 3 researched, grey like every early rate.
  assert.ok(html.includes("Research is wrong") && html.includes('2 <span class="early" title="Fewer than 30 emails: too early to tell">(66.7%)</span>'));
  // Tables scroll inside their card.
  assert.ok(html.includes('class="table-scroll"'));
  // Not the empty-week sentence.
  assert.ok(!html.includes("No emails sent this week"));
});

test("time to answer: minutes under an hour, whole hours from 60", () => {
  const n = payloadFor2026W43.numbers;
  const at = (m) => kpisHtml({ ...payloadFor2026W43, numbers: { ...n, claude: { ...n.claude, median_minutes: m } } });
  assert.ok(at(420).includes("7 h"));
  assert.ok(at(59).includes("59 min"));
  assert.ok(at(60).includes("1 h"));
  assert.ok(at(90).includes("2 h"));
});

test("a saved review shows as text with when it was written; later weeks get ›; trend rows oldest first", () => {
  const trend = lastWeeks("2026-W43", 4).map((w) => trendRow(computeWeek(rows, weekStartOf(w))));
  const html = kpisHtml({
    ...payloadFor2026W43, next: "2026-W44", still_counting: false, trend,
    analysis: { text: "## What worked\nOpeners <i>landed</i>.", created_at: "2026-10-25T18:52:00Z" },   // GMT again from 02:00 BST that morning
  });
  assert.ok(html.includes("<h3>What worked</h3>") && html.includes("Openers &lt;i&gt;landed&lt;/i&gt;."));
  assert.ok(html.includes("Written Sun 25 Oct, 18:52"));
  const bst = kpisHtml({ ...payloadFor2026W43, analysis: { text: "Fine.", created_at: "2026-10-18T17:52:00Z" } });
  assert.ok(bst.includes("Written Sun 18 Oct, 18:52"));   // UK time: BST is UTC + 1
  assert.ok(!html.includes("Claude writes its review on Sunday evening."));
  assert.ok(html.includes('href="/#/kpis?week=2026-W44"') && html.includes("›"));
  assert.ok(!html.includes("still collecting views and replies"));
  const last4 = html.slice(html.indexOf("Last 4 weeks"));
  const order = ["2026-W40", "2026-W41", "2026-W42", "2026-W43"].map((w) => last4.indexOf(`href="/#/kpis?week=${w}"`));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), String(order));
});

test("an unknown group is labelled <kind> (<author>), escaped", () => {
  const n = payloadFor2026W43.numbers;
  const g = { key: "x:y", kind: "<b>x</b>", author: "y", sent: 1, bounced: 0, viewed: 0, replied: 0, positive: 0, opted_out: 0 };
  const html = kpisHtml({ ...payloadFor2026W43, numbers: { ...n, groups: [...n.groups, g] } });
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt; (y)") && !html.includes("<b>x</b>"));
});

test("an empty week has no NaN, keeps the review and the trend", () => {
  const html = kpisHtml(emptyPayload);
  assert.ok(!html.includes("NaN") && !html.includes("undefined") && !html.includes("null"));
  assert.ok(html.includes("Numbers start after your first email goes out.") && html.includes("Claude writes its review on Sunday evening."));
  assert.ok(html.includes("Last 4 weeks"));
});

// ---------------------------------------------------------------- "too early to tell" is visible, not only a hover title

// The page with every title="…" removed (a phone never shows them), cut to one section: its heading to the next one.
const sectionOf = (html, heading) => {
  const bare = html.replace(/ title="[^"]*"/g, "");
  const at = bare.indexOf(`<h2>${heading}</h2>`);
  assert.ok(at >= 0, heading);
  const end = bare.indexOf('<div class="section-title">', at + 1);
  return bare.slice(at, end < 0 ? bare.length : end);
};

test("an empty week's grades and research tables say \"too early to tell\" in words", () => {
  const early = { k: 1, n: 1, pct: 100, early: true };
  const html = kpisHtml({
    ...emptyPayload,
    numbers: {
      ...emptyPayload.numbers,
      grades: [{ grade: "A+", emailed: 1, viewed: early, replied: early, won: { k: 0, n: 1, pct: 0, early: true } }],
      research: { researched: 3, with_email: 2, too_big: 0, wrong_flags: 0 },
    },
  });
  assert.match(html, /No emails sent this week/);
  const grades = sectionOf(html, "Do the grades predict sales?");
  assert.ok(grades.includes("too early to tell") && grades.includes("If A+ isn't doing better than B, the grading needs a tweak."), grades);
  assert.ok(sectionOf(html, "Research").includes("too early to tell"));
});

test("the hand-checked week's steps and Last 4 weeks tables say \"too early to tell\" in words", () => {
  const trend = lastWeeks("2026-W43", 4).map((w) => trendRow(computeWeek(rows, weekStartOf(w))));
  const html = kpisHtml({ ...payloadFor2026W43, trend });
  for (const h of ["Every kind of email", "Follow-up steps", "Do the grades predict sales?", "Research", "Last 4 weeks"]) {
    assert.ok(sectionOf(html, h).includes("too early to tell"), h);
  }
});

test("a table with no early cell has no early note", () => {
  const html = kpisHtml(payloadFor2026W43);   // trend: [] → "Nothing yet."
  assert.ok(!sectionOf(html, "Last 4 weeks").includes("too early to tell"));
  const big = { k: 12, n: 40, pct: 30, early: false };
  const grades = [{ grade: "A", emailed: 40, viewed: big, replied: big, won: big }];
  const g = sectionOf(kpisHtml({ ...payloadFor2026W43, numbers: { ...payloadFor2026W43.numbers, grades } }), "Do the grades predict sales?");
  assert.ok(!g.includes("too early to tell") && g.includes("If A+ isn't doing better than B"), g);
});

// ---------------------------------------------------------------- review fixes

test("a group named like an Object property is labelled <kind> (<author>), never undefined", () => {
  const n = payloadFor2026W43.numbers;
  const g = { key: "constructor", kind: "constructor", author: "x", sent: 1, bounced: 0, viewed: 0, replied: 0, positive: 0, opted_out: 0 };
  const html = kpisHtml({ ...payloadFor2026W43, numbers: { ...n, groups: [g] } });
  assert.ok(html.includes("constructor (x)") && !html.includes("undefined"), html);
});

test("the CSS: grey early numbers, tables scroll in their card, 2 tiles per row on a phone, review styles its own", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /\.early \{ color: var\(--text-3\); \}/);
  assert.match(css, /\.table-scroll \{ overflow-x: auto;/);
  const phone = css.slice(css.indexOf("@media (max-width: 640px)", css.indexOf("KPIs page")));
  assert.match(phone.slice(0, phone.indexOf("\n}")), /\.kpi-tiles \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  // The review card's class isn't .review: that's the lead drawer's Google reviews (leadview.js), whose look it would change.
  const html = kpisHtml({ ...payloadFor2026W43, analysis: { text: "Fine.", created_at: "2026-10-25T18:52:00Z" } });
  assert.ok(html.includes('class="card kpi-review"') && !/class="([^"]*\s)?review[\s"]/.test(html));
  const kpiCss = css.slice(css.indexOf("KPIs page (stage 11"), css.indexOf("nav: the Todo badge"));
  assert.ok(!/\.review(?![\w-])/.test(kpiCss), "the KPIs CSS restyles .review");
});
