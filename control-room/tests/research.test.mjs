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
    audit: { email_source: "website", owner_source: "website" } };
  const m = mergeResearch(lead, cleanResearch({ emails: [{ email: "dave@smith.co.uk", source_url: "https://x.co.uk" }],
    owner: { first: "Dave", source_url: "https://x.co.uk" } }).clean);
  assert.equal(m.email, "office@smith.co.uk");
  assert.equal(m.director_name, "Rachel Smith");
  assert.ok(m.emails.includes("dave@smith.co.uk"));
});
