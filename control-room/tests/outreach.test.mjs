// Outreach engine. Run: node --test control-room/tests/outreach.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { seeded } from "../functions/_lib/bandit.js";
import { chooseVersion, cleanBusiness, decide, eligibility, facts, gate, render, versionStats, withChances } from "../functions/_lib/outreach.js";
import { SEED_FOLLOWUPS, SEED_TEST } from "../functions/_lib/outreach-seed.js";

const LEAD = {
  place_id: "p1", name: "SMITH ROOFING LTD - Roofer in Leeds", town: "LEEDS", trade: "roofer", director_first_name: "DAVID",
  email: "info@smithroofing.co.uk", company_number: "123", status: "new", rating: 4.7, review_count: 23,
  findings: ["not_mobile", "maps_rarely_found"], map_rank: { top3_pct: 8 },
  audit: { email_source: "website", owner_source: "website", owner_confident: true, company: { type: "ltd", match_basis: "postcode" } },
};
const F = facts(LEAD, { competitor: { name: "Apex Roofing Ltd", top3_pct: 76 }, spots: 25, sender: { first: "Nik" } });

test("facts are cleaned up and only true", () => {
  assert.equal(F.business, "Smith Roofing");
  assert.equal(F.town, "Leeds");
  assert.equal(F.greeting, "Hi David,");
  // a guessed name is never used ("Hi Diamond,")
  assert.equal(facts({ ...LEAD, director_first_name: "Diamond", audit: { owner_source: "business name" } }).greeting, "Hi,");
  assert.equal(F.competitor, "Apex Roofing");
  assert.match(F.problem, /only showed up in a few spots/);
  // a competitor who isn't ahead of them isn't a "leader"
  assert.equal(facts(LEAD, { competitor: { name: "X", top3_pct: 5 } }).competitor, undefined);
  assert.equal(cleanBusiness("Jones & Sons Plumbing Limited"), "Jones & Sons Plumbing");
  assert.equal(cleanBusiness("ACE LOCKSMITHS | 24/7 Emergency"), "Ace Locksmiths");
});

test("every starting version passes the quality gate, as a template and rendered", () => {
  for (const v of SEED_TEST) {
    assert.deepEqual(gate(v, 1), [], v.name);
    const r = render(v, F);
    assert.ok(r, v.name);
    assert.deepEqual(gate(r, 1, { rendered: true, lead: F }), [], v.name);
  }
  for (const v of SEED_FOLLOWUPS) {
    assert.deepEqual(gate(v, v.step), [], v.name);
    assert.deepEqual(gate(render(v, F), v.step, { rendered: true }), [], v.name);
  }
});

test("a version is skipped for a lead without the facts it needs", () => {
  const noMaps = facts({ ...LEAD, map_rank: {} }, { sender: { first: "Nik" } });
  assert.equal(render(SEED_TEST[0], noMaps), null);
  assert.ok(render(SEED_TEST[1], noMaps));
});

test("the gate blocks what the playbook forbids", () => {
  const g = (body, subject = "website for you", step = 1, opts = {}) => gate({ subject, body }, step, opts).join(" | ");
  assert.match(g("{greeting}\n\nYour SEO needs work in {town}. Interested?"), /SEO/);
  assert.match(g("{greeting}\n\nYour outdated site in {town} could be better. Want help?"), /insult/);
  assert.match(g("{greeting}\n\nSee https://aetoswebsites.com for {business}. Want it?"), /links/);
  assert.match(g("{greeting}\n\nWebsites for {business} from £1,950. Want one?"), /prices/);
  assert.match(g("{greeting}\n\nA free audit for {business}. Want it?"), /free/);
  assert.match(g("{greeting}\n\nIs {business} busy? Want more calls?"), /one question/);
  assert.match(g("{greeting}\n\nI hope this email finds you well at {business}. Want help?"), /robotic/);
  assert.match(g("{greeting}\n\nI've mocked up a site for {business}. Want it?"), /not done yet/);
  assert.match(g("{greeting}\n\nHi {business}.", "Re: your website"), /fake/);
  assert.match(g(`{greeting}\n\n${"word ".repeat(95)}`), /Too long/);
  assert.match(g("{greeting}\n\nWe {nonsense} for {business}."), /Unknown placeholder/);
  assert.match(gate({ subject: "Hi", body: "Hi,\n\nSMITH ROOFING LTD LTD rocks.\n\nNik" }, 1, { rendered: true, lead: F }).join("|"), /Ltd Ltd/);
  assert.match(gate({ subject: "Hi", body: "Hi,\n\nNice weather today.\n\nWant a chat?" }, 1, { rendered: true, lead: F }).join("|"), /lead-specific/);
});

test("every lead with an email gets emailed, unless opted out, already contacted, or a too-early guess", () => {
  assert.equal(eligibility(LEAD).ok, true);
  assert.equal(eligibility({ ...LEAD, company_number: null, audit: { email_source: "website" } }).ok, true); // sole traders too
  assert.equal(eligibility({ ...LEAD, email: "dave.smith@gmail.com" }).ok, true);
  const no = (patch, ctx = {}) => eligibility({ ...LEAD, ...patch }, ctx).reason;
  assert.match(no({ email: "" }), /No email/);
  assert.match(no({ audit: { email_source: "guessed" } }), /Guessed/);
  assert.equal(eligibility({ ...LEAD, audit: { email_source: "guessed" } }, { guessedAllowed: true }).ok, true);
  assert.match(no({}, { suppressed: new Set(["smithroofing.co.uk"]) }), /Opted out/);
  assert.match(no({}, { suppressed: new Set(["123"]) }), /Opted out/);
  assert.match(no({}, { contacted: new Set(["p1"]) }), /sequence/);
  assert.match(no({ status: "contacted" }), /Already contacted/);
});

const DAY = 86400000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

test("emails count after 10 days, or straight away once a positive reply arrives within 10 days", () => {
  const versions = [{ id: "a", status: "live" }, { id: "b", status: "live" }];
  const sends = [
    { version_id: "a", place_id: "1", sent_at: iso(12) }, // matured, no reply
    { version_id: "a", place_id: "2", sent_at: iso(3) },  // too young, not counted
    { version_id: "a", place_id: "3", sent_at: iso(2) },  // young but replied positively → counted
    { version_id: "b", place_id: "4", sent_at: iso(30) }, // replied positively, but after 10 days → no credit
  ];
  const replies = [
    { place_id: "3", received_at: iso(1), cls: "interested" },
    { place_id: "4", received_at: iso(5), cls: "question" },
  ];
  const [a, b] = versionStats(versions, sends, replies, NOW);
  assert.deepEqual([a.sends, a.counted, a.positive], [3, 2, 1]);
  assert.deepEqual([b.sends, b.counted, b.positive], [1, 1, 0]);
  assert.equal(a.alpha, 2);
  assert.equal(a.beta, 50);
});

const arm = (id, counted, positive, extra = {}) => ({ id, status: "live", sends: counted, counted, positive, negative: 0, complaints: 0, alpha: 1 + positive, beta: 49 + counted - positive, mean: (1 + positive) / (50 + counted), pbest: null, ...extra });

test("new versions get a fair share; once known, the better one gets most leads", () => {
  const rng = seeded(7);
  const young = [arm("a", 20, 1), arm("b", 10, 0)];
  const picks = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i++) picks[chooseVersion(young, rng)]++;
  assert.ok(picks.b > 800 && picks.a > 800, JSON.stringify(picks)); // both under 150: split evenly
  const known = [arm("a", 400, 20), arm("b", 400, 6)];
  const later = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i++) later[chooseVersion(known, rng)]++;
  assert.ok(later.a > 1800, JSON.stringify(later));
});

test("decisions: guardrail pause, early retire, end at 250 each or after 8 weeks", () => {
  const t = { id: "t", started_at: iso(20) };
  const noisy = decide(t, withChances([arm("a", 80, 2, { sends: 80, negative: 5 }), arm("b", 80, 2)], seeded(1)), NOW);
  assert.deepEqual(noisy.map((x) => [x.type, x.id]), [["pause", "a"]]);
  const complaint = decide(t, withChances([arm("a", 5, 0, { complaints: 1 }), arm("b", 5, 0)], seeded(1)), NOW);
  assert.equal(complaint[0].type, "pause");

  const early = decide(t, withChances([arm("a", 260, 1), arm("b", 260, 18), arm("c", 120, 3)], seeded(1)), NOW);
  assert.deepEqual(early.map((x) => [x.type, x.id]), [["retire", "a"]]);

  const done = decide(t, withChances([arm("a", 260, 4), arm("b", 255, 12)], seeded(1)), NOW);
  assert.deepEqual(done.at(-1), { type: "end", keep: "b", reason: done.at(-1).reason });
  const close = decide(t, withChances([arm("a", 260, 7), arm("b", 255, 8)], seeded(1)), NOW);
  assert.deepEqual(close.map((x) => [x.type, x.keep]), [["end", "b"]]); // close call: no early retire, just keep the better

  const old = decide({ id: "t", started_at: iso(60) }, withChances([arm("a", 90, 3), arm("b", 80, 1)], seeded(1)), NOW);
  assert.equal(old.at(-1).type, "end");
  assert.equal(old.at(-1).keep, "a");

  // a lone champion waiting for a challenger isn't a test that can end
  assert.deepEqual(decide(t, withChances([arm("a", 300, 9)], seeded(1)), NOW), []);
  // equal versions early on: nothing happens
  assert.deepEqual(decide(t, withChances([arm("a", 100, 2), arm("b", 100, 2)], seeded(1)), NOW), []);
});
