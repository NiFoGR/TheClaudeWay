// KPIs routes (stage 11 Task 6): GET /api/kpis (the page), GET /api/agent/kpis (the weekly-kpis Routine: numbers,
// samples, approved follow-ups, earlier reviews; saves the snapshot) and POST /api/agent/kpis/:week (Claude's review,
// which becomes one `kpi` todo). The seed is the hand-checked week (fixtures/kpi-week.mjs) inserted into the real
// tables, plus rows that must not count: a drill lead's email and stage 0's unknown-sender and client escalations.
// Run: node --test control-room/tests/kpis-api.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { computeWeek, countSuggestions, suggestionLines, anonymise, kpiSamples, lastWeeks, trendRow, weekStartOf } from "../functions/_lib/kpis.js";
import { kpiFrom, kpiPayload, loadKpiRows } from "../functions/_lib/kpis-db.js";
import { addUkDays } from "../functions/_lib/ukTime.js";
import { setSecret } from "../functions/_lib/settings.js";
import { onRequestGet as kpisGet } from "../functions/api/kpis.js";
import { onRequestGet as agentKpisGet } from "../functions/api/agent/kpis.js";
import { onRequestPost as agentKpisPost } from "../functions/api/agent/kpis/[week].js";
import { rows } from "./fixtures/kpi-week.mjs";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const KEY = randomBytes(32).toString("base64url");
const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-25T17:47:00Z");

// ---------------------------------------------------------------- seeding the real tables

async function seed(DB) {
  await setSecret(DB, "agent_token", KEY);
  const run = (sql, ...values) => DB.prepare(sql).bind(...values).run();
  for (const m of rows.messages) {
    await run(`INSERT INTO messages (id, place_id, direction, kind, step, author, subject, body, status, due_at, sent_at,
        received_at, class, intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.id, m.place_id, m.direction, m.kind, m.step, m.author, m.subject, m.body, m.status, m.due_at, m.sent_at,
    m.received_at, m.class, m.intent, m.created_at);
  }
  // Must not count: a drill lead's sent first email.
  await run(`INSERT INTO messages (id, place_id, direction, kind, author, subject, body, status, sent_at, created_at)
    VALUES ('d1', 'drill:1', 'out', 'first', 'nik', 'Drill', 'A drill email', 'sent', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z')`);
  for (const [i, v] of rows.views.entries()) {
    await run("INSERT INTO demo_events (slug, place_id, kind, at) VALUES (?, ?, 'view', ?)", `${v.place_id}-demo`, v.place_id, v.at);
    // An order-page visit is not a view.
    if (i === 0) await run("INSERT INTO demo_events (slug, place_id, kind, at) VALUES (?, ?, 'order_page', ?)", `${v.place_id}-demo`, v.place_id, v.at);
  }
  for (const [i, c] of rows.calls.entries()) {
    await run("INSERT INTO calls (id, place_id, slot_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      `call${i}`, c.place_id, "2026-10-22T10:00:00Z", c.status, c.created_at, c.created_at);
  }
  for (const [i, o] of rows.orders.entries()) {
    await run(`INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, created_at)
      VALUES (?, ?, ?, 'weekend', ?, 24900, 90, ?, ?)`, `cl${i}`, "Hartley Removals", o.place_id, o.build_fee_pence, o.paid_on, `${o.paid_on}T12:00:00Z`);
  }
  const researched = new Set(rows.research.map((r) => r.place_id));
  for (const r of rows.research) {
    await run(`INSERT INTO research (place_id, status, grade, best_email, too_big, notes, researched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      r.place_id, r.status, rows.grades[r.place_id] ?? null, r.best_email, r.too_big, r.notes, r.researched_at);
  }
  // The other graded leads were researched weeks before.
  for (const [p, grade] of Object.entries(rows.grades)) {
    if (researched.has(p)) continue;
    await run(`INSERT INTO research (place_id, status, grade, best_email, too_big, researched_at) VALUES (?, 'done', ?, ?, 0, ?)`,
      p, grade, `owner@${p}.example`, "2026-10-05T07:00:00Z");
  }
  for (const [i, e] of rows.escalations.entries()) {
    await run(`INSERT INTO todos (id, kind, place_id, title, dedupe, created_at) VALUES (?, 'escalation', ?, 'Check this reply', ?, ?)`,
      `esc${i}`, e.place_id, e.dedupe, e.created_at);
  }
  // Must not count: stage 0's unknown-sender and client escalations.
  await run(`INSERT INTO todos (id, kind, title, dedupe, created_at)
    VALUES ('x9', 'escalation', 'Email from someone we don''t know', 'escalation:unknown:x9', '2026-10-22T09:00:00Z')`);
  await run(`INSERT INTO todos (id, kind, client_id, title, dedupe, created_at)
    VALUES ('c9', 'escalation', 'c9', 'Email from a client', 'escalation:client:c9', '2026-10-23T09:00:00Z')`);
  // Follow-up wording: step 1 approved, step 2 still a draft.
  await run("INSERT INTO followup_templates (step, day_offset, body, status, approved_at) VALUES (1, 1, 'Just checking this reached you: {demo_link}', 'approved', '2026-10-10T09:00:00Z')");
  await run("INSERT INTO followup_templates (step, day_offset, body, status) VALUES (2, 2, 'A draft nobody approved', 'draft')");
}

const DB = fakeD1();
await seed(DB);

const getKpis = (week, { now = NOW } = {}) => {
  const q = week === undefined ? "" : `?week=${encodeURIComponent(week)}`;
  return kpisGet({ request: new Request(`${ORIGIN}/api/kpis${q}`), env: { DB }, now });
};

const agentGet = (week, { token = KEY, now = NOW } = {}) => {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const q = week === undefined ? "" : `?week=${encodeURIComponent(week)}`;
  return agentKpisGet({ request: new Request(`${ORIGIN}/api/agent/kpis${q}`, { headers }), env: { DB }, now });
};

const agentPost = (week, body, { token = KEY, now = NOW } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`${ORIGIN}/api/agent/kpis/${encodeURIComponent(week)}`, {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return agentKpisPost({ request, env: { DB }, params: { week }, now });
};

// ---------------------------------------------------------------- the spec's tests (Task 6, Step 1)

test("page payload matches the pure numbers", async () => {
  const r = await (await getKpis("2026-W43")).json();
  assert.deepEqual([r.week, r.label, r.prev, r.next, r.still_counting], ["2026-W43", "19–25 Oct", "2026-W42", null, true]);
  assert.deepEqual(r.numbers.totals.revenue_pence, 175000);
  assert.deepEqual([r.numbers.totals.sent, r.numbers.claude.escalated], [9, 1]);   // drill, unknown-sender and client left out
  assert.equal(r.trend.length, 4);
});

test("bad and future weeks", async () => {
  assert.deepEqual(await (await getKpis("43")).json(), { error: "Week should look like 2026-W43." });
  assert.deepEqual(await (await getKpis("2026-W44")).json(), { error: "That week hasn't started yet." });
});

test("agent reads, snapshot is saved, review becomes one kpi todo", async () => {
  assert.equal((await agentGet("2026-W43", { token: null })).status, 401);
  const a = await (await agentGet("2026-W43")).json();
  assert.ok(a.samples.first_emails.length === 5 && !JSON.stringify(a.samples).match(/@|07\d{3}/));
  assert.ok(await DB.prepare("SELECT numbers FROM kpi_reports WHERE week = '2026-W43'").first());
  const md = "## The week in one line\nFine.\n## Suggestions\n1. Shorten follow-up 2: 0 of 1 replied.\n2. Keep openers.";
  assert.deepEqual(await (await agentPost("2026-W43", { analysis: md })).json(), { ok: true, suggestions: 2 });
  await agentPost("2026-W43", { analysis: md });
  const todos = (await DB.prepare("SELECT title, link, due_at FROM todos WHERE kind = 'kpi'").all()).results;
  assert.deepEqual(todos, [{ title: "Claude's email review for 19–25 Oct: 2 suggestions", link: "/#/kpis?week=2026-W43", due_at: "2026-10-26T08:00:00Z" }]);
  const four = md + "\n3. a\n4. b";
  assert.deepEqual(await (await agentPost("2026-W43", { analysis: four })).json(), { error: "At most 3 suggestions, found 4." });
  assert.equal((await agentPost("2026-W43", { analysis: "" })).status, 400);  // "The analysis is empty."
});

// ---------------------------------------------------------------- more edges

test("page and agent payloads: every number from computeWeek, samples, templates, the saved review", async () => {
  const loaded = await loadKpiRows(DB);
  const pure = computeWeek(rows, "2026-10-19");
  const r = await (await getKpis("2026-W43")).json();
  assert.deepEqual(r.numbers, JSON.parse(JSON.stringify(computeWeek(loaded, "2026-10-19"))));
  assert.deepEqual([r.numbers.groups, r.numbers.nik, r.numbers.claude, r.numbers.totals, r.numbers.grades, r.numbers.research],
    JSON.parse(JSON.stringify([pure.groups, pure.nik, pure.claude, pure.totals, pure.grades, pure.research])));
  assert.deepEqual(r.trend.map((t) => [t.week, t.first_sent]), [["2026-W40", 0], ["2026-W41", 0], ["2026-W42", 1], ["2026-W43", 5]]);
  assert.equal(r.start, "2026-10-19");
  assert.deepEqual(r.analysis.text.split("\n")[0], "## The week in one line");   // the review saved above
  assert.equal(r.analysis.created_at, "2026-10-25T17:47:00Z");

  // No ?week: the latest week with a review. An earlier week has a › arrow; a week 8+ days old is no longer counting.
  assert.equal((await (await getKpis()).json()).week, "2026-W43");
  const w42 = await (await getKpis("2026-W42", { now: new Date("2026-11-03T12:00:00Z") })).json();
  assert.deepEqual([w42.prev, w42.next, w42.still_counting, w42.analysis], ["2026-W41", "2026-W43", false, null]);
  assert.equal((await getKpis("2026-W54")).status, 400);

  const a = await (await agentGet("2026-W43")).json();
  assert.equal(a.numbers.totals.sent, 9);
  assert.deepEqual(a.followup_templates, [{ step: 1, day_offset: 1, body: "Just checking this reached you: {demo_link}" }]);
  assert.deepEqual(a.previous, []);   // reviews of earlier weeks only
  const p1 = a.samples.first_emails.find((s) => s.subject === "A website for Ashdown Roofing");
  assert.deepEqual([p1.viewed7, p1.replied, p1.positive, p1.bounced], [true, true, true, false]);
  const p4 = a.samples.first_emails.find((s) => s.subject === "A website for Moss Locksmiths");
  assert.deepEqual([p4.viewed7, p4.replied, p4.bounced], [false, false, true]);
  const cr = a.samples.claude_replies;
  assert.deepEqual(cr.map((s) => [s.minutes, s.moved_forward]), [[12, true], [4, false], [420, true]]);
  assert.match(cr[0].they_wrote, /\[phone\]/);
  assert.match(cr[2].they_wrote, /\[email\]/);
  assert.match(cr[2].claude_wrote, /£2,000/);
});

test("the review: limits, a re-post updates the open todo, nothing to change", async () => {
  assert.deepEqual(await (await agentPost("2026-W43", { analysis: "x".repeat(6001) })).json(),
    { error: "The analysis is too long: 6,001 characters (6,000 max)." });
  assert.deepEqual(await (await agentPost("2026-W43", "not json")).json(), { error: "Body must be a JSON object with analysis." });
  assert.deepEqual(await (await agentPost("2026-W43", { analysis: "   " })).json(), { error: "The analysis is empty." });
  assert.deepEqual(await (await agentPost("2026-W44", { analysis: "## Suggestions" })).json(), { error: "That week hasn't started yet." });
  assert.equal((await agentPost("2026-W43", { analysis: "x" }, { token: "wrong" })).status, 401);

  const one = "## The week in one line\nQuiet.\n## Suggestions\n1) Try a shorter subject line: 1 of 5 opened.\n   It reads better on a phone.";
  assert.deepEqual(await (await agentPost("2026-W43", { analysis: one })).json(), { ok: true, suggestions: 1 });
  let todo = await DB.prepare("SELECT title, detail, status FROM todos WHERE dedupe = 'kpi:2026-W43'").first();
  assert.deepEqual(todo, { title: "Claude's email review for 19–25 Oct: 1 suggestion", detail: "Try a shorter subject line: 1 of 5 opened.", status: "open" });

  // A week with no snapshot yet gets one with the review; no suggestions → "nothing to change".
  const none = "## The week in one line\nNothing sent.\n## Suggestions\nNone yet.";
  assert.deepEqual(await (await agentPost("2026-W42", { analysis: none })).json(), { ok: true, suggestions: 0 });
  const w42 = await DB.prepare("SELECT numbers, analysis FROM kpi_reports WHERE week = '2026-W42'").first();
  assert.equal(JSON.parse(w42.numbers).nik.first_sent, 1);
  assert.equal(w42.analysis, none);
  todo = await DB.prepare("SELECT title, detail, due_at FROM todos WHERE dedupe = 'kpi:2026-W42'").first();
  assert.deepEqual(todo, { title: "Claude's email review for 12–18 Oct: nothing to change", detail: "", due_at: "2026-10-19T07:00:00Z" });   // 08:00 BST

  // Done stays done: a later re-post changes nothing on it.
  await DB.prepare("UPDATE todos SET status = 'done' WHERE dedupe = 'kpi:2026-W43'").run();
  await agentPost("2026-W43", { analysis: "## Suggestions\n1. a\n2. b\n3. c" });
  todo = await DB.prepare("SELECT title, status FROM todos WHERE dedupe = 'kpi:2026-W43'").first();
  assert.deepEqual(todo, { title: "Claude's email review for 19–25 Oct: 1 suggestion", status: "done" });

  // The agent's previous reviews: earlier weeks with a review, newest first.
  const a = await (await agentGet("2026-W43")).json();
  assert.deepEqual(a.previous, [{ week: "2026-W42", analysis: none }]);
});

test("the samples' bodies: only the ones they quote are read, and only their start", async () => {
  const loaded = await loadKpiRows(DB);
  const body = (id) => loaded.messages.find((m) => m.id === id).body;
  assert.match(body("m1"), /Ashdown Roofing/);    // Nik's first email
  assert.match(body("c1"), /quick call/);         // Claude's reply
  assert.match(body("i2"), /Looks good/);         // a human reply
  assert.deepEqual([body("m6"), body("i1"), body("i6")], ["", "", ""]);   // a follow-up, a bounce, an opt-out
  await DB.prepare(`INSERT INTO messages (id, place_id, direction, kind, author, subject, body, status, received_at, class, intent, created_at)
    VALUES ('long', 'p9', 'in', 'inbound', 'them', 'Re: hi', ?, 'received', '2025-01-01T09:00:00Z', 'human', 'question', '2025-01-01T09:00:00Z')`)
    .bind("x".repeat(5000)).run();
  assert.equal((await loadKpiRows(DB)).messages.find((m) => m.id === "long").body.length, 2400);
  assert.equal((await loadKpiRows(DB, { bodies: false })).messages.find((m) => m.id === "long").body, "");
  await DB.prepare("DELETE FROM messages WHERE id = 'long'").run();

  // The Routine with no ?week reviews the current UK week (Mon 26 Oct 00:30 GMT is already week 44).
  assert.equal((await (await agentGet(undefined)).json()).week, "2026-W43");
  assert.equal((await (await agentGet(undefined, { now: new Date("2026-10-26T00:30:00Z") })).json()).week, "2026-W44");
  assert.equal((await agentGet("2026-W44")).status, 400);
});

test("suggestion lines and anonymise (pure)", () => {
  const md = "## What worked\n1. Not a suggestion\n## Suggestions\n1. First change: 3 of 12.\nmore words\n 2) Second\n### Detail\n3. Third\n## After\n4. Not one";
  assert.equal(countSuggestions(md), 3);
  assert.deepEqual(suggestionLines(md), ["First change: 3 of 12.", "Second", "Third"]);
  assert.equal(countSuggestions("No headings at all\n1. x"), 0);
  assert.deepEqual(suggestionLines(""), []);
  assert.equal(anonymise("Mail jo.smith+x@wren.example or ring +44 7700 900123 / 01632 960 001."),
    "Mail [email] or ring [phone] / [phone].");
  // Punctuated UK numbers too; dates, times and prices stay.
  assert.equal(anonymise("Call 07700-900-123, (01632) 960001, +44 (0)7700 900123 or +44-7700-900123."),
    "Call [phone], [phone], [phone] or [phone].");
  assert.equal(anonymise("On 2026-10-19 at 07:00, £1,750 and 0 of 12 replied."), "On 2026-10-19 at 07:00, £1,750 and 0 of 12 replied.");
  assert.equal(anonymise("a".repeat(1300)).length, 1200);
  assert.equal(anonymise(null), "");
});

test("anonymise stays fast on a long unbroken word, with or without an @ (a prospect writes the text)", () => {
  const time = (text) => {
    anonymise(text);   // warm up
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      anonymise(text);
      runs.push(performance.now() - t);
    }
    return Math.min(...runs);
  };
  const long = "a".repeat(2400);
  assert.ok(time(long) < 2, `${time(long).toFixed(2)} ms on 2,400 letters`);
  assert.ok(time(`@${long}`) < 2, `${time(`@${long}`).toFixed(2)} ms on an @ and 2,400 letters`);
  assert.equal(anonymise(long).length, 1200);
  // Real addresses still go, up to the RFC's 64-character local part.
  assert.equal(anonymise(`write to ${"j".repeat(64)}@wren.example today`), "write to [email] today");
});

test("a body cut by the loader never leaves part of a phone number in the samples", () => {
  // loadKpiRows reads 2,400 characters; long addresses before the cut shrink to "[email]", pulling the cut into view.
  const addr = `${"j".repeat(64)}@${"w".repeat(250)}.com`;
  let body = `${addr} `.repeat(4);
  body += "x ".repeat(Math.floor((2392 - body.length) / 2)).padEnd(2392 - body.length, "y");
  const cut = `${body}07700 900123 please call`.slice(0, 2400);
  assert.match(cut, /07700 90$/);
  const at = (t) => `2026-10-19T${t}:00Z`;
  const msgs = [
    { id: "a", place_id: "p", direction: "out", kind: "first", author: "nik", status: "sent", sent_at: at("08:00"), subject: "Hi", body: cut },
    { id: "b", place_id: "p", direction: "in", kind: "inbound", author: "them", status: "received", class: "human", intent: "question", received_at: at("09:00"), body: cut },
    { id: "c", place_id: "p", direction: "out", kind: "reply", author: "claude", status: "sent", sent_at: at("09:05"), subject: "Re: Hi", body: cut },
  ];
  const s = kpiSamples({ messages: msgs, views: [], calls: [], orders: [], research: [], escalations: [], grades: {} }, "2026-10-19");
  const text = JSON.stringify(s);
  assert.ok(!/07\d{3}|\b90\b|@/.test(text), text.slice(-80));
  assert.match(s.claude_replies[0].they_wrote, /\[email\] \[email\] \[email\] \[email\] x x/);
  // A shorter body (not cut) keeps its last word.
  const short = kpiSamples({ messages: [{ ...msgs[0], body: "Ring 07700 900123 today" }], views: [], calls: [], orders: [], research: [], escalations: [], grades: {} }, "2026-10-19");
  assert.equal(short.first_emails[0].body, "Ring [phone] today");
});

// ---------------------------------------------------------------- a year of sending: what's read depends on the weeks shown

// About 12 months of sending: 2 first emails a day (3 mailboxes' worth at the planned pace, cut to keep the test quick),
// follow-ups on days 1, 2, 4, 7, 10, 17, 24, 30 and 60 until a bounce, opt-out or reply, Claude's replies 20 minutes
// after a human one, demo views, calls, orders, escalations, graded research and "[Nik …]" flags. Every 4th time is
// stored with no zone ("2026-10-19 08:00:00"), as SQLite's datetime() writes them. Deterministic (seeded).
function seedYear(DB) {
  let x = 20261025;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const DAY = 86400000;
  const nowMs = NOW.getTime();
  const firstDay = Date.UTC(2025, 9, 27);
  let n = 0;
  const stamp = (ms) => (++n % 4 === 0 ? new Date(ms).toISOString().slice(0, 19).replace("T", " ") : new Date(ms).toISOString());
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const raw = DB.raw;
  const msg = raw.prepare(`INSERT INTO messages (id, place_id, direction, kind, step, author, subject, body, status, sent_at, received_at,
      class, intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const view = raw.prepare("INSERT INTO demo_events (slug, place_id, kind, at) VALUES (?, ?, 'view', ?)");
  const call = raw.prepare("INSERT INTO calls (id, place_id, slot_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  const client = raw.prepare(`INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, created_at)
      VALUES (?, 'A client', ?, 'full', 195000, 24900, 60, ?, ?)`);
  const research = raw.prepare("INSERT INTO research (place_id, status, grade, best_email, too_big, notes, researched_at) VALUES (?, 'done', ?, ?, ?, ?, ?)");
  const esc = raw.prepare("INSERT INTO todos (id, kind, place_id, title, dedupe, created_at) VALUES (?, 'escalation', ?, 'Check this reply', ?, ?)");
  const OFFSETS = [1, 2, 4, 7, 10, 17, 24, 30, 60];
  const INTENTS = ["interested", "question", "price", "not_interested", "call_request", "not_interested"];
  raw.exec("BEGIN");
  for (let i = 0; i < 730; i++) {
    const p = `y${i}`;
    const first = firstDay + Math.floor(i / 2) * DAY + (7 + (i % 9)) * 3600000 + Math.floor(rnd() * 50) * 60000;
    if (first >= nowMs) break;
    const grade = ["A+", "A", "B", "C", "D"][Math.floor(rnd() * 5)];
    const flagAt = day(first + Math.floor(rnd() * 300) * DAY);
    const notes = rnd() < 0.08 ? `[Nik ${flagAt}] ${rnd() < 0.3 ? "Not a fit: too big" : "Wrong owner"}` : "";
    research.run(p, grade, rnd() < 0.8 ? `owner@${p}.example` : null, rnd() < 0.05 ? 1 : 0, notes, stamp(first - DAY));
    const fate = rnd();
    const stopAt = fate < 0.08 ? 0 : Math.floor(rnd() * 5); // the step after which the bounce, opt-out or reply comes
    const sends = [first, ...OFFSETS.map((d) => first + d * DAY)];
    for (let step = 0; step < sends.length; step++) {
      const at = sends[step];
      if (at >= nowMs) break;
      msg.run(`${p}-s${step}`, p, "out", step === 0 ? "first" : "followup", step === 0 ? null : step, step === 0 ? "nik" : "system",
        `A website for ${p}`, `Hi, I built ${p} a website: {demo_link}`, "sent", stamp(at), null, null, null, stamp(at));
      if (rnd() < 0.06 && at + 2 * DAY < nowMs) view.run(`${p}-demo`, p, stamp(at + Math.floor(rnd() * 2 * DAY)));
      if (step !== stopAt || fate >= 0.3) continue;
      const back = at + (fate < 0.08 ? 300000 : 3 * 3600000);
      if (back >= nowMs) break;
      if (fate < 0.08) {
        msg.run(`${p}-b`, p, "in", "inbound", null, "them", "Undeliverable", "No such user", "received", null, stamp(back), "bounce", null, stamp(back));
      } else if (fate < 0.11) {
        msg.run(`${p}-o`, p, "in", "inbound", null, "them", "Re: hi", "Please remove me", "received", null, stamp(back), "opt_out", null, stamp(back));
      } else {
        const intent = INTENTS[Math.floor(rnd() * INTENTS.length)];
        msg.run(`${p}-h`, p, "in", "inbound", null, "them", "Re: hi", `Ring me on 07700 900${String(i).padStart(3, "0")}, ${intent}`, "received", null,
          stamp(back), "human", intent, stamp(back));
        const reply = back + 20 * 60000;
        if (reply < nowMs) {
          msg.run(`${p}-c`, p, "out", "reply", null, "claude", "Re: hi", "Happy to help: around £2,000 all in.", "sent", stamp(reply), null, null, null, stamp(reply));
          if (rnd() < 0.3) esc.run(`${p}-e`, p, `escalation:${p}-h`, stamp(reply));
          if (intent !== "not_interested" && rnd() < 0.4 && reply + DAY < nowMs) {
            call.run(`${p}-call`, p, new Date(reply + 2 * DAY).toISOString(), "confirmed", stamp(reply + DAY), stamp(reply + DAY));
          }
          if (intent !== "not_interested" && rnd() < 0.15 && reply + 3 * DAY < nowMs) client.run(`${p}-cl`, p, day(reply + 3 * DAY), stamp(reply + 3 * DAY));
        }
      }
      break;
    }
  }
  raw.exec("COMMIT");
}

test("a year of sending: KPIs read only the weeks shown and give the same numbers as reading everything", async () => {
  const Y = fakeD1();
  seedYear(Y);
  const total = (await Y.prepare("SELECT COUNT(*) AS n FROM messages").first()).n;
  assert.ok(total > 4000, `${total} messages seeded`);

  const week = "2026-W43";
  const from = kpiFrom(week);
  assert.equal(from, "2026-09-28");   // the Monday of the oldest of the 4 trend weeks
  const bounded = await loadKpiRows(Y, { from, bodiesFrom: weekStartOf(week) });
  const outSince = addUkDays(from, -1), inSince = addUkDays(from, -8);
  // Only the window: sent mail from the day before the oldest week, inbound from 8 days before (reply speed looks back).
  for (const m of bounded.messages) {
    if (m.direction === "out") assert.ok(m.sent_at >= outSince, `${m.id} sent ${m.sent_at}`);
    else assert.ok(m.received_at >= inSince, `${m.id} received ${m.received_at}`);
  }
  for (const v of bounded.views) assert.ok(v.at >= outSince);
  for (const c of bounded.calls) assert.ok(c.created_at >= outSince);
  for (const o of bounded.orders) assert.ok(o.paid_on >= outSince);
  for (const e of bounded.escalations) assert.ok(e.created_at >= outSince);
  for (const r of bounded.research) assert.ok(r.researched_at >= outSince || r.notes.includes("[Nik "));
  assert.ok(bounded.messages.length < total / 5, `${bounded.messages.length} of ${total} read`);
  // Bodies only for the reviewed week's mail (and the inbound before it).
  assert.ok(bounded.messages.filter((m) => m.direction === "out" && m.sent_at < addUkDays(weekStartOf(week), -1)).every((m) => m.body === ""));

  // The full, unbounded computation: every row, and grade calibration from the raw rows and grades (kpis.js).
  const all = await loadKpiRows(Y);
  const grades = Object.fromEntries((await Y.prepare("SELECT place_id, grade FROM research").all()).results.map((r) => [r.place_id, r.grade]));
  const full = { ...all, calibration: undefined, grades };
  const json = (x) => JSON.parse(JSON.stringify(x));
  for (const w of lastWeeks(week, 4)) {
    assert.deepEqual(json(computeWeek(bounded, weekStartOf(w))), json(computeWeek(full, weekStartOf(w))), w);
  }
  const n = computeWeek(bounded, weekStartOf(week));
  assert.ok(n.totals.sent > 50 && n.claude.replies_sent > 0 && n.nik.first_sent > 0, "the week has mail of each kind");
  assert.ok(n.grades.filter((g) => g.emailed > 50 && g.replied.k > 0).length === 5, "calibration covers the year");
  assert.deepEqual(json(kpiSamples(bounded, weekStartOf(week))), json(kpiSamples(full, weekStartOf(week))));

  // The page and the Routine read the same window.
  const page = await kpiPayload(Y, week, NOW);
  assert.deepEqual(page.numbers, json(computeWeek(full, weekStartOf(week))));
  assert.deepEqual(page.trend, json(lastWeeks(week, 4).map((w) => trendRow(computeWeek(full, weekStartOf(w))))));
  await setSecret(Y, "agent_token", KEY);
  const routine = await (await agentKpisGet({ request: new Request(`${ORIGIN}/api/agent/kpis?week=${week}`, { headers: { authorization: `Bearer ${KEY}` } }), env: { DB: Y }, now: NOW })).json();
  assert.deepEqual(routine.numbers, page.numbers);
  assert.deepEqual(routine.samples, json(kpiSamples(full, weekStartOf(week))));

  // The 4 weeks' work stays well inside the free plan's 10 ms (fresh rows each run: nothing cached).
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const fresh = { ...bounded, messages: [...bounded.messages] };
    const t = performance.now();
    for (const w of lastWeeks(week, 4)) computeWeek(fresh, weekStartOf(w));
    runs.push(performance.now() - t);
  }
  assert.ok(Math.min(...runs) < 10, `${Math.min(...runs).toFixed(1)} ms for 4 weeks`);
});
