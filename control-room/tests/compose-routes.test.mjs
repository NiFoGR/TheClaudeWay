// Compose routes (stage 5–6, docs/rebuild/06-email-followups.md Part B Task 10): GET /api/compose/:id (composeContext:
// what the composer in the lead drawer shows), POST /api/compose/:id/preview (previewFirst: the exact text and every
// check, always 200) and POST /api/compose/:id/send (sendFirst: 200 {id, due_at}, else 400/409 {error: issues[0].message,
// issues}; on success it nudges a send-only tick through context.waitUntil so the email usually goes within seconds).
// The logic is Task 9's (tests/first-email.test.mjs); these tests check the wiring.
// Handlers are called the way Pages calls them: {request, env: {DB}, params: {id}, waitUntil}; `now` only in tests.
// Run: node --test control-room/tests/compose-routes.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { TEMPLATES } from "../functions/_lib/demo/render.js";
import { coldFooter } from "../functions/_lib/mail/compose.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { sendStep } from "../functions/_lib/mail/outbox.js";
import { TICK_BUDGET } from "../functions/_lib/tick.js";
import { onRequestGet } from "../functions/api/compose/[id]/index.js";
import { onRequestPost as previewPost } from "../functions/api/compose/[id]/preview.js";
import { onRequestPost } from "../functions/api/compose/[id]/send.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch, seedSuppression } from "./helpers/shortlistSeed.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-22T08:15:00Z"); // Thu 09:15 BST: inside the cold window
const DEMO_URL = "https://aetoswebsites.com/d/green-leaf";
const MARK = { first: "Mark", full: "Mark Green", source_url: "https://greenleaf.co.uk/about", confident: true };
const EMAILS = [
  { email: "mark@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" },
  { email: "info@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/", where: "Footer" },
];
const GOOD = { to: "mark@greenleaf.co.uk", subject: "Your website", body: "{demo_link}" };
const QUEUED = "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one.";

/** A POST as Pages hands it to a handler: `body` as JSON text (a string goes as it is). */
const post = (body) => new Request(`${ORIGIN}/api/compose/p1`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const get = () => new Request(`${ORIGIN}/api/compose/p1`);
const countOf = async (DB, sql) => Number((await DB.prepare(sql).first()).n);

/**
 * fakeD1 with lead p1 "Green Leaf Landscapes" ready to email (as first-email.test.mjs's readyLead): research done
 * (grade A, owner Mark confident, his addresses), demo green-leaf live (until 2099: the plan's two tests pass no `now`,
 * so they run on the real clock) with the landscaper look approved, prospect
 * `ready`, cold mailbox m1 (nik@aetoswebsites.com, From "Nik Example", cap 10 since January) and business:sender_name
 * "Nik". Returns {env, waits, DB} (waits records what the route hands to waitUntil). `stage` changes the prospect's;
 * `count: true` wraps env.DB in countingDB after seeding (the seeding isn't counted) and returns `used`.
 */
async function routeEnv({ stage = "ready", count = false } = {}) {
  const DB = fakeD1();
  await seedMailbox(DB, { id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example", started_on: "2026-01-01", cap_override: 10 });
  await setSetting(DB, "business:sender_name", "Nik");
  await setSetting(DB, "demo:template:landscaper:approved",
    JSON.stringify({ version: TEMPLATES.landscaper.TEMPLATE.version, at: "2026-10-01T09:00:00Z" }));
  await seedLead(DB, { place_id: "p1", name: "Green Leaf Landscapes", trade: "landscaper", company_number: "01234567" });
  await seedResearch(DB, { place_id: "p1", grade: "A", owner: MARK, emails: EMAILS, best_email: "mark@greenleaf.co.uk" });
  await seedDemo(DB, { place_id: "p1", slug: "green-leaf", expires_at: "2099-01-01T00:00:00Z" }); // the plan's tests use the real clock
  await seedProspect(DB, { place_id: "p1", stage, email: "mark@greenleaf.co.uk", greet_name: "Mark",
    first_sent_at: stage === "ready" ? null : "2026-10-20T08:15:00Z" });
  const waits = [];
  if (!count) return { env: { DB }, waits, DB };
  const counter = countingDB(DB);
  return { env: { DB: counter.DB }, waits, DB, used: counter.used };
}

// ---------------------------------------------------------------- the plan's tests (Part B, Task 10, Step 1)

test("send route returns plain-English 400 and nudges the tick", async () => {
  const { env, waits } = await routeEnv();                               // fakeD1 + ready lead; waitUntil recorder
  const bad1 = await onRequestPost({ env, params: { id: "p1" }, request: post({ to: "mark@greenleaf.co.uk", subject: "Hi", body: "no link" }), waitUntil: waits.push.bind(waits) });
  assert.equal(bad1.status, 400);
  assert.equal((await bad1.json()).error, "Add the demo link: press Insert demo link.");
  const ok = await onRequestPost({ env, params: { id: "p1" }, request: post({ to: "mark@greenleaf.co.uk", subject: "Your website", body: "{demo_link}" }), waitUntil: waits.push.bind(waits) });
  assert.equal(ok.status, 200); assert.equal(waits.length, 1);
  await Promise.all(waits); // the nudged tick finishes before the next test
});

test("preview renders the full text", async () => {
  const { env } = await routeEnv();
  const r = await previewPost({ env, params: { id: "p1" }, request: post(GOOD) });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.text, "Hi Mark,\n\nhttps://aetoswebsites.com/d/green-leaf\n\n" + coldFooter("Nik"));
  assert.deepEqual(out.issues, []);
  assert.equal(out.from, "Nik Example <nik@aetoswebsites.com>");
  assert.deepEqual(Object.keys(out).sort(), ["from", "issues", "text"]);
});

// ---------------------------------------------------------------- GET /api/compose/:id

test("GET answers composeContext as JSON; a lead with no prospect is 200 with no_prospect", async () => {
  const { env } = await routeEnv();
  const r = await onRequestGet({ env, params: { id: "p1" }, request: get(), now: NOW });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const ctx = await r.json();
  assert.equal(ctx.business, "Green Leaf Landscapes");
  assert.deepEqual(ctx.to_options, [
    { email: "mark@greenleaf.co.uk", where: "Contact page", source_url: "https://greenleaf.co.uk/contact", best: true },
    { email: "info@greenleaf.co.uk", where: "Footer", source_url: "https://greenleaf.co.uk/", best: false },
  ]);
  assert.deepEqual(ctx.greeting, { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(ctx.demo, { ok: true, url: DEMO_URL, reason: "" });
  assert.equal(ctx.due_at, "2026-10-22T08:15:00Z");
  assert.deepEqual(ctx.mailbox, { id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example" });
  assert.equal(ctx.sender_name, "Nik");
  assert.deepEqual(ctx.blocking, []);
  assert.equal(ctx.followups_approved, false);
  assert.equal(ctx.stage, "ready");
  assert.equal(ctx.first_message_id, null);

  const none = await onRequestGet({ env, params: { id: "no-such-lead" }, request: get(), now: NOW });
  assert.equal(none.status, 200);
  const blank = await none.json();
  assert.deepEqual(blank.blocking.map((i) => i.code), ["no_prospect"]);
  assert.equal(blank.stage, null);
});

test("GET outside the cold window: due at the next window start", async () => {
  const { env } = await routeEnv();
  const r = await onRequestGet({ env, params: { id: "p1" }, request: get(), now: new Date("2026-10-25T10:00:00Z") }); // Sunday
  assert.equal((await r.json()).due_at, "2026-10-26T07:00:00Z");
});

// ---------------------------------------------------------------- POST /api/compose/:id/preview

test("preview is always 200 with the checks in plain English, and writes and nudges nothing", async () => {
  const { env, waits, DB } = await routeEnv();
  const ctx = { env, params: { id: "p1" }, now: NOW, waitUntil: waits.push.bind(waits) };

  const r = await previewPost({ ...ctx, request: post({ to: "typo@x.com", subject: "", body: "no link" }) });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.issues.map((i) => i.code), ["subject_missing", "demo_missing", "not_in_list"]);
  assert.deepEqual(out.issues.map((i) => i.message), ["Add a subject.", "Add the demo link: press Insert demo link.", "Pick an address from the list."]);
  assert.equal(out.text, `Hi Mark,\n\nno link\n\n${coldFooter("Nik")}`);

  // Not JSON, or not {to, subject, body} as text: still 200, one plain-English issue, no text.
  for (const body of ["{not json", JSON.stringify([1]), JSON.stringify({ to: 1, subject: "x", body: "y" })]) {
    const p = await previewPost({ ...ctx, request: post(body) });
    assert.equal(p.status, 200, body);
    const o = await p.json();
    assert.equal(o.text, "", body);
    assert.deepEqual(o.issues.map((i) => i.code), ["bad_request"], body);
    assert.match(o.issues[0].message, /Refresh the page and try again\.$/);
  }

  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
  assert.equal(waits.length, 0);
});

test("preview of a lead already emailed says so first", async () => {
  const { env } = await routeEnv({ stage: "emailed" });
  const r = await previewPost({ env, params: { id: "p1" }, request: post(GOOD), now: NOW });
  assert.equal(r.status, 200);
  const { issues } = await r.json();
  assert.equal(issues[0].code, "already_emailed");
  assert.equal(issues[0].message, "You've already emailed Green Leaf Landscapes on 20 Oct. The thread is below.");
});

test("preview also runs Send's own checks (do-not-email list, shared address), in Send's order", async () => {
  // Part A: Send stays disabled until every check passes, so the preview lists exactly what Send would refuse with.
  const { env, waits, DB } = await routeEnv();
  await seedSuppression(DB, "mark@greenleaf.co.uk"); // opted out on 21 Oct
  await setSetting(DB, "business:sender_name", ""); // a check from the rest of blocking, which Send puts last
  const ctx = { env, params: { id: "p1" }, now: NOW, waitUntil: waits.push.bind(waits) };
  const input = { to: "Mark@GreenLeaf.co.uk ", subject: "", body: "{demo_link}" };

  // Stage 4 also holds the demo of a lead whose best address is on the list: demo_not_ready, which Send puts after the
  // address checks.
  const preview = await (await previewPost({ ...ctx, request: post(input) })).json();
  assert.deepEqual(preview.issues.map((i) => i.code), ["subject_missing", "suppressed", "demo_not_ready", "no_sender_name"]);
  assert.equal(preview.issues[1].message, "mark@greenleaf.co.uk is on your do-not-email list (opted out on 21 Oct). You can't email it.");
  const send = await onRequestPost({ ...ctx, request: post(input) });
  assert.equal(send.status, 400);
  assert.deepEqual((await send.json()).issues, preview.issues, "the preview's checks are Send's");

  // An address that isn't from the list gets "Pick an address" and nothing about the address itself.
  const typo = await (await previewPost({ ...ctx, request: post({ ...input, to: "mark@greenleaf.co.uk.typo" }) })).json();
  assert.deepEqual(typo.issues.map((i) => i.code), ["subject_missing", "not_in_list", "demo_not_ready", "no_sender_name"]);
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
  assert.equal(waits.length, 0);

  // Another lead already being emailed at the address picked: the only issue, and Send's 400 says the same.
  const other = await routeEnv();
  await seedLead(other.DB, { place_id: "p2", name: "Other Ltd" });
  await seedProspect(other.DB, { place_id: "p2", stage: "emailed", email: "info@greenleaf.co.uk", first_sent_at: "2026-10-20T08:15:00Z" });
  const toInfo = { ...GOOD, to: "info@greenleaf.co.uk" };
  const shared = await (await previewPost({ env: other.env, params: { id: "p1" }, now: NOW, request: post(toInfo) })).json();
  assert.deepEqual(shared.issues, [{ code: "shared_address", message: "info@greenleaf.co.uk is already being emailed as Other Ltd." }]);
  const refused = await onRequestPost({ env: other.env, params: { id: "p1" }, now: NOW, request: post(toInfo), waitUntil: other.waits.push.bind(other.waits) });
  assert.equal(refused.status, 400);
  assert.deepEqual((await refused.json()).issues, shared.issues);
  // The best address is still fine.
  assert.deepEqual((await (await previewPost({ env: other.env, params: { id: "p1" }, now: NOW, request: post(GOOD) })).json()).issues, []);
});

// ---------------------------------------------------------------- POST /api/compose/:id/send

test("send: 200 {id, due_at} with the email queued; a second Send is 409 queued_already; refusals don't nudge", async () => {
  const { env, waits, DB } = await routeEnv();
  const ctx = { env, params: { id: "p1" }, now: NOW, waitUntil: waits.push.bind(waits) };

  const ok = await onRequestPost({ ...ctx, request: post(GOOD) });
  assert.equal(ok.status, 200);
  const sent = await ok.json();
  assert.deepEqual(Object.keys(sent).sort(), ["due_at", "id"]);
  assert.equal(sent.due_at, "2026-10-22T08:15:00Z");
  const m = await DB.prepare("SELECT * FROM messages WHERE id = ?").bind(sent.id).first();
  assert.equal(m.kind, "first"); assert.equal(m.status, "queued"); assert.equal(m.author, "nik");
  assert.equal(m.body, `Hi Mark,\n\n${DEMO_URL}\n\n${coldFooter("Nik")}`);
  assert.equal(waits.length, 1);
  await Promise.all(waits);

  const again = await onRequestPost({ ...ctx, request: post(GOOD) });
  assert.equal(again.status, 409);
  const body = await again.json();
  assert.equal(body.error, QUEUED);
  assert.equal(body.issues[0].code, "queued_already");
  assert.equal(body.error, body.issues[0].message);
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages WHERE kind = 'first'"), 1);
  assert.equal(waits.length, 1, "a refused Send doesn't nudge the tick");
});

test("send: every refusal is 400 {error: issues[0].message, issues} in plain English", async () => {
  const { env, waits, DB } = await routeEnv();
  const ctx = { env, params: { id: "p1" }, now: NOW, waitUntil: waits.push.bind(waits) };
  const cases = [
    [{ ...GOOD, to: "typo@x.com" }, "not_in_list", "Pick an address from the list."],
    [{ ...GOOD, subject: "Re: your site" }, "subject_re", 'The subject can\'t start with "Re:" or "Fwd:".'],
    [{ ...GOOD, body: "Better SEO {demo_link}" }, "seo", 'Don\'t say "SEO". Say "front page of Google" instead.'],
    ["{not json", "bad_request", null],
    [JSON.stringify(null), "bad_request", null],
  ];
  for (const [input, code, message] of cases) {
    const r = await onRequestPost({ ...ctx, request: post(input) });
    assert.equal(r.status, 400, code);
    const out = await r.json();
    assert.equal(out.issues[0].code, code);
    assert.equal(out.error, out.issues[0].message);
    if (message) assert.equal(out.error, message);
  }
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
  assert.equal(waits.length, 0);

  const { env: emailedEnv } = await routeEnv({ stage: "emailed" });
  const done = await onRequestPost({ env: emailedEnv, params: { id: "p1" }, now: NOW, request: post(GOOD), waitUntil: waits.push.bind(waits) });
  assert.equal(done.status, 400);
  assert.equal((await done.json()).error, "You've already emailed Green Leaf Landscapes on 20 Oct. The thread is below.");
  assert.equal(waits.length, 0);
});

test("send outside the cold window: due at the next window start", async () => {
  const { env, waits } = await routeEnv();
  const r = await onRequestPost({ env, params: { id: "p1" }, request: post(GOOD), now: new Date("2026-10-25T10:00:00Z"), waitUntil: waits.push.bind(waits) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).due_at, "2026-10-26T07:00:00Z");
  await Promise.all(waits);
});

// ---------------------------------------------------------------- the nudge

test("the nudge is a send-only tick (reason compose), and Send plus its tick stay within D1's 50 queries", async () => {
  // Worst case: m1's password is saved and another lead's follow-up is due too, so the tick sends 2 (in Node the
  // email library can't load, so both fail, after every query a real send makes).
  const { env, waits, DB, used } = await routeEnv({ count: true });
  await setSecret(DB, "mailbox:m1", "not-a-real-password");
  await seedLead(DB, { place_id: "p2", name: "Other Ltd" });
  await seedResearch(DB, { place_id: "p2" });
  await seedProspect(DB, { place_id: "p2", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-21T08:00:00Z" });
  await seedMessage(DB, { place_id: "p2", kind: "followup", step: 1, to_addr: "p2@example.com", from_addr: "nik@aetoswebsites.com",
    subject: "Re: Your website", body: `Hi,\n\nJust checking you saw it.\n\n${coldFooter("Nik")}`, due_at: "2026-10-22T08:00:00Z" });

  const r = await onRequestPost({ env, params: { id: "p1" }, request: post(GOOD), now: NOW, waitUntil: waits.push.bind(waits) });
  assert.equal(r.status, 200);
  assert.equal(waits.length, 1);
  const tick = await waits[0];
  assert.equal(tick.ran, true);
  assert.deepEqual(Object.keys(tick.steps), ["send"]);
  assert.equal(tick.steps.send, "sent 0, failed 2, held 0");
  assert.ok(used() <= TICK_BUDGET.total, `Send and its tick made ${used()} D1 queries (D1 allows ${TICK_BUDGET.total} per invocation)`);
  const beat = await DB.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'tick:last'").first();
  assert.equal(Number(beat.n), 1);
});

test("the nudge's send step is given what this whole request has left of D1's 50, not only the tick's own", async (t) => {
  const { env, waits, used } = await routeEnv({ count: true });
  const seen = [];
  t.mock.method(sendStep, "run", async (ctx) => {
    seen.push({ left: ctx.budget.left(), used: used() });
    return "sent 0, failed 0, held 0";
  });
  const r = await onRequestPost({ env, params: { id: "p1" }, request: post(GOOD), now: NOW, waitUntil: waits.push.bind(waits) });
  assert.equal(r.status, 200);
  assert.deepEqual(await waits[0], { ran: true, steps: { send: "sent 0, failed 0, held 0" } });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].used > 13, `Send's own queries count too (${seen[0].used} made before the step)`);
  assert.equal(seen[0].left, TICK_BUDGET.total - seen[0].used - 1, "one is kept for the tick's lease release");
  assert.ok(seen[0].left >= TICK_BUDGET.minToStart);
  assert.ok(used() <= TICK_BUDGET.total);
});

test("a nudge that is turned away (too_soon) or can't run never fails the Send", async (t) => {
  // A tick ran 5 s ago: the nudge returns too_soon and the email waits for the next one.
  const soon = await routeEnv();
  await setSetting(soon.DB, "tick:last", "2026-10-22T08:14:55Z");
  const r = await onRequestPost({ env: soon.env, params: { id: "p1" }, request: post(GOOD), now: NOW, waitUntil: soon.waits.push.bind(soon.waits) });
  assert.equal(r.status, 200);
  assert.deepEqual(await soon.waits[0], { ran: false, why: "too_soon" });
  assert.equal(await countOf(soon.DB, "SELECT COUNT(*) n FROM messages WHERE status = 'queued'"), 1);

  // The tick throws before any step (here: its first read fails): the error is logged, the promise never rejects.
  const broken = await routeEnv();
  const raw = broken.DB;
  const DB = {
    prepare: (sql) => {
      if (/^SELECT key, value FROM settings WHERE key IN/.test(sql)) throw new Error("D1 is having a moment");
      return raw.prepare(sql);
    },
    batch: (stmts) => raw.batch(stmts),
  };
  const logged = t.mock.method(console, "error", () => {});
  const r2 = await onRequestPost({ env: { DB }, params: { id: "p1" }, request: post(GOOD), now: NOW, waitUntil: broken.waits.push.bind(broken.waits) });
  assert.equal(r2.status, 200);
  assert.equal(await broken.waits[0], undefined);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /^The tick \(compose\) couldn't run: D1 is having a moment$/);
});
