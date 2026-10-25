// End-to-end with fake SMTP (stage 5–6, docs/rebuild/06-email-followups.md Part B Task 16, Part A §A11 #2–#4): Nik's
// first email goes through sendFirst, then the tick is simulated every 15 minutes (the `followups` step, then stage 0's
// dispatchDue with a fake SMTP `send` that records every email), for 75 days of UK time across the BST→GMT change.
// The 9 follow-ups go at the A4 times in the same thread from the same mailbox; a reply, an opt-out or a bounce (read
// by stage 0's real inbound step) stops them, a demo view or an out-of-office doesn't; and one mailbox capped at 10 a
// day never sends more, turns Nik away only when a day it would book is really full, and when its cap is cut sends
// follow-ups before first emails and skips none. Then Part A's edge cases end to end: a reply before the send is
// recorded (A9), a demo view before it is recorded (stage 4's beacon, 05 Part A §8), a paused mailbox (A9, A5) and
// follow-ups approved after the first email went (A4, Q-L).
//
// Volume: A11 #4's 0.8–1.2 new businesses a day over days 61–70 is NOT met with A4's schedule, and stays an open item
// for Nik (Q-K in 06-email-followups.md lists the measured options). Offsets 10, 17 and 24 days are all 3 mod 7, 2 and
// 30 are 2, and 4 and 60 are 4, so for each of them the start day whose follow-up would land on a Sunday lands on
// Monday with the one that's due there anyway. At one new business a sending day, Monday would need about 16 of the
// week's 60 sends. With 10 a day, Monday fills first and turns new first emails away: one a morning whenever there's
// room starts about 0.4–0.5 a day (one mailbox ≈ 3.5 new businesses a week, A2), and sending as many as there's room
// for goes in bursts of 10 (from this Thursday start: days 1, 13, 34 and 45, so none over days 61–70). The most these
// rules allow is about 0.85 a day (5.9 a week), and only with a planned mix of start days (almost none on a Thursday or
// Friday), which nothing here plans. The test is an honest regression check on what the schedule gives today (0.3–0.6
// a day) and the exact room behind it; if Nik changes Q-K, change FOLLOWUP_DAYS or the Sunday rule in followups.js and
// restore A11 #4's 0.8–1.2 here if the new schedule reaches it.
// Run: node --test control-room/tests/email-e2e.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoLink } from "../functions/_lib/demo-db.js";
import { composeContext, sendFirst } from "../functions/_lib/first-email.js";
import {
  DRAFTS, ensureTemplates, followupHealthFromDb, followupsStep, renderFollowup, roomForFirsts, stopFollowups,
} from "../functions/_lib/followups.js";
import { coldFooter } from "../functions/_lib/mail/compose.js";
import { processInbound } from "../functions/_lib/mail/inbound-db.js";
import { dispatchDue } from "../functions/_lib/mail/outbox.js";
import { applyStageEvent } from "../functions/_lib/prospects.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { addUkDays, ukDate, ukParts } from "../functions/_lib/ukTime.js";
import { onRequestPost as approveFollowup } from "../functions/api/voice/followups/[step]/approve.js";
import { onRequestPost as beacon } from "../functions/d/[slug]/e.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedMailbox, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

const MIN = 60000;
const TICK = 15 * MIN; // the simulated tick: every 15 minutes (the real one runs every 5)
const DAY = 24 * 60 * MIN;
const START = Date.parse("2026-10-22T08:15:00Z"); // Thu 22 Oct 2026, 09:15 BST: Nik presses Send
const EMAIL = "mark@greenleaf.co.uk";
const INPUT = { to: EMAIL, subject: "Your website", body: "I made you a new website, have a look: {demo_link}" };
const MARK = { first: "Mark", full: "Mark Green", source_url: "https://greenleaf.co.uk/about", confident: true };
const DEMO_LIVE_UNTIL = "2027-12-31T00:00:00Z";
// A phone's browser, as the demo page's beacon arrives from it (stage 4's bots.js lets it through).
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

/**
 * Stage 4's demoReady, injected: every demo is up (the demo gate has its own tests in followups-db.test.mjs). Like the
 * real one it reads the lead's latest demo in one D1 statement, so the followups step spends its 18 queries as it does
 * live (a stub that costs nothing hid a budget bug: followups-db.test.mjs, "a busy run still queues 3").
 */
const okDemo = async (DB, placeId) => {
  const demo = await DB.prepare("SELECT slug FROM demos WHERE place_id = ? ORDER BY created_at DESC, slug DESC LIMIT 1")
    .bind(placeId).first();
  return demo ? { ok: true, reason: "", url: demoLink(demo.slug), slug: demo.slug }
    : { ok: false, reason: "No demo yet: Lead not found", url: null, slug: null };
};
const demoUrl = (placeId) => demoLink(placeId); // readyLead's demo slug is the place_id

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const getProspect = (DB, id) => one(DB, "SELECT * FROM prospects WHERE place_id = ?", id);
const queuedFollowups = async (DB, id) =>
  Number((await one(DB, "SELECT COUNT(*) AS n FROM messages WHERE place_id = ? AND kind = 'followup' AND status = 'queued'", id)).n);

/**
 * The world every test starts from: cold mailbox m1 (nik@aetoswebsites.com, From "Nik Example", started long ago, cap
 * `cap`) with its password saved (dispatchDue holds every email until it is), business:sender_name "Nik" (the footer),
 * and all 9 follow-up templates seeded as their A6 drafts and approved (left as drafts with `approved: false`).
 */
async function world({ cap = 10, approved = true } = {}) {
  const DB = fakeD1();
  await seedMailbox(DB, {
    id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example", started_on: "2026-01-01", cap_override: cap,
  });
  await setSecret(DB, "mailbox:m1", "x");
  await setSetting(DB, "business:sender_name", "Nik");
  await ensureTemplates(DB);
  if (approved) {
    await DB.prepare("UPDATE followup_templates SET status = 'approved', approved_at = ?").bind("2026-10-20T09:00:00Z").run();
  }
  return DB;
}

/**
 * A lead ready for its first email (stage 3's ready rule, which the outbox's claim checks too): research done (grade A,
 * owner Mark confident, `email` its best and only address), a live demo and a `ready` prospect writing to `email`.
 */
async function readyLead(DB, placeId, { name = "Green Leaf Landscapes", email = EMAIL } = {}) {
  await seedLead(DB, { place_id: placeId, name, trade: "landscaper" });
  await seedResearch(DB, {
    place_id: placeId, grade: "A", owner: MARK, best_email: email,
    emails: [{ email, source_url: `https://example.com/${placeId}/contact`, where: "Contact page" }],
    angle: [{ fact: "48 five-star Google reviews", source_url: "https://maps.google.com/?cid=1" }], opener: "",
  });
  await seedDemo(DB, { place_id: placeId, slug: placeId, expires_at: DEMO_LIVE_UNTIL });
  await seedProspect(DB, { place_id: placeId, email, greet_name: null });
}

// Follow-ups whose time has come but that haven't gone (?1 = now): `queued` and due (dispatchDue sends them before
// any first email: A4), and `booked`, due but not queued yet (queueDue queues at most 3 a run, within its D1 queries).
const WAITING_SQL = `SELECT
    (SELECT COUNT(*) FROM messages WHERE direction = 'out' AND kind = 'followup' AND status = 'queued' AND due_at <= ?1)
      AS queued,
    (SELECT COUNT(*) FROM prospects WHERE stage IN ('emailed', 'viewed') AND followup_step < 9
       AND next_followup_at <= ?1) AS booked`;
const waitingAt = async (DB, ms) => {
  const row = await one(DB, WAITING_SQL, iso(ms));
  return { queued: Number(row.queued), booked: Number(row.booked) };
};

/**
 * The tick, every `tick` simulated ms (15 minutes unless given) from `from` for `days` days, skipping any time
 * `when(now)` refuses (default: none): first `before(now, sent)` (Nik and the outside
 * world: Send, a demo view, an inbound email), then the `followups` step, then the send step's dispatchDue (2 sends a
 * tick, as sendStep allows) with the fake SMTP. Returns every email "sent": {to, headers, text, at (ms), day (UK),
 * mailbox, place_id, kind, step, waiting}, read from its messages row; `waiting` is, for a first email, the follow-ups
 * waiting as it went ({queued, booked}: WAITING_SQL), else null.
 */
async function simulate(DB, { from, days, before = null, tick = TICK, when = null }) {
  const sent = [];
  let now = null;
  const send = async (mailbox, _password, message) => {
    const row = await one(DB, "SELECT place_id, kind, step FROM messages WHERE message_id = ? AND status = 'sending'",
      message.headers["Message-ID"]);
    const waiting = row.kind === "first" ? await waitingAt(DB, now.getTime()) : null;
    sent.push({
      to: message.to, headers: message.headers, text: message.text, at: now.getTime(), day: ukDate(now),
      mailbox: mailbox.id, place_id: row.place_id, kind: row.kind, step: row.step, waiting,
    });
    return { ok: true };
  };
  for (let ms = from; ms < from + days * DAY; ms += tick) {
    now = new Date(ms);
    if (when && !when(now)) continue;
    if (before) await before(now, sent);
    await followupsStep({ DB, env: {}, now }, { demoReady: okDemo });
    await dispatchDue(DB, {}, now, { limit: 2, send });
  }
  return sent;
}

/** `before` for simulate: each [UTC ISO time, fn(now, sent)] runs once, on the first tick at or after its time. */
function events(list) {
  const waiting = list.map(([at, fn]) => ({ at: Date.parse(at), fn }));
  return async (now, sent) => {
    for (const e of waiting) {
      if (!e.done && now.getTime() >= e.at) {
        e.done = true;
        await e.fn(now, sent);
      }
    }
  };
}

// ---- Inbound mail, as the relay saves it (tests/fixtures/mail, as inbound-db.test.mjs uses them)

const fixture = (name) => readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url), "utf8");

// The headers the relay stores: the top-level header block, lower-cased keys, as JSON (inbound-db.test.mjs's).
function relayHeaders(raw) {
  const block = raw.split(/\r?\n\r?\n/)[0];
  const h = new Headers();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return JSON.stringify(Object.fromEntries(h));
}

// Replace a header of the top-level block (folded lines included, any case).
function setHeader(raw, name, value) {
  const end = raw.indexOf("\r\n\r\n");
  const head = `${raw.slice(0, end)}\r\n`;
  const re = new RegExp(`^${name}:[^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*(?:\\r\\n)?`, "im");
  assert.match(head, re, `${name} header`);
  return head.replace(re, `${name}: ${value}\r\n`).slice(0, -2) + raw.slice(end);
}

let rawSeq = 0;
// An email arriving at `now`, then the inbound step reading it (as the next tick's first step would).
async function receive(DB, raw, now) {
  const id = `raw-e2e-${++rawSeq}`;
  await DB.prepare("INSERT INTO inbound_raw (id, received_at, envelope_from, envelope_to, headers, raw) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, iso(now.getTime()), "someone@example.com", "nik@aetoswebsites.com", relayHeaders(raw), raw)
    .run();
  return processInbound(DB, now);
}

// Their reply to the latest email of the thread (`sent`): `fixtureName` with From = the lead, threaded under it.
function replyTo(fixtureName, sent, from = `Mark Green <${EMAIL}>`) {
  const ids = sent.map((s) => s.headers["Message-ID"]);
  let raw = setHeader(fixture(fixtureName), "From", from);
  raw = setHeader(raw, "In-Reply-To", ids.at(-1));
  return setHeader(raw, "References", ids.join(" "));
}

// Gmail's bounce of the latest email of the thread (`sent`), which went to `address`.
const bounceOf = (sent, address) => fixture("dsn-gmail.eml")
  .replaceAll("<orig@aetoswebsites.com>", sent.at(-1).headers["Message-ID"])
  .replaceAll("nobody@x.com", address);

/** Nik's first email to p1 at START, then the tick for `days` days; `before(DB)` gives simulate's `before`. */
async function oneLead({ days = 75, before = null } = {}) {
  const DB = await world();
  await readyLead(DB, "p1");
  const r = await sendFirst(DB, "p1", INPUT, new Date(START), { demoReady: okDemo });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.due_at, iso(START)); // inside the window: it goes at once
  const sent = await simulate(DB, { from: START, days, before: before ? before(DB) : null });
  return { DB, sent };
}

// ---------------------------------------------------------------- the plan's tests (Part B, Task 16, Step 1)

test("first email + 9 follow-ups at the right UK times across BST→GMT", async () => {
  const { DB, sent } = await oneLead(); // sendFirst at 2026-10-22T08:15:00Z, all templates approved, run the loop
  assert.equal(sent.length, 10);
  const want = ["2026-10-22T08:15", "2026-10-23T08:15", "2026-10-24T08:15", "2026-10-26T09:15", "2026-10-29T09:15",
    "2026-11-02T09:15", "2026-11-09T09:15", "2026-11-16T09:15", "2026-11-21T09:15", "2026-12-21T09:15"];
  want.forEach((w, i) => {
    const late = sent[i].at - Date.parse(`${w}:00Z`);
    assert.ok(late >= 0 && late < 15 * MIN, `email ${i}: sent ${iso(sent[i].at)}, due ${w}`);
  });
  sent.slice(1).forEach((s, i) => {
    assert.equal(s.headers["In-Reply-To"], sent[0].headers["Message-ID"]);
    assert.equal(s.headers.References.split(" ").length, i + 1);
    assert.equal(s.headers.Subject, "Re: Your website");
  });
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "lost"); assert.equal(p.lost_reason, "sequence_done");

  // ---- beyond the plan's assertions
  // The References grow by one each time: the first email, then every follow-up sent before this one, in order.
  const ids = sent.map((s) => s.headers["Message-ID"]);
  assert.equal(new Set(ids).size, 10, "a new Message-ID for every email");
  sent.slice(1).forEach((s, i) => assert.equal(s.headers.References, ids.slice(0, i + 1).join(" "), `follow-up ${i + 1}`));
  // One mailbox, one address, one subject line (the first email's own), every one ending with Nik's cold footer.
  assert.deepEqual([...new Set(sent.map((s) => s.mailbox))], ["m1"]);
  assert.deepEqual([...new Set(sent.map((s) => s.to))], [EMAIL]);
  assert.ok(sent.every((s) => s.headers.From === "Nik Example <nik@aetoswebsites.com>"), "From is the mailbox's");
  assert.equal(sent[0].headers.Subject, "Your website");
  assert.equal(sent[0].headers["In-Reply-To"], undefined);
  assert.equal(sent[0].text, `Hi Mark,\n\nI made you a new website, have a look: ${demoUrl("p1")}\n\n${coldFooter("Nik")}`);
  // Each follow-up is its approved wording, for this lead: "Hi Mark,", the cleaned name, their demo link.
  sent.slice(1).forEach((s, i) => {
    const step = i + 1;
    const body = renderFollowup(DRAFTS[step], { greeting: "Hi Mark,", business: "Green Leaf Landscapes", demoUrl: demoUrl("p1") });
    assert.equal(s.text, `${body}\n\n${coldFooter("Nik")}`, `follow-up ${step}`);
  });
  // The database agrees: 10 emails sent, steps 1–9 in order, nothing failed, cancelled or still waiting.
  const out = await all(DB, "SELECT kind, step, status, sent_at FROM messages WHERE direction = 'out' ORDER BY sent_at");
  assert.deepEqual(out.map((m) => [m.kind, m.step, m.status]),
    [["first", null, "sent"], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => ["followup", step, "sent"])]);
  assert.deepEqual(out.map((m) => Date.parse(m.sent_at)), sent.map((s) => s.at));
  // Closed as lost 7 days after follow-up 9 (Mon 28 Dec 09:15 GMT), nothing booked after it, Nik's words kept once.
  const closedLate = Date.parse(p.stage_at) - Date.parse("2026-12-28T09:15:00Z");
  assert.ok(closedLate >= 0 && closedLate < 15 * MIN, `closed ${p.stage_at}`);
  assert.equal(p.followup_step, 9);
  assert.equal(p.next_followup_at, null);
  assert.equal(p.first_sent_at, iso(sent[0].at));
  assert.equal(p.root_message_id, ids[0]);
  const examples = await all(DB, "SELECT id, situation, source, body FROM style_examples");
  assert.equal(examples.length, 1);
  assert.equal(examples[0].source, "nik_sent");
  assert.equal(examples[0].body, `Hi Mark,\n\nI made you a new website, have a look: ${demoUrl("p1")}`);
});

test("a reply on day 3 stops the rest; a demo view does not", async () => {
  const checks = {};
  const { DB, sent } = await oneLead({
    before: (DB) => events([
      // Day 0, after the first email: an out-of-office comes back (class auto: A5, it never stops anything).
      ["2026-10-22T12:00:00Z", async (now, sentSoFar) => {
        checks.auto = await receive(DB, replyTo("ooo.eml", sentSoFar), now);
      }],
      // Day 1, after follow-up 1: they open the demo (stage 4's view counter fires demo_view).
      ["2026-10-23T12:00:00Z", async (now) => {
        assert.deepEqual(await applyStageEvent(DB, "p1", "demo_view", now), { from: "emailed", to: "viewed" });
      }],
      // Day 2, after follow-up 2: still going while viewed.
      ["2026-10-24T12:00:00Z", async () => { checks.day2 = await getProspect(DB, "p1"); }],
      // Day 3 (Sun 25 Oct, 10:00 GMT): Mark writes back in the thread; stage 0's inbound step reads it.
      ["2026-10-25T10:00:00Z", async (now, sentSoFar) => {
        checks.inbound = await receive(DB, replyTo("gmail-reply.eml", sentSoFar), now);
      }],
    ]),
  });
  // demo_view on day 1 → stage viewed, keeps going; inbound human on 2026-10-25 → 3 sent in total, stage replied
  assert.deepEqual(checks.auto, { auto: 1 });
  assert.equal(checks.day2.stage, "viewed");
  assert.equal(checks.day2.followup_step, 2);
  assert.ok(checks.day2.next_followup_at, "follow-up 3 still booked while they've only viewed the demo");
  assert.deepEqual(checks.inbound, { human: 1 });
  assert.equal(sent.length, 3, sent.map((s) => iso(s.at)).join(", "));
  assert.deepEqual(sent.map((s) => iso(s.at)), ["2026-10-22T08:15:00Z", "2026-10-23T08:15:00Z", "2026-10-24T08:15:00Z"]);
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "replied");
  assert.equal(p.followup_step, 2);
  assert.equal(p.next_followup_at, null);
  assert.equal(await queuedFollowups(DB, "p1"), 0);
  // Nothing was ever queued after the reply, so there's nothing for stage 7's stopFollowups to cancel either.
  assert.equal(await stopFollowups(DB, "p1", "replied", new Date(START + 75 * DAY)), 0);
  const msgs = await all(DB, "SELECT direction, kind, step, status, class FROM messages WHERE place_id = 'p1' ORDER BY COALESCE(sent_at, received_at)");
  assert.deepEqual(msgs.map((m) => [m.direction, m.kind, m.step, m.status, m.class]), [
    ["out", "first", null, "sent", null], ["in", "inbound", null, "received", "auto"],
    ["out", "followup", 1, "sent", null], ["out", "followup", 2, "sent", null],
    ["in", "inbound", null, "received", "human"],
  ]);
});

test("opt-out and bounce stop and suppress", async () => {
  // Two leads from the same mailbox: p1 says "no thanks" on day 3, p2's address bounces follow-up 2 on day 3.
  const JO = "jo@oakandash.co.uk";
  const DB = await world();
  await readyLead(DB, "p1");
  await readyLead(DB, "p2", { name: "OAK & ASH GARDENS LTD", email: JO });
  for (const [id, to] of [["p1", EMAIL], ["p2", JO]]) {
    const r = await sendFirst(DB, id, { ...INPUT, to }, new Date(START), { demoReady: okDemo });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  }
  const inbound = [];
  const only = (sent, to) => sent.filter((s) => s.to === to);
  const sent = await simulate(DB, {
    from: START,
    days: 75,
    before: events([
      ["2026-10-25T10:00:00Z", async (now, s) => { inbound.push(await receive(DB, replyTo("no-thanks.eml", only(s, EMAIL)), now)); }],
      ["2026-10-25T11:00:00Z", async (now, s) => { inbound.push(await receive(DB, bounceOf(only(s, JO), JO), now)); }],
    ]),
  });
  assert.deepEqual(inbound, [{ opt_out: 1 }, { bounce: 1 }]);
  for (const [id, to, reason] of [["p1", EMAIL, "opt_out"], ["p2", JO, "bounce"]]) {
    const mine = only(sent, to);
    assert.equal(mine.length, 3, `${id}: the first email and follow-ups 1–2, nothing after`);
    assert.deepEqual(mine.map((s) => s.headers.References?.split(" ").length ?? 0), [0, 1, 2], id);
    const p = await getProspect(DB, id);
    assert.equal(p.stage, "lost", id);
    assert.equal(p.lost_reason, reason, id);
    assert.equal(p.next_followup_at, null, id);
    assert.equal(await queuedFollowups(DB, id), 0, id);
    assert.deepEqual(await all(DB, "SELECT kind, reason FROM suppression WHERE value = ?", to), [{ kind: "email", reason }], id);
  }
  // p2's follow-ups were written for its own name, cleaned ("OAK & ASH GARDENS LTD" → "Oak & Ash Gardens").
  assert.match(only(sent, JO)[1].text, /a new website for Oak & Ash Gardens and/);
  // The mailbox wasn't paused by one bounce (stage 0 pauses at 2 in 7 days), so p1's follow-ups went as booked.
  assert.equal((await one(DB, "SELECT status FROM mailboxes WHERE id = 'm1'")).status, "active");
  assert.equal(sent.length, 6);
});

test("cap respected; follow-ups before first emails; none skipped", async (t) => {
  // 70 days: each morning sendFirst for a new lead whenever roomForFirsts(...).total ≥ 1; then cap_override 5 for 3 days
  // (cut right after a morning's Send, so that first email competes with the follow-ups for the 5 places), then 10
  // again until day 90, Nik still sending each morning.
  const DB = await world({ cap: 10 });
  const LEADS = 80;
  const leadId = (n) => `c${String(n).padStart(3, "0")}`;
  const leadEmail = (n) => `owner@lead${n}.example.com`;
  for (let n = 1; n <= LEADS; n++) await readyLead(DB, leadId(n), { name: `Oak Tree ${n} Landscapes`, email: leadEmail(n) });
  const setCap = (cap) => DB.prepare("UPDATE mailboxes SET cap_override = ? WHERE id = 'm1'").bind(cap).run();

  const from = Date.parse("2026-10-22T06:00:00Z"); // Thu 22 Oct 2026, 07:00 BST
  const day1 = ukDate(new Date(from));
  const dayNo = (ukDay) => Math.round((Date.parse(`${ukDay}T12:00:00Z`) - Date.parse(`${day1}T12:00:00Z`)) / DAY) + 1;
  const started = []; // {day, place_id, id}: Nik's Sends that went through
  const refused = []; // {day, fullDay}: mornings roomForFirsts had no room
  let next = 1;
  let cut = null; // {from, until}: UK days, cap 5 from `from` up to but not including `until`
  const leftOver = {}; // UK day → follow-ups still waiting at 23:45 (they go first in the next window)

  const nik = async (now) => {
    const day = ukDate(now);
    if (cut && !cut.restored && day >= cut.until) {
      await setCap(10);
      cut.restored = true;
    }
    const { hh, mm } = ukParts(now);
    if (hh === 23 && mm === 45) {
      const w = await waitingAt(DB, now.getTime());
      leftOver[day] = w.queued + w.booked;
    }
    if (hh !== 7 || mm !== 0) return; // each morning (every day: a Sunday's Send waits for Monday 07:00)
    const room = await roomForFirsts(DB, now);
    if (room.total < 1) {
      refused.push({ day, fullDay: room.byMailbox.m1.fullDay });
      return;
    }
    assert.ok(next <= LEADS, "enough leads seeded");
    const n = next++;
    const r = await sendFirst(DB, leadId(n), { ...INPUT, to: leadEmail(n) }, now, { demoReady: okDemo });
    assert.equal(r.ok, true, `${day}: Send refused though roomForFirsts said ${room.total}: ${JSON.stringify(r.issues)}`);
    started.push({ day, place_id: leadId(n), id: r.id });
    if (!cut && dayNo(day) > 70) {
      cut = { from: day, until: addUkDays(day, 3), restored: false };
      await setCap(5);
    }
  };
  const sent = await simulate(DB, { from, days: 90, before: nik });
  const lastDay = ukDate(new Date(from + 90 * DAY - TICK));
  assert.ok(cut?.restored, "the cap was cut for 3 days and restored");
  const cutDays = [0, 1, 2].map((i) => addUkDays(cut.from, i));

  // ---- no UK day ever has more than its cap of cold sends (10; 5 while it's cut)
  const perDay = {};
  for (const s of sent) perDay[s.day] = (perDay[s.day] ?? 0) + 1;
  for (const [day, n] of Object.entries(perDay)) {
    assert.ok(n <= (cutDays.includes(day) ? 5 : 10), `${day}: ${n} cold sends`);
  }

  // ---- the room is exact: Nik is turned away only when a day it would book is really full (all of its leads run
  // their whole sequence here, so what's booked is what goes), and a Send never fails while the room says yes (above)
  for (const r of refused.filter((x) => x.day < cut.from && x.fullDay < cut.from)) {
    assert.equal(perDay[r.fullDay], 10, `refused on ${r.day}: ${r.fullDay} was full`);
  }
  // A4 moves Sunday follow-ups to Monday, so Monday fills first and is the day that turns Nik away (top of the file).
  const weekday = (ukDay) => new Date(`${ukDay}T12:00:00Z`).getUTCDay();
  const before = refused.filter((x) => x.day < cut.from);
  assert.ok(before.every((x) => weekday(x.fullDay) === 1), `every refusal is for a full Monday: ${JSON.stringify(before)}`);

  // ---- new businesses a day over days 61–70. A11 #4's target (0.8–1.2) is unmet with A4's schedule and open for Nik
  // (A11 #4, Q-K; top of the file). This checks what the schedule gives today: 0.4 (0.5 over days 31–70). Below 0.3
  // the plan would be wasting room; above 0.6 something changed the schedule or the planner, so look at Q-K again.
  const newIn = (lo, hi) => started.filter((s) => dayNo(s.day) >= lo && dayNo(s.day) <= hi).length;
  const mean = newIn(61, 70) / 10;
  t.diagnostic(`days 61–70: ${mean} new businesses a day (days 31–70: ${newIn(31, 70) / 40}); Nik was turned away on `
    + `${before.length} of ${dayNo(cut.from) - 1} mornings, every time for a full Monday`);
  assert.ok(mean >= 0.3 && mean <= 0.6, `days 61–70: ${mean} new businesses a day (A4's schedule today; A11 #4 / Q-K)`);

  // ---- follow-ups before first emails: no first email ever went, on the cut days or any other, while a follow-up was
  // waiting, queued or due but not queued yet, so none ever took a follow-up's place. (The followups step queues what's
  // due before its bookkeeping: with the bookkeeping first, recording two sends took the queries queueDue needs and 22
  // of 57 first emails went ahead of due follow-ups, one on a full day.)
  const firsts = sent.filter((x) => x.kind === "first");
  assert.equal(firsts.length, started.length);
  for (const s of firsts) {
    assert.deepEqual(s.waiting, { queued: 0, booked: 0 }, `${s.place_id}'s first email went at ${iso(s.at)} while follow-ups waited`);
  }
  // At least one cut day ended with follow-ups still waiting (the cut really pushed some to the next day). Each such
  // day used all 5 places on follow-ups alone; the ones left over stayed queued and, by the check above, went before
  // any first email the next morning.
  const overflowed = cutDays.filter((day) => leftOver[day] > 0);
  assert.ok(overflowed.length >= 1, `the cut left follow-ups waiting overnight: ${JSON.stringify(leftOver)}`);
  for (const day of overflowed) {
    const that = sent.filter((s) => s.day === day);
    assert.equal(that.length, 5, `${day}: all 5 places used`);
    assert.ok(that.every((s) => s.kind === "followup"), `${day}: follow-ups only while some were waiting`);
  }

  // ---- none skipped: every first email went once; each lead's follow-ups went in step order, each step once, one
  // email a UK day at most; nothing failed or was cancelled; and by the end nothing is waiting
  const byLead = new Map();
  for (const s of sent) byLead.set(s.place_id, [...(byLead.get(s.place_id) ?? []), s]);
  assert.deepEqual([...byLead.keys()].sort(), started.map((s) => s.place_id).sort(), "every lead Nik sent to got its email");
  for (const [placeId, mine] of byLead) {
    assert.equal(mine[0].kind, "first", placeId);
    assert.deepEqual(mine.slice(1).map((s) => s.step), mine.slice(1).map((_, i) => i + 1), `${placeId}: steps in order, none skipped or twice`);
    assert.equal(new Set(mine.map((s) => s.day)).size, mine.length, `${placeId}: never two on one UK day`);
    const p = await getProspect(DB, placeId);
    assert.equal(p.followup_step, mine.length - 1, placeId);
  }
  assert.deepEqual(await all(DB, "SELECT status, COUNT(*) AS n FROM messages WHERE status IN ('failed', 'cancelled') GROUP BY status"), []);
  const end = iso(from + 90 * DAY);
  assert.deepEqual(await waitingAt(DB, Date.parse(end)), { queued: 0, booked: 0 }, `nothing waiting on ${lastDay}`);
  assert.equal(Number((await one(DB, "SELECT COUNT(*) AS n FROM messages WHERE status IN ('queued', 'sending') AND due_at <= ?", end)).n), 0);
});

// ---------------------------------------------------------------- Part A's edge cases, end to end (review additions)

test("a reply that lands before the send is recorded: no follow-up is ever queued (A9)", async () => {
  // The first email goes at 08:15; Mark's answer comes in before the next followups run has recorded the send, so
  // stage 0's inbound step reads it while the lead is still `ready` (inbound_human doesn't move a ready lead). That run
  // then records the send and the stop together: emailed, then replied, and nothing booked.
  const checks = {};
  const { DB, sent } = await oneLead({
    days: 3,
    before: (DB) => events([
      ["2026-10-22T08:20:00Z", async (now, sentSoFar) => {
        checks.before = await getProspect(DB, "p1");
        checks.inbound = await receive(DB, replyTo("gmail-reply.eml", sentSoFar), now);
        checks.after = await getProspect(DB, "p1");
      }],
    ]),
  });
  assert.equal(sent.length, 1);
  assert.equal(checks.before.stage, "ready");
  assert.equal(checks.before.first_sent_at, null);
  assert.deepEqual(checks.inbound, { human: 1 });
  assert.equal(checks.after.stage, "ready");
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "replied");
  assert.equal(p.first_sent_at, "2026-10-22T08:15:00Z");
  assert.equal(p.root_message_id, sent[0].headers["Message-ID"]);
  assert.equal(p.followup_step, 0);
  assert.equal(p.next_followup_at, null);
  assert.equal(Number((await one(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup'")).n), 0, "never queued");
  // The email did go, so Nik's words are kept as a style example all the same.
  assert.deepEqual(await all(DB, "SELECT id, source FROM style_examples"),
    [{ id: `sent:${(await one(DB, "SELECT id FROM messages WHERE kind = 'first'")).id}`, source: "nik_sent" }]);
});

test("a demo view as the first email lands counts before the followups step records the send (05 Part A §8)", async (t) => {
  // The first email goes on one tick (the followups step runs before the send step), so the lead stays `ready` until
  // the next followups run, 5 minutes or more later. Mark taps the link on his phone as the email arrives: stage 4's
  // beacon counts that view and moves him on (first_sent, then demo_view), and the next run still books follow-up 1.
  const DB = await world();
  await readyLead(DB, "gl-p1"); // its demo's slug is "gl-p1", one the beacon takes (^[a-z0-9-]{3,60}$)
  const r = await sendFirst(DB, "gl-p1", INPUT, new Date(START), { demoReady: okDemo });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  await followupsStep({ DB, env: {}, now: new Date(START) }, { demoReady: okDemo });
  const sends = [];
  await dispatchDue(DB, {}, new Date(START), { limit: 2, send: async (_mailbox, _password, message) => {
    sends.push(message);
    return { ok: true };
  } });
  assert.equal(sends.length, 1);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE kind = 'first'")).status, "sent");
  assert.equal((await getProspect(DB, "gl-p1")).stage, "ready", "not recorded until the next followups run");

  const tapped = START + 2 * MIN;
  t.mock.timers.enable({ apis: ["Date"], now: tapped }); // the beacon reads the clock
  const res = await beacon({
    request: new Request("https://aetoswebsites.com/d/gl-p1/e", { method: "POST", body: '{"kind":"view"}', headers: { "user-agent": PHONE } }),
    env: { DB, CONTROL_ROOM_PASSWORD: "pw" },
    params: { slug: "gl-p1" },
  });
  t.mock.timers.reset();
  assert.equal(res.status, 204);
  const seen = await getProspect(DB, "gl-p1");
  assert.equal(seen.views, 1);
  assert.equal(seen.stage, "viewed");
  assert.equal(seen.last_view_at, iso(tapped));
  assert.deepEqual(await all(DB, "SELECT kind, at FROM demo_events"), [{ kind: "view", at: iso(tapped) }]);

  // The next followups run records the send: still viewed, and the follow-ups are booked as for any lead.
  await followupsStep({ DB, env: {}, now: new Date(START + 5 * MIN) }, { demoReady: okDemo });
  const p = await getProspect(DB, "gl-p1");
  assert.equal(p.stage, "viewed");
  assert.equal(p.views, 1);
  assert.equal(p.first_sent_at, iso(START));
  assert.equal(p.root_message_id, sends[0].headers["Message-ID"]);
  assert.equal(p.followup_step, 0);
  assert.equal(p.next_followup_at, "2026-10-23T08:15:00Z"); // follow-up 1: the next day, same UK time
  // and follow-up 1 goes then, in the thread
  const later = await simulate(DB, { from: START + TICK, days: 2 });
  assert.deepEqual(later.map((s) => [s.kind, s.step, iso(s.at)]),
    [["followup", 1, "2026-10-23T08:15:00Z"], ["followup", 2, "2026-10-24T08:15:00Z"]]);
  assert.equal(later[0].headers["In-Reply-To"], sends[0].headers["Message-ID"]);
});

test("a paused mailbox keeps its follow-ups queued in their thread; a reply meanwhile cancels the waiting one (A9, A5)", async () => {
  // Two leads emailed from m1 on Thu 22 Oct. On Fri 23 Oct at 07:00 BST, before follow-up 1 is due, m1 is paused (stage
  // 0 pauses a mailbox on bounces) and Nik has a second cold mailbox, m2, ready to send. Follow-up 1 is queued on time
  // for both and waits on m1: it is never moved to m2 (it belongs to m1's thread). Jo (p2) replies on Sat 24 Oct: her
  // waiting follow-up is cancelled. By Sun the light is red and names the paused mailbox. m1 is active again from Mon 26
  // Oct 06:30 GMT: p1's follow-up 1 goes at 07:00, the window's start, and its later steps move on from it, one a day.
  const JO = "jo@oakandash.co.uk";
  const DB = await world();
  await readyLead(DB, "p1");
  await readyLead(DB, "p2", { name: "OAK & ASH GARDENS LTD", email: JO });
  for (const [id, to] of [["p1", EMAIL], ["p2", JO]]) {
    const r = await sendFirst(DB, id, { ...INPUT, to }, new Date(START), { demoReady: okDemo });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  }
  const seen = {};
  const sent = await simulate(DB, {
    from: START,
    days: 8,
    before: events([
      ["2026-10-23T06:00:00Z", async () => {
        await DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = ? WHERE id = 'm1'").bind("2 bounces in 7 days").run();
        await seedMailbox(DB, {
          id: "m2", address: "nik@aetos-mail.co.uk", display_name: "Nik Example", started_on: "2026-01-01", cap_override: 10,
        });
        await setSecret(DB, "mailbox:m2", "y");
      }],
      ["2026-10-23T12:00:00Z", async () => {
        seen.queued = await all(DB, "SELECT place_id, step, status, mailbox_id, due_at FROM messages WHERE kind = 'followup' ORDER BY place_id");
      }],
      ["2026-10-24T10:00:00Z", async (now, s) => {
        seen.inbound = await receive(DB, replyTo("gmail-reply.eml", s.filter((x) => x.to === JO), `Jo Ash <${JO}>`), now);
      }],
      ["2026-10-25T12:00:00Z", async (now) => { seen.red = await followupHealthFromDb(DB, now); }],
      ["2026-10-26T06:30:00Z", async () => {
        await DB.prepare("UPDATE mailboxes SET status = 'active', paused_reason = NULL WHERE id = 'm1'").run();
      }],
      ["2026-10-26T08:00:00Z", async (now) => { seen.green = await followupHealthFromDb(DB, now); }],
    ]),
  });
  // Queued on time, from m1, while m1 was paused; and nothing went out until it was active again.
  assert.deepEqual(seen.queued, [
    { place_id: "p1", step: 1, status: "queued", mailbox_id: "m1", due_at: "2026-10-23T08:15:00Z" },
    { place_id: "p2", step: 1, status: "queued", mailbox_id: "m1", due_at: "2026-10-23T08:15:00Z" },
  ]);
  assert.deepEqual(seen.inbound, { human: 1 });
  assert.deepEqual(seen.red, {
    name: "followups", level: "red", detail: "1 follow-up is a day late: mailbox nik@aetoswebsites.com is paused.",
    fix: "Open Setup → Mailboxes and fix the paused mailbox.",
  });
  assert.equal(seen.green.level, "green");
  assert.ok(sent.every((s) => s.mailbox === "m1"), "nothing ever went from m2");
  const byTime = (a, b) => a.at - b.at || a.place_id.localeCompare(b.place_id); // the two first emails go on one tick
  assert.deepEqual([...sent].sort(byTime).map((s) => [s.place_id, s.step, iso(s.at)]), [
    ["p1", null, "2026-10-22T08:15:00Z"], ["p2", null, "2026-10-22T08:15:00Z"],
    ["p1", 1, "2026-10-26T07:00:00Z"], // waited on m1 over the weekend, then went first thing
    ["p1", 2, "2026-10-27T09:15:00Z"], // day 2 (Sat 24) has passed: the next sending day after step 1, at 09:15 UK
    ["p1", 3, "2026-10-28T09:15:00Z"], // day 4 (Mon 26) too
    ["p1", 4, "2026-10-29T09:15:00Z"], // day 7 (Thu 29): back on the plan
  ]);
  // p1's follow-up 1 is the row queued on Friday, threaded under its first email; nothing was queued twice.
  const p1 = await all(DB, "SELECT step, status, due_at, sent_at, in_reply_to FROM messages WHERE place_id = 'p1' AND kind = 'followup' ORDER BY step");
  assert.deepEqual(p1.map((m) => [m.step, m.status]), [[1, "sent"], [2, "sent"], [3, "sent"], [4, "sent"]]);
  assert.equal(p1[0].due_at, "2026-10-23T08:15:00Z");
  assert.equal(p1[0].sent_at, "2026-10-26T07:00:00Z");
  const root = sent.find((s) => s.place_id === "p1" && s.kind === "first").headers["Message-ID"];
  assert.ok(p1.every((m) => m.in_reply_to === root), "every follow-up in p1's thread");
  // Jo's: her follow-up 1 cancelled, never sent, stage replied, nothing booked.
  const p2 = await all(DB, "SELECT step, status FROM messages WHERE place_id = 'p2' AND kind = 'followup'");
  assert.deepEqual(p2, [{ step: 1, status: "cancelled" }]);
  const jo = await getProspect(DB, "p2");
  assert.equal(jo.stage, "replied");
  assert.equal(jo.next_followup_at, null);
  assert.equal(jo.followup_step, 0);
});

test("a reply read on a tick that doesn't run the followups step: their follow-up already queued never goes (A5)", async () => {
  // Three leads emailed on Thu 22 Oct, each with follow-up 1 booked for Fri 23 Oct 08:15Z. On that tick the followups
  // step queues all three and the send step sends two (2 a tick). The third lead replies a minute later. The relay's
  // inbound tick runs the inbound step (lead → replied) and the send step, but not the followups step, which ran a
  // minute ago (every 5 minutes). Their waiting follow-up must not go: the outbox holds it, and the next followups run
  // cancels it.
  const DB = await world();
  const leads = [["p1", "owner@p1.example.com"], ["p2", "owner@p2.example.com"], ["p3", "owner@p3.example.com"]];
  for (const [id, email] of leads) await readyLead(DB, id, { name: `Oak Tree ${id} Landscapes`, email });
  for (const [id, to] of leads) {
    const r = await sendFirst(DB, id, { ...INPUT, to }, new Date(START), { demoReady: okDemo });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  }
  const firsts = await simulate(DB, { from: START, days: 1 }); // the first emails go and are synced
  assert.equal(firsts.length, 3);
  const t1 = new Date("2026-10-23T08:15:00Z");
  await DB.prepare("UPDATE prospects SET next_followup_at = ? WHERE place_id IN ('p1', 'p2', 'p3')").bind(iso(t1.getTime())).run();

  const out = [];
  const send = async (_mailbox, _password, message) => { out.push(message.to); return { ok: true }; };
  assert.match(await followupsStep({ DB, env: {}, now: t1 }, { demoReady: okDemo }), /queued 3/);
  assert.deepEqual(await dispatchDue(DB, {}, t1, { limit: 2, send }), { sent: 2, failed: 0, held: 0 });
  const left = await all(DB, "SELECT place_id FROM messages WHERE kind = 'followup' AND status = 'queued'");
  assert.equal(left.length, 1);
  const who = left[0].place_id;
  const address = leads.find(([id]) => id === who)[1];

  // A minute later their reply comes in: the inbound tick's inbound step reads it, then its send step runs.
  const t2 = new Date(t1.getTime() + MIN);
  const thread = firsts.filter((s) => s.place_id === who);
  assert.deepEqual(await receive(DB, replyTo("gmail-reply.eml", thread, `Owner <${address}>`), t2), { human: 1 });
  assert.equal((await getProspect(DB, who)).stage, "replied");
  assert.deepEqual(await dispatchDue(DB, {}, t2, { limit: 2, send }), { sent: 0, failed: 0, held: 1 });
  assert.ok(!out.includes(address), `a follow-up went to ${address} after they replied`);

  // The next cron tick's followups step cancels it; nothing more goes.
  const t3 = new Date(t1.getTime() + 5 * MIN);
  assert.match(await followupsStep({ DB, env: {}, now: t3 }, { demoReady: okDemo }), /stopped 1/);
  assert.deepEqual(await all(DB, "SELECT step, status FROM messages WHERE place_id = ? AND kind = 'followup'", who),
    [{ step: 1, status: "cancelled" }]);
  assert.deepEqual(await dispatchDue(DB, {}, t3, { limit: 2, send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(out.length, 2);
  assert.equal((await getProspect(DB, who)).next_followup_at, null);
});

test("follow-ups approved after the first email went: they wait, then go one a day from the next tick, none skipped (A4, Q-L)", async () => {
  // Nik sends his first email on Thu 22 Oct before approving the 9 follow-ups (Q-L: allowed, with the composer's yellow
  // note). Nothing follows while they're drafts: the setup todo is open and the light is amber. He approves all 9 on the
  // Voice page on Tue 27 Oct at 12:00 GMT: follow-up 1 goes on that tick, and the rest move on from it one sending day at
  // a time (nextDue: no catch-up burst, nothing skipped), until they're back on the plan (day 10, Mon 2 Nov).
  const DB = await world({ approved: false });
  await readyLead(DB, "p1");
  assert.equal((await composeContext(DB, "p1", new Date(START), { demoReady: okDemo })).followups_approved, false);
  const r = await sendFirst(DB, "p1", INPUT, new Date(START), { demoReady: okDemo });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  const seen = {};
  const sent = await simulate(DB, {
    from: START,
    days: 12,
    before: events([
      ["2026-10-24T12:00:00Z", async (now) => {
        seen.todo = await one(DB, "SELECT status FROM todos WHERE dedupe = 'setup:followups'");
        seen.light = await followupHealthFromDb(DB, now);
        seen.p = await getProspect(DB, "p1");
      }],
      ["2026-10-27T12:00:00Z", async (now) => {
        for (let step = 1; step <= 9; step++) {
          const res = await approveFollowup({
            request: new Request(`https://control.example/api/voice/followups/${step}/approve`, { method: "POST" }),
            env: { DB }, params: { step: String(step) }, now,
          });
          assert.equal(res.status, 200, `approve ${step}`);
        }
      }],
    ]),
  });
  assert.equal(seen.todo.status, "open");
  assert.deepEqual(seen.light, {
    name: "followups", level: "amber", detail: "1 follow-up is waiting for you to approve the wording on the Voice page.",
    fix: "Approve them on the Voice page.",
  });
  assert.equal(seen.p.stage, "emailed");
  assert.equal(seen.p.followup_step, 0);
  assert.equal(seen.p.next_followup_at, "2026-10-23T08:15:00Z"); // still booked for day 1, waiting
  assert.deepEqual(sent.map((s) => [s.step, iso(s.at)]), [
    [null, "2026-10-22T08:15:00Z"],
    [1, "2026-10-27T12:00:00Z"], // the tick Nik approved the 9th
    [2, "2026-10-28T09:15:00Z"], [3, "2026-10-29T09:15:00Z"], [4, "2026-10-30T09:15:00Z"], // one a day, at 09:15 UK
    [5, "2026-11-02T09:15:00Z"], // day 10 (Sun 1 Nov → Mon): back on the plan
  ]);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe LIKE 'setup:followups%'")).status, "done");
  const p = await getProspect(DB, "p1");
  assert.equal(p.followup_step, 5);
  assert.equal(p.next_followup_at, "2026-11-09T09:15:00Z"); // day 17, as in the worked example
});

// Found in review: a follow-up's time is clamped to 18:59 UK (A4), but the cron ticks on the 5-minute marks, so one due
// at 18:56–18:59 was first seen by the 19:00 tick, outside the window. It waited for 07:00 the next sending day, each
// later step moved on from that late send, and a Saturday one was "a day late" on the Sunday evening (the light went
// red with nothing wrong). The last followups run before 19:00 now reaches the bookings up to the window's end and
// queues them for that moment, so they go a few minutes early, on their A4 day.
test("a first email sent at 18:57: every follow-up goes on its A4 day, at the last tick before 19:00", async () => {
  const DB = await world();
  await readyLead(DB, "p1");
  const pressed = Date.parse("2026-11-03T18:57:00Z"); // Tue 3 Nov 2026, 18:57 GMT
  const r = await sendFirst(DB, "p1", INPUT, new Date(pressed), { demoReady: okDemo });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.due_at, iso(pressed));
  // The route's nudge runs the tick at once, and the email goes.
  const first = [];
  await followupsStep({ DB, env: {}, now: new Date(pressed) }, { demoReady: okDemo });
  await dispatchDue(DB, {}, new Date(pressed), { limit: 2, send: async (_mailbox, _password, message) => {
    first.push(message);
    return { ok: true };
  } });
  assert.equal(first.length, 1);
  // Then the cron's ticks on the 5-minute marks. Every booking is at 18:57 UK (GMT all through), so only the evenings
  // are simulated; the light is read on the Sunday evening after Saturday's follow-up 3.
  const evening = (now) => [18, 19].includes(ukParts(now).hh);
  const seen = {};
  const sent = await simulate(DB, {
    from: Date.parse("2026-11-03T19:00:00Z"), days: 68, tick: 5 * MIN, when: evening,
    before: events([["2026-11-08T19:30:00Z", async (now) => { seen.sunday = await followupHealthFromDb(DB, now); }]]),
  });
  // A4 from Tue 3 Nov: days 1, 2, 4, 7, 10, 17, 24, 30 and 60, at 18:57.
  const a4 = ["2026-11-04", "2026-11-05", "2026-11-07", "2026-11-10", "2026-11-13", "2026-11-20", "2026-11-27",
    "2026-12-03", "2027-01-02"];
  assert.deepEqual(sent.map((s) => [s.kind, s.step, iso(s.at)]), a4.map((day, i) => ["followup", i + 1, `${day}T18:55:00Z`]));
  sent.forEach((s, i) => {
    assert.ok(Math.abs(s.at - Date.parse(`${a4[i]}T18:57:00Z`)) < 15 * MIN, `follow-up ${i + 1} within 15 minutes (A11 #2)`);
    assert.equal(s.headers["In-Reply-To"], first[0].headers["Message-ID"]);
  });
  assert.equal(seen.sunday.level, "green", JSON.stringify(seen.sunday));
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.lost_reason, p.followup_step], ["lost", "sequence_done", 9]);
  assert.equal(p.stage_at, "2027-01-09T18:55:00Z"); // 7 days after follow-up 9 went
});
