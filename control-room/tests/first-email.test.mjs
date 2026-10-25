// First email (stage 5–6, docs/rebuild/06-email-followups.md Part B Task 9): composeContext (what the composer in the
// lead drawer shows: the To options, the greeting, Claude's angle and opener, the demo, the mailbox, the db-side checks),
// previewFirst (the exact text and every check, pure on that context), sendChecks (the do-not-email list, an address
// another lead is being emailed at) and sendFirst (every check again, then the lead claimed and its first email queued
// in one transaction, so a double Send queues one email).
// Run: node --test control-room/tests/first-email.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { TEMPLATES } from "../functions/_lib/demo/render.js";
import { composeContext, previewFirst, sendChecks, sendFirst } from "../functions/_lib/first-email.js";
import { coldFooter } from "../functions/_lib/mail/compose.js";
import { dispatchDue } from "../functions/_lib/mail/outbox.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import {
  seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch,
} from "./helpers/shortlistSeed.mjs";

const NOW = new Date("2026-10-22T08:15:00Z"); // Thu 09:15 BST: inside the cold window
const DEMO_URL = "https://aetoswebsites.com/d/green-leaf";
const MARK = { first: "Mark", full: "Mark Green", source_url: "https://greenleaf.co.uk/about", confident: true };
// As research could hold them: a repeat in other case, a bad source link, junk entries.
const EMAILS = [
  { email: "Mark@GreenLeaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" },
  { email: "info@greenleaf.co.uk", source_url: "javascript:alert(1)", where: "Footer" },
  { email: "mark@greenleaf.co.uk", source_url: "https://facebook.com/greenleaf", where: "Facebook" },
  { email: "not an email", source_url: null, where: "?" },
  42,
];
const ANGLE = [
  { fact: "No website, but 48 five-star Google reviews", source_url: "https://maps.google.com/?cid=1" },
  { fact: "Not on the first page for landscaper Warrington", source_url: "https://www.google.com/search?q=landscaper+warrington" },
];
const OPENER = "I saw Green Leaf has 48 five-star reviews on Google.";

const input = { to: "mark@greenleaf.co.uk", subject: "Your website", body: "I made you a site: {demo_link}" };

const getProspect = (DB, id) => DB.prepare("SELECT * FROM prospects WHERE place_id = ?").bind(id).first();
const getMessage = (DB, id) => DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
const countOf = async (DB, sql) => Number((await DB.prepare(sql).first()).n);

/**
 * Lead p1 "Green Leaf Landscapes" (a landscaper, company 01234567), ready to email: research done (grade A, owner Mark
 * confident, his emails, the angle and opener), demo green-leaf live with the landscaper look approved, prospect
 * `ready` writing to mark@greenleaf.co.uk, cold mailbox m1 (nik@aetoswebsites.com, From "Nik Example", cap 10) and
 * business:sender_name "Nik", so the footer test proves the setting is used. `mailbox: null` = no mailbox at all;
 * `senderName: null` = no name on Setup; `lookApproved: false` = the landscaper look isn't approved yet.
 */
async function readyLead({
  owner = MARK, stage = "ready", first_sent_at = null, mailbox = {}, noProspect = false, research = {}, senderName = "Nik",
  lookApproved = true,
} = {}) {
  const DB = fakeD1();
  if (mailbox !== null) {
    await seedMailbox(DB, {
      id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example", started_on: "2026-01-01", cap_override: 10, ...mailbox,
    });
  }
  if (senderName !== null) await setSetting(DB, "business:sender_name", senderName);
  if (lookApproved) {
    await setSetting(DB, "demo:template:landscaper:approved",
      JSON.stringify({ version: TEMPLATES.landscaper.TEMPLATE.version, at: "2026-10-01T09:00:00Z" }));
  }
  await seedLead(DB, { place_id: "p1", name: "Green Leaf Landscapes", trade: "landscaper", company_number: "01234567" });
  await seedResearch(DB, {
    place_id: "p1", grade: "A", owner, emails: EMAILS, best_email: "mark@greenleaf.co.uk", angle: ANGLE, opener: OPENER, ...research,
  });
  await seedDemo(DB, { place_id: "p1", slug: "green-leaf" });
  if (!noProspect) {
    await seedProspect(DB, { place_id: "p1", stage, first_sent_at, email: "mark@greenleaf.co.uk", greet_name: "Mark" });
  }
  return DB;
}

/** readyLead() with one change, then Send: the first issue's message (and the status checked: 409 only for queued_already). */
async function issueFor({ suppress, to, otherProspectEmail, stage, first_sent_at, demo, mailbox, fullOn, noProspect } = {}) {
  const DB = await readyLead({
    stage, first_sent_at, mailbox, noProspect,
    research: noProspect ? { status: "queued", grade: null } : {}, // not graded yet: stage 4 makes no prospect for it
  });
  if (suppress) {
    await DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES (?, ?, ?, ?)")
      .bind(suppress.value, suppress.kind ?? "email", suppress.reason, suppress.created_at)
      .run();
  }
  if (otherProspectEmail) {
    await seedLead(DB, { place_id: "p2", name: "Other Ltd" });
    await seedProspect(DB, { place_id: "p2", stage: "emailed", email: otherProspectEmail, first_sent_at: "2026-10-01T09:00:00Z" });
  }
  if (fullOn) {
    // 10 threads on m1 whose 9th follow-up goes that day: every place that day is booked.
    for (let i = 0; i < 10; i++) {
      await seedProspect(DB, { place_id: `f${i}`, stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-09-10T08:00:00Z",
        followup_step: 8, next_followup_at: `${fullOn}T09:00:00Z` });
    }
  }
  const options = demo ? { demoReady: async () => ({ url: null, slug: null, ...demo }) } : {};
  const r = await sendFirst(DB, "p1", { ...input, ...(to ? { to } : {}) }, NOW, options);
  assert.equal(r.ok, false, "refused");
  assert.equal(r.status, r.issues[0].code === "queued_already" ? 409 : 400, r.issues[0].code);
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages WHERE kind = 'first'"), 0, "nothing queued");
  return r.issues[0].message;
}

// ---------------------------------------------------------------- the plan's tests (Part B, Task 9, Step 1)

test("send queues one first email and keeps the lead ready", async () => {
  const DB = await readyLead();                                          // research, prospect 'ready', mailbox m1 cap 10, demo ok, business:sender_name "Nik"
  const r = await sendFirst(DB, "p1", input, new Date("2026-10-22T08:15:00Z"));
  assert.equal(r.ok, true); assert.equal(r.due_at, "2026-10-22T08:15:00Z");
  const m = await DB.prepare("SELECT * FROM messages WHERE id = ?").bind(r.id).first();
  assert.equal(m.kind, "first"); assert.equal(m.author, "nik"); assert.equal(m.status, "queued"); assert.match(m.message_id, /@aetoswebsites\.com>$/);
  assert.equal(m.body, `Hi Mark,\n\nI made you a site: https://aetoswebsites.com/d/green-leaf\n\n${coldFooter("Nik")}`);
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "ready"); assert.equal(p.subject, "Your website"); assert.equal(p.greet_name, "Mark"); assert.equal(p.mailbox_id, "m1");
  assert.equal(await DB.prepare("SELECT COUNT(*) n FROM style_examples").first().then((x) => x.n), 0);
});

test("second send is refused", async () => {
  const DB = await readyLead(); const now = new Date("2026-10-22T08:15:00Z");
  await sendFirst(DB, "p1", input, now);
  const r = await sendFirst(DB, "p1", input, now);
  assert.equal(r.status, 409); assert.equal(r.issues[0].code, "queued_already");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM messages").first()).n, 1);
});

test("outside the window it is due at the next window start", async () =>
  assert.equal((await sendFirst(await readyLead(), "p1", input, new Date("2026-10-25T10:00:00Z"))).due_at, "2026-10-26T07:00:00Z"));

test("each db check has its exact message", async () => {
  assert.equal(await issueFor({ suppress: { value: "mark@greenleaf.co.uk", reason: "opt_out", created_at: "2026-11-03T10:00:00Z" } }),
    "mark@greenleaf.co.uk is on your do-not-email list (opted out on 3 Nov). You can't email it.");
  assert.equal(await issueFor({ suppress: { value: "greenleaf.co.uk", kind: "domain", reason: "bounce", created_at: "2026-11-03T10:00:00Z" } }),
    "mark@greenleaf.co.uk is on your do-not-email list (bounced on 3 Nov). You can't email it.");
  assert.equal(await issueFor({ to: "typo@x.com" }), "Pick an address from the list.");
  assert.equal(await issueFor({ otherProspectEmail: "mark@greenleaf.co.uk" }), "mark@greenleaf.co.uk is already being emailed as Other Ltd.");
  assert.equal(await issueFor({ stage: "emailed", first_sent_at: "2026-10-22T08:15:00Z" }), "You've already emailed Green Leaf Landscapes on 22 Oct. The thread is below.");
  assert.equal(await issueFor({ demo: { ok: false, reason: "the landscaper template isn't approved yet" } }), "Their demo isn't ready: the landscaper template isn't approved yet. Fix it on the Demo card first.");
  assert.equal(await issueFor({ mailbox: null }), "No mailbox is set up for cold email yet. Add one on Setup → Mailboxes.");
  assert.equal(await issueFor({ mailbox: { started_on: "2026-10-20", cap_override: null } }), "Your mailbox is still warming up: cold emails can start on Tue 3 Nov.");
  assert.equal(await issueFor({ fullOn: "2026-11-09" }), "Your mailboxes are full on Mon 9 Nov (follow-ups already booked that day). Send this one tomorrow.");
  assert.equal(await issueFor({ noProspect: true }), "This lead isn't ready to email yet: it needs a grade, an email and a demo first.");
});

test("greeting falls back to Hi, when the owner isn't confident", async () => {
  const DB = await readyLead({ owner: { ...MARK, confident: false } });
  const r = await sendFirst(DB, "p1", input, NOW);
  assert.equal(r.ok, true);
  const m = await getMessage(DB, r.id);
  assert.ok(m.body.startsWith("Hi,\n\nI made you a site: "), m.body);
  assert.equal((await getProspect(DB, "p1")).greet_name, null);                   // seeded "Mark": Send stores NULL ("Hi,")
});

// ---------------------------------------------------------------- composeContext

test("composeContext: what the composer shows", async () => {
  const DB = await readyLead();
  const ctx = await composeContext(DB, "p1", NOW);
  assert.equal(ctx.business, "Green Leaf Landscapes");
  // lower-cased, de-duplicated (the first time an address is found wins), the best one first; only http(s) source links
  assert.deepEqual(ctx.to_options, [
    { email: "mark@greenleaf.co.uk", where: "Contact page", source_url: "https://greenleaf.co.uk/contact", best: true },
    { email: "info@greenleaf.co.uk", where: "Footer", source_url: null, best: false },
  ]);
  assert.deepEqual(ctx.greeting, { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(ctx.angle, ANGLE);
  assert.equal(ctx.opener, OPENER);
  assert.deepEqual(ctx.demo, { ok: true, url: DEMO_URL, reason: "" });
  assert.equal(ctx.due_at, "2026-10-22T08:15:00Z");
  assert.deepEqual(ctx.mailbox, { id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example" });
  assert.equal(ctx.sender_name, "Nik");
  assert.deepEqual(ctx.blocking, []);
  assert.equal(ctx.followups_approved, false);
  assert.equal(ctx.stage, "ready");
  assert.equal(ctx.first_message_id, null);
  assert.equal(ctx.place_id, "p1");
  for (const key of ["business", "to_options", "greeting", "angle", "opener", "demo", "due_at", "mailbox", "sender_name",
    "blocking", "followups_approved", "stage", "first_message_id"]) assert.ok(Object.hasOwn(ctx, key), key);
});

test("composeContext: the best email is offered even when the list hasn't got it; a lower-case confident name is title-cased", async () => {
  const DB = await readyLead({ owner: { ...MARK, first: "mark" }, research: { best_email: " Owner@GreenLeaf.co.uk " } });
  const ctx = await composeContext(DB, "p1", NOW);
  assert.deepEqual(ctx.to_options[0], { email: "owner@greenleaf.co.uk", where: "", source_url: null, best: true });
  assert.deepEqual(ctx.to_options.map((o) => o.best), [true, false, false]);
  assert.deepEqual(ctx.greeting, { line: "Hi Mark,", name: "Mark" });
});

test("composeContext: outside the window the email waits for Monday 07:00, and the room is Monday's", async () => {
  const DB = await readyLead();
  const ctx = await composeContext(DB, "p1", new Date("2026-10-24T18:30:00Z")); // Sat 19:30 BST
  assert.equal(ctx.due_at, "2026-10-26T07:00:00Z");
  assert.deepEqual(ctx.blocking, []);
  assert.equal(ctx.mailbox.id, "m1");
});

test("composeContext: followups_approved once all 9 are approved; first_message_id is the newest first email not cancelled", async () => {
  const DB = await readyLead();
  for (let s = 1; s <= 9; s++) {
    await DB.prepare("INSERT INTO followup_templates (step, day_offset, body, status) VALUES (?, ?, ?, 'approved')").bind(s, s, "x").run();
  }
  await seedMessage(DB, { id: "old", place_id: "p1", status: "failed", created_at: "2026-10-20T08:00:00Z" });
  await seedMessage(DB, { id: "gone", place_id: "p1", status: "cancelled", created_at: "2026-10-21T08:00:00Z" });
  const ctx = await composeContext(DB, "p1", NOW);
  assert.equal(ctx.followups_approved, true);
  assert.equal(ctx.first_message_id, "old");
  assert.deepEqual(ctx.blocking, []);                                      // a failed or cancelled one doesn't block
});

test("composeContext: no mailbox has room or can send", async () => {
  const paused = await readyLead({ mailbox: { status: "paused", paused_reason: "2 emails bounced in 7 days (last: a@b.com)." } });
  const ctx = await composeContext(paused, "p1", NOW);
  assert.equal(ctx.mailbox, null);
  // A mailbox is set up but paused: "No mailbox is set up" wouldn't be true, so it says why, as the Leads banner does.
  assert.deepEqual(ctx.blocking, [{ code: "no_mailbox",
    message: "Sending is paused: 2 emails bounced in 7 days (last: a@b.com). Fix it on Setup → Mailboxes." }]);

  const system = await readyLead({ mailbox: { role: "system" } });
  assert.deepEqual((await composeContext(system, "p1", NOW)).blocking.map((i) => i.code), ["no_mailbox"]);

  const never = await readyLead({ mailbox: { cap_override: 0 } });
  assert.deepEqual((await composeContext(never, "p1", NOW)).blocking, [{ code: "warming_up",
    message: "Your mailbox can't send cold email in the next 60 days: check its start date and daily limit on Setup → Mailboxes." }]);
});

test("composeContext: the mailbox with the most room sends it; a paused or system one never", async () => {
  const DB = await readyLead();
  await seedMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam", started_on: "2026-01-01", cap_override: 10 });
  await seedMailbox(DB, { id: "m3", address: "kim@aetoswebsites.com", display_name: "Kim", started_on: "2026-01-01", cap_override: 50, status: "paused" });
  await seedMailbox(DB, { id: "s1", address: "team@aetoswebsites.com", display_name: "Team", started_on: "2026-01-01", cap_override: 50, role: "system" });
  for (let i = 0; i < 3; i++) {
    await seedMessage(DB, { mailbox_id: "m1", status: "sent", sent_at: "2026-10-22T07:00:00Z", to_addr: `x${i}@y.com` });
  }
  assert.deepEqual((await composeContext(DB, "p1", NOW)).mailbox, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" });
  const r = await sendFirst(DB, "p1", input, NOW);
  const m = await getMessage(DB, r.id);
  assert.equal(m.mailbox_id, "m2"); assert.equal(m.from_addr, "sam@aetoswebsites.com"); assert.match(m.message_id, /@aetoswebsites\.com>$/);
  assert.equal((await getProspect(DB, "p1")).mailbox_id, "m2");
});

test("composeContext: a lead set aside after Send shows stage 4's reason (Part A, Set aside after Send)", async () => {
  const DB = await readyLead();
  assert.equal((await sendFirst(DB, "p1", input, new Date("2026-10-24T19:30:00Z"))).due_at, "2026-10-26T07:00:00Z");
  await DB.prepare("UPDATE leads SET excluded = 1, exclude_reason = 'A branch of a chain' WHERE place_id = 'p1'").run();
  const ctx = await composeContext(DB, "p1", new Date("2026-10-25T10:00:00Z"));
  assert.deepEqual(ctx.demo, { ok: false, url: null, reason: "No demo yet: Excluded: A branch of a chain" });
  assert.deepEqual(ctx.blocking.map((i) => i.code), ["queued_already", "demo_not_ready"]);
  // and the outbox never sends it (stage 0's claim needs the lead to pass stage 3's ready rule)
  await setSecret(DB, "mailbox:m1", "pw");
  const sent = [];
  const tally = await dispatchDue(DB, {}, new Date("2026-10-26T07:05:00Z"), { send: async (...a) => (sent.push(a), { ok: true }) });
  assert.deepEqual(tally, { sent: 0, failed: 0, held: 1 });
  assert.equal(sent.length, 0);
});

test("composeContext: stage 4's own reason when the look isn't approved yet; Send is refused with it", async () => {
  const DB = await readyLead({ lookApproved: false });
  const ctx = await composeContext(DB, "p1", NOW);
  assert.deepEqual(ctx.demo, { ok: false, url: null, reason: "Waiting for you to approve the Landscaper look on the Demo page" });
  const message = "Their demo isn't ready: Waiting for you to approve the Landscaper look on the Demo page. Fix it on the Demo card first.";
  assert.deepEqual(ctx.blocking, [{ code: "demo_not_ready", message }]);
  assert.deepEqual(await sendFirst(DB, "p1", input, NOW), { ok: false, status: 400, issues: [{ code: "demo_not_ready", message }] });
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
});

test("composeContext: no name on Setup blocks Send (overview §9: every cold email ends with Nik's name)", async () => {
  for (const senderName of [null, "  "]) {
    const DB = await readyLead({ senderName });
    const ctx = await composeContext(DB, "p1", NOW);
    assert.equal(ctx.sender_name, "");
    const message = "Add your name on Setup → Business details first: every email is signed with it.";
    assert.deepEqual(ctx.blocking, [{ code: "no_sender_name", message }]);
    assert.deepEqual(previewFirst(ctx, input).issues, [{ code: "no_sender_name", message }]);
    assert.deepEqual(await sendFirst(DB, "p1", input, NOW), { ok: false, status: 400, issues: [{ code: "no_sender_name", message }] });
    assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
    await setSetting(DB, "business:sender_name", "Nik");
    const r = await sendFirst(DB, "p1", input, NOW);
    assert.equal(r.ok, true);
    assert.ok((await getMessage(DB, r.id)).body.endsWith(coldFooter("Nik")));
  }
});

test("sendFirst: a blank first_sent_at reads as never emailed, in the checks and in the claim", async () => {
  const DB = await readyLead({ first_sent_at: "" });
  assert.deepEqual((await composeContext(DB, "p1", NOW)).blocking, []);
  const r = await sendFirst(DB, "p1", input, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages WHERE kind = 'first' AND status = 'queued'"), 1);
});

test("composeContext: a qualifying lead whose prospect was never made gets one from stage 4's gate, and can be emailed", async () => {
  const DB = await readyLead({ noProspect: true });
  const ctx = await composeContext(DB, "p1", NOW);
  assert.equal(ctx.stage, "ready");
  assert.deepEqual(ctx.blocking, []);
  assert.equal((await sendFirst(DB, "p1", input, NOW)).ok, true);
});

// ---------------------------------------------------------------- previewFirst (pure on the context)

test("previewFirst: the exact text, the From line, and every check in order", async () => {
  const ctx = await composeContext(await readyLead(), "p1", NOW);
  const ok = previewFirst(ctx, { to: "mark@greenleaf.co.uk", subject: "Your website", body: "{demo_link}" });
  assert.deepEqual(ok, { text: `Hi Mark,\n\n${DEMO_URL}\n\n${coldFooter("Nik")}`, from: "Nik Example <nik@aetoswebsites.com>", issues: [] });

  const bad = previewFirst(ctx, { to: "typo@x.com", subject: "Re: hi", body: "Hi Mark,\nsee www.x.com" });
  assert.deepEqual(bad.issues.map((i) => i.code), ["subject_re", "greeting", "demo_missing", "other_link", "not_in_list"]);
  assert.equal(bad.issues[1].message, 'Leave out the greeting: "Hi Mark," is added for you.');
  assert.equal(bad.issues[4].message, "Pick an address from the list.");
  assert.equal(bad.text, `Hi Mark,\n\nHi Mark,\nsee www.x.com\n\n${coldFooter("Nik")}`);

  // An empty draft: the greeting and the footer only, and nothing picked yet.
  const empty = previewFirst(ctx, {});
  assert.equal(empty.text, `Hi Mark,\n\n${coldFooter("Nik")}`);
  assert.deepEqual(empty.issues.map((i) => i.code), ["subject_missing", "body_missing", "not_in_list"]);
});

test("previewFirst: the lead's state comes first, the demo and mailbox checks after the text; {demo_link} stays while there's no demo", () => {
  const ctx = {
    greeting: { line: "Hi,", name: null }, sender_name: "Nik", mailbox: null,
    demo: { ok: false, url: null, reason: "No demo yet: Not researched yet" },
    to_options: [{ email: "a@b.co.uk", where: "", source_url: null, best: true }],
    blocking: [
      { code: "demo_not_ready", message: "Their demo isn't ready: No demo yet: Not researched yet. Fix it on the Demo card first." },
      { code: "queued_already", message: "A first email to X is already waiting to go out. Cancel it below to write a new one." },
    ],
  };
  const p = previewFirst(ctx, { to: "A@B.co.uk ", subject: "Hello", body: "Look: {demo_link}" });
  assert.equal(p.text, `Hi,\n\nLook: {demo_link}\n\n${coldFooter("Nik")}`);
  assert.equal(p.from, "");
  assert.deepEqual(p.issues.map((i) => i.code), ["queued_already", "demo_not_ready"]);
});

test("previewFirst and sendFirst: input that isn't text is a plain-English 400, never a crash", async () => {
  const DB = await readyLead();
  const ctx = await composeContext(DB, "p1", NOW);
  for (const bad of [null, "text", [], { ...input, subject: 5 }, { ...input, body: { text: "x" } }, { ...input, to: ["a"] }]) {
    const p = previewFirst(ctx, bad);
    assert.deepEqual(p.issues.map((i) => i.code), ["bad_request"], JSON.stringify(bad));
    const r = await sendFirst(DB, "p1", bad, NOW);
    assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(r.issues[0].code, "bad_request");
    assert.match(r.issues[0].message, /refresh the page/i);
  }
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
});

// ---------------------------------------------------------------- sendChecks and sendFirst

test("sendChecks: clean, a company on the list, another lead's queued first email to the same address", async () => {
  const DB = await readyLead();
  const ctx = await composeContext(DB, "p1", NOW);
  assert.deepEqual(await sendChecks(DB, ctx, "mark@greenleaf.co.uk"), []);

  await seedLead(DB, { place_id: "p2", name: "  GREEN LEAF LANDSCAPES - Landscaper in Warrington " });
  await seedProspect(DB, { place_id: "p2", stage: "ready", email: "Mark@GreenLeaf.co.uk" });
  assert.deepEqual(await sendChecks(DB, ctx, "mark@greenleaf.co.uk"), [], "a ready lead not emailed yet doesn't count");
  await seedMessage(DB, { place_id: "p2", status: "queued", to_addr: "mark@greenleaf.co.uk" });
  assert.deepEqual(await sendChecks(DB, ctx, "mark@greenleaf.co.uk"), [{ code: "shared_address",
    message: "mark@greenleaf.co.uk is already being emailed as GREEN LEAF LANDSCAPES - Landscaper in Warrington." }]);
  await DB.prepare("UPDATE prospects SET stage = 'lost' WHERE place_id = 'p2'").run();
  assert.deepEqual(await sendChecks(DB, ctx, "mark@greenleaf.co.uk"), [], "a lost lead doesn't count");

  await DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES ('01234567', 'company', 'manual', '2026-10-05T09:00:00Z')").run();
  assert.deepEqual(await sendChecks(DB, ctx, "info@greenleaf.co.uk"), [{ code: "suppressed",
    message: "Green Leaf Landscapes is on your do-not-email list (manual on 5 Oct). You can't email it." }]);
});

test("sendFirst: already emailed when the first email went but the sync hasn't run yet; a lead past ready never emailed", async () => {
  const DB = await readyLead();
  await seedMessage(DB, { place_id: "p1", status: "sent", sent_at: "2026-10-21T08:00:00Z" });
  const r = await sendFirst(DB, "p1", input, NOW);
  assert.equal(r.status, 400);
  assert.deepEqual(r.issues[0], { code: "already_emailed",
    message: "You've already emailed Green Leaf Landscapes on 21 Oct. The thread is below." });

  const lost = await readyLead({ stage: "lost" });
  assert.deepEqual((await sendFirst(lost, "p1", input, NOW)).issues[0], { code: "already_emailed",
    message: "You can't send Green Leaf Landscapes a first email: it's marked \"Lost\"." });
});

test("sendFirst: two Sends at once (double-click, two tabs) queue one email, and the prospect matches it", async () => {
  const DB = await readyLead();
  const [a, b] = await Promise.all([
    sendFirst(DB, "p1", input, NOW),
    sendFirst(DB, "p1", { ...input, to: "info@greenleaf.co.uk", subject: "Another try" }, NOW),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const refused = a.ok ? b : a;
  assert.equal(refused.status, 409);
  assert.equal(refused.issues[0].code, "queued_already");
  assert.equal(refused.issues[0].message, "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one.");
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 1);
  const m = await getMessage(DB, (a.ok ? a : b).id);
  const p = await getProspect(DB, "p1");
  assert.equal(p.subject, m.subject); assert.equal(p.email, m.to_addr); assert.equal(p.mailbox_id, m.mailbox_id);
});

test("sendFirst: the subject goes on one line; the To is stored lower-cased", async () => {
  const DB = await readyLead();
  const r = await sendFirst(DB, "p1", { ...input, to: " Info@GreenLeaf.co.uk ", subject: " Your\r\nnew   website " }, NOW);
  assert.equal(r.ok, true);
  const m = await getMessage(DB, r.id);
  assert.equal(m.subject, "Your new website"); assert.equal(m.to_addr, "info@greenleaf.co.uk");
  assert.equal(m.from_addr, "nik@aetoswebsites.com"); assert.equal(m.direction, "out"); assert.equal(m.step, null);
  assert.equal(m.due_at, "2026-10-22T08:15:00Z"); assert.equal(m.created_at, "2026-10-22T08:15:00Z"); assert.equal(m.place_id, "p1");
  const p = await getProspect(DB, "p1");
  assert.equal(p.subject, "Your new website"); assert.equal(p.email, "info@greenleaf.co.uk"); assert.equal(p.updated_at, "2026-10-22T08:15:00Z");
});

test("sendFirst: every text check of Part A §A3 refuses Send with 400 and its message", async () => {
  const DB = await readyLead();
  for (const [code, change, message] of [
    ["subject_missing", { subject: " " }, "Add a subject."],
    ["subject_re", { subject: "Fwd: your site" }, 'The subject can\'t start with "Re:" or "Fwd:".'],
    ["body_missing", { body: "\n " }, "Write the email first."],
    ["greeting", { body: "Hello,\n{demo_link}" }, 'Leave out the greeting: "Hi Mark," is added for you.'],
    ["demo_missing", { body: "No link" }, "Add the demo link: press Insert demo link."],
    ["demo_twice", { body: `{demo_link} ${DEMO_URL}` }, "The demo link is in there more than once. Keep it once."],
    ["other_link", { body: "{demo_link} or greenleaf.co.uk" }, "Only the demo link is allowed. Remove: greenleaf.co.uk"],
    ["seo", { subject: "Better SEO" }, 'Don\'t say "SEO". Say "front page of Google" instead.'],
    ["too_long", { body: `{demo_link} ${"word ".repeat(149)}` }, "Too long: 150 words. Keep it under 150."],
    ["placeholder", { body: "{demo_link} for {business}" }, "{business} isn't filled in for you. Only {demo_link} is."],
  ]) {
    const r = await sendFirst(DB, "p1", { ...input, ...change }, NOW);
    assert.equal(r.status, 400, code);
    assert.deepEqual(r.issues, [{ code, message }], code);
  }
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages"), 0);
});

test("sendFirst: a text check refuses with 400 and writes nothing; a cancelled first email frees the lead again", async () => {
  const DB = await readyLead();
  const r = await sendFirst(DB, "p1", { ...input, body: "No link here" }, NOW);
  assert.deepEqual(r, { ok: false, status: 400, issues: [{ code: "demo_missing", message: "Add the demo link: press Insert demo link." }] });
  assert.equal((await getProspect(DB, "p1")).subject, null);

  const first = await sendFirst(DB, "p1", input, NOW);
  await DB.prepare("UPDATE messages SET status = 'cancelled' WHERE id = ?").bind(first.id).run();
  const again = await sendFirst(DB, "p1", { ...input, subject: "Second go" }, NOW);
  assert.equal(again.ok, true);
  assert.notEqual(again.id, first.id);
  assert.notEqual((await getMessage(DB, again.id)).message_id, (await getMessage(DB, first.id)).message_id);
  assert.equal((await composeContext(DB, "p1", NOW)).first_message_id, again.id);
});

test("sendFirst: D1 statements stay few (composeContext 9, sendFirst 13, 14 when the claim loses a race)", async () => {
  const DB = await readyLead();
  const c = countingDB(DB);
  await composeContext(c.DB, "p1", NOW);
  assert.equal(c.used(), 9);
  const s = countingDB(DB);
  assert.equal((await sendFirst(s.DB, "p1", input, NOW)).ok, true);
  assert.equal(s.used(), 13);
  // Two Sends at once: both pass the checks, the second is refused by the batch and reads the lead again (1 more).
  const raced = await readyLead();
  const r = countingDB(raced);
  const [one, two] = await Promise.all([sendFirst(r.DB, "p1", input, NOW), sendFirst(r.DB, "p1", input, NOW)]);
  assert.deepEqual([one.ok, two.ok].sort(), [false, true]);
  assert.equal(r.used(), 13 + 14);
});

test("the queued email goes out at its due time, from the mailbox Send picked, exactly as previewed", async () => {
  const DB = await readyLead();
  await setSecret(DB, "mailbox:m1", "pw");
  const sunday = new Date("2026-10-25T10:00:00Z");
  const ctx = await composeContext(DB, "p1", sunday);
  const preview = previewFirst(ctx, input);
  const r = await sendFirst(DB, "p1", input, sunday);
  const sent = [];
  const send = async (mailbox, password, msg) => (sent.push(msg), { ok: true });
  assert.deepEqual(await dispatchDue(DB, {}, sunday, { send }), { sent: 0, failed: 0, held: 0 }); // not due till Monday
  assert.equal((await getMessage(DB, r.id)).status, "queued");
  assert.deepEqual(await dispatchDue(DB, {}, new Date("2026-10-26T07:00:00Z"), { send }), { sent: 1, failed: 0, held: 0 });
  assert.equal(sent[0].text, preview.text);
  assert.equal(sent[0].headers.From, preview.from);
  assert.equal(sent[0].headers.Subject, "Your website");
  assert.equal(sent[0].headers["Message-ID"], (await getMessage(DB, r.id)).message_id);
});
