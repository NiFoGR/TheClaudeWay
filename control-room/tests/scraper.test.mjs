// Lead Scraper page (02-find Task 15): the Automatic search card's exact copy (Part A "What Nik sees"), every value
// escaped, and the runs list without the old client-side "Stuck" guess (the tick's stale_jobs step fails a run that
// makes no progress; the server's status is the truth). The browser check of the whole page is in the task notes.
// Run: node --test control-room/tests/scraper.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// lib.js and leads.js touch the page when they load, so give them just enough of one.
const stub = () => ({
  innerHTML: "", textContent: "", hidden: false, style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], append() {}, prepend() {}, before() {}, remove() {},
});
globalThis.document ??= { getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [], body: stub() };
globalThis.document.addEventListener ??= () => {};
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
const scraper = await import("../public/js/scraper.js");
const { automaticFormHtml, automaticHtml, inProgress, runRow } = scraper;

const XSS = `"><img src=x onerror=alert(1)>`;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
// The text a person reads: inline tags dropped, block tags a space, entities decoded, spaces collapsed.
const plain = (html) => html.replace(/<\/?(?:b|span|svg|path)\b[^>]*>/g, "").replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const TOWNS = ["Warrington", "Widnes", "Runcorn", "St Helens", "Wigan", "Leigh", "Northwich", "Altrincham", "Sale",
  "Stockport", "Chester", "Crewe", "Bolton", "Bury", "Salford", "Knutsford", "Macclesfield", "Ellesmere Port"];
const territory = (extra = {}) => ({ on: true, trade: "landscaper", towns: TOWNS, next: 0, max: 60, ...extra });
const answer = (extra = {}) => ({
  territory: territory(), upcoming: "Warrington", today: "Decided after 6am", counts: { goodWaiting: 0, researchQueued: 0 }, ...extra,
});
const RULE = "Every morning from 6am it searches landscaper in the next town on your list, when fewer than 30 good leads"
  + " are waiting and Claude has fewer than 40 to research. Next town: Warrington.";

test("the card: title Automatic search, badge On, today's line, the rule line with the next town, Edit", () => {
  const html = automaticHtml(answer());
  const text = plain(html);
  assert.match(text, /^Automatic search On Today: Decided after 6am /);
  assert.ok(html.includes('<span class="badge good">On</span>'));
  assert.ok(html.includes("<b>Today:</b> Decided after 6am"));
  assert.ok(text.includes(RULE), text);
  assert.ok(html.includes('id="auto-edit"') && text.endsWith("Edit"));
  assert.doesNotMatch(text, /Autopilot|Switched off/);
});

test("switched off: badge Off and the off line instead of the rule", () => {
  const html = automaticHtml(answer({ territory: territory({ on: false }), today: "Off. Nothing is searched automatically" }));
  const text = plain(html);
  assert.ok(html.includes('<span class="badge">Off</span>') && !html.includes(">On<"));
  assert.ok(text.includes("Today: Off. Nothing is searched automatically"));
  assert.ok(text.includes("Switched off: nothing is searched automatically."));
  assert.ok(!text.includes("Every morning from 6am"));
});

test("today's lines from the server, the next town and the niche are shown as text, never markup", () => {
  for (const today of ["Skipped: 34 good leads waiting", "Skipped: Claude has 41 leads to research first",
    "Searched Widnes at 06:02 — it failed: Google refused", "Skipped: every town on your list was searched in the last 30 days. Add more towns"]) {
    assert.ok(plain(automaticHtml(answer({ today }))).includes(`Today: ${today} `), today);
  }
  const html = automaticHtml(answer({
    today: `Couldn't start the search for Widnes: ${XSS}GitHub said no`,
    upcoming: `<script>alert(1)</script>`,
    territory: territory({ trade: `land${XSS}` }),
  }));
  noRawHtml(html);
  assert.ok(plain(html).includes(`Today: Couldn't start the search for Widnes: ${XSS}GitHub said no`));
  assert.ok(plain(html).includes("Next town: <script>alert(1)</script>."));
  assert.ok(plain(html).includes(`it searches land${XSS} in the next town`));
  const none = plain(automaticHtml(answer({ upcoming: "none (every town searched in the last 30 days)" })));
  assert.ok(none.includes("Next town: none (every town searched in the last 30 days)."));
});

test("no answer from the server: a plain-English error in the card's place, escaped; nothing to show → empty", () => {
  const text = plain(automaticHtml({ error: "Request failed (500)" }));
  assert.ok(text.includes("Automatic search"));
  assert.ok(text.includes("Couldn't load the automatic search: Request failed (500). Reload the page to try again."), text);
  assert.ok(plain(automaticHtml({ error: "D1 is down." })).includes("search: D1 is down. Reload"));
  noRawHtml(automaticHtml({ error: XSS }));
  assert.equal(automaticHtml(null), "");
  assert.equal(automaticHtml({}), "");
});

test("Edit opens 'Automatic search' with the four labels, the towns one per line and Save", () => {
  const form = automaticFormHtml(territory());
  assert.ok(form.includes("<h2>Automatic search</h2>"));
  const labels = [...form.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => plain(m[1]));
  assert.deepEqual(labels, ["Search one town every morning", "Niche",
    "Towns, in order (one per line). A town searched in the last 30 days is skipped.", "Leads per search"]);
  assert.ok(form.includes(`>${TOWNS.join("\n")}</textarea>`));
  assert.match(form, /name="on" checked/);
  assert.match(form, /name="max"[^>]*value="60"/);
  assert.match(form, /<button class="btn" type="submit">Save<\/button>/);
  // novalidate: the server's exact errors show, not the browser's own bubbles.
  assert.match(form, /<form [^>]*id="auto-form"[^>]*novalidate/);
  const off = automaticFormHtml(territory({ on: false, trade: `land${XSS}`, towns: ["Warrington", `<b>Widnes</b>${XSS}`] }));
  assert.doesNotMatch(off, /name="on" checked/);
  noRawHtml(off);
  assert.ok(off.includes("Warrington\n&lt;b&gt;Widnes&lt;/b&gt;"));
});

test("the card calls /api/territory (never the old autopilot route) and saving says 'Saved.'", () => {
  const src = readFileSync(new URL("../public/js/scraper.js", import.meta.url), "utf8");
  assert.ok(src.includes('api("/api/territory")'));
  assert.ok(src.includes('api("/api/territory", { method: "PUT"'));
  assert.ok(!/\/api\/autopilot/.test(src)); // written as a regex so `grep -rn` for the old route finds no caller
  assert.ok(src.includes('toast("Saved.")'));
});

test("a stopped run shows Failed and its error; a run 'running' for hours is still Working (no client Stuck)", () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600e3).toISOString();
  const failed = runRow({ id: "j1", trade: "landscaper", town: "Leigh", status: "failed", created_at: twoHoursAgo,
    error: "Stopped: no progress for 45 minutes. Press Find leads to try again." });
  assert.ok(failed.includes('<span class="badge bad">Failed</span>'));
  assert.ok(plain(failed).includes("Stopped: no progress for 45 minutes. Press Find leads to try again."));
  const old = runRow({ id: "j2", trade: "roofer", town: "Leeds", status: "running", created_at: twoHoursAgo, max_results: 60 });
  assert.ok(old.includes('<span class="badge warn">Working</span>'));
  assert.doesNotMatch(old, /Stuck|No word from GitHub/);
  assert.ok(old.includes('class="progress slim"'));
  assert.ok(runRow({ id: "j3", trade: "roofer", town: "Leeds", status: "queued", created_at: twoHoursAgo }).includes(">Starting</span>"));
  const done = runRow({ id: "j4", trade: "roofer", town: "Leeds", status: "done", created_at: twoHoursAgo, found: 41, pitchable: 12 });
  assert.ok(plain(done).includes("12 worth pitching of 41 found") && done.includes(">Done</span>"));
  noRawHtml(runRow({ id: XSS, trade: XSS, town: XSS, status: "failed", error: XSS, created_at: twoHoursAgo }));
  noRawHtml(runRow({ id: "j5", trade: "x", town: "y", status: "done", found: XSS, pitchable: XSS, created_at: twoHoursAgo }));
});

test("inProgress is the server's queued/running; isStuck and STUCK_MINUTES are gone", () => {
  const long = "2026-01-01T00:00:00Z";
  assert.equal(inProgress({ status: "queued", created_at: long }), true);
  assert.equal(inProgress({ status: "running", created_at: long }), true);
  for (const status of ["done", "failed", "anything"]) assert.equal(inProgress({ status, created_at: long }), false, status);
  assert.equal(scraper.isStuck, undefined);
  assert.equal(scraper.STUCK_MINUTES, undefined);
  assert.equal(typeof runRow, "function"); // home.js's Latest searches uses it
});
