// AI lead research merge. Run: node --test control-room/tests/research.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { cleanResearch, mergeResearch } from "../functions/_lib/research.js";

test("every email and the owner's name need a source URL", () => {
  assert.match(cleanResearch({ emails: [{ email: "dave@smithroofing.co.uk" }] }).error, /source_url/);
  assert.match(cleanResearch({ owner: { first: "Dave" } }).error, /source_url/);
  const { clean } = cleanResearch({ emails: [{ email: "Dave@SmithRoofing.co.uk", source_url: "https://facebook.com/smithroofing", where: "Facebook About" },
    { email: "info@example.com", source_url: "https://x.com" }, { email: "not an email", source_url: "https://x.com" }] });
  assert.deepEqual(clean.emails.map((e) => e.email), ["dave@smithroofing.co.uk"]);
});

test("found emails fill an empty or guessed email; a weaker owner name gets replaced", () => {
  const lead = { place_id: "p", email: "info@smith.co.uk", emails: ["info@smith.co.uk"], socials: { facebook: "https://fb.com/a" },
    website: "https://smith.co.uk", director_first_name: "Smith", director_name: "Smith", audit: { email_source: "guessed", owner_source: "business name" } };
  const { clean } = cleanResearch({
    emails: [{ email: "dave@gmail.com", source_url: "https://facebook.com/x" }, { email: "dave@smith.co.uk", source_url: "https://smith.co.uk/about" }],
    owner: { first: "Dave", full: "Dave Smith", source_url: "https://smith.co.uk/about" },
    socials: { instagram: "https://instagram.com/smith" },
    review: { verdict: "Looks dated", summary: "Old layout, hard to use on a phone.", problems: ["No reviews shown"], good: ["Clear phone number"] },
  });
  const m = mergeResearch(lead, clean, "2026-10-04T00:00:00Z");
  assert.equal(m.email, "dave@smith.co.uk"); // own domain first, replaces the guess
  assert.deepEqual(m.emails.slice(0, 2), ["dave@smith.co.uk", "dave@gmail.com"]);
  assert.equal(m.audit.email_source, "ai");
  assert.equal(m.director_name, "Dave Smith");
  assert.equal(m.audit.owner_source, "AI research");
  assert.equal(m.socials.instagram, "https://instagram.com/smith");
  assert.equal(m.audit.ai_research.review.verdict, "Looks dated");
});

test("a real email from the website and a website-found owner are kept", () => {
  const lead = { email: "office@smith.co.uk", emails: ["office@smith.co.uk"], director_first_name: "Rachel", director_name: "Rachel Smith",
    audit: { email_source: "website", owner_source: "website", owner_confident: true } };
  const m = mergeResearch(lead, cleanResearch({ emails: [{ email: "dave@smith.co.uk", source_url: "https://x.co.uk" }],
    owner: { first: "Dave", source_url: "https://x.co.uk" } }).clean);
  assert.equal(m.email, "office@smith.co.uk");
  assert.equal(m.director_name, "Rachel Smith");
  assert.ok(m.emails.includes("dave@smith.co.uk"));
});

test("Claude picks the decision maker's email, rates the website, drops false alarms, excludes big firms", () => {
  const lead = { email: "enquiries@eddiestobart.com", emails: ["enquiries@eddiestobart.com", "jack.quayle@eddiestobart.com"],
    website: "https://eddiestobart.com", quality_score: 50, issues: ["Not mobile-friendly", "No contact form"],
    audit: { email_source: "website", score: { total: 50, website: 20, seo: 18, maps: 12 }, ai_needs: ["size", "best", "review"] } };
  const { clean } = cleanResearch({ best_email: "Jack.Quayle@eddiestobart.com", best_email_why: "Managing director",
    website_score: 6, score_reason: "Modern, fast site", wrong_findings: ["Not mobile-friendly"],
    too_big: true, too_big_reason: "National logistics firm, 200+ depots" });
  const m = mergeResearch(lead, clean);
  assert.equal(m.email, "jack.quayle@eddiestobart.com");
  assert.equal(m.emails[0], "jack.quayle@eddiestobart.com");
  assert.equal(m.audit.email_choice, "ai");
  assert.equal(m.audit.email_source, "website"); // it was on their site, Claude only chose it
  assert.equal(m.quality_score, 36); // 6 (Claude) + 18 + 12
  assert.equal(m.audit.score.website_by, "claude");
  assert.deepEqual(m.issues, ["No contact form"]);
  assert.equal(m.excluded, 1);
  assert.match(m.exclude_reason, /National logistics/);
  assert.deepEqual(m.audit.ai_needs, []);
});

test("a best email Claude didn't actually find is ignored; a silly score is refused", () => {
  const lead = { email: "info@smith.co.uk", emails: ["info@smith.co.uk"], audit: {} };
  const m = mergeResearch(lead, cleanResearch({ best_email: "dave@smith.co.uk" }).clean);
  assert.equal(m.email, "info@smith.co.uk");
  assert.match(cleanResearch({ website_score: 80 }).error, /0 to 45/);
});

test("Claude replaces a guessed owner, or clears one it can see is wrong", () => {
  const lead = { director_first_name: "Diamond", director_name: "Diamond Kickboxing", audit: { owner_source: "business name" } };
  const fixed = mergeResearch(lead, cleanResearch({ owner: { first: "Mark", full: "Mark Matthews", source_url: "https://facebook.com/diamondkickboxing" } }).clean);
  assert.equal(fixed.director_name, "Mark Matthews");
  assert.equal(fixed.audit.owner_confident, true);
  const cleared = mergeResearch(lead, cleanResearch({ owner_wrong: true }).clean);
  assert.equal(cleared.director_first_name, "");
  assert.equal(cleared.audit.owner_confident, false);
});
