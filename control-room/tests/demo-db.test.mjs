// Demo sites in D1 (stage 4, docs/rebuild/05-demo.md Tasks 8 and 9): ensureDemo makes a lead's demo and its `ready`
// prospect when the lead qualifies (Part A §1), demoBySlug finds a demo with everything its page needs, demoLink is the
// link the first email carries. recordEvent (kept for stage 9) counts a view once per 30 minutes. templateApproval and
// approveTemplate are Nik's OK for a look (Part A §7), and demoReady is what stages 5/6 ask before an email goes out.
// Run: node --test control-room/tests/demo-db.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import {
  approveTemplate, DEMO_BASE, DEMO_DAYS, demoBySlug, demoLink, demoReady, ensureDemo, latestDemo, recordEvent,
  syncDemoExpiry, templateApproval,
} from "../functions/_lib/demo-db.js";
import { TEMPLATES } from "../functions/_lib/demo/render.js";
import { markNotFit } from "../functions/_lib/shortlist-db.js";
import { addTodo, closeTodos } from "../functions/_lib/todo.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import {
  seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch, seedSuppression,
} from "./helpers/shortlistSeed.mjs";

const AT = new Date("2026-10-21T10:00:00Z");
const SLUG = /^green-leaf-landscapes-[a-hj-km-np-z2-9]{6}$/;
const LANDSCAPER_TODO = "setup:demo-template:landscaper:v1";
const GENERIC_TODO = "setup:demo-template:generic:v1";
const NO = (reason) => ({ ok: false, reason, demo: null, created: false });

const DAVE = { first: "Dave", full: "Dave Smith", source_url: "https://greenleaf.co.uk/about", confident: true };
const COPY = { headline: "Garden design in Warrington", intro: "", services: ["Patios"], areas: ["Warrington"], about: "" };

/** A database with lead p1 (Green Leaf Landscapes, a landscaper) and its research (grade A, Dave's email). */
async function seed({ lead = {}, research = {} } = {}) {
  const DB = fakeD1();
  if (lead) await seedLead(DB, { place_id: "p1", name: "Green Leaf Landscapes", trade: "landscaper", ...lead });
  if (research) {
    await seedResearch(DB, { place_id: "p1", grade: "A", best_email: "Dave@GreenLeaf.co.uk", owner: DAVE, copy: COPY, ...research });
  }
  return DB;
}

const one = (DB, sql, ...args) => DB.raw.prepare(sql).get(...args);
const count = (DB, sql, ...args) => Number(one(DB, sql, ...args).n);
const prospectOf = (DB, id = "p1") => one(DB, "SELECT * FROM prospects WHERE place_id = ?", id);

// ---------------------------------------------------------------- the spec's tests (Task 8, Step 1)

test("ensureDemo makes the demo (180 days) and the ready prospect, then reuses the demo", async () => {
  const DB = await seed();
  const r = await ensureDemo(DB, "p1", AT); // AT = 2026-10-21T10:00:00Z
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.reason, "");
  assert.equal(r.demo.expires_at, "2027-04-19T10:00:00Z"); // +180 days
  assert.deepEqual(Object.keys(r.demo).sort(), ["created_at", "expires_at", "place_id", "slug"]);
  assert.match(r.demo.slug, SLUG);
  assert.equal(r.demo.place_id, "p1");
  assert.equal(r.demo.created_at, "2026-10-21T10:00:00Z", "stored as util.now() text: no milliseconds");
  assert.deepEqual({ ...one(DB, "SELECT * FROM demos") }, r.demo, "the row is what it returns");

  const p = prospectOf(DB);
  assert.equal(p.stage, "ready");
  assert.equal(p.email, "dave@greenleaf.co.uk", "best_email lower-cased");
  assert.equal(p.greet_name, "Dave");
  assert.equal(p.stage_at, "2026-10-21T10:00:00Z");

  const again = await ensureDemo(DB, "p1", AT);
  assert.equal(again.demo.slug, r.demo.slug); // reused
  assert.equal(again.created, false);
  assert.equal(again.ok, true);
  assert.deepEqual(again.demo, r.demo);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 1);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM prospects"), 1);
  // still live a day before it ends, a new one once it has ended
  assert.equal((await ensureDemo(DB, "p1", new Date("2027-04-18T10:00:00Z"))).demo.slug, r.demo.slug);
});

test("an owner who isn't confident gets greet_name NULL (the email says Hi,)", async () => {
  for (const owner of [{ ...DAVE, confident: false }, { first: "Dave" }, null, "not json", { first: 42, confident: true }]) {
    const DB = await seed({ research: { owner } });
    assert.equal((await ensureDemo(DB, "p1", AT)).ok, true, JSON.stringify(owner));
    const p = prospectOf(DB);
    assert.equal(p.greet_name, null, JSON.stringify(owner));
    assert.equal(p.email, "dave@greenleaf.co.uk");
  }
});

test("a better email on re-research updates a ready prospect, keeps its demo and its stage", async () => {
  const DB = await seed();
  const first = await ensureDemo(DB, "p1", AT);
  const before = prospectOf(DB);
  DB.raw.prepare("UPDATE research SET best_email = ?, owner = ? WHERE place_id = 'p1'")
    .run("sue@greenleaf.co.uk", JSON.stringify({ first: "Sue", full: "Sue Jones", source_url: "https://greenleaf.co.uk", confident: true }));
  const later = new Date("2026-10-22T09:00:00Z");
  const r = await ensureDemo(DB, "p1", later);
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.demo.slug, first.demo.slug, "demo kept");
  const p = prospectOf(DB);
  assert.equal(p.email, "sue@greenleaf.co.uk");
  assert.equal(p.greet_name, "Sue");
  assert.equal(p.stage, "ready", "no stage change");
  assert.equal(p.stage_at, before.stage_at, "no stage change");
  assert.equal(p.updated_at, "2026-10-22T09:00:00Z");
  // an owner no longer confident takes the name off
  DB.raw.prepare("UPDATE research SET owner = ? WHERE place_id = 'p1'").run(JSON.stringify({ first: "Sue", confident: false }));
  await ensureDemo(DB, "p1", later);
  assert.equal(prospectOf(DB).greet_name, null);
});

test("a first email queued, sending, sent or failed freezes the ready prospect's address and greeting; cancelled frees it", async () => {
  // Stage 6 writes the To Nik picked (any sourced address) and greet_name into the prospect when it queues the first
  // email, and the stage stays `ready` until the send succeeds; follow-ups go to prospects.email and stage 0 matches
  // replies by it. Re-research (or the hot step) in between must not point the thread at another address.
  const SUE = JSON.stringify({ first: "Sue", full: "Sue Jones", source_url: "https://greenleaf.co.uk", confident: true });
  for (const status of ["queued", "sending", "sent", "failed"]) {
    const DB = await seed();
    await seedMailbox(DB);
    assert.equal((await ensureDemo(DB, "p1", AT)).ok, true);
    // stage 6's claim: Nik picked office@ (no greeting), and the first email waits for the window
    DB.raw.prepare("UPDATE prospects SET email = 'office@greenleaf.co.uk', greet_name = NULL, mailbox_id = 'm1', subject = 'Your website' WHERE place_id = 'p1'").run();
    DB.raw.prepare(`INSERT INTO messages (id, place_id, mailbox_id, direction, kind, author, to_addr, subject, body, status, due_at, sent_at, created_at)
      VALUES ('first1', 'p1', 'm1', 'out', 'first', 'nik', 'office@greenleaf.co.uk', 'Your website', 'Hi,', ?, '2026-10-26T07:00:00Z', ?, '2026-10-21T10:00:00Z')`)
      .run(status, status === "sent" ? "2026-10-21T10:01:00Z" : null);
    const frozen = { ...prospectOf(DB) };
    // the research is posted again with a different best email and owner
    DB.raw.prepare("UPDATE research SET best_email = 'sue@greenleaf.co.uk', owner = ? WHERE place_id = 'p1'").run(SUE);
    const c = countingDB(DB);
    const r = await ensureDemo(c.DB, "p1", new Date("2026-10-22T09:00:00Z"));
    assert.equal(r.ok, true, status);
    assert.equal(c.used(), 1, `${status}: nothing to write, so just the one read`);
    assert.deepEqual({ ...prospectOf(DB) }, frozen, `${status}: the address and greeting stay as Nik queued them`);
    // Nik cancels it (for a failed one: he gives up on it): the next research brings the prospect up to date again
    DB.raw.prepare("UPDATE messages SET status = 'cancelled' WHERE id = 'first1'").run();
    if (status === "sent") continue; // a sent email is never cancelled
    await ensureDemo(DB, "p1", new Date("2026-10-22T09:05:00Z"));
    const p = prospectOf(DB);
    assert.equal(p.email, "sue@greenleaf.co.uk", status);
    assert.equal(p.greet_name, "Sue", status);
    assert.equal(p.stage, "ready", status);
    assert.equal(p.updated_at, "2026-10-22T09:05:00Z", status);
  }
  // other messages (a follow-up, an inbound one, another lead's first email) don't freeze it
  const DB = await seed();
  await seedLead(DB, { place_id: "p2" });
  assert.equal((await ensureDemo(DB, "p1", AT)).ok, true);
  for (const o of [{ place_id: "p1", kind: "followup", status: "queued" }, { place_id: "p1", kind: "inbound" }, { place_id: "p2", status: "queued" }]) {
    DB.raw.prepare(`INSERT INTO messages (id, place_id, direction, kind, author, body, status, created_at)
      VALUES (?, ?, ?, ?, 'nik', 'x', ?, '2026-10-21T10:00:00Z')`)
      .run(`x-${o.place_id}-${o.kind ?? "first"}`, o.place_id, o.kind === "inbound" ? "in" : "out", o.kind ?? "first", o.status ?? "received");
  }
  DB.raw.prepare("UPDATE research SET best_email = 'sue@greenleaf.co.uk', owner = ? WHERE place_id = 'p1'").run(SUE);
  const sqls = [];
  await ensureDemo({ prepare: (sql) => (sqls.push(sql), DB.prepare(sql)), batch: (s) => DB.batch(s) }, "p1", AT);
  assert.equal(prospectOf(DB).email, "sue@greenleaf.co.uk");
  assert.equal(prospectOf(DB).greet_name, "Sue");
  // the first-email check reads that lead's own messages (messages_place), in the read and in the UPDATE
  assert.equal(sqls.length, 2);
  for (const sql of sqls) {
    const plan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join("\n");
    assert.match(plan, /SEARCH m USING INDEX messages_place \(place_id=\?\)/, plan);
    assert.doesNotMatch(plan, /messages_due/, plan);
  }
});

test("every reason a lead gets no demo, word for word; nothing is written", async () => {
  const gradeC = () => seed({ research: { grade: "C" } });
  const gradeD = () => seed({ research: { grade: "D" } });
  const noEmail = () => seed({ research: { best_email: null } });
  const blankEmail = () => seed({ research: { best_email: "  " } });
  const badEmail = () => seed({ research: { best_email: "dave at greenleaf" } });
  const tooBig = () => seed({ research: { grade: "D", too_big: 1 } });
  const notDone = () => seed({ research: { status: "queued", grade: null } });
  const skipped = () => seed({ research: { status: "skipped", grade: null } });
  const noResearch = () => seed({ research: null });
  const excluded = () => seed({ lead: { excluded: 1, exclude_reason: "Chain / national brand" } });
  const suppressedDomain = async () => {
    const DB = await seed();
    await seedSuppression(DB, "greenleaf.co.uk", "domain");
    return DB;
  };
  const suppressedEmail = async () => {
    const DB = await seed();
    await seedSuppression(DB, "dave@greenleaf.co.uk", "email");
    return DB;
  };
  const missing = () => seed({ lead: null, research: null });
  for (const [setup, reason] of [[gradeC, "Grade C: only A+, A and B get a demo"], [noEmail, "No email found"],
    [tooBig, "Too big for us"], [notDone, "Not researched yet"], [excluded, "Excluded: Chain / national brand"],
    [suppressedDomain, "On the do-not-contact list"], [missing, "Lead not found"],
    [gradeD, "Grade D: only A+, A and B get a demo"], [blankEmail, "No email found"], [badEmail, "No email found"],
    [skipped, "Taken off the list (the research card says why)"],
    [noResearch, "Not researched yet"], [suppressedEmail, "On the do-not-contact list"]]) {
    const DB = await setup();
    assert.deepEqual(await ensureDemo(DB, "p1", AT), NO(reason));
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 0, reason);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM prospects"), 0, reason);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos"), 0, reason);
  }
  // A+ and B get one too
  for (const grade of ["A+", "B"]) assert.equal((await ensureDemo(await seed({ research: { grade } }), "p1", AT)).ok, true, grade);
});

test("the do-not-contact check reads the address and its domain only", async () => {
  // a subdomain is another domain, and another address at a different domain doesn't count (as isSuppressed reads it)
  for (const value of ["mail.greenleaf.co.uk", "leaf.co.uk", "sue@greenleaf.co.uk", "dave@greenleaf.com"]) {
    const DB = await seed();
    await seedSuppression(DB, value);
    assert.equal((await ensureDemo(DB, "p1", AT)).ok, true, value);
  }
  // a domain kept in another case still matches (suppression values are lower-cased when stored)
  const DB = await seed({ research: { best_email: "dave@GREENLEAF.co.uk" } });
  await seedSuppression(DB, "@GreenLeaf.CO.UK", "domain");
  assert.deepEqual(await ensureDemo(DB, "p1", AT), NO("On the do-not-contact list"));
});

test("a prospect already 'emailed' (or later) is never changed", async () => {
  for (const stage of ["emailed", "viewed", "replied", "won", "lost"]) {
    const DB = await seed();
    await seedProspect(DB, { place_id: "p1", stage, email: "old@greenleaf.co.uk", greet_name: null, views: 2 });
    const before = prospectOf(DB);
    const r = await ensureDemo(DB, "p1", AT);
    assert.equal(r.ok, true, stage);
    assert.equal(r.created, true, stage);
    assert.deepEqual(prospectOf(DB), before, stage);
  }
});

test("re-graded to C after the demo exists: the demo and the ready prospect stay (the link may be out)", async () => {
  const DB = await seed();
  const { demo } = await ensureDemo(DB, "p1", AT);
  const before = prospectOf(DB);
  DB.raw.prepare("UPDATE research SET grade = 'C', best_email = 'sue@greenleaf.co.uk' WHERE place_id = 'p1'").run();
  assert.deepEqual(await ensureDemo(DB, "p1", AT), NO("Grade C: only A+, A and B get a demo"));
  assert.deepEqual({ ...one(DB, "SELECT * FROM demos") }, demo, "demo kept");
  assert.deepEqual(prospectOf(DB), before, "the ready prospect isn't touched by a lead that no longer qualifies");
  // and its new address on the do-not-contact list leaves the ready prospect's address alone too
  DB.raw.prepare("UPDATE research SET grade = 'A' WHERE place_id = 'p1'").run();
  await seedSuppression(DB, "sue@greenleaf.co.uk");
  assert.deepEqual(await ensureDemo(DB, "p1", AT), NO("On the do-not-contact list"));
  assert.deepEqual(prospectOf(DB), before);
});

test("two calls at once: no error, one prospect, and both then reuse the same latest demo", async () => {
  const DB = await seed();
  const [a, b] = await Promise.all([ensureDemo(DB, "p1", AT), ensureDemo(DB, "p1", AT)]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM prospects"), 1);
  assert.equal(prospectOf(DB).stage, "ready");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos"), 1, "the setup todo once");
  // the latest (created_at, then slug, as stage 3's shortlist picks it) is the one every later call uses
  const latest = one(DB, "SELECT slug FROM demos ORDER BY created_at DESC, slug DESC LIMIT 1").slug;
  assert.equal((await ensureDemo(DB, "p1", AT)).demo.slug, latest);
  assert.equal((await ensureDemo(DB, "p1", AT)).created, false);
});

test("a won prospect's demo never ends, so a client never gets a second one", async () => {
  const DB = await seed();
  await seedProspect(DB, { place_id: "p1", stage: "won", email: "dave@greenleaf.co.uk" });
  await seedDemo(DB, { place_id: "p1", slug: "green-leaf-landscapes-won234", expires_at: "2026-01-01T00:00:00Z" });
  const r = await ensureDemo(DB, "p1", AT);
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.demo.slug, "green-leaf-landscapes-won234");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 1);
  assert.equal((await demoBySlug(DB, r.demo.slug, AT)).expired, false, "the page agrees");
});

test("an expired demo gets a new slug; old millisecond times are read too", async () => {
  const DB = await seed();
  // made by the old system: 14 days, toISOString with milliseconds
  await seedDemo(DB, { place_id: "p1", slug: "green-leaf-landscapes-abc234", created_at: "2026-10-01T09:00:00Z", expires_at: "2026-10-15T09:00:00.000Z" });
  const r = await ensureDemo(DB, "p1", AT);
  assert.equal(r.created, true);
  assert.notEqual(r.demo.slug, "green-leaf-landscapes-abc234");
  assert.match(r.demo.slug, SLUG);
  assert.equal(r.demo.expires_at, "2027-04-19T10:00:00Z");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 2, "the old row stays (its link may be out)");
  // a live old-format demo is reused
  const live = await seed();
  await seedDemo(live, { place_id: "p1", slug: "green-leaf-landscapes-def567", created_at: "2026-10-20T09:00:00Z", expires_at: "2026-11-03T09:00:00.000Z" });
  const kept = await ensureDemo(live, "p1", AT);
  assert.equal(kept.created, false);
  assert.equal(kept.demo.slug, "green-leaf-landscapes-def567");
  assert.equal(kept.demo.expires_at, "2026-11-03T09:00:00.000Z");
  // the latest demo is the one judged: an older live one doesn't count once a newer one has ended
  const both = await seed();
  await seedDemo(both, { place_id: "p1", slug: "green-leaf-landscapes-old222", created_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" });
  await seedDemo(both, { place_id: "p1", slug: "green-leaf-landscapes-new333", created_at: "2026-05-01T00:00:00Z", expires_at: "2026-10-01T00:00:00Z" });
  const fresh = await ensureDemo(both, "p1", AT);
  assert.equal(fresh.created, true);
  assert.ok(!["green-leaf-landscapes-old222", "green-leaf-landscapes-new333"].includes(fresh.demo.slug));
});

test("an unapproved template adds the setup todo once", async () => {
  const DB = await seed();
  await ensureDemo(DB, "p1", AT);
  await ensureDemo(DB, "p1", AT);
  await seedLead(DB, { place_id: "p2", name: "Lawn Kings", trade: "Lawn care" });
  await seedResearch(DB, { place_id: "p2", grade: "B", best_email: "info@lawnkings.co.uk" });
  assert.equal((await ensureDemo(DB, "p2", AT)).ok, true);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM todos WHERE dedupe='setup:demo-template:landscaper:v1'").get().n, 1);
  const todo = one(DB, "SELECT * FROM todos WHERE dedupe = ?", LANDSCAPER_TODO);
  assert.equal(todo.kind, "setup");
  assert.equal(todo.title, "Approve the Landscaper look on the Demo page");
  assert.equal(todo.status, "open");
  assert.equal(todo.link, "/#/demo");
  assert.equal(todo.place_id, null, "one todo per look, not per lead");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos"), 1);
  // another trade: the "Everything else" look's own todo
  await seedLead(DB, { place_id: "p3", name: "Smith Roofing", trade: "roofer" });
  await seedResearch(DB, { place_id: "p3", grade: "A", best_email: "dave@smithroofing.co.uk" });
  assert.equal((await ensureDemo(DB, "p3", AT)).ok, true);
  assert.equal(one(DB, "SELECT title FROM todos WHERE dedupe = ?", GENERIC_TODO).title, "Approve the Everything else look on the Demo page");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos"), 2);
  // dismissed by Nik: never comes back
  DB.raw.prepare("UPDATE todos SET status = 'dismissed' WHERE dedupe = ?").run(GENERIC_TODO);
  await ensureDemo(DB, "p3", AT);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = ?", GENERIC_TODO), 1);
  assert.equal(one(DB, "SELECT status FROM todos WHERE dedupe = ?", GENERIC_TODO).status, "dismissed");
});

test("an approved look adds no todo; an approval of another version doesn't count", async () => {
  const approve = (DB, version) => DB.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo:template:landscaper:approved', ?)")
    .run(JSON.stringify({ version, at: "2026-10-20T09:00:00Z" }));
  const DB = await seed();
  approve(DB, 1);
  assert.equal((await ensureDemo(DB, "p1", AT)).ok, true);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos"), 0);
  // version 0 approved, the look is now version 1: Nik has to look again
  const old = await seed();
  approve(old, 0);
  await ensureDemo(old, "p1", AT);
  assert.equal(count(old, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = ? AND status = 'open'", LANDSCAPER_TODO), 1);
  // closed by the approval (Task 9 closes the setup:demo-template:landscaper: prefix): not added again once approved
  await closeTodos(old, "setup:demo-template:landscaper:");
  approve(old, 1);
  await ensureDemo(old, "p1", AT);
  assert.equal(count(old, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 0);
  // a setting that isn't readable JSON counts as not approved
  const broken = await seed();
  broken.raw.prepare("INSERT INTO settings (key, value) VALUES ('demo:template:landscaper:approved', 'yes')").run();
  await ensureDemo(broken, "p1", AT);
  assert.equal(count(broken, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = ?", LANDSCAPER_TODO), 1);
});

test("demoBySlug: bad slug → null; expired → expired:true; won → expired:false", async () => {
  const DB = await seed();
  const { demo } = await ensureDemo(DB, "p1", AT);
  for (const bad of ["", "ab", "../etc", "Green-Leaf", "a".repeat(61), null, undefined, 42, "x y z", "nope-123456"]) {
    assert.equal(await demoBySlug(DB, bad, AT), null, String(bad));
  }
  const found = await demoBySlug(DB, demo.slug, AT);
  assert.deepEqual(found.demo, demo);
  assert.equal(found.lead.place_id, "p1");
  assert.equal(found.lead.name, "Green Leaf Landscapes", "the raw leads row");
  assert.equal(found.lead.audit, "{}", "JSON columns as stored text, for buildDemoData");
  assert.equal(found.research.grade, "A");
  assert.equal(found.research.copy, JSON.stringify(COPY), "the raw research row");
  assert.equal(found.prospect.stage, "ready");
  assert.equal(found.expired, false);
  assert.equal(found.contact_email, "", "no mailbox on the thread yet");
  assert.deepEqual(Object.keys(found).sort(), ["contact_email", "demo", "expired", "lead", "prospect", "research"]);

  // ends at expires_at
  assert.equal((await demoBySlug(DB, demo.slug, new Date("2027-04-19T09:59:59Z"))).expired, false);
  assert.equal((await demoBySlug(DB, demo.slug, new Date("2027-04-19T10:00:00Z"))).expired, true);
  DB.raw.prepare("UPDATE demos SET expires_at = '2026-01-01T00:00:00Z'").run();
  assert.equal((await demoBySlug(DB, demo.slug, AT)).expired, true);
  // the thread's mailbox is the address on the expired page
  await seedMailbox(DB, { id: "m1", address: "nik@aetoswebsites.com" });
  DB.raw.prepare("UPDATE prospects SET mailbox_id = 'm1', stage = 'emailed'").run();
  assert.equal((await demoBySlug(DB, demo.slug, AT)).contact_email, "nik@aetoswebsites.com");
  // a client never sees "ended"
  DB.raw.prepare("UPDATE prospects SET stage = 'won'").run();
  const won = await demoBySlug(DB, demo.slug, AT);
  assert.equal(won.expired, false);
  assert.equal(won.prospect.stage, "won");
  // an old millisecond expiry reads the same way
  DB.raw.prepare("UPDATE demos SET expires_at = '2026-10-15T09:00:00.000Z'").run();
  DB.raw.prepare("UPDATE prospects SET stage = 'emailed'").run();
  assert.equal((await demoBySlug(DB, demo.slug, AT)).expired, true);
  assert.equal((await demoBySlug(DB, demo.slug, new Date("2026-10-15T08:59:59Z"))).expired, false);
});

test("demoBySlug: no prospect or research row → null fields; the lead deleted → null", async () => {
  const DB = await seed({ research: null });
  await seedDemo(DB, { place_id: "p1", slug: "green-leaf-landscapes-abc234", expires_at: "2027-01-01T00:00:00Z" });
  const found = await demoBySlug(DB, "green-leaf-landscapes-abc234", AT);
  assert.equal(found.research, null);
  assert.equal(found.prospect, null);
  assert.equal(found.contact_email, "");
  assert.equal(found.expired, false);
  // a re-scrape deleted the lead: the page can't be drawn, so it's not found (d/[slug]/order.js reads found.lead)
  DB.raw.prepare("DELETE FROM leads").run();
  assert.equal(await demoBySlug(DB, "green-leaf-landscapes-abc234", AT), null);
  // an unknown slug
  assert.equal(await demoBySlug(DB, "nobody-here-abc234", AT), null);
});

// ---------------------------------------------------------------- more

test("demoLink, DEMO_BASE and DEMO_DAYS", () => {
  assert.equal(DEMO_DAYS, 180);
  assert.equal(DEMO_BASE, "https://aetoswebsites.com");
  assert.equal(demoLink("green-leaf-landscapes-7k2p9q"), "https://aetoswebsites.com/d/green-leaf-landscapes-7k2p9q");
});

test("D1 budget: the common case is at most 4 statements, a reuse is 1", async () => {
  // the setup todo already there (another lead's demo added it): read, demo insert, applyStageEvent's read + insert
  const DB = await seed();
  await seedLead(DB, { place_id: "p0", name: "Lawn Kings", trade: "lawn care" });
  await seedResearch(DB, { place_id: "p0", grade: "A", best_email: "info@lawnkings.co.uk" });
  await ensureDemo(DB, "p0", AT);
  let c = countingDB(DB);
  assert.equal((await ensureDemo(c.DB, "p1", AT)).created, true);
  assert.ok(c.used() <= 4, `used ${c.used()}`);
  c = countingDB(DB);
  await ensureDemo(c.DB, "p1", AT);
  assert.equal(c.used(), 1, "a demo and prospect that are already right cost the one read");
  // a refusal is the one read
  c = countingDB(DB);
  await ensureDemo(c.DB, "nobody", AT);
  assert.equal(c.used(), 1);
  // the very first demo of a look adds its todo: 5
  const first = await seed();
  c = countingDB(first);
  await ensureDemo(c.DB, "p1", AT);
  assert.equal(c.used(), 5);
  // a ready prospect's better email: read + one UPDATE
  first.raw.prepare("UPDATE research SET best_email = 'sue@greenleaf.co.uk' WHERE place_id = 'p1'").run();
  c = countingDB(first);
  await ensureDemo(c.DB, "p1", AT);
  assert.equal(c.used(), 2);
  assert.equal(prospectOf(first).email, "sue@greenleaf.co.uk");
});

test("a slug clash retries once with a new slug", async () => {
  const DB = await seed();
  await seedLead(DB, { place_id: "other", name: "Someone Else" });
  await seedDemo(DB, { place_id: "other", slug: "green-leaf-landscapes-aaaaaa" });
  const random = Math.random;
  let calls = 0;
  Math.random = () => (calls++ < 6 ? 0 : 0.5); // the first slug's 6 characters are all "a", the retry's all "s"
  try {
    const r = await ensureDemo(DB, "p1", AT);
    assert.equal(r.created, true);
    assert.equal(r.demo.slug, "green-leaf-landscapes-ssssss");
    assert.equal(one(DB, "SELECT place_id FROM demos WHERE slug = 'green-leaf-landscapes-aaaaaa'").place_id, "other", "the other lead's demo untouched");
    // both taken: a plain error, nothing half-made
    await seedLead(DB, { place_id: "p9", name: "Green Leaf Landscapes", trade: "landscaper" });
    await seedResearch(DB, { place_id: "p9", grade: "A", best_email: "a@greenleaf.co.uk" });
    calls = 0;
    Math.random = () => (calls++ < 6 ? 0 : 0.5);
    await assert.rejects(ensureDemo(DB, "p9", AT), /couldn't make a demo link for this lead.*try again/i);
    assert.equal(prospectOf(DB, "p9"), undefined);
  } finally {
    Math.random = random;
  }
});

test("ensureDemo needs a real time", async () => {
  const DB = await seed();
  await assert.rejects(ensureDemo(DB, "p1", new Date("nope")), /time/i);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 0);
});

test("recordEvent: views count once per 30 minutes; unknown kinds and expired demos aren't stored", async () => {
  const DB = await seed();
  const at = new Date("2026-10-04T10:00:00Z");
  const demo = { slug: "green-leaf-landscapes-abc234", place_id: "p1", expires_at: "2026-10-18T10:00:00Z" };
  assert.equal(await recordEvent(DB, demo, "view", at), true);
  assert.equal(await recordEvent(DB, demo, "view", new Date(at.getTime() + 60000)), false);
  assert.equal(await recordEvent(DB, demo, "view", new Date(at.getTime() + 31 * 60000)), true);
  assert.equal(await recordEvent(DB, demo, "hack", at), false);
  assert.equal(await recordEvent(DB, demo, "order_page", at), true, "only views are de-duplicated");
  assert.equal(await recordEvent(DB, demo, "view", new Date("2026-10-20T10:00:00Z")), false, "expired");
  assert.equal(await recordEvent(DB, demo, "order_page", new Date("2026-10-18T10:00:00Z")), false, "ended at expires_at, as demoBySlug reads it");
  assert.equal(await recordEvent(DB, demo, "ordered", new Date("2026-10-20T10:00:00Z")), true, "an order counts even after");
  const rows = DB.raw.prepare("SELECT kind, at FROM demo_events ORDER BY rowid").all().map((r) => `${r.kind} ${r.at}`);
  assert.deepEqual(rows, ["view 2026-10-04T10:00:00Z", "view 2026-10-04T10:31:00Z", "order_page 2026-10-04T10:00:00Z",
    "ordered 2026-10-20T10:00:00Z"]);
});

// ---------------------------------------------------------------- Task 9: the look's approval gate and demoReady

const NOT_READY = (reason) => ({ ok: false, reason, url: null, slug: null });
const WAITING = "Waiting for you to approve the Landscaper look on the Demo page";
const EXPIRED = "Their demo has expired: a new one is being made";
const CHANGED = "This look changed since you opened the page. Refresh and check it again before approving.";
const APPROVAL_KEY = "demo:template:landscaper:approved";
const settingOf = (DB, key) => one(DB, "SELECT value FROM settings WHERE key = ?", key)?.value;

test("the gate: demoReady waits for Nik's OK of the look; approval of version 1 doesn't approve version 2; expiry", async () => {
  const DB = await seed();
  assert.deepEqual(await demoReady(DB, "nope"), { ok: false, reason: "No demo yet: Lead not found", url: null, slug: null });
  const { slug } = (await ensureDemo(DB, "p1", AT)).demo;
  const todoId = one(DB, "SELECT id FROM todos WHERE dedupe = ?", LANDSCAPER_TODO).id;
  assert.equal((await demoReady(DB, "p1", AT)).reason, "Waiting for you to approve the Landscaper look on the Demo page");
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(WAITING), "no link while it waits");
  await approveTemplate(DB, "landscaper", 1, AT);
  assert.deepEqual(await demoReady(DB, "p1", AT), { ok: true, reason: "", url: demoLink(slug), slug });
  // The spec reads the todo back by its dedupe ("SELECT status FROM todos WHERE dedupe='setup:demo-template:landscaper:v1'"),
  // but stage 0's closeTodos frees the dedupe of every todo it closes (dedupe || '@' || done_at), so it's read by id.
  const todo = one(DB, "SELECT status, dedupe FROM todos WHERE id = ?", todoId);
  assert.equal(todo.status, "done");
  assert.ok(todo.dedupe.startsWith(`${LANDSCAPER_TODO}@`), todo.dedupe);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 0);
  await assert.rejects(approveTemplate(DB, "landscaper", 0, AT), /This look changed/);
  // approval of version 1 doesn't approve version 2:
  DB.raw.prepare("UPDATE settings SET value='{\"version\":0,\"at\":\"x\"}' WHERE key='demo:template:landscaper:approved'").run();
  assert.equal((await templateApproval(DB, "landscaper")).approved, false);
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(WAITING));
  // expired demo:
  DB.raw.prepare("UPDATE demos SET expires_at='2026-01-01T00:00:00Z'").run();
  assert.equal((await demoReady(DB, "p1", AT)).reason, "Their demo has expired: a new one is being made");
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(EXPIRED));
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 1, "demoReady leaves replacing it to the hot step");
});

test("templateApproval: approved only when the stored version is the look's current one", async () => {
  const DB = fakeD1();
  assert.equal(TEMPLATES.landscaper.TEMPLATE.version, 1);
  assert.deepEqual(await templateApproval(DB, "landscaper"), { approved: false, version: null, at: null });
  await approveTemplate(DB, "landscaper", 1, AT);
  assert.equal(settingOf(DB, APPROVAL_KEY), '{"version":1,"at":"2026-10-21T10:00:00Z"}', "JSON text, util.now() time");
  assert.deepEqual(await templateApproval(DB, "landscaper"), { approved: true, version: 1, at: "2026-10-21T10:00:00Z" });
  assert.deepEqual(await templateApproval(DB, "generic"), { approved: false, version: null, at: null }, "one look's OK isn't the other's");
  // an older version's OK says which one (the Demo page's "This look changed since you approved version <n>.")
  DB.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify({ version: 0, at: "2026-09-01T09:00:00Z" }), APPROVAL_KEY);
  assert.deepEqual(await templateApproval(DB, "landscaper"), { approved: false, version: 0, at: "2026-09-01T09:00:00Z" });
  // an OK of any other version, older or newer, doesn't count either
  DB.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify({ version: 2, at: "2026-09-01T09:00:00Z" }), APPROVAL_KEY);
  assert.deepEqual(await templateApproval(DB, "landscaper"), { approved: false, version: 2, at: "2026-09-01T09:00:00Z" });
  // a setting that can't be read counts as not approved
  for (const bad of ["yes", "", "null", "1", "[1]", '{"version":"1","at":"x"}', '{"version":1.5}', '{"at":"2026-10-21T10:00:00Z"}']) {
    DB.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(bad, APPROVAL_KEY);
    assert.equal((await templateApproval(DB, "landscaper")).approved, false, bad);
  }
  // ensureDemo reads the same rule: the version-1 setting stops its todo
  const other = await seed();
  await approveTemplate(other, "landscaper", 1, AT);
  await ensureDemo(other, "p1", AT);
  assert.equal(count(other, "SELECT COUNT(*) AS n FROM todos"), 0);
});

test("approveTemplate: a changed look is refused and nothing is written; it closes that look's todos only", async () => {
  const DB = await seed();
  await ensureDemo(DB, "p1", AT); // the landscaper look's v1 todo
  await seedLead(DB, { place_id: "p3", name: "Smith Roofing", trade: "roofer" });
  await seedResearch(DB, { place_id: "p3", grade: "A", best_email: "dave@smithroofing.co.uk" });
  await ensureDemo(DB, "p3", AT); // the generic look's v1 todo
  // an older version's todo still open, and a stage 0 setup todo
  await addTodo(DB, { kind: "setup", title: "Approve the Landscaper look on the Demo page", dedupe: "setup:demo-template:landscaper:v0" });
  await addTodo(DB, { kind: "setup", title: "Add your mailbox password", dedupe: "setup:first_mailbox" });
  for (const version of [0, 2, "1", null, undefined, 1.5, true]) {
    await assert.rejects(approveTemplate(DB, "landscaper", version, AT), (e) => e.message === CHANGED, String(version));
  }
  assert.equal(settingOf(DB, APPROVAL_KEY), undefined, "nothing stored");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 4, "nothing closed");

  const c = countingDB(DB);
  await approveTemplate(c.DB, "landscaper", 1, AT);
  assert.equal(c.used(), 2, "the setting and one close");
  const open = DB.raw.prepare("SELECT dedupe FROM todos WHERE status = 'open' ORDER BY dedupe").all().map((r) => r.dedupe);
  assert.deepEqual(open, [GENERIC_TODO, "setup:first_mailbox"], "every version of this look's todo closed, nothing else");

  // approved: another landscaper lead's demo asks for nothing more and is ready at once
  await seedLead(DB, { place_id: "p2", name: "Lawn Kings", trade: "Lawn care" });
  await seedResearch(DB, { place_id: "p2", grade: "B", best_email: "info@lawnkings.co.uk" });
  const r = await ensureDemo(DB, "p2", AT);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open' AND dedupe LIKE 'setup:demo-template:landscaper:%'"), 0);
  assert.deepEqual(await demoReady(DB, "p2", AT), { ok: true, reason: "", url: demoLink(r.demo.slug), slug: r.demo.slug });
  // the other look still waits, in its own words
  assert.deepEqual(await demoReady(DB, "p3", AT), NOT_READY("Waiting for you to approve the Everything else look on the Demo page"));
  // approving again is fine: only the time moves on
  await approveTemplate(DB, "landscaper", 1, new Date("2026-10-22T08:00:00Z"));
  assert.deepEqual(await templateApproval(DB, "landscaper"), { approved: true, version: 1, at: "2026-10-22T08:00:00Z" });
  // the generic look approved by its own version
  await approveTemplate(DB, "generic", TEMPLATES.generic.TEMPLATE.version, AT);
  assert.equal((await demoReady(DB, "p3", AT)).ok, true);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 1, "only stage 0's own todo is left");
});

test("approveTemplate needs a real time; an unknown look is refused before anything is read or written", async () => {
  const DB = fakeD1();
  await assert.rejects(approveTemplate(DB, "landscaper", 1, new Date("nope")), /time/i);
  assert.equal((await templateApproval(DB, "landscaper")).approved, false);
  for (const id of ["", "nope", "Landscaper", "constructor", "__proto__", "toString", "landscaper:v1", null, undefined, 42]) {
    const c = countingDB(DB);
    await assert.rejects(templateApproval(c.DB, id), /^Error: That look doesn't exist\. The looks are: generic, landscaper\.$/, String(id));
    await assert.rejects(approveTemplate(c.DB, id, 1, AT), /That look doesn't exist/, String(id));
    assert.equal(c.used(), 0, String(id));
  }
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'demo:%'"), 0);
});

test("demoReady: every reason a lead has no demo, word for word, after 'No demo yet: '; nothing is made", async () => {
  const cases = [[{ research: { grade: "C" } }, "Grade C: only A+, A and B get a demo"],
    [{ research: { best_email: null } }, "No email found"], [{ research: { grade: "D", too_big: 1 } }, "Too big for us"],
    [{ research: { status: "queued", grade: null } }, "Not researched yet"], [{ research: null }, "Not researched yet"],
    [{ research: { status: "skipped", grade: null } }, "Taken off the list (the research card says why)"],
    [{ research: { status: "skipped", grade: "A" } }, "Taken off the list (the research card says why)"],
    [{ lead: { excluded: 1, exclude_reason: "Chain / national brand" }, research: { status: "skipped" } }, "Excluded: Chain / national brand"],
    [{ lead: { excluded: 1, exclude_reason: "Chain / national brand" } }, "Excluded: Chain / national brand"],
    [{ lead: null, research: null }, "Lead not found"]];
  for (const [setup, reason] of cases) {
    const DB = await seed(setup);
    await approveTemplate(DB, "landscaper", 1, AT);
    assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(`No demo yet: ${reason}`), reason);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 0, reason);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM prospects"), 0, reason);
  }
  const suppressed = await seed();
  await seedSuppression(suppressed, "greenleaf.co.uk", "domain");
  assert.deepEqual(await demoReady(suppressed, "p1", AT), NOT_READY("No demo yet: On the do-not-contact list"));
});

test("demoReady: a live demo stays ready when the lead stops qualifying (the link may be out); without one the reason shows", async () => {
  // Part A edge case "Re-graded to C after the demo exists: Demo stays (link may already be out)". Stage 6 holds
  // follow-ups while demoReady isn't ok, with a todo saying their demo isn't available: that would be untrue here.
  const DB = await seed();
  await approveTemplate(DB, "landscaper", 1, AT);
  const { demo } = await ensureDemo(DB, "p1", AT);
  const ok = { ok: true, reason: "", url: demoLink(demo.slug), slug: demo.slug };
  DB.raw.prepare("UPDATE prospects SET stage = 'emailed'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), ok);
  DB.raw.prepare("UPDATE research SET grade = 'C'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), ok, "re-graded to C: the demo stays");
  DB.raw.prepare("UPDATE leads SET excluded = 1, exclude_reason = 'Too far away'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), ok, "excluded later: the demo stays");
  await seedSuppression(DB, "dave@greenleaf.co.uk", "email");
  assert.deepEqual(await demoReady(DB, "p1", AT), ok, "opted out: the demo stays (stage 0's outbox refuses the address)");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 1);
  // once it has ended, nothing replaces it for a lead that no longer qualifies: Part A §1's reason, never "a new one is
  // being made" (the hot step's safety net makes demos only for leads that qualify)
  DB.raw.prepare("UPDATE demos SET expires_at = '2026-01-01T00:00:00Z'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY("No demo yet: Excluded: Too far away"));
  DB.raw.prepare("UPDATE leads SET excluded = 0").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY("No demo yet: Grade C: only A+, A and B get a demo"));
  DB.raw.prepare("UPDATE research SET grade = 'A'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY("No demo yet: On the do-not-contact list"));
  DB.raw.prepare("DELETE FROM suppression").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(EXPIRED), "qualifies again: the hot step makes a new one");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 1, "demoReady never replaces it itself");
  assert.equal(prospectOf(DB).stage, "emailed", "and the prospect untouched");
});

test("demoReady: a `ready` prospect (nothing sent yet) is judged on Part A §1 first, even with a live demo", async () => {
  // stage 5/6's first-email gate (demo_not_ready) relies on this answer for grade, too-big and excluded
  const DB = await seed();
  await approveTemplate(DB, "landscaper", 1, AT);
  const { demo } = await ensureDemo(DB, "p1", AT);
  const ok = { ok: true, reason: "", url: demoLink(demo.slug), slug: demo.slug };
  assert.deepEqual(await demoReady(DB, "p1", AT), ok);
  const demos = () => DB.raw.prepare("SELECT * FROM demos").all().map((r) => ({ ...r }));
  const before = { demos: demos(), prospect: { ...prospectOf(DB) } };
  for (const [change, restore, reason] of [
    ["UPDATE research SET grade = 'C'", "UPDATE research SET grade = 'A'", "No demo yet: Grade C: only A+, A and B get a demo"],
    ["UPDATE research SET too_big = 1", "UPDATE research SET too_big = 0", "No demo yet: Too big for us"],
    ["UPDATE leads SET excluded = 1, exclude_reason = 'Multiple branches (chain)'", "UPDATE leads SET excluded = 0, exclude_reason = NULL",
      "No demo yet: Excluded: Multiple branches (chain)"],
    ["UPDATE research SET status = 'queued'", "UPDATE research SET status = 'done'", "No demo yet: Not researched yet"],
  ]) {
    DB.raw.prepare(change).run();
    assert.equal(prospectOf(DB).stage, "ready", change);
    assert.deepEqual(await demoReady(DB, "p1", AT), { ok: false, reason, url: null, slug: null }, change);
    assert.deepEqual(demos(), before.demos, `${change}: the demo stays`);
    assert.deepEqual({ ...prospectOf(DB) }, before.prospect, `${change}: the prospect stays`);
    DB.raw.prepare(restore).run();
    assert.deepEqual(await demoReady(DB, "p1", AT), ok, `${change} undone`);
  }
});

test("demoReady after Nik's Not a fit: no demo for the email, and nothing is made again", async () => {
  // stage 3's markNotFit skips the research and deletes the ready prospect; the demo row stays
  const DB = await seed();
  await approveTemplate(DB, "landscaper", 1, AT);
  const { demo } = await ensureDemo(DB, "p1", AT);
  assert.equal((await demoReady(DB, "p1", AT)).ok, true);
  assert.deepEqual(await markNotFit(DB, "p1", "Only does commercial work", AT), { ok: true });
  assert.equal(prospectOf(DB), undefined);
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY("No demo yet: Taken off the list (the research card says why)"));
  assert.equal(prospectOf(DB), undefined, "the prospect isn't made again");
  assert.deepEqual(DB.raw.prepare("SELECT * FROM demos").all().map((r) => ({ ...r })), [demo], "no new demo either");
});

test("demoReady: expiry as the page reads it; old millisecond times; a won prospect's demo never ends; the latest demo", async () => {
  const DB = await seed();
  await approveTemplate(DB, "landscaper", 1, AT);
  const { demo } = await ensureDemo(DB, "p1", AT);
  const ok = { ok: true, reason: "", url: demoLink(demo.slug), slug: demo.slug };
  assert.deepEqual(await demoReady(DB, "p1", new Date("2027-04-19T09:59:59Z")), ok);
  assert.deepEqual(await demoReady(DB, "p1", new Date("2027-04-19T10:00:00Z")), NOT_READY(EXPIRED), "ends at expires_at");
  DB.raw.prepare("UPDATE demos SET expires_at = '2026-10-21T10:00:00.000Z'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(EXPIRED));
  assert.deepEqual(await demoReady(DB, "p1", new Date("2026-10-21T09:59:59Z")), ok);
  DB.raw.prepare("UPDATE demos SET expires_at = 'not a time'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), NOT_READY(EXPIRED), "an unreadable expiry counts as ended");
  DB.raw.prepare("UPDATE prospects SET stage = 'won'").run();
  assert.deepEqual(await demoReady(DB, "p1", AT), ok, "a client never sees ended");
  // ISO text works as the time too
  assert.deepEqual(await demoReady(DB, "p1", "2026-10-21T10:00:00Z"), ok);

  // the latest demo (newest created_at) is the one judged, as ensureDemo and the shortlist pick it
  const both = await seed();
  await approveTemplate(both, "landscaper", 1, AT);
  await seedProspect(both, { place_id: "p1", stage: "emailed", email: "dave@greenleaf.co.uk" });
  await seedDemo(both, { place_id: "p1", slug: "green-leaf-landscapes-old222", created_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" });
  await seedDemo(both, { place_id: "p1", slug: "green-leaf-landscapes-new333", created_at: "2026-05-01T00:00:00Z", expires_at: "2026-10-01T00:00:00Z" });
  assert.deepEqual(await demoReady(both, "p1", AT), NOT_READY(EXPIRED));
  both.raw.prepare("UPDATE demos SET expires_at = '2027-02-01T00:00:00Z' WHERE slug = 'green-leaf-landscapes-new333'").run();
  assert.deepEqual(await demoReady(both, "p1", AT),
    { ok: true, reason: "", url: "https://aetoswebsites.com/d/green-leaf-landscapes-new333", slug: "green-leaf-landscapes-new333" });
  assert.equal(count(both, "SELECT COUNT(*) AS n FROM demos"), 2);
});

test("demoReady: a lead that qualifies but missed its demo or its prospect gets them now", async () => {
  // research graded it before this stage shipped: no demo, no prospect
  const DB = await seed();
  await approveTemplate(DB, "landscaper", 1, AT);
  const r = await demoReady(DB, "p1", AT);
  const made = one(DB, "SELECT * FROM demos");
  assert.match(made.slug, SLUG);
  assert.deepEqual(r, { ok: true, reason: "", url: demoLink(made.slug), slug: made.slug });
  assert.equal(made.expires_at, "2027-04-19T10:00:00Z");
  assert.equal(prospectOf(DB).stage, "ready");
  assert.equal(prospectOf(DB).email, "dave@greenleaf.co.uk");
  // a live demo from the old system (no prospect): the demo is kept, the prospect made, and the look still waits
  const old = await seed();
  await seedDemo(old, { place_id: "p1", slug: "green-leaf-landscapes-abc234", created_at: "2026-10-20T09:00:00Z", expires_at: "2026-11-03T09:00:00.000Z" });
  assert.deepEqual(await demoReady(old, "p1", AT), NOT_READY(WAITING));
  assert.equal(count(old, "SELECT COUNT(*) AS n FROM demos"), 1);
  assert.equal(prospectOf(old).stage, "ready");
  assert.equal(count(old, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = ?", LANDSCAPER_TODO), 1, "and Nik is asked to approve it");
});

test("D1 budget: demoReady is one read, templateApproval one, approveTemplate two", async () => {
  const DB = await seed();
  await ensureDemo(DB, "p1", AT);
  for (const [run, n] of [[(D) => demoReady(D, "p1", AT), 1], [(D) => demoReady(D, "nobody", AT), 1],
    [(D) => templateApproval(D, "landscaper"), 1], [(D) => approveTemplate(D, "landscaper", 1, AT), 2],
    [(D) => demoReady(D, "p1", AT), 1]]) {
    const c = countingDB(DB);
    await run(c.DB);
    assert.equal(c.used(), n, String(run));
  }
  assert.equal((await demoReady(DB, "p1", AT)).ok, true);
  // a bad time is refused before any query
  const c = countingDB(DB);
  await assert.rejects(demoReady(c.DB, "p1", new Date("nope")), /time/i);
  assert.equal(c.used(), 0);
});

// ---------------------------------------------------------------- latestDemo: the one rule for a lead's current demo

test("latestDemo: a lead with several demos rows; the current one is the newest (created_at, then slug), never filtered", async () => {
  // A lead can have several demos rows: the old system's, and a new one made when its demo ended before any email.
  // Stage 7's inbox (and anything else reading a lead's demo) uses this rule, never a join on place_id.
  const DB = await seed();
  assert.equal(await latestDemo(DB, "p1"), null, "no demo yet");
  assert.equal(await latestDemo(DB, "nobody"), null);
  assert.equal(await latestDemo(DB, undefined), null);
  const OLD = { slug: "green-leaf-landscapes-abc234", place_id: "p1", created_at: "2026-10-01T09:00:00Z", expires_at: "2026-10-15T09:00:00.000Z" };
  await seedDemo(DB, OLD);
  assert.deepEqual(await latestDemo(DB, "p1"), OLD, "an ended demo is still the lead's latest: no expiry filter");

  // its demo ended before any email: ensureDemo makes a second row, which is now the latest
  const made = await ensureDemo(DB, "p1", AT);
  assert.equal(made.created, true);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos WHERE place_id = 'p1'"), 2);
  const c = countingDB(DB);
  const latest = await latestDemo(c.DB, "p1");
  assert.equal(c.used(), 1, "one read");
  assert.deepEqual(latest, made.demo);
  assert.deepEqual(Object.keys(latest).sort(), ["created_at", "expires_at", "place_id", "slug"]);
  // ...the one ensureDemo reuses and demoReady judges
  assert.equal((await ensureDemo(DB, "p1", AT)).demo.slug, latest.slug);
  await approveTemplate(DB, "landscaper", 1, AT);
  assert.equal((await demoReady(DB, "p1", AT)).slug, latest.slug);
  // ...and the one syncDemoExpiry extends (the old row keeps its end date)
  DB.raw.prepare("UPDATE prospects SET stage = 'emailed'").run();
  await seedMessage(DB, { place_id: "p1", status: "sent", sent_at: "2026-11-01T08:00:00Z" });
  assert.equal(await syncDemoExpiry(DB), 1);
  assert.equal((await latestDemo(DB, "p1")).expires_at, "2027-04-30T08:00:00Z");
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE slug = ?", OLD.slug).expires_at, OLD.expires_at);

  // the same created_at: the higher slug wins, ended or not (an older live demo never counts)
  const tie = await seed();
  await seedDemo(tie, { place_id: "p1", slug: "green-leaf-landscapes-mmm555", created_at: "2026-01-01T00:00:00Z", expires_at: "2027-06-01T00:00:00Z" });
  await seedDemo(tie, { place_id: "p1", slug: "green-leaf-landscapes-aaa222", created_at: "2026-05-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" });
  await seedDemo(tie, { place_id: "p1", slug: "green-leaf-landscapes-zzz999", created_at: "2026-05-01T00:00:00Z", expires_at: "2026-06-01T00:00:00Z" });
  await seedDemo(tie, { place_id: "p2", slug: "someone-else-zzzzzz", created_at: "2026-09-01T00:00:00Z", expires_at: "2027-06-01T00:00:00Z" });
  assert.equal((await latestDemo(tie, "p1")).slug, "green-leaf-landscapes-zzz999");
  await seedProspect(tie, { place_id: "p1", stage: "emailed", email: "dave@greenleaf.co.uk" });
  await approveTemplate(tie, "landscaper", 1, AT);
  assert.deepEqual(await demoReady(tie, "p1", AT), NOT_READY(EXPIRED), "demoReady judges the same row");
  // it only reads
  assert.equal(count(tie, "SELECT COUNT(*) AS n FROM demos"), 4);
  assert.equal(one(tie, "SELECT expires_at FROM demos WHERE slug = 'green-leaf-landscapes-zzz999'").expires_at, "2026-06-01T00:00:00Z");
});
