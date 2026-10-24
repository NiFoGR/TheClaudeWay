// Call script per lead (stage 3, docs/rebuild/04-shortlist.md Task 7): prices and the weekend deal from stage 0's
// offerFor (as GET /api/leads/:id sends it, in pence), the guarantee in its exact words (GUARANTEE), the owner's first
// name only when research marked it confident, the first angle fact before you dial, and no price written in the file.
// Run: node --test control-room/tests/callscript.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GUARANTEE, formatPounds, offerFor } from "../functions/_lib/offer.js";
import { callScript, pounds, shortName } from "../public/js/callscript.js";

const LEAD = {
  name: "DIAMOND KICKBOXING ACADEMY LTD", trade: "Kickboxing", town: "Warrington", phone: "07969 770905",
  rating: 4.7, review_count: 12, owner_first: "Mark", findings: ["not_secure", "maps_some_top3", "no_form"],
  map_rank: { top3_pct: 24, found_pct: 80 },
};
const text = (sections) => sections.flatMap((s) => [s.title, ...s.lines]).join("\n");
const WEDNESDAY = new Date("2026-10-07T10:00:00Z");
const SATURDAY = new Date("2026-10-10T10:00:00Z");
// Every call passes today's offer and the guarantee, as the drawer payload carries them.
const opts = (day, extra = {}) => ({ offer: offerFor(day), guarantee: GUARANTEE, today: day, ...extra });
const script = (lead, day, extra) => text(callScript(lead, opts(day, extra)));
const section = (sections, title) => sections.find((s) => s.title === title);

test("it uses only what we know, said kindly, with the confirmed name", () => {
  const t = script(LEAD, WEDNESDAY);
  assert.match(t, /Hi, is that Mark\?/);
  assert.match(t, /Diamond Kickboxing Academy/);
  assert.match(t, /Not secure/);
  assert.doesNotMatch(t, /\bSEO\b|outdated|terrible|rubbish|ugly/i);
  // no confident first name (owner_first null): never a name, ask for whoever runs it
  const guessed = script({ ...LEAD, owner_first: null }, WEDNESDAY);
  assert.doesNotMatch(guessed, /Mark/);
  assert.match(guessed, /whoever runs/);
  // the old fields are gone: a director's name or an audit flag never puts a name in
  const old = script({ ...LEAD, owner_first: null, director_first_name: "Mark", audit: { owner_confident: true } }, WEDNESDAY);
  assert.doesNotMatch(old, /Mark/);
});

test("weekday and weekend prices follow the offer", () => {
  const weekday = script(LEAD, WEDNESDAY);
  assert.match(weekday, /£1,950/);
  assert.match(weekday, /first 60 days free/);
  assert.match(weekday, /£249/);
  assert.doesNotMatch(weekday, /£1,750|around £2,000|90 days free|weekend/i);
  const weekend = script(LEAD, SATURDAY);
  assert.match(weekend, /around £2,000/);
  assert.match(weekend, /£1,750/);
  assert.match(weekend, /90 days free/);
  assert.match(weekend, /£249/);
  assert.ok(section(callScript(LEAD, opts(SATURDAY)), "Before you dial").lines
    .includes("Today's a weekend: the weekend deal is on (around £2,000 → £1,750 and 90 days free)."));
  // £2,000 is only ever spoken around the real £1,950; the deal itself is £1,750
  assert.doesNotMatch(weekend, /£1,950/);
});

test("the weekend is decided by UK time, from the offer", () => {
  // 00:30 Saturday BST is 23:30 Friday UTC: the weekend deal (offerFor decides; the script never reads the clock)
  const fridayUtc = new Date("2026-10-09T23:30:00Z");
  assert.equal(offerFor(fridayUtc).weekend, true);
  assert.match(script(LEAD, fridayUtc), /around £2,000/);
  // 23:30 Sunday GMT (after the clock change) is still the weekend; 00:30 Monday GMT isn't
  assert.match(script(LEAD, new Date("2026-11-01T23:30:00Z")), /90 days free/);
  assert.match(script(LEAD, new Date("2026-11-02T00:30:00Z")), /first 60 days free/);
  // the offer wins over the day it's said on: a weekday offer on a Saturday is the weekday price
  const t = text(callScript(LEAD, { offer: offerFor(WEDNESDAY), guarantee: GUARANTEE, today: SATURDAY }));
  assert.match(t, /£1,950/);
  assert.doesNotMatch(t, /£1,750/);
});

test("the guarantee is said in its exact words, never the old one", () => {
  for (const day of [WEDNESDAY, SATURDAY]) {
    const sections = callScript(LEAD, opts(day));
    const t = text(sections);
    assert.ok(t.includes(GUARANTEE.headline));
    assert.ok(t.includes(GUARANTEE.section));
    assert.doesNotMatch(t, /(keep working|work) for free until you are|\bSEO\b/i);
    const pitch = section(sections, "Pitch (problem → why it matters → the fix)");
    assert.ok(pitch.lines.includes(`"We build it, and it's live in 7 days, guaranteed. ${GUARANTEE.headline} ${GUARANTEE.section}"`));
    // the objection answers that quoted the old guarantee quote the section instead
    const objections = text(sections.filter((s) => s.objection));
    assert.ok(objections.includes(GUARANTEE.section));
    assert.match(text(sections.filter((s) => /costs too much/.test(s.title))), /The guarantee: we will work for FREE/);
    assert.match(text(sections.filter((s) => /other clients/.test(s.title))), /The guarantee: we will work for FREE/);
  }
});

test("the first angle fact is in Before you dial", () => {
  const angle = [{ fact: "No photos of their work on Google", source_url: "https://g.co/x" }, { fact: "Second fact" }];
  const prep = section(callScript({ ...LEAD, angle }, opts(WEDNESDAY)), "Before you dial");
  assert.ok(prep.lines.some((l) => l.includes("No photos of their work on Google")));
  assert.ok(prep.lines.includes("Angle: No photos of their work on Google"));
  assert.ok(!prep.lines.some((l) => l.includes("Second fact")));
  // none, or not a usable one: no Angle line
  for (const a of [undefined, [], [{ fact: "  " }], ["text"], "nope"]) {
    assert.ok(!section(callScript({ ...LEAD, angle: a }, opts(WEDNESDAY)), "Before you dial").lines.some((l) => l.startsWith("Angle:")));
  }
});

test("\"I've built you a site\" is only said once their demo exists", () => {
  assert.doesNotMatch(script(LEAD, WEDNESDAY), /I've (actually )?built/);
  assert.match(script({ ...LEAD, demo_url: "https://aetoswebsites.com/demo/x" }, WEDNESDAY), /I've actually built a demo/);
});

test("every common objection has answers, and clients are never invented", () => {
  const s = callScript(LEAD, opts(WEDNESDAY));
  const obj = s.filter((x) => x.objection).map((x) => x.title).join(" ");
  for (const q of ["costs too much", "think about it", "information", "already got a website", "Word of mouth", "other clients"]) assert.match(obj, new RegExp(q, "i"));
  assert.match(text(s.filter((x) => /other clients/.test(x.title))), /Never invent/);
  assert.equal(shortName("SMITH ROOFING LTD - Roofer in Leeds"), "Smith Roofing");
});

test("it needs the offer and the guarantee from the payload", () => {
  assert.throws(() => callScript(LEAD, {}), /needs opts.offer/);
  assert.throws(() => callScript(LEAD), new Error("callScript needs opts.offer and opts.guarantee from /api/leads/:id"));
  assert.throws(() => callScript(LEAD, { offer: offerFor(WEDNESDAY) }), /needs opts.offer and opts.guarantee/);
  assert.throws(() => callScript(LEAD, { guarantee: GUARANTEE }), /needs opts.offer and opts.guarantee/);
  // an offer that isn't offerFor's (no free days, or a price that isn't pence) is refused, never "undefined days free"
  const weekday = offerFor(WEDNESDAY);
  for (const full of [{ ...weekday.full, freeDays: undefined }, { ...weekday.full, freeDays: "60" }, { ...weekday.full, freeDays: -1 }]) {
    assert.throws(() => callScript(LEAD, { offer: { ...weekday, full }, guarantee: GUARANTEE }), /needs opts.offer and opts.guarantee/);
  }
  assert.throws(() => callScript(LEAD, { offer: { ...weekday, full: { ...weekday.full, build: "195000" } }, guarantee: GUARANTEE }));
  assert.throws(() => callScript(LEAD, null), /needs opts.offer and opts.guarantee/);
});

test("amounts are written exactly as offer.js formatPounds writes them", () => {
  for (const pence of [195000, 175000, 24900, 200000, 24950, 5, 0, -24900, 100000000]) assert.equal(pounds(pence), formatPounds(pence));
  assert.equal(pounds(195000), "£1,950");
  assert.throws(() => pounds("195000"));
  assert.throws(() => pounds(NaN));
});

test("callscript.js writes no price of its own", () => {
  assert.doesNotMatch(readFileSync(new URL("../public/js/callscript.js", import.meta.url), "utf8"), /£\s?\d/);
});
