// The daily automatic search, pure part: choose the town, decide, explain (02-find Task 9).
// Run: node --test control-room/tests/territory.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TERRITORY, FIND_FROM, GOOD_WAITING_MIN, MIN_RESEARCH_SCORE, RECENT_DAYS, RESEARCH_QUEUE_MAX,
  chooseTown, cleanTerritory, decideFind, parseTerritory, todayLine,
} from "../functions/_lib/territory.js";

const T = { ...DEFAULT_TERRITORY, towns: ["Warrington", "Widnes", "Runcorn"], next: 0 };
const job = (town, created_at, extra = {}) => ({ trade: "landscaper", town, status: "done", created_at, ...extra });

// ---------------------------------------------------------------- the spec's tests (Task 9, Step 1)

test("skips towns searched in the last 30 days for this trade", () => {
  assert.deepEqual(chooseTown(T, [job(" warrington ", "2026-10-10T06:00:00Z")], "2026-10-19"), { town: "Widnes", next: 2 });
  assert.deepEqual(chooseTown(T, [job("Warrington", "2026-09-19T08:00:00Z")], "2026-10-19"), { town: "Warrington", next: 1 });
  assert.deepEqual(chooseTown(T, [job("Warrington", "2026-09-20T08:00:00Z")], "2026-10-19"), { town: "Widnes", next: 2 });
  assert.deepEqual(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { status: "failed" })], "2026-10-19").town, "Warrington");
  assert.deepEqual(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { trade: "Roofer" })], "2026-10-19").town, "Warrington");
  assert.equal(chooseTown(T, ["Warrington", "Widnes", "Runcorn"].map((t) => job(t, "2026-10-18T06:00:00Z")), "2026-10-19"), null);
  assert.equal(chooseTown({ ...T, next: 7 }, [], "2026-10-19").town, "Widnes");
});

test("decides in order: off, running, good, research, towns", () => {
  const base = { territory: T, goodWaiting: 29, researchQueued: 39, activeJobs: 0, recentJobs: [], ukToday: "2026-10-19" };
  assert.deepEqual(decideFind(base), { search: true, town: "Warrington", next: 1 });
  assert.deepEqual(decideFind({ ...base, territory: { ...T, on: false }, activeJobs: 1 }), { search: false, reason: "off" });
  assert.deepEqual(decideFind({ ...base, activeJobs: 1, goodWaiting: 99 }), { search: false, reason: "running" });
  assert.deepEqual(decideFind({ ...base, goodWaiting: 30 }), { search: false, reason: "good", n: 30 });
  assert.deepEqual(decideFind({ ...base, researchQueued: 40 }), { search: false, reason: "research", n: 40 });
});

test("today line", () => {
  const now = new Date("2026-10-19T09:00:00Z");
  const d = { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: true, town: "Widnes", job_id: "j" };
  assert.equal(todayLine(d, { status: "done", found: 41 }, now), "Searched Widnes at 06:02 — 41 found");
  assert.equal(todayLine(d, { status: "running" }, now), "Searching Widnes (started 06:02)");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "good", n: 34 }, null, now), "Skipped: 34 good leads waiting");
  assert.equal(todayLine({ day: "2026-10-18", search: false, reason: "good", n: 34 }, null, now), "Decided after 6am");
});

test("territory edits", () => {
  const old = { ...T, next: 2 };
  assert.equal(cleanTerritory({ on: true, trade: "landscaper", towns: "Warrington\n\nwidnes\nWidnes \nRuncorn", max: 60 }, old).territory.towns.length, 3);
  assert.equal(cleanTerritory({ on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], max: 60 }, old).territory.next, 2);
  assert.equal(cleanTerritory({ on: true, trade: "roofer", towns: ["Warrington", "Widnes", "Runcorn"], max: 60 }, old).territory.next, 0);
  assert.deepEqual(cleanTerritory({ trade: "landscaper", towns: " ", max: 60 }, old), { error: "Add at least one town (one per line)" });
  assert.deepEqual(cleanTerritory({ trade: "landscaper", towns: "Leigh", max: 5 }, old), { error: "Leads per search must be between 10 and 300" });
  assert.deepEqual(parseTerritory("{bad"), DEFAULT_TERRITORY);
});

// ---------------------------------------------------------------- more edges (Review Focus 3, Part A's table)

test("the constants are the spec's numbers, and the default is the same list autopilot.py has", () => {
  assert.equal(RECENT_DAYS, 30);
  assert.equal(GOOD_WAITING_MIN, 30);
  assert.equal(RESEARCH_QUEUE_MAX, 40);
  assert.equal(MIN_RESEARCH_SCORE, 35);
  assert.equal(FIND_FROM, "06:00");
  assert.equal(DEFAULT_TERRITORY.on, true);
  assert.equal(DEFAULT_TERRITORY.trade, "landscaper");
  assert.equal(DEFAULT_TERRITORY.next, 0);
  assert.equal(DEFAULT_TERRITORY.max, 60);
  assert.equal(DEFAULT_TERRITORY.towns.length, 18);
  assert.deepEqual(DEFAULT_TERRITORY.towns.slice(0, 3), ["Warrington", "Widnes", "Runcorn"]);
  assert.equal(DEFAULT_TERRITORY.towns.at(-1), "Ellesmere Port");
  assert.throws(() => { DEFAULT_TERRITORY.towns.push("Leeds"); }); // a caller can't change everyone's default
});

test("chooseTown: the pointer wraps, the 30 days are UK days, other trades and failed runs don't count", () => {
  // Starts from `next` and wraps round the end of the list.
  assert.deepEqual(chooseTown({ ...T, next: 2 }, [], "2026-10-19"), { town: "Runcorn", next: 0 });
  assert.deepEqual(chooseTown({ ...T, next: 2 }, [job("Runcorn", "2026-10-18T06:00:00Z")], "2026-10-19"), { town: "Warrington", next: 1 });
  // A run at 23:30 UTC on 19 Sep is 00:30 on 20 Sep in the UK (BST): inside the 30 days of 19 Oct.
  assert.equal(chooseTown(T, [job("Warrington", "2026-09-19T23:30:00Z")], "2026-10-19").town, "Widnes");
  // Trade compared without case or spaces; queued and running runs count as recent.
  assert.equal(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { trade: " Landscaper " })], "2026-10-19").town, "Widnes");
  assert.equal(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { status: "running" })], "2026-10-19").town, "Widnes");
  assert.equal(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { status: "queued" })], "2026-10-19").town, "Widnes");
  // Town spelling: case and extra spaces don't make it a different town.
  assert.equal(chooseTown({ ...T, towns: ["St Helens", "Wigan"] }, [job("st  helens", "2026-10-18T06:00:00Z")], "2026-10-19").town, "Wigan");
  // Nothing to search: an empty list, or every town recent.
  assert.equal(chooseTown({ ...T, towns: [] }, [], "2026-10-19"), null);
  assert.equal(chooseTown({ ...T, towns: [" ", ""] }, [], "2026-10-19"), null);
  // A bad pointer never fails: negative counts back from the end (as Python's % does), text or missing is the top.
  assert.equal(chooseTown({ ...T, next: -1 }, [], "2026-10-19").town, "Runcorn");
  assert.equal(chooseTown({ ...T, next: "x" }, [], "2026-10-19").town, "Warrington");
  assert.equal(chooseTown({ ...T, next: undefined }, null, "2026-10-19").town, "Warrington");
  // A run with no usable time can't make a town recent.
  assert.equal(chooseTown(T, [job("Warrington", "")], "2026-10-19").town, "Warrington");
});

test("decideFind: towns used up is the last reason; thresholds are exactly 30 and 40", () => {
  const base = { territory: T, goodWaiting: 0, researchQueued: 0, activeJobs: 0, recentJobs: [], ukToday: "2026-10-19" };
  const all = T.towns.map((t) => job(t, "2026-10-18T06:00:00Z"));
  assert.deepEqual(decideFind({ ...base, recentJobs: all }), { search: false, reason: "towns" });
  // research comes before towns, good before research, running before good
  assert.deepEqual(decideFind({ ...base, recentJobs: all, researchQueued: 41 }), { search: false, reason: "research", n: 41 });
  assert.deepEqual(decideFind({ ...base, recentJobs: all, researchQueued: 41, goodWaiting: 34 }), { search: false, reason: "good", n: 34 });
  assert.deepEqual(decideFind({ ...base, recentJobs: all, goodWaiting: 34, activeJobs: 2 }), { search: false, reason: "running" });
  assert.deepEqual(decideFind({ ...base, goodWaiting: 29, researchQueued: 39, recentJobs: [job("Warrington", "2026-10-18T06:00:00Z")] }),
    { search: true, town: "Widnes", next: 2 });
  assert.deepEqual(decideFind({ ...base, territory: { ...T, on: false } }), { search: false, reason: "off" });
});

test("today line: every state in Part A's table, times in UK HH:MM", () => {
  const now = new Date("2026-10-19T09:00:00Z");
  const d = { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: true, town: "Widnes", job_id: "j" };
  assert.equal(todayLine(null, null, now), "Decided after 6am");
  assert.equal(todayLine(undefined, undefined, now), "Decided after 6am");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "off" }, null, now), "Off. Nothing is searched automatically");
  assert.equal(todayLine(d, { status: "queued" }, now), "Searching Widnes (started 06:02)");
  assert.equal(todayLine(d, { status: "done", found: 0 }, now), "Searched Widnes at 06:02 — 0 found");
  assert.equal(todayLine(d, { status: "failed", error: "Google refused the search." }, now),
    "Searched Widnes at 06:02 — it failed: Google refused the search.");
  assert.equal(todayLine({ ...d, error: "GitHub refused to start the run (401): Bad credentials" }, { status: "failed", error: "GitHub refused to start the run (401): Bad credentials" }, now),
    "Couldn't start the search for Widnes: GitHub refused to start the run (401): Bad credentials");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "research", n: 41 }, null, now), "Skipped: Claude has 41 leads to research first");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "running" }, null, now), "Skipped: a search was already running");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "towns" }, null, now),
    "Skipped: every town on your list was searched in the last 30 days. Add more towns");
  // GMT after the clocks go back (25 Oct 2026): 06:02 UTC is 06:02 UK.
  const gmt = { day: "2026-10-26", at: "2026-10-26T06:02:00Z", search: true, town: "Leigh", job_id: "k" };
  assert.equal(todayLine(gmt, { status: "running" }, new Date("2026-10-26T10:00:00Z")), "Searching Leigh (started 06:02)");
  // "Today" is the UK day: 23:30 UTC on 19 Oct (BST) is already the 20th, so the 19th's decision is old news.
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "good", n: 34 }, null, new Date("2026-10-19T23:30:00Z")), "Decided after 6am");
  assert.equal(todayLine({ day: "2026-10-20", search: false, reason: "good", n: 34 }, null, new Date("2026-10-19T23:30:00Z")), "Skipped: 34 good leads waiting");
});

test("territory edits: clean towns, keep the place only when nothing but on/off or size changes", () => {
  const old = { ...T, next: 2 };
  const clean = (body, o = old) => cleanTerritory(body, o).territory;
  // trimmed, de-duplicated without case (first spelling kept), commas split too, blank lines dropped
  assert.deepEqual(clean({ on: true, trade: " landscaper ", towns: " Warrington\r\n\nwidnes\nWidnes \nRuncorn, Leigh", max: 60 }),
    { on: true, trade: "landscaper", towns: ["Warrington", "widnes", "Runcorn", "Leigh"], next: 0, max: 60 });
  // at most 200 towns
  const many = Array.from({ length: 250 }, (_, i) => `Town ${i}`);
  assert.equal(clean({ on: true, trade: "landscaper", towns: many, max: 60 }).towns.length, 200);
  // on/off and size changes keep the place; the trade's case doesn't count as a change
  assert.deepEqual(clean({ on: false, trade: "Landscaper", towns: "Warrington\nWidnes\nRuncorn", max: 100 }),
    { on: false, trade: "Landscaper", towns: ["Warrington", "Widnes", "Runcorn"], next: 2, max: 100 });
  // a changed list starts from the top
  assert.equal(clean({ on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn", "Leigh"], max: 60 }).next, 0);
  assert.equal(clean({ on: true, trade: "landscaper", towns: ["Widnes", "Warrington", "Runcorn"], max: 60 }).next, 0);
  // `next` past the end of an unchanged list wraps
  assert.equal(clean({ on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], max: 60 }, { ...T, next: 7 }).next, 1);
  // no old territory: compared with the defaults
  assert.equal(clean({ on: true, trade: "landscaper", towns: DEFAULT_TERRITORY.towns, max: 60 }, null).next, 0);
  assert.equal(clean({ on: true, trade: "landscaper", towns: ["Leigh"], max: 60 }, undefined).next, 0);
  // max: missing means 60, text numbers are fine
  assert.equal(clean({ on: true, trade: "landscaper", towns: "Leigh" }).max, 60);
  assert.equal(clean({ on: true, trade: "landscaper", towns: "Leigh", max: "120" }).max, 120);
  // the old errors, in the old order: trade, towns, size
  const nicheError = { error: "Type the niche to search, e.g. landscaper" };
  assert.deepEqual(cleanTerritory({ trade: " ", towns: "", max: 5 }, old), nicheError);
  assert.deepEqual(cleanTerritory({ trade: "x", towns: "Leigh", max: 60 }, old), nicheError);
  assert.deepEqual(cleanTerritory({ trade: "a".repeat(61), towns: "Leigh", max: 60 }, old), nicheError);
  assert.deepEqual(cleanTerritory({ towns: "Leigh", max: 60 }, old), nicheError);
  assert.deepEqual(cleanTerritory({ trade: "landscaper", max: 60 }, old), { error: "Add at least one town (one per line)" });
  assert.deepEqual(cleanTerritory({ trade: "landscaper", towns: ["", "  "], max: 60 }, old), { error: "Add at least one town (one per line)" });
  for (const max of [0, 9, 301, 60.5, -20, "abc"]) {
    assert.deepEqual(cleanTerritory({ trade: "landscaper", towns: "Leigh", max }, old), { error: "Leads per search must be between 10 and 300" });
  }
  assert.deepEqual(cleanTerritory(null, old), nicheError);
});

test("parseTerritory: stored JSON over the defaults; anything unreadable gives the defaults", () => {
  assert.deepEqual(parseTerritory(null), DEFAULT_TERRITORY);
  assert.deepEqual(parseTerritory(""), DEFAULT_TERRITORY);
  assert.deepEqual(parseTerritory("null"), DEFAULT_TERRITORY);
  assert.deepEqual(parseTerritory("[1,2]"), DEFAULT_TERRITORY);
  assert.deepEqual(parseTerritory("42"), DEFAULT_TERRITORY);
  assert.deepEqual(parseTerritory(JSON.stringify({ on: false, trade: "roofer", towns: ["Leigh"], next: 3, max: 100 })),
    { on: false, trade: "roofer", towns: ["Leigh"], next: 3, max: 100 });
  assert.deepEqual(parseTerritory(JSON.stringify({ next: 4 })), { ...DEFAULT_TERRITORY, next: 4 });
  // a copy: changing what it gives back never changes the defaults
  const t = parseTerritory(null);
  t.towns.push("Leeds");
  t.max = 10;
  assert.equal(DEFAULT_TERRITORY.towns.length, 18);
  assert.equal(DEFAULT_TERRITORY.max, 60);
});

// ---------------------------------------------------------------- review fixes

test("one town however it's written: St./Saint, hyphens, dots and case (as Python's audit.town_key)", () => {
  const L = { ...T, towns: ["St Helens", "Newton-le-Willows", "Wigan"], next: 0 };
  // Nik's hand search spelt another way still makes the list town recent (Part A: no town twice in 30 days)
  for (const typed of ["St. Helens", "Saint Helens", "st helens", "ST.HELENS".replace(".", ". "), "St.Helens", "ST.HELENS", "  ST   HELENS "]) {
    assert.equal(chooseTown(L, [job(typed, "2026-10-18T06:00:00Z")], "2026-10-19").town, "Newton-le-Willows", typed);
  }
  assert.equal(chooseTown({ ...L, next: 1 }, [job("Newton le Willows", "2026-10-18T06:00:00Z")], "2026-10-19").town, "Wigan");
  assert.equal(chooseTown({ ...L, next: 1 }, [job("Newton–le–Willows", "2026-10-18T06:00:00Z")], "2026-10-19").town, "Wigan"); // en dash
  // a word that only starts with "saint" is a different town
  assert.equal(chooseTown({ ...L, towns: ["Saintfield", "Wigan"] }, [job("St field", "2026-10-18T06:00:00Z")], "2026-10-19").town, "Saintfield");
  // the list keeps one of each (the first spelling), so one town is never searched twice in a row of the list
  const towns = "St Helens\nSt. Helens\nSaint Helens\nNewton-le-Willows\nNewton le Willows\nWigan";
  assert.deepEqual(cleanTerritory({ on: true, trade: "landscaper", towns, max: 60 }, L).territory.towns,
    ["St Helens", "Newton-le-Willows", "Wigan"]);
  // the rest of Python's town_key examples (test_leads.py): apostrophes, accents, "&" and hyphens are one town too
  const more = "King's Lynn\nKings Lynn\nKing’s Lynn\nKing‘s Lynn\nYnys Môn\nYnys Mon\nBrighton & Hove\nBrighton and Hove\nStoke-on-Trent\nStoke on Trent";
  assert.deepEqual(cleanTerritory({ on: true, trade: "landscaper", towns: more, max: 60 }, L).territory.towns,
    ["King's Lynn", "Ynys Môn", "Brighton & Hove", "Stoke-on-Trent"]);
  assert.equal(chooseTown({ ...L, towns: ["Brighton & Hove", "Wigan"] }, [job("Brighton and Hove", "2026-10-18T06:00:00Z")], "2026-10-19").town, "Wigan");
  // re-spelling a town isn't a new list: the place is kept
  assert.equal(cleanTerritory({ on: true, trade: "landscaper", towns: "St. Helens\nNewton le Willows\nWigan", max: 60 }, { ...L, next: 2 }).territory.next, 2);
});

test("today line: the saved JSON text works too, and a missing count never shows as 'undefined'", () => {
  const now = new Date("2026-10-19T09:00:00Z");
  assert.equal(todayLine(JSON.stringify({ day: "2026-10-19", search: false, reason: "good", n: 34 }), null, now), "Skipped: 34 good leads waiting");
  assert.equal(todayLine("{not json", null, now), "Decided after 6am");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "good" }, null, now), "Skipped: enough good leads waiting");
  assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "research", n: null }, null, now), "Skipped: Claude has enough leads to research first");
  assert.ok(!/undefined|null|NaN/.test(todayLine({ day: "2026-10-19", search: true, at: "2026-10-19T05:02:00Z" }, { status: "done" }, now)));
  // a missing or unreadable decision time falls back to the job's own start; neither → no time at all
  const s = { day: "2026-10-19", search: true, town: "Wigan" };
  assert.equal(todayLine({ ...s, at: "nope" }, { status: "running", created_at: "2026-10-19T05:03:00Z" }, now), "Searching Wigan (started 06:03)");
  assert.equal(todayLine(s, { status: "running", created_at: "2026-10-19T05:03:00Z" }, now), "Searching Wigan (started 06:03)");
  assert.equal(todayLine({ ...s, at: "nope" }, { status: "done", found: 7 }, now), "Searched Wigan — 7 found");
});

test("parseTerritory: a stored size or niche that can't be searched falls back to the default", () => {
  // these go straight to the GitHub run (max as text), so a bad one would fail every morning
  for (const max of ["abc", 0, 5, 301, 60.5, null, true]) {
    assert.equal(parseTerritory(JSON.stringify({ max })).max, 60, String(max));
  }
  assert.equal(parseTerritory(JSON.stringify({ max: "120" })).max, 120);
  assert.equal(parseTerritory(JSON.stringify({ max: 10 })).max, 10);
  assert.equal(parseTerritory(JSON.stringify({ max: 300 })).max, 300);
  for (const trade of ["", "  ", null, 42, ["roofer"]]) {
    assert.equal(parseTerritory(JSON.stringify({ trade })).trade, "landscaper", JSON.stringify(trade));
  }
  assert.equal(parseTerritory(JSON.stringify({ trade: " roofer " })).trade, "roofer");
});
