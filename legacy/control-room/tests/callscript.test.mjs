// Call script per lead. Run: node --test control-room/tests/callscript.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { callScript, shortName } from "../public/js/callscript.js";

const LEAD = {
  name: "DIAMOND KICKBOXING ACADEMY LTD", trade: "Kickboxing", town: "Warrington", phone: "07969 770905",
  rating: 4.7, review_count: 12, director_first_name: "Mark", findings: ["not_secure", "maps_some_top3", "no_form"],
  map_rank: { top3_pct: 24, found_pct: 80 }, audit: { owner_confident: true },
};
const text = (sections) => sections.flatMap((s) => [s.title, ...s.lines]).join("\n");
const WEDNESDAY = new Date("2026-10-07T10:00:00");
const SATURDAY = new Date("2026-10-10T10:00:00");

test("it uses only what we know, said kindly, with the confirmed name", () => {
  const t = text(callScript(LEAD, { today: WEDNESDAY }));
  assert.match(t, /Hi, is that Mark\?/);
  assert.match(t, /Diamond Kickboxing Academy/);
  assert.match(t, /Not secure/);
  assert.doesNotMatch(t, /\bSEO\b|outdated|terrible|rubbish|ugly/i);
  assert.match(t, /front page of Google/);
  // a guessed name is never used
  const guessed = text(callScript({ ...LEAD, audit: {} }, { today: WEDNESDAY }));
  assert.doesNotMatch(guessed, /Mark/);
  assert.match(guessed, /whoever runs/);
});

test("weekday and weekend prices follow the offer", () => {
  const weekday = text(callScript(LEAD, { today: WEDNESDAY }));
  assert.match(weekday, /£1,950/);
  assert.match(weekday, /first 60 days free/);
  const weekend = text(callScript(LEAD, { today: SATURDAY }));
  assert.match(weekend, /£1,750/);
  assert.match(weekend, /90 days free/);
});

test("\"I've built you a site\" is only said once their demo exists", () => {
  assert.doesNotMatch(text(callScript(LEAD, { today: WEDNESDAY })), /I've (actually )?built/);
  assert.match(text(callScript({ ...LEAD, demo_url: "https://aetoswebsites.com/demo/x" }, { today: WEDNESDAY })), /I've actually built a demo/);
});

test("every common objection has answers, and clients are never invented", () => {
  const s = callScript(LEAD, { today: WEDNESDAY });
  const obj = s.filter((x) => x.objection).map((x) => x.title).join(" ");
  for (const q of ["costs too much", "think about it", "information", "already got a website", "Word of mouth", "other clients"]) assert.match(obj, new RegExp(q, "i"));
  assert.match(text(s.filter((x) => /other clients/.test(x.title))), /Never invent/);
  assert.equal(shortName("SMITH ROOFING LTD - Roofer in Leeds"), "Smith Roofing");
});
