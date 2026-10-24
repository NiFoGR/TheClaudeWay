// leadRow: a lead as every API hands it out (leads, picks, overview, outreach previews). Run:
// node --test control-room/tests/lead-row.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { facts } from "../functions/_lib/outreach.js";
import { leadRow } from "../functions/_lib/util.js";
import { callScript } from "../public/js/callscript.js";

// A Warrington landscaper saved before stage 1 from the Runcorn search: its audit carries the Runcorn scan's Maps lines
// (false claim #7). Part A keeps the stored lines until its town is searched again, so they must never be quoted.
const RUNCORN_MAPS = { avg_rank: 21, top3_pct: 0, found_pct: 0, scan_town: "Runcorn" };
const AWAY = {
  place_id: "p1", name: "Green Leaf Landscaping", trade: "landscaper", town: "Warrington", search_town: "Runcorn",
  rating: 4.8, review_count: 20, excluded: 0, email: "info@greenleaf.co.uk",
  issues: JSON.stringify(["Not in Google Maps' top 20 anywhere we checked across Runcorn",
    "The top 3 businesses on Google have far more reviews"]),
  audit: JSON.stringify({ findings: ["maps_invisible", "reviews_behind"], map_rank: RUNCORN_MAPS,
    score: { total: 25, website: 0, seo: 0, maps: 25 } }),
};
const HOME = {
  ...AWAY, town: "St. Helens", search_town: "St Helens",
  issues: JSON.stringify(["Not in Google Maps' top 20 anywhere we checked across Saint Helens"]),
  audit: JSON.stringify({ findings: ["maps_invisible"], map_rank: { ...RUNCORN_MAPS, scan_town: "Saint Helens" } }),
};
const MAPS_LINE = /top 20|top 3 in|more reviews/;
// The call script takes today's offer and the guarantee from the payload (stage 3), as GET /api/leads/:id sends them.
const DAY = new Date("2026-10-07T10:00:00Z");
const lines = (lead) => callScript(lead, { today: DAY, offer: offerFor(DAY), guarantee: GUARANTEE }).flatMap((s) => s.lines);

test("a lead found from another town's search has no Maps lines in the call script or the emails", () => {
  const lead = leadRow(AWAY);
  assert.deepEqual(lines(lead).filter((l) => MAPS_LINE.test(l)), []);
  const f = facts(lead, { competitor: { name: "Top Turf Ltd", top3_pct: 76 }, spots: 49 });
  assert.equal(f.problem, undefined);
  assert.equal(f.top3, undefined);
  assert.equal(f.competitor, undefined);
  // the size of that town's scan isn't about them either ("I checked 49 spots around Warrington")
  assert.equal(f.spots, undefined);
  assert.deepEqual(lead.findings, []);
  // {} and never null: facts reads `lead.map_rank || lead.audit?.map_rank` (callScript reads only `lead.map_rank`)
  assert.deepEqual(lead.map_rank, {});
});

test("only what's handed out changes: audit and issues stay as saved", () => {
  const lead = leadRow(AWAY);
  assert.deepEqual(lead.audit.findings, ["maps_invisible", "reviews_behind"]);
  assert.deepEqual(lead.audit.map_rank, RUNCORN_MAPS);
  assert.equal(lead.issues.length, 2);
});

test("other Maps-free findings stay; a new row marked home false loses its Maps part too", () => {
  const mixed = leadRow({ ...AWAY, audit: JSON.stringify({ findings: ["no_website", "maps_invisible", "maps_some_top3", "reviews_behind"],
    map_rank: RUNCORN_MAPS }) });
  assert.deepEqual(mixed.findings, ["no_website"]);
  const marked = leadRow({ ...AWAY, town: "Runcorn", audit: JSON.stringify({ findings: ["maps_no_top3", "not_mobile"],
    map_rank: { scan_town: "Runcorn", home: false } }) });
  assert.deepEqual(marked.findings, ["not_mobile"]);
  assert.deepEqual(marked.map_rank, {});
  // no town of its own on the row: its search town is its town (as Python's qualify.score)
  const noTown = leadRow({ ...AWAY, town: "", search_town: "Runcorn" });
  assert.deepEqual(noTown.findings, ["maps_invisible", "reviews_behind"]);
});

test("a lead in its own town keeps its Maps finding, however the town is spelt", () => {
  const lead = leadRow(HOME);
  assert.deepEqual(lead.findings, ["maps_invisible"]);
  assert.equal(lead.map_rank.top3_pct, 0);
  assert.ok(lines(lead).some((l) => /didn't come up in Google's top 20/.test(l)));
  assert.ok(lines(lead).some((l) => /top 3 in 0% of St\. Helens/.test(l)));
  const f = facts(lead, { spots: 49 });
  assert.match(f.problem, /didn't come up in Google's top 20/);
  assert.equal(f.top3, "0");
  assert.equal(f.spots, "49");
  // Map Rank saved before scan_town existed, or none at all: nothing to compare, left as it is
  assert.deepEqual(leadRow({ ...AWAY, audit: JSON.stringify({ findings: ["maps_invisible"], map_rank: { top3_pct: 8 } }) }).findings,
    ["maps_invisible"]);
  assert.deepEqual(leadRow({ ...AWAY, audit: "" }).map_rank, {});
});
