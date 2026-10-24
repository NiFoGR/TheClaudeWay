// Claude's research card in the lead drawer (stage 2, 03-research-grade.md Task 8): public/js/researchcard.js, pure.
// Every state in Part A "What Nik sees" (no row, waiting, being re-checked, skipped, done), the full card top to
// bottom, the cap lines, and scraped or Claude-written text escaped with links only to http(s) pages. leads.js wires
// its buttons (Copy, Research is wrong); the browser check is in the task notes.
// Run: node --test control-room/tests/researchcard.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// lib.js reads the page when it loads (its `view`), so give it just enough of one; researchcard.js never touches it.
globalThis.document = { getElementById: () => null };
const { esc, safeUrl } = await import("../public/js/lib.js");
const { RECHECK_OFFLINE, capLine, recheckAnswer, recheckedResearch, researchCard } = await import("../public/js/researchcard.js");
const H = { esc, safeUrl };

const XSS = `"><img src=x onerror=alert(1)>`;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
// The text a person reads: tags dropped, entities decoded, spaces collapsed.
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const link = (u) => `href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer"`;
// The <li> rows of the card, as HTML.
const items = (html) => html.split("<li").slice(1).map((s) => s.slice(0, s.indexOf("</li>")));

const OPENER = "Came across Green Leaf looking for a landscaper in Warrington: 61 five-star reviews, but you're not in"
  + " the top 3 on Google Maps there.\nSo I put together a quick site for you that puts those reviews front and centre.";
const SEARCHED = ["search: \"Green Leaf Landscapes\" Warrington facebook", "opened: https://greenleaf.co.uk",
  "opened: https://greenleaf.co.uk/contact", "search: \"Green Leaf Landscapes\" Warrington email",
  "search: \"Green Leaf Landscapes\" Warrington yell"];

// A done A+ row as GET /api/research/:place_id gives it (research.js parseResearch).
const done = (o = {}) => ({
  place_id: "ChIJgreenleaf", status: "done", grade: "A+",
  points: {
    need: 5, means: 4, reach: 5, fit: 5, total: 19, capped: null,
    reasons: { need: "No website; top 3 on Maps in 12% of Warrington", means: "61 reviews at 4.9, trading since 2014",
      reach: "Dave's own email, on the contact page", fit: "Owner-run landscaper" },
  },
  grade_reason: "Owner-run landscaper with 61 great reviews but no website and rarely in the Maps top 3. We have Dave's own email.",
  angle: [
    { fact: "Not in the Google Maps top 3 for 'landscaper Warrington' (Map Rank: 12% top-3)",
      source_url: "https://control.example/#/maprank?scan=7&biz=ChIJgreenleaf" },
    { fact: "No website: customers only find a Facebook page", source_url: "https://www.facebook.com/greenleaflandscapes" },
  ],
  opener: OPENER,
  owner: { first: "Dave", full: "Dave Smith", source_url: "https://greenleaf.co.uk/about", confident: true },
  best_email: "dave@greenleaf.co.uk", best_email_why: "Owner's own address",
  emails: [
    { email: "info@greenleaf.co.uk", source_url: "https://greenleaf.co.uk", where: "Footer" },
    { email: "dave@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" },
  ],
  copy: { headline: "Garden design and landscaping in Warrington", intro: "Patios and fencing.", services: ["Patios"],
    areas: ["Warrington"], about: "" },
  site_review: { verdict: "Facebook page only", summary: "No website of their own; the Facebook page has their number.",
    problems: ["Good reviews, but nowhere on a site of their own shows them"], good: ["Photos of recent jobs"] },
  too_big: false,
  notes: "[Nik 2026-10-12] Ask about the vans\nCompany dissolved 2023, now trades as a sole trader",
  searched: SEARCHED,
  queued_at: "2026-10-19T05:47:00Z", researched_at: "2026-10-19T06:10:00Z",
  ...o,
});
// A queued row stage 1 has just made: nothing researched yet.
const queued = (o = {}) => ({
  place_id: "ChIJnew", status: "queued", grade: null, points: null, grade_reason: null, angle: [], opener: null,
  owner: null, best_email: null, best_email_why: null, emails: [], copy: null, site_review: null, too_big: false,
  notes: "", searched: [], queued_at: "2026-10-19T05:47:00Z", researched_at: null, ...o,
});
const skipped = (notes, o = {}) => queued({ status: "skipped", notes, ...o });

test("empty states", () => {
  const none = researchCard({ research: null, waiting: 14 }, H);
  assert.match(none, /Not queued for research/);
  assert.match(plain(none), /Not queued for research\. Leads are queued when the daily search keeps them\./);
  assert.doesNotMatch(none, /Research is wrong/);

  const waiting = researchCard({ research: queued(), waiting: 14 }, H);
  assert.match(waiting, /Waiting for Claude/);
  assert.match(waiting, /14 leads waiting/);
  assert.match(plain(waiting), /Waiting for Claude\. It researches 8 leads a run, every morning at 06:47 and after each search\. 14 leads waiting\./);
  assert.doesNotMatch(waiting, /Research is wrong/, "nothing to re-check yet");
  assert.match(plain(researchCard({ research: queued(), waiting: 1 }, H)), /after each search\. 1 lead waiting\.$/);

  const recheck = researchCard({ research: done({ status: "queued", grade: "B",
    notes: "[Nik 2026-10-19] owner is Sue\n[Nik 2026-10-12] Ask about the vans\nOld Claude note" }), waiting: 3 }, H);
  assert.match(recheck, /Being re-checked after your note/);
  assert.match(plain(recheck), /Being re-checked after your note: “owner is Sue”\./);
  assert.match(recheck, /class="grade">B</, "the old grade");
  assert.match(recheck, /class="research-old"/, "the old research, faded");
  assert.doesNotMatch(recheck, /Research is wrong/, "already being re-checked");

  const skip = researchCard({ research: skipped("Skipped: the scraper excluded this lead (Chain or franchise)."), waiting: 3 }, H);
  assert.match(skip, /Skipped:/);
  assert.match(plain(skip), /Skipped: the scraper excluded this lead \(Chain or franchise\)\./);
  assert.match(skip, /Research is wrong/, "the only way to bring a skipped lead back");
});

test("full card", () => {
  const r = done();
  const html = researchCard({ research: r, waiting: 3 }, H);
  const text = plain(html);
  assert.match(html, /A\+/);
  assert.match(html, /class="grade aplus">A\+</);
  assert.match(html, /19\/20/);
  assert.match(text, /Researched 19 Oct/);
  assert.match(html, /Need 5\/5/);
  assert.match(text, /Need 5\/5 · No website; top 3 on Maps in 12% of Warrington/, "Part A: \"Need 5/5 · <reason>\"");
  assert.match(text, /Means 4\/5 · 61 reviews at 4\.9, trading since 2014/);
  assert.match(text, /Reach 5\/5 · Dave's own email, on the contact page Fit 5\/5 · Owner-run landscaper/);
  assert.match(html, /style="width:80%"/, "a bar per point");
  assert.ok(html.includes(esc(r.grade_reason)), "Why: grade_reason");
  for (const line of OPENER.split("\n")) assert.ok(html.includes(esc(line)), "the opener text");
  assert.match(html, /class="opener-box"/);
  assert.match(html, /data-copy-opener/, "a Copy button");
  assert.match(html, /Research is wrong/);
  for (const a of r.angle) {
    assert.ok(html.includes(esc(a.fact)));
    assert.ok(html.includes(link(a.source_url)), `angle source ${a.source_url} linked in a new tab`);
  }
  assert.match(html, /href="https:\/\/www\.facebook\.com\/greenleaflandscapes" target="_blank" rel="noopener noreferrer"/);

  // Emails: the best one first and starred, with why; each with where and its source.
  const rows = items(html).filter((li) => li.includes("mailto:"));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /★/);
  assert.match(rows[0], /mailto:dave@greenleaf\.co\.uk/);
  assert.ok(rows[0].includes(esc("Owner's own address")));
  assert.match(rows[0], /Contact page/);
  assert.ok(rows[0].includes(link("https://greenleaf.co.uk/contact")));
  assert.doesNotMatch(rows[1], /★/);
  assert.match(rows[1], /info@greenleaf\.co\.uk/);

  assert.match(text, /Dave Smith · confirmed \( source \)/);
  assert.ok(html.includes(link("https://greenleaf.co.uk/about")));
  assert.match(text, /Their website Facebook page only\. No website of their own/);
  assert.match(text, /Good reviews, but nowhere on a site of their own shows them/);
  assert.match(text, /Good: Photos of recent jobs/);
  assert.match(text, /Notes \[Nik 2026-10-12\] Ask about the vans Company dissolved 2023, now trades as a sole trader/);
  assert.match(html, /<details[^>]*><summary>What Claude checked \(5\)<\/summary>/, "collapsed");
  for (const s of SEARCHED) assert.ok(html.includes(esc(s)));
  assert.doesNotMatch(html, /<details[^>]* open/);

  // The Research is wrong box: hidden until the button is pressed, with Re-check and Cancel.
  assert.match(html, /data-recheck-box hidden/);
  assert.match(text, /What's wrong\? Claude reads this when it re-checks\./);
  assert.match(html, /<textarea[^>]*data-recheck-note/);
  assert.match(html, /data-recheck-send>Re-check</);
  assert.match(html, /data-recheck-cancel>Cancel</);
  assert.match(html, /class="error" data-recheck-error hidden/);

  // Top to bottom, as Part A lists it.
  const order = ["Researched 19 Oct", "Need 5/5", "<h4>Why</h4>", "<h4>How we can help</h4>", "<h4>Suggested opener</h4>",
    "<h4>Owner</h4>", "<h4>Emails</h4>", "<h4>Their website</h4>", "<h4>Notes</h4>", "What Claude checked", "Research is wrong"];
  const at = order.map((s) => html.indexOf(s));
  assert.ok(at.every((i) => i >= 0), `all sections present: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in Part A's order");
});

test("the researched date is the UK day", () => {
  const late = researchCard({ research: done({ researched_at: "2026-10-18T23:30:00Z" }), waiting: 0 }, H);
  assert.match(plain(late), /Researched 19 Oct/, "00:30 BST is the 19th in the UK");
  const winter = researchCard({ research: done({ researched_at: "2026-12-01T23:30:00Z" }), waiting: 0 }, H);
  assert.match(plain(winter), /Researched 1 Dec/, "GMT in winter");
  assert.doesNotMatch(researchCard({ research: done({ researched_at: null }), waiting: 0 }, H), /Researched/);
});

test("capped line", () => {
  assert.equal(capLine("reach", "C"), "Capped at C: no email that reaches the owner");
  assert.equal(capLine("fit", "D"), "Capped at D: not a fit");
  assert.equal(capLine("too_big", "D"), "Capped at D: too big for us");
  assert.equal(capLine(null, "A"), "");
  assert.equal(capLine("constructor", "B"), "");

  const c = researchCard({ research: done({ grade: "C", points: { ...done().points, reach: 1, total: 15, capped: "reach" } }), waiting: 0 }, H);
  assert.match(plain(c), /Capped at C: no email that reaches the owner/);
  assert.match(c, /class="grade">C</, "A/B/C/D badges are neutral");
  const big = researchCard({ research: done({ grade: "D", too_big: true, opener: "", copy: null,
    points: { ...done().points, fit: 0, total: 14, capped: "too_big" } }), waiting: 0 }, H);
  assert.match(plain(big), /Too big for us/);
  assert.match(plain(big), /Capped at D: too big for us/);
  assert.doesNotMatch(big, /Suggested opener|data-copy-opener/, "no opener when too big");
  assert.doesNotMatch(researchCard({ research: done(), waiting: 0 }, H), /Capped at|Too big for us/);
});

test("escapes hostile text", () => {
  const html = researchCard({ research: done({
    grade_reason: "<img src=x onerror=alert(1)>",
    angle: [{ fact: XSS, source_url: "javascript:alert(1)" }, { fact: "Fine fact", source_url: "data:text/html,<script>alert(1)</script>" }],
    opener: `${XSS}\n<script>alert(1)</script>`,
    owner: { first: XSS, full: XSS, source_url: "javascript:alert(1)", confident: true },
    best_email: `x@y.co${XSS}`, best_email_why: XSS,
    emails: [{ email: `x@y.co${XSS}`, source_url: "javascript:alert(1)", where: XSS }],
    site_review: { verdict: XSS, summary: XSS, problems: [XSS], good: [XSS] },
    points: { ...done().points, reasons: { need: XSS, means: XSS, reach: XSS, fit: XSS } },
    notes: `[Nik 2026-10-19] ${XSS}\n${XSS}`, searched: [XSS, "opened: javascript:alert(1)", XSS],
    grade: `<b>A</b>`,
  }), waiting: `<img src=x>` }, H);
  noRawHtml(html);
  assert.doesNotMatch(html, /<b>A<\/b>/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /href="data:/);
  // Every link goes to an http(s) page or is a mailto.
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) assert.match(href, /^(https?:\/\/|mailto:)/);
  // A source that isn't http(s) is plain text, never a link.
  assert.match(plain(html), /Fine fact/);

  const recheck = researchCard({ research: done({ status: "queued", notes: `[Nik 2026-10-19] ${XSS}` }), waiting: 1 }, H);
  noRawHtml(recheck);
  assert.ok(recheck.includes(`“${esc(XSS)}”`));
  const skip = researchCard({ research: skipped(`[Nik 2026-10-19] Not a fit: ${XSS}`), waiting: 1 }, H);
  noRawHtml(skip);
  assert.ok(skip.includes(esc(`Skipped: you marked it not a fit (${XSS}).`)));
  noRawHtml(researchCard({ research: skipped(`Skipped: ${XSS}`), waiting: 1 }, H));
});

test("owner not confident", () => {
  const html = researchCard({ research: done({ owner: { first: "Dave", full: "Dave Smith", source_url: "https://greenleaf.co.uk/about", confident: false } }), waiting: 0 }, H);
  assert.ok(html.includes("not confirmed: emails say &quot;Hi,&quot;"), "escaped quotes");
  // Part A: "Dave · not confirmed: emails say "Hi,"": the first name the emails would have used, so Nik sees the guess.
  assert.match(plain(html), /Owner Dave · not confirmed: emails say "Hi," \( source \)/);
  assert.ok(html.includes(link("https://greenleaf.co.uk/about")), "its source, so Nik can check it");
  assert.doesNotMatch(plain(html), /· confirmed|Dave Smith/);
  // The business-name case the server forces to not confident ("Diamond" of "Diamond Kickboxing").
  const diamond = researchCard({ research: done({ owner: { first: "Diamond", full: "Diamond Jones", source_url: "https://d.example/about", confident: false } }), waiting: 0 }, H);
  assert.match(plain(diamond), /Owner Diamond · not confirmed: emails say "Hi,"/);
});

test("nothing found", () => {
  const html = researchCard({ research: done({ grade: "C", owner: null, emails: [], best_email: null, best_email_why: null,
    site_review: null, notes: "", points: { ...done().points, reach: 0, total: 14, capped: "reach" } }), waiting: 0 }, H);
  const text = plain(html);
  assert.match(text, /Owner Not found/);
  assert.match(text, /No email found\. Claude checked 5 places \(see below\)\./);
  assert.doesNotMatch(html, /mailto:|★/);
  assert.doesNotMatch(text, /Their website/, "hidden when site_review is null");
  assert.doesNotMatch(text, /Notes/, "no empty notes section");
  assert.match(text, /What Claude checked \(5\)/);
  assert.match(plain(researchCard({ research: done({ emails: [], best_email: null, searched: ["one"] }), waiting: 0 }, H)),
    /Claude checked 1 place \(see below\)\./);
});

test("a point without a reason has no dangling separator", () => {
  const html = researchCard({ research: done({ points: { ...done().points, reasons: { need: "", means: "  " } } }), waiting: 0 }, H);
  assert.match(plain(html), /Need 5\/5 Means 4\/5 Reach 5\/5 Fit 5\/5 Why/);
  assert.doesNotMatch(plain(html), /\/5 ·/);
});

test("Research is wrong: what the answer shows", () => {
  assert.equal(RECHECK_OFFLINE, "Couldn't save. Check your connection and press Re-check again.", "Part A's network message, exactly");
  const fired = "Queued. Claude has been asked to research it now. Check back in 15 minutes.";
  assert.deepEqual(recheckAnswer(200, { ok: true, fired: true, message: fired }), { message: fired });
  assert.deepEqual(recheckAnswer(200, { ok: true, fired: false, message: "Queued. Claude will pick it up on its current or next run." }),
    { message: "Queued. Claude will pick it up on its current or next run." });
  // The route's own refusals, word for word.
  const short = "Say what's wrong in a few words (5 to 500 characters).";
  assert.deepEqual(recheckAnswer(400, { error: short }), { error: short });
  const none = "This lead hasn't been researched yet, so there's nothing to re-check.";
  assert.deepEqual(recheckAnswer(404, { error: none }), { error: none });
  // A lead Claude may not research now: the 409's own words under the box (nothing was changed, so no toast).
  const excluded = "The scraper excluded this lead (Multiple branches (chain)), so Claude won't research it. Nothing was changed.";
  assert.deepEqual(recheckAnswer(409, { error: excluded }), { error: excluded });
  const gone = "This lead no longer exists, so there's nothing to re-check.";
  assert.deepEqual(recheckAnswer(404, { error: gone }), { error: gone });
  // A server failure says so in plain English and what to do; never a bare status or an empty box.
  assert.deepEqual(recheckAnswer(500, { error: "D1_ERROR: no such table: research." }),
    { error: "Couldn't save: the Control Room had a problem (D1_ERROR: no such table: research). Press Re-check again in a minute." });
  assert.deepEqual(recheckAnswer(502, null),
    { error: "Couldn't save: the Control Room had a problem (HTTP 502). Press Re-check again in a minute." });
  assert.deepEqual(recheckAnswer(200, null),
    { error: "Couldn't save: the Control Room had a problem (HTTP 200). Press Re-check again in a minute." }, "not the route's answer");
  assert.match(recheckAnswer(400, {}).error, /^Couldn't save: the Control Room had a problem \(HTTP 400\)\./);
});

test("Not a fit reason", () => {
  const html = researchCard({ research: skipped("[Nik 2026-10-19] Not a fit: Wrong trade"), waiting: 2 }, H);
  assert.match(plain(html), /Skipped: you marked it not a fit \(Wrong trade\)\./);
  // Nik's newest line wins over an older scraper skip; a newer "Skipped: …" line (a later queue skip) wins over an older
  // Not a fit that is no longer his newest note.
  assert.match(plain(researchCard({ research: skipped("[Nik 2026-10-19] Not a fit: Wrong trade.\nSkipped: the lead no longer exists."), waiting: 0 }, H)),
    /Skipped: you marked it not a fit \(Wrong trade\)\./);
  assert.match(plain(researchCard({ research: skipped("[Nik 2026-10-20] owner is Sue\n[Nik 2026-10-19] Not a fit: Wrong trade\nSkipped: the lead no longer exists."), waiting: 0 }, H)),
    /Skipped: the lead no longer exists\./);
  // The 12-month purge's blanked row.
  assert.match(plain(researchCard({ research: skipped("Skipped: details deleted 12 months after last contact."), waiting: 0 }, H)),
    /Skipped: details deleted 12 months after last contact\./);
  assert.match(plain(researchCard({ research: skipped(""), waiting: 0 }, H)), /Skipped: no reason was saved\./);
});

test("after Research is wrong the card says it's being re-checked", () => {
  const now = new Date("2026-10-19T23:30:00Z"); // 00:30 on the 20th in the UK
  const r = recheckedResearch(done(), "Owner is Sue,\n  not Dave ", now);
  assert.equal(r.status, "queued");
  assert.equal(r.notes, "[Nik 2026-10-20] Owner is Sue, not Dave\n[Nik 2026-10-12] Ask about the vans\nCompany dissolved 2023, now trades as a sole trader");
  const html = researchCard({ research: r, waiting: 4 }, H);
  assert.match(plain(html), /Being re-checked after your note: “Owner is Sue, not Dave”\./);
  assert.match(html, /class="grade aplus">A\+</, "the old research stays visible, faded");
  // A purged or never-researched row brought back by Nik: no old research to show.
  const back = researchCard({ research: recheckedResearch(skipped("Skipped: details deleted 12 months after last contact."), "Please look again", now), waiting: 1 }, H);
  assert.match(plain(back), /Being re-checked after your note: “Please look again”\./);
  assert.doesNotMatch(back, /research-old|class="grade/);
});

test("pure: no imports, never touches the page", () => {
  const src = readFileSync(new URL("../public/js/researchcard.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\b(document|window|navigator|localStorage|fetch)\b/);
  assert.match(researchCard({}, H), /Not queued for research/, "a missing answer is no row");
});
