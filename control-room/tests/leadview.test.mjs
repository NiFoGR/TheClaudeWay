// The Leads page's pure HTML (stage 3, docs/rebuild/04-shortlist.md Task 7): public/js/leadview.js. Scraped, inbound
// and Claude-written values escaped, outside links only to http(s) pages, the buttons Part A allows for each stage and
// today's room, stage 2's research card embedded unchanged, the three mount points, the demo preview built only on
// demand, the grade chips of each view, and the call script fed from the payload. leads.js puts it on the page.
// Run: node --test control-room/tests/leadview.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { leadDetail, listLeads } from "../functions/_lib/shortlist-db.js";
import { STAGE_LABELS as SERVER_STAGE_LABELS, STAGE_TOKENS, parseLeadFilters } from "../functions/_lib/shortlist.js";
import { esc, icon, safeUrl } from "../public/js/html.js";
import {
  FIT_TEXT_MAX, NOT_A_FIT_REASONS, STAGE_LABELS, bannerHtml, drawerHtml, filterBarHtml, gradeBadge, leadRowHtml, leadsBodyHtml,
  leadsErrorHtml, leadsQueryString, notAFitHtml, notAFitReason, parseLeadsQuery, parseRoute, scriptLead, threadHtml,
} from "../public/js/leadview.js";
import { researchCard } from "../public/js/researchcard.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { SEED_AT, seedDemo, seedLead, seedMessage, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

// leadview.js (and html.js, researchcard.js, callscript.js) loaded above with no page at all: they're pure.
const PURE = typeof globalThis.document === "undefined";

const NOW = new Date("2026-10-21T08:00:00Z"); // Wed 09:00 UK
const SATURDAY = new Date("2026-10-24T10:00:00Z");
const XSS = `"><img src=x onerror=alert(1)>`;
const count = (html, s) => html.split(s).length - 1;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
// The text a person reads: tags dropped, entities decoded, spaces collapsed.
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const POINTS = {
  need: 4, means: 3, reach: 5, fit: 4, total: 16, capped: null,
  reasons: { need: "No website", means: "61 reviews", reach: "Owner's own email", fit: "Landscaper" },
};
const MARK = { first: "Mark", full: "Mark Dean", source_url: "https://x.co.uk/about", confident: true };
// Stage 2's parsed research (parseResearch), as GET /api/leads/:id sends it.
const RESEARCH = {
  place_id: "ChIJgl", status: "done", grade: "A", points: POINTS, grade_reason: "Owner-run, good reviews, weak site.",
  angle: [{ fact: "No photos of their work on Google", source_url: "https://g.co/x" }],
  opener: "Came across Green Leaf looking for a landscaper in Warrington.", owner: MARK,
  best_email: "mark@greenleaf.co.uk", best_email_why: "Owner's own address",
  emails: [{ email: "mark@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" }],
  copy: null, site_review: null, too_big: false, notes: "", searched: [],
  queued_at: "2026-10-20T05:47:00Z", researched_at: "2026-10-20T06:10:00Z",
};
const PROSPECT = {
  stage: "ready", stage_label: "Ready to email", stage_at: SEED_AT, email: "mark@greenleaf.co.uk", greet_name: "Mark",
  first_sent_at: null, followup_step: 0, next_followup_at: null, views: 0, last_view_at: null, last_inbound_at: null,
  lost_reason: null, hot: false,
};
const LEAD = {
  place_id: "ChIJgl", name: "Green Leaf Landscapes", trade: "landscaper", town: "Warrington", search_town: "Warrington",
  address: "1 High Street, Warrington", postcode: "WA1 1AA", phone: "07700 900123", website: "https://greenleaf.co.uk",
  maps_url: "https://maps.google.com/?cid=123", rating: 4.8, review_count: 61, quality_score: 62,
  company_number: "01234567", excluded: false, exclude_reason: null, issues: ["No photos of your work"],
  findings: ["not_mobile", "maps_some_top3"], socials: { facebook: "https://facebook.com/greenleaf" },
  reviews: [{ author: "Sarah K.", rating: 5, text: "Brilliant job on our garden, tidy and on time." }],
  notes: "Call Friday", first_seen_at: "2026-10-01T06:00:00Z", email: "mark@greenleaf.co.uk",
};
const MESSAGE = {
  id: "m-1", direction: "out", kind: "first", step: null, author: "nik", from_addr: "nik@aetoswebsites.com",
  to_addr: "mark@greenleaf.co.uk", subject: "Your new website", body: "Hi Mark,\n\nI made you a website.", status: "sent",
  sent_at: "2026-10-20T08:05:00Z", received_at: null, created_at: "2026-10-20T08:00:00Z", class: null,
};
// A Detail (Part B Task 4's shape); `o.lead` is merged into the lead, everything else replaces.
const detail = (o = {}) => ({
  research: RESEARCH, research_waiting: 2, prospect: PROSPECT,
  demo: { slug: "green-leaf", url: "/d/green-leaf", expires_at: "2027-01-01T00:00:00Z", template: "landscaper" },
  map_rank: { scan_id: "scan-w", keyword: "landscaper", avg_rank: 6.5, top3_pct: 12, found_pct: 80, updated_at: SEED_AT },
  messages: [], calls: [], suppressed: false, offer: offerFor(NOW), guarantee: GUARANTEE,
  ...o,
  lead: { ...LEAD, ...o.lead },
});
const CAP = { mailboxes: 1, paused: [], cap: 10, sent: 0, followupsDue: 7, firstQueued: 0, room: 3, warmupFrom: null };
const draw = (d, o = {}) => drawerHtml(d, { capacity: CAP, sender: "Nik", origin: "https://control.example", now: NOW, ...o });
// A list row (Part B Task 3's shape).
const ROW = {
  place_id: "ChIJgl", name: "Green Leaf Landscapes", trade: "landscaper", town: "Warrington", phone: "07700 900123",
  website: "https://greenleaf.co.uk", rating: 4.8, review_count: 61, quality_score: 62, excluded: false, grade: "A",
  grade_reason: "Owner-run, good reviews, weak site.", research_status: "done", email: "mark@greenleaf.co.uk",
  suppressed: false, stage: "ready", stage_label: "Ready to email", views: 0, last_view_at: null, hot: false,
  demo_slug: "green-leaf", top_issue: "No photos of your work", owner_first: "Mark",
};
// The Write first email button's tag.
const writeButton = (html) => (html.match(/<button[^>]*data-write-email[^>]*>/) || [""])[0];

test("pure: loads in node with no page", () => {
  assert.equal(PURE, true);
});

test("escaping: names, links, reviews and message bodies are inert text", () => {
  const row = leadRowHtml({ ...ROW, name: "<img src=x onerror=alert(1)>" }, { selected: false });
  assert.match(row, /&lt;img/);
  assert.doesNotMatch(row, /<img/);
  noRawHtml(leadRowHtml({ ...ROW, name: XSS, trade: XSS, town: XSS, grade_reason: XSS, email: XSS, stage_label: XSS, place_id: XSS }, {}));

  const html = draw(detail({
    lead: { website: "javascript:alert(1)", reviews: [{ author: XSS, rating: 5, text: "</p><script>x</script>" }] },
    messages: [{ ...MESSAGE, body: "<b>hi</b>", subject: XSS }],
  }));
  assert.doesNotMatch(html, /href="javascript:/);
  assert.ok(plain(html).includes("javascript:alert(1)"), "a javascript: website is shown as text");
  assert.ok(html.includes("&lt;/p&gt;&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes('<pre class="msg-body">&lt;b&gt;hi&lt;/b&gt;</pre>'));
  assert.doesNotMatch(html, /<b>hi<\/b>/);
  noRawHtml(html);

  // Every scraped or inbound field at once, quotes in attributes included.
  const evil = draw(detail({
    lead: {
      name: XSS, trade: XSS, town: XSS, search_town: XSS, address: XSS, postcode: XSS, phone: XSS, website: XSS,
      maps_url: "javascript:alert(1)", company_number: XSS, notes: `</textarea>${XSS}`, exclude_reason: XSS, excluded: true,
      socials: { facebook: "javascript:alert(1)", [XSS]: "https://facebook.com/x" }, reviews: [{ author: XSS, rating: XSS, text: XSS }],
    },
    prospect: { ...PROSPECT, stage_label: XSS },
    demo: { slug: XSS, url: "javascript:alert(1)", expires_at: XSS, template: XSS },
    map_rank: { scan_id: XSS, keyword: XSS, avg_rank: XSS, top3_pct: XSS, found_pct: XSS, updated_at: XSS },
    messages: [{ ...MESSAGE, author: XSS, from_addr: XSS, to_addr: XSS, subject: XSS, body: XSS, status: XSS, kind: XSS, class: XSS }],
  }));
  noRawHtml(evil);
  assert.doesNotMatch(evil, /<\/textarea>"/);
  assert.equal(count(evil, "</textarea>"), 2, "the notes box and stage 2's note box, each closed once");
});

test("buttons follow the stage and today's room", () => {
  const ready = draw(detail());
  assert.match(ready, /Write first email/);
  assert.match(ready, /Not a fit/);
  assert.doesNotMatch(writeButton(ready), /disabled/);

  const emailed = draw(detail({ prospect: { ...PROSPECT, stage: "emailed", stage_label: "Emailed", first_sent_at: SEED_AT } }));
  assert.doesNotMatch(emailed, /Write first email/);
  assert.doesNotMatch(emailed, /Not a fit/);

  const full = draw(detail(), { capacity: { ...CAP, sent: 2, firstQueued: 1, room: 0 } });
  assert.match(full, /No room left today/);
  assert.match(writeButton(full), /\bdisabled\b/);

  const noMailbox = draw(detail(), { capacity: { ...CAP, mailboxes: 0, cap: 0, followupsDue: 0, room: 0 } });
  assert.match(noMailbox, /Add a mailbox first/);
  assert.doesNotMatch(noMailbox, /No room left today/);
  assert.match(writeButton(noMailbox), /\bdisabled\b/);

  // Not contacted yet (no prospect row): Not a fit, but nothing to write yet.
  const fresh = draw(detail({ prospect: null }));
  assert.match(fresh, /Not a fit/);
  assert.doesNotMatch(fresh, /Write first email/);

  // On the do-not-contact list: never writable.
  const blocked = draw(detail({ suppressed: true }));
  assert.match(blocked, /Do not email/);
  assert.match(writeButton(blocked), /\bdisabled\b/);

  // Call, Website, Google, Open demo; the website and maps links only when they're http(s).
  assert.match(ready, /href="tel:07700900123"/);
  assert.match(ready, /href="https:\/\/greenleaf\.co\.uk\/"[^>]*>[^<]*(<svg[^]*?<\/svg>)?\s*Website/);
  assert.match(ready, /href="https:\/\/maps\.google\.com\/\?cid=123"/);
  assert.match(ready, /href="\/d\/green-leaf"[^>]*>[^]*?Open demo/);
  const bare = draw(detail({ lead: { phone: null, website: null, maps_url: null }, demo: null }));
  assert.doesNotMatch(bare, /href="tel:|Open demo/);
  assert.doesNotMatch(bare, />\s*(<svg[^]*?<\/svg>)?\s*Website<\/a>/);
});

test("research card: stage 2's, embedded unchanged", () => {
  const d = detail();
  const html = draw(d);
  assert.ok(html.includes(researchCard({ research: d.research, waiting: d.research_waiting }, { esc, safeUrl })));
  assert.match(html, /Need 4\/5/);
  assert.match(html, /Owner&#39;s own email/);
  // no grade card or point labels of its own: the points appear once, inside the card
  assert.equal(count(html, "Need 4/5"), 1);
  assert.equal(count(html, 'class="points"'), 1);
  assert.equal(count(html, "Claude's research"), 1);

  const none = draw(detail({ research: null }));
  assert.ok(none.includes(researchCard({ research: null, waiting: 2 }, { esc, safeUrl })));
  assert.match(none, /Not queued for research/);
  const waiting = draw(detail({ research: { ...RESEARCH, status: "queued", grade: null, points: null, researched_at: null } }));
  assert.match(waiting, /Waiting for Claude/);
  assert.match(waiting, /2 leads waiting/);
});

test("mount points: #d-demo, #d-email and #d-call exactly once each", () => {
  for (const d of [detail(), detail({ demo: null }), detail({ research: null, prospect: null, map_rank: null }),
    detail({ messages: [MESSAGE], lead: { email: null }, prospect: null })]) {
    const html = draw(d);
    for (const slot of ['<div id="d-demo"></div>', '<div id="d-email"></div>', '<div id="d-call"></div>']) {
      assert.equal(count(html, slot), 1, slot);
    }
    // in Part A's order: research, demo, Maps, email (then the conversation), reviews, call script, facts, notes
    const at = (s) => html.indexOf(s);
    assert.ok(at("Claude's research") < at('<div id="d-demo"></div>'));
    assert.ok(at('<div id="d-demo"></div>') < at("Google Maps"));
    assert.ok(at("Google Maps") < at('<div id="d-email"></div>'));
    assert.ok(at('<div id="d-email"></div>') < at("Conversation"));
    assert.ok(at("Conversation") < at("Top reviews"));
    assert.ok(at("Top reviews") < at("Call script"));
    assert.ok(at("Call script") < at('<div id="d-call"></div>'));
    assert.ok(at('<div id="d-call"></div>') < at("Business facts"));
    assert.ok(at("Business facts") < at('id="d-notes"'));
    // The read-only Conversation is the element right after the #d-email slot, so style.css can hide it once stage
    // 6 mounts its thread (or the composer) there: the messages never show twice.
    assert.match(html, /<div id="d-email"><\/div><div class="conversation" data-conversation><h4 class="thread-head">Conversation<\/h4>/);
    assert.equal(count(html, "data-conversation"), 1);
  }
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /^#d-email:not\(:empty\) \+ \[data-conversation\] \{ display: none; \}$/m);
});

// The link, views, expiry and no-demo reason are stage 4's Demo site card now (public/js/demo.js demoCardHtml, mounted
// into #d-demo by leads.js; tested in demo-ui.test.mjs), so they show once and a lead that won't get a demo never
// reads "made automatically". The section keeps its heading, the slot and Preview.
test("demo: the heading, stage 4's #d-demo slot, a relative Open demo and a preview frame only built when pressed", () => {
  const html = draw(detail({ prospect: { ...PROSPECT, views: 3, last_view_at: "2026-10-20T13:05:00Z" } }));
  assert.match(html, /href="\/d\/green-leaf"/);
  assert.doesNotMatch(html, /href="https?:\/\/[^"]*\/d\/green-leaf/);
  const section = html.slice(html.indexOf("<h3>Demo site</h3>"), html.indexOf("<h3>Google Maps</h3>"));
  assert.match(section, /^<h3>Demo site<\/h3>\s*<div id="d-demo"><\/div>\s*<button class="btn secondary sm" data-preview-toggle/);
  // the card's facts aren't drawn here as well
  for (const d of [detail({ prospect: { ...PROSPECT, views: 3, last_view_at: "2026-10-20T13:05:00Z" } }), detail(), detail({ demo: null })]) {
    assert.doesNotMatch(plain(draw(d)), /Ends 1 Jan 2027|Viewed \d|Not viewed yet|No demo yet|made automatically/);
  }

  // Preview toggle; the frame sits in an inert <template> until it's pressed.
  assert.match(html, /data-preview-toggle/);
  assert.ok(html.includes('src="/api/demo/preview?template=landscaper&amp;place_id=ChIJgl"'));
  const tpl = html.slice(html.indexOf("<template"), html.indexOf("</template>") + "</template>".length);
  assert.match(tpl, /^<template[^>]*>\s*<iframe [^>]*sandbox=""[^>]*loading="lazy"/);
  assert.equal(count(html.replace(tpl, ""), "<iframe"), 0, "no frame outside the template");
  // both values URI-encoded
  const odd = draw(detail({ lead: { place_id: "a&b/c d" }, demo: { slug: "x", url: "/d/x", expires_at: "2027-01-01T00:00:00Z", template: "a&b" } }));
  assert.ok(odd.includes('src="/api/demo/preview?template=a%26b&amp;place_id=a%26b%2Fc%20d"'));

  // no template yet (stage 4 not shipped): no Preview toggle
  const noTemplate = draw(detail({ demo: { slug: "green-leaf", url: "/d/green-leaf", expires_at: "2027-01-01T00:00:00Z", template: null } }));
  assert.doesNotMatch(noTemplate, /data-preview-toggle|<iframe|\/api\/demo\/preview/);
  assert.match(noTemplate, /href="\/d\/green-leaf"/);

  // no live demo: the heading and the slot only (stage 4's card says why), no Preview and no Open demo
  const none = draw(detail({ demo: null }));
  assert.match(none, /<h3>Demo site<\/h3>\s*<div id="d-demo"><\/div>\s*<h3>Google Maps<\/h3>/);
  assert.doesNotMatch(none, /template is approved/);
  assert.doesNotMatch(none, /data-preview-toggle|Open demo/);
  // a link that isn't our relative /d/<slug> is never used
  assert.doesNotMatch(draw(detail({ demo: { slug: "x", url: "//evil.example/d/x", expires_at: "2027-01-01T00:00:00Z", template: null } })),
    /href="\/\/evil/);

  for (const out of [html, noTemplate, none, odd, draw(detail({ demo: { slug: "x", url: "/d/x?preview=1", template: "t" } }))]) {
    assert.doesNotMatch(out, /\?preview=1/);
  }
});

test("owner: the first name only when research marked it confident", () => {
  assert.equal(scriptLead(detail()).owner_first, "Mark");
  assert.equal(scriptLead(detail({ research: { ...RESEARCH, owner: { ...MARK, confident: false } } })).owner_first, null);
  assert.equal(scriptLead(detail({ research: { ...RESEARCH, owner: { ...MARK, confident: "true" } } })).owner_first, null);
  assert.equal(scriptLead(detail({ research: null })).owner_first, null);

  const s = scriptLead(detail(), "https://control.example");
  assert.equal(s.demo_url, "https://control.example/d/green-leaf");
  assert.equal(scriptLead(detail({ demo: null }), "https://control.example").demo_url, "");
  assert.deepEqual(s.angle, RESEARCH.angle);
  assert.deepEqual(s.findings, LEAD.findings);
  assert.deepEqual(s.map_rank, detail().map_rank);
  assert.deepEqual(scriptLead(detail({ map_rank: null })).map_rank, {});
  assert.equal(s.email, "mark@greenleaf.co.uk");
  assert.equal(scriptLead(detail({ prospect: null, lead: { email: null } })).email, null);
  assert.deepEqual([s.name, s.trade, s.town, s.rating, s.review_count], ["Green Leaf Landscapes", "landscaper", "Warrington", 4.8, 61]);

  const unsure = draw(detail({ research: { ...RESEARCH, owner: { ...MARK, confident: false } } }));
  assert.doesNotMatch(unsure, /Hi, is that Mark\?/);
  assert.match(draw(detail()), /Hi, is that Mark\?/);
});

test("call script: from the payload's offer and guarantee, open when there's no email", () => {
  const html = draw(detail());
  assert.ok(html.includes(esc(GUARANTEE.headline)));
  assert.ok(html.includes(esc(GUARANTEE.section)));
  assert.match(html, /£1,950/);
  assert.match(html, /Angle: No photos of their work on Google/);
  assert.match(html, /<details class="script">/, "collapsed when there's an email");
  assert.match(draw(detail({ prospect: null, lead: { email: null } })), /<details class="script" open>/);
  const weekend = draw(detail({ offer: offerFor(SATURDAY) }), { now: SATURDAY });
  assert.match(weekend, /around £2,000/);
  assert.match(weekend, /£1,750/);
  // a payload without the offer: a plain-English line instead of a broken panel
  const broken = draw(detail({ offer: undefined }));
  assert.ok(plain(broken).includes(
    "Couldn't fill in the call script (callScript needs opts.offer and opts.guarantee from /api/leads/:id). Close this lead and open it again."));
  assert.doesNotMatch(broken, /<details class="script"/);
  assert.equal(count(broken, '<div id="d-call"></div>'), 1);
  // a malformed offer (no free days) is the same plain-English line, never "the first undefined days free"
  const noDays = draw(detail({ offer: { ...offerFor(NOW), full: { ...offerFor(NOW).full, freeDays: undefined } } }));
  assert.doesNotMatch(noDays, /undefined/);
  assert.match(plain(noDays), /Couldn't fill in the call script/);
  // no options at all, or null: still a whole panel (no room known, so Write first email isn't held back)
  for (const opts of [undefined, null]) {
    const html = drawerHtml(detail(), opts);
    assert.match(html, /Write first email/);
    assert.equal(count(html, '<div id="d-call"></div>'), 1);
  }
});

test("Maps, reviews, facts and notes", () => {
  const html = draw(detail());
  const text = plain(html);
  assert.match(text, /Average rank #7/);
  assert.match(text, /Top 3 in 12% of Warrington/);
  assert.match(text, /Found in 80%/);
  assert.match(html, /href="#\/maprank\?scan=scan-w&amp;biz=ChIJgl"/);
  assert.match(plain(draw(detail({ map_rank: null }))), /Google Maps Not scanned yet\./);
  assert.match(text, /★★★★★ Sarah K\. Brilliant job on our garden, tidy and on time\./);
  assert.match(plain(draw(detail({ lead: { reviews: [] } }))), /No Google reviews with text/);
  assert.equal(count(draw(detail({ lead: { reviews: Array.from({ length: 5 }, (_, i) => ({ author: `A${i}`, rating: 4, text: `T${i}` })) } })), 'class="review"'), 3);
  assert.ok(text.includes("Found searching landscaper in Warrington, 1 Oct 2026"));
  assert.match(text, /Company 01234567/);
  assert.match(text, /4\.8★ from 61 reviews/);
  assert.match(html, /<textarea id="d-notes"[^>]*>Call Friday<\/textarea>/);
  assert.match(text, /Saves when you click away\./);
  // head: grade, stage, hot
  assert.match(html, /<span class="grade a"[^>]*>A<\/span>/);
  assert.match(text, /Ready to email/);
  const hot = draw(detail({ prospect: { ...PROSPECT, stage: "viewed", stage_label: "Opened demo", views: 2, hot: true } }));
  assert.match(plain(hot), /Opened demo Hot/);
  assert.match(plain(draw(detail({ prospect: null }))), /Not contacted/);
  assert.match(html, /data-x[^>]*aria-label="Close"/);
});

test("conversation: every message oldest first as plain text, or Nothing sent yet", () => {
  assert.equal(plain(threadHtml([])), "Nothing sent yet.");
  assert.equal(plain(threadHtml(undefined)), "Nothing sent yet.");
  const reply = { ...MESSAGE, id: "m-2", direction: "in", kind: "inbound", author: "them", from_addr: "mark@greenleaf.co.uk",
    to_addr: "nik@aetoswebsites.com", subject: "Re: Your new website", body: "How much?", status: "received", sent_at: null,
    received_at: "2026-10-21T09:15:00Z", created_at: "2026-10-21T09:15:00Z", class: "human" };
  const html = threadHtml([MESSAGE, reply]);
  assert.equal(count(html, '<pre class="msg-body">'), 2);
  assert.ok(html.indexOf("I made you a website.") < html.indexOf("How much?"));
  const text = plain(html);
  assert.match(text, /You · 20 Oct 2026, 09:05 · First email/);
  assert.match(text, /Them · 21 Oct 2026, 10:15/);
  assert.match(text, /Your new website/);
  assert.match(text, /nik@aetoswebsites\.com → mark@greenleaf\.co\.uk/);
  assert.match(plain(threadHtml([{ ...MESSAGE, kind: "followup", step: 2, author: "system", status: "queued", sent_at: null }])),
    /Follow-up 2 Waiting to go/);
  assert.match(plain(threadHtml([{ ...reply, class: "bounce" }])), /Bounced/);
  // the drawer shows it under the email slot
  assert.ok(draw(detail({ messages: [MESSAGE, reply] })).includes(html));
  assert.match(plain(draw(detail())), /Conversation Nothing sent yet\./);
});

test("list row: grade, business, why, email, stage, score", () => {
  const html = leadRowHtml(ROW, { selected: true });
  assert.match(html, /^<tr class="click sel" data-id="ChIJgl">/);
  assert.match(html, /<span class="grade a"[^>]*>A<\/span>/);
  const text = plain(html);
  assert.match(text, /Green Leaf Landscapes landscaper · Warrington · Owner: Mark/);
  assert.match(text, /Owner-run, good reviews, weak site\./);
  assert.match(text, /mark@greenleaf\.co\.uk/);
  assert.match(text, /Ready to email/);
  assert.match(text, /62$/);
  assert.match(leadRowHtml(ROW, {}), /^<tr class="click" data-id="ChIJgl">/);
  const other = plain(leadRowHtml({ ...ROW, grade: null, grade_reason: null, research_status: null, email: null, suppressed: true,
    stage: "viewed", stage_label: "Opened demo", hot: true, owner_first: null, excluded: true }, {}));
  assert.match(other, /No photos of your work/, "the top issue when there's no grade reason");
  assert.match(other, /No email/);
  assert.match(other, /Do not email/);
  assert.match(other, /Opened demo Hot/);
  assert.match(other, /Excluded/);
  assert.doesNotMatch(other, /Owner:/);
  assert.match(plain(leadRowHtml({ ...ROW, grade_reason: null, top_issue: null, research_status: null }, {})), /Not researched yet/);
});

test("grade badges", () => {
  assert.equal(gradeBadge("A+"), '<span class="grade aplus" title="Grade A+">A+</span>');
  for (const [g, cls] of [["A", "a"], ["B", "b"], ["C", "c"], ["D", "d"]]) assert.equal(gradeBadge(g), `<span class="grade ${cls}" title="Grade ${g}">${g}</span>`);
  for (const g of [null, undefined, "", "E", "A ", "__proto__", XSS]) assert.equal(gradeBadge(g), '<span class="grade none" title="Not graded">–</span>');
});

test("banner", () => {
  const warn = bannerHtml({ tone: "warn", text: "Add your mailbox on Setup to start emailing.", link: { href: "#/setup", label: "Open Setup" } });
  assert.match(warn, /href="#\/setup"/);
  assert.match(warn, /class="banner warn"/);
  assert.equal(plain(warn), "Add your mailbox on Setup to start emailing. Open Setup");
  const ok = bannerHtml({ tone: "ok", text: "You can send 3 first emails today (10 a day, 7 follow-ups already due).", link: null });
  assert.match(ok, /class="banner ok"/);
  assert.doesNotMatch(ok, /<a /);
  noRawHtml(bannerHtml({ tone: `ok" onclick="x`, text: XSS, link: { href: "javascript:alert(1)", label: XSS } }));
  assert.match(bannerHtml({ tone: `ok" onclick="x`, text: "x", link: null }), /class="banner info"/);
  // in-app links in either form (#/… or /#/…, as todos store them) are kept; other relative or protocol links aren't
  assert.match(bannerHtml({ tone: "warn", text: "x", link: { href: "/#/setup", label: "Open Setup" } }), /href="\/#\/setup"/);
  for (const href of ["//evil.example/#/setup", "/setup", "data:text/html,x"]) {
    assert.doesNotMatch(bannerHtml({ tone: "warn", text: "x", link: { href, label: "Open Setup" } }), /<a /, href);
  }
  assert.equal(bannerHtml(null), "");
});

test("chips: Ready shows A+, A and B (B only with spare room); All shows all six and the stages", () => {
  const counts = { "A+": 4, "A": 12, "B": 30, "C": 0, "D": 0, none: 171 };
  const ready = filterBarHtml({ view: "ready", grades: ["A+", "A"] }, { grade_counts: counts, ready: { b_included: false } });
  assert.ok(ready.includes('A+ <span class="n">4</span>'));
  assert.ok(ready.includes('A <span class="n">12</span>'));
  assert.match(ready, /data-grade="B"[^>]*>B <span class="n">30<\/span> <span class="spare">Spare room only<\/span>/);
  assert.match(ready, /<button class="chip off"[^>]*data-grade="B"[^>]*disabled/);
  assert.match(ready, /<button class="chip on"[^>]*data-grade="A\+"/);
  for (const g of ["C", "D", "none"]) assert.doesNotMatch(ready, new RegExp(`data-grade="${g}"`));
  assert.doesNotMatch(ready, /Not graded/);
  assert.doesNotMatch(ready, /data-stage=/);
  assert.doesNotMatch(ready, /id="f-email"|id="f-researched"|id="f-excluded"/);
  // B in Ready when there's spare room
  const spare = filterBarHtml({ view: "ready", grades: null }, { grade_counts: counts, ready: { b_included: true } });
  assert.doesNotMatch(spare, /Spare room only|chip off/);
  assert.match(spare, /<button class="chip"[^>]*data-grade="B"/);

  const all = filterBarHtml({ view: "all", grades: ["none"], stages: ["ready", "none"], email: true, researched: false, excluded: true },
    { grade_counts: counts, ready: { b_included: false } });
  for (const [g, label, n] of [["A+", "A+", 4], ["A", "A", 12], ["B", "B", 30], ["C", "C", 0], ["D", "D", 0], ["none", "Not graded", 171]]) {
    assert.ok(all.includes(`data-grade="${esc(g)}"`), g);
    assert.ok(all.includes(`${label} <span class="n">${n}</span>`), label);
  }
  assert.doesNotMatch(all, /Spare room only/);
  for (const s of STAGE_TOKENS) assert.ok(all.includes(`data-stage="${s}"`), s);
  for (const label of Object.values(SERVER_STAGE_LABELS)) assert.ok(all.includes(`>${label}</button>`), label);
  assert.match(all, /<button class="chip on"[^>]*data-stage="none"/);
  assert.match(all, /<button class="chip on"[^>]*data-grade="none"/);
  assert.match(all, /<option value="1" selected>Has email<\/option>/);
  assert.match(all, /<option value="0" selected>Not researched<\/option>/);
  assert.match(all, /id="f-excluded" checked/);
});

test("tabs, facets, search and the run filter", () => {
  const data = {
    grade_counts: { "A+": 1, "A": 2, "B": 0, "C": 0, "D": 0, none: 3 }, ready: { b_included: false },
    view_counts: { ready: 3, all: 213 },
    facets: { trades: [{ value: "landscaper", n: 200 }, { value: XSS, n: 1 }], towns: [{ value: "Warrington", n: 213 }] },
  };
  const html = filterBarHtml({ view: "all", grades: null, trade: "landscaper", town: "Runcorn", q: `o'neill "100%"`, job: "j1" }, data);
  const text = plain(html);
  assert.match(text, /Ready to email \(3\)/);
  assert.match(text, /All leads \(213\)/);
  assert.match(html, /<button class="active"[^>]*data-view="all"/);
  assert.match(html, /<option value="landscaper" selected>landscaper \(200\)<\/option>/);
  assert.match(html, /<option value="Runcorn" selected>Runcorn<\/option>/, "a town from the URL stays picked");
  assert.match(html, /id="f-search"[^>]*maxlength="100"/);
  assert.ok(html.includes(`value="o&#39;neill &quot;100%&quot;"`));
  assert.match(html, /data-clear-job/);
  assert.doesNotMatch(filterBarHtml({ view: "all" }, data), /data-clear-job/);
  noRawHtml(html);
  // page 2 and later: no counts, still the chips
  const later = filterBarHtml({ view: "ready" }, { grade_counts: null, view_counts: null, ready: null });
  assert.match(later, /data-grade="A\+"[^>]*>A\+<\/button>/);
  assert.match(plain(later), /Ready to email All leads/);
});

test("stage labels match the server's", () => {
  assert.deepEqual({ ...STAGE_LABELS }, { ...SERVER_STAGE_LABELS });
});

test("a real payload from leadDetail renders", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "gl", name: "Green Leaf Landscapes", phone: "07700 900123", website: "https://greenleaf.co.uk",
    email: "info@greenleaf.co.uk", audit: { findings: ["no_website"], reviews: [{ author: "Sarah K.", rating: 5, text: "<b>Great</b>" }] } });
  await seedResearch(DB, { place_id: "gl", points: POINTS, owner: MARK, angle: RESEARCH.angle, best_email: "mark@greenleaf.co.uk" });
  await seedProspect(DB, { place_id: "gl", email: "mark@greenleaf.co.uk" });
  await seedDemo(DB, { place_id: "gl", slug: "green-leaf" });
  await seedMessage(DB, { place_id: "gl", body: "<script>x</script>" });
  const d = await leadDetail(DB, "gl", NOW);
  const html = draw(d);
  assert.ok(html.includes(researchCard({ research: d.research, waiting: d.research_waiting }, { esc, safeUrl })));
  assert.match(html, /href="\/d\/green-leaf"/);
  assert.match(html, /Write first email/);
  assert.match(html, /Hi, is that Mark\?/);
  assert.ok(html.includes("&lt;b&gt;Great&lt;/b&gt;"));
  assert.ok(html.includes('<pre class="msg-body">&lt;script&gt;x&lt;/script&gt;</pre>'));
  noRawHtml(html);
  for (const slot of ["d-demo", "d-email", "d-call"]) assert.equal(count(html, `<div id="${slot}"></div>`), 1);
});

test("lib.js re-exports html.js's esc, safeUrl and icon", async () => {
  globalThis.document = { getElementById: () => null };
  try {
    const lib = await import("../public/js/lib.js");
    assert.equal(lib.esc, esc);
    assert.equal(lib.safeUrl, safeUrl);
    assert.equal(lib.icon, icon);
    assert.equal(lib.pageHead(XSS, ""), `<div class="page-head"><div><h1>${esc(XSS)}</h1></div></div>`);
  } finally {
    delete globalThis.document;
  }
});

// ---------------------------------------------------------------- Task 8: routes and the page's query string

test("routes", () => {
  assert.deepEqual({ ...parseRoute("#/lead/ChIJ123"), params: undefined }, { page: "leads", leadId: "ChIJ123", params: undefined });
  assert.equal(parseRoute("#/leads?view=all&job=j1").params.get("job"), "j1");
  assert.equal(parseRoute("#/nope").page, "nope");          // unknown pages are app.js's job (PAGES.find → home)
  assert.equal(parseRoute("#/replies?x=1").page, "replies"); // later stages' routes pass through
  assert.equal(parseRoute("").page, "home");
  assert.equal(parseRoute("#/").page, "home");
  assert.equal(parseRoute("#/leads").leadId, null);
});

test("client query string round-trips through the server parser", () => {
  const q = { view: "all", grades: ["A+", "A", "none"], trade: "landscaper", town: null, email: true, stages: ["none"],
    researched: null, q: "o'neill 100%", excluded: false, job: null, page: 2 };
  const back = parseLeadFilters(new URLSearchParams(leadsQueryString(q)));   // from ../functions/_lib/shortlist.js
  assert.deepEqual(back, { ...q });
});

test("routes: lead ids decoded, every other page passes through with its query", () => {
  assert.equal(parseRoute("#/lead/ChIJ%2B1_x-y").leadId, "ChIJ+1_x-y");
  assert.equal(parseRoute("#/lead/50%").leadId, "50%", "a malformed escape is kept as it is");
  for (const hash of ["#/lead", "#/lead/", "#lead/"]) assert.deepEqual({ ...parseRoute(hash), params: undefined }, { page: "leads", leadId: null, params: undefined }, hash);
  assert.equal(parseRoute("#/scraper?job=j1").params.get("job"), "j1");
  assert.equal(parseRoute("#/maprank?scan=s1&biz=b2").page, "maprank");
  assert.equal(parseRoute("#/setup?at=business").params.get("at"), "business");
  assert.equal(parseRoute(undefined).page, "home");
  assert.equal(parseRoute("#/leads?view=all&grade=ap,a").params.get("grade"), "ap,a");
  assert.equal(parseRoute("#/lead/x?view=all").params.get("view"), "all");
});

// Inputs the page can meet in its URL: every filter, bad values, repeats, wildcards, emoji, a huge search.
const URLS = ["", "view=all", "view=ready", "view=ALL", "grade=ap,a,b,c,d,none", "grade=A+", "grade=ap&grade=b,zz,__proto__,constructor",
  "grade=ap,ap,a", "grade=", "stage=ready,none,hot", "stage=__proto__,won", "trade=landscaper&town=Warrington", "trade=&town=",
  "email=1", "email=0", "email=x", "researched=1", "researched=0", "excluded=1", "excluded=true", "job=j1", "page=0", "page=abc",
  "page=3", "page=1234567890", "page=-2", "q=" + "x".repeat(500), "q=%20%20o%27neill%20100%25%20", "q=a_b%5C%25", "q=" + "%F0%9F%98%80".repeat(150),
  "q=%20%20%20", "view=all&grade=none&stage=none&email=0&researched=0&excluded=1&q=100%25&job=j%2C2&page=2&trade=a%2Cb"];

test("the page reads its URL exactly as the server's parseLeadFilters does", () => {
  for (const u of URLS) {
    assert.deepEqual(parseLeadsQuery(new URLSearchParams(u)), parseLeadFilters(new URLSearchParams(u)), u);
    assert.deepEqual(parseLeadsQuery(u), parseLeadFilters(u), `${u} (as text)`);
  }
  assert.deepEqual(parseLeadsQuery(undefined), parseLeadFilters(""));
});

test("every query the page can hold round-trips through its URL", () => {
  for (const u of URLS) {
    const q = parseLeadFilters(new URLSearchParams(u));
    const qs = leadsQueryString(q);
    assert.deepEqual(parseLeadFilters(new URLSearchParams(qs)), q, `${u} → ${qs}`);
    assert.deepEqual(parseLeadsQuery(parseRoute(`#/leads?${qs}`).params), q, `${u} via the hash`);
    assert.doesNotMatch(qs, /grade=[^&]*(A\+|A%2B)/, "never A+ in a URL");
  }
  const none = parseLeadFilters("");
  assert.equal(leadsQueryString(none), "");
  assert.equal(leadsQueryString({ ...none, grades: ["A+"] }), "grade=ap");
  assert.equal(leadsQueryString({ ...none, view: "all", grades: ["A+", "A", "none"], stages: ["ready", "none"] }), "view=all&grade=ap,a,none&stage=ready,none");
  assert.equal(leadsQueryString({ ...none, page: 1, excluded: false, email: null, q: "   " }), "");
  assert.equal(leadsQueryString({ ...none, grades: ["E", "__proto__"], stages: ["hot"] }), "", "unknown values are left out");
  assert.equal(leadsQueryString(null), "");
});

const DATA = {
  rows: [ROW, { ...ROW, place_id: "p2", name: "Second & Sons", grade: "A+" }], total: 213, page: 1, pages: 5,
  grade_counts: { "A+": 4, "A": 12, "B": 30, "C": 0, "D": 0, none: 167 }, view_counts: { ready: 16, all: 213 },
  facets: { trades: [{ value: "landscaper", n: 213 }], towns: [{ value: "Warrington", n: 213 }] },
  capacity: { ...CAP, banner: { tone: "ok", text: "You can send 3 first emails today (10 a day, 7 follow-ups already due).", link: null } },
  ready: { top: 16, b: 30, b_included: false, grades: ["A+", "A"], waiting_demo: 0 },
};
const READY_Q = parseLeadFilters("");
const ALL_Q = parseLeadFilters("view=all");

test("the page body: banner, tabs and chips, the table, and Showing 1–50 of 213", () => {
  const html = leadsBodyHtml(READY_Q, DATA, { selected: "p2" });
  assert.ok(html.includes(bannerHtml(DATA.capacity.banner)));
  assert.ok(html.includes(filterBarHtml(READY_Q, DATA)));
  assert.ok(html.indexOf('class="banner ok"') < html.indexOf('data-view="ready"'));
  assert.ok(html.indexOf('data-view="ready"') < html.indexOf("<table"));
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Grade", "Business", "Why", "Email", "Stage", "Score"]);
  assert.ok(html.includes(leadRowHtml(ROW, { selected: false })));
  assert.ok(html.includes(leadRowHtml(DATA.rows[1], { selected: true })));
  assert.match(plain(html), /Showing 1–2 of 213 Previous Next$/);
  assert.match(html, /<button class="btn secondary sm" data-page="0" disabled>Previous<\/button>/);
  assert.match(html, /<button class="btn secondary sm" data-page="2">Next<\/button>/);
  const last = leadsBodyHtml({ ...ALL_Q, page: 5 }, { ...DATA, rows: Array.from({ length: 13 }, (_, i) => ({ ...ROW, place_id: `x${i}` })), page: 5, total: 1213, pages: 25 });
  assert.match(plain(last), /Showing 201–213 of 1,213/);
  const one = leadsBodyHtml(ALL_Q, { ...DATA, total: 2, pages: 1 });
  assert.match(plain(one), /Showing 1–2 of 2$/);
  assert.doesNotMatch(one, /data-page=/, "one page: no Previous / Next");
  noRawHtml(leadsBodyHtml(ALL_Q, { ...DATA, rows: [{ ...ROW, name: XSS, place_id: XSS, email: XSS, grade_reason: XSS }],
    capacity: { banner: { tone: "warn", text: XSS, link: { href: "javascript:alert(1)", label: XSS } } } }));
});

test("the page body's empty states (Part A, exactly)", () => {
  const empty = { ...DATA, rows: [], total: 0, pages: 1 };
  const text = (q, d) => plain(leadsBodyHtml(q, d)).replace(/^.*?All leads(?: \(\d+\))?/, "").trim();
  assert.ok(text(READY_Q, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 2 } })
    .endsWith("No leads are ready to email yet. 2 A-grade leads are waiting for their demo site."));
  assert.ok(text(READY_Q, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 1 } })
    .endsWith("No leads are ready to email yet. 1 A-grade lead is waiting for their demo site."));
  const none = leadsBodyHtml(READY_Q, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 0 } });
  assert.ok(plain(none).endsWith("No A-grade leads yet. Claude grades new leads every morning at 06:47. See all leads"));
  assert.match(none, /<a class="btn secondary sm" href="#\/leads\?view=all">See all leads<\/a>/);
  // A-grade leads exist but none is ready or waiting (all emailed or hidden): "No A-grade leads yet" would be untrue.
  const gone = leadsBodyHtml(READY_Q, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 0, graded_top: 4 } });
  assert.ok(plain(gone).endsWith("No leads are ready to email right now. None of your A-grade leads is waiting for its demo site. See your A-grade leads"));
  assert.doesNotMatch(gone, /No A-grade leads yet/);
  const href = gone.match(/href="#\/leads\?([^"]*)">See your A-grade leads/)[1].replaceAll("&amp;", "&");
  assert.deepEqual({ view: parseLeadFilters(href).view, grades: parseLeadFilters(href).grades }, { view: "all", grades: ["A+", "A"] });
  assert.ok(plain(leadsBodyHtml(READY_Q, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 0, graded_top: 0 } }))
    .endsWith("No A-grade leads yet. Claude grades new leads every morning at 06:47. See all leads"));
  assert.ok(plain(leadsBodyHtml(READY_Q, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 2, graded_top: 9 } }))
    .endsWith("No leads are ready to email yet. 2 A-grade leads are waiting for their demo site."));
  for (const q of [{ ...ALL_Q, grades: ["C"] }, { ...ALL_Q, stages: ["won"] }, { ...ALL_Q, email: false }, { ...ALL_Q, q: "zzz" },
    { ...READY_Q, trade: "roofer" }, { ...READY_Q, job: "j1" }, { ...READY_Q, grades: ["B"] }]) {
    const html = leadsBodyHtml(q, empty);
    assert.ok(plain(html).endsWith("No leads match these filters. Clear filters"), JSON.stringify(q));
    assert.match(html, /<button class="btn secondary sm" data-clear-filters>Clear filters<\/button>/);
  }
  assert.ok(plain(leadsBodyHtml(ALL_Q, empty)).endsWith("No leads yet. Find some on the Lead Scraper page. Open Lead Scraper"));
  // Ready has no C, D or Not graded chip and the server ignores those tokens there (listLeads), so a link carrying one
  // (e.g. from All leads) still gets Ready's own empty state, not "No leads match these filters."
  for (const grades of [["C"], ["D", "none"]]) {
    const html = leadsBodyHtml({ ...READY_Q, grades }, { ...empty, ready: { ...DATA.ready, top: 0, waiting_demo: 0 } });
    assert.ok(plain(html).endsWith("No A-grade leads yet. Claude grades new leads every morning at 06:47. See all leads"), grades.join());
    assert.doesNotMatch(html, /data-clear-filters/);
  }
  assert.ok(plain(leadsBodyHtml({ ...READY_Q, grades: ["C", "A"] }, empty)).endsWith("No leads match these filters. Clear filters"));
  assert.ok(plain(leadsBodyHtml({ ...ALL_Q, grades: ["none"] }, empty)).endsWith("No leads match these filters. Clear filters"));
  assert.ok(plain(leadsBodyHtml({ ...ALL_Q, excluded: true }, empty)).endsWith("Open Lead Scraper"), "Show excluded only widens");
  // past the last page
  const past = leadsBodyHtml({ ...ALL_Q, page: 9 }, { ...empty, total: 60, page: 9, pages: 2, grade_counts: null });
  assert.match(past, /data-page="1">Back to the first page/);
  // nothing at all from the server: still a page, no crash
  assert.match(leadsBodyHtml(undefined, undefined), /No A-grade leads yet/);
});

test("an API error: its own text in red, and where to look", () => {
  const html = leadsErrorHtml("The database isn't connected <b>yet</b>.");
  assert.equal(html, `<p class="error">The database isn&#39;t connected &lt;b&gt;yet&lt;/b&gt;.</p><p class="hint">Open <a href="#/setup">Setup</a> to see what's connected.</p>`);
  assert.match(leadsErrorHtml(""), /Couldn&#39;t load your leads\./);
});

test("Not a fit: the dialog's words and the reason sent", () => {
  assert.deepEqual([...NOT_A_FIT_REASONS], ["Too big (not owner-run)", "Front-desk business", "Wrong trade", "Already doing well online", "Other"]);
  const html = notAFitHtml(XSS);
  const text = plain(html);
  assert.match(text, /^Why isn't it a fit\?/);
  for (const r of NOT_A_FIT_REASONS) assert.ok(html.includes(`<input type="radio" name="fit" value="${esc(r)}"> ${esc(r)}</label>`), r);
  assert.ok(html.includes(`<textarea id="fit-text" rows="2" maxlength="${FIT_TEXT_MAX}">`));
  // whatever is picked, a full text box still fits the server's 3 to 200 characters (no confusing 400)
  assert.equal(FIT_TEXT_MAX, 173);
  for (const r of NOT_A_FIT_REASONS) {
    const reason = notAFitReason(r, "x".repeat(FIT_TEXT_MAX));
    assert.ok([...reason].length <= 200, `${r}: ${[...reason].length}`);
    assert.ok([...reason].length >= 3);
  }
  assert.match(html, /<button class="btn" type="submit" data-fit-send>Hide this lead<\/button>/);
  assert.match(html, /<form id="fit-form" novalidate>/);
  assert.match(html, /data-fit-error hidden/);
  noRawHtml(html);
  assert.equal(notAFitReason("Wrong trade", ""), "Wrong trade");
  assert.equal(notAFitReason("Wrong trade", "  a garden\n centre "), "Wrong trade: a garden centre");
  assert.equal(notAFitReason("Other", " They sell sheds "), "They sell sheds");
  assert.equal(notAFitReason("Other", ""), "", "Other needs words: the server's 400 says so");
  assert.equal(notAFitReason("", "x"), "x");
  assert.equal(notAFitReason("<b>made up</b>", ""), "", "only the listed choices");
});

// ---------------------------------------------------------------- the wiring files (they need a page to load)

const js = (name) => readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");
const pageStub = () => {
  const el = () => ({ innerHTML: "", querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  return { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() };
};
async function withPage(fn) {
  const had = Object.hasOwn(globalThis, "document");
  if (!had) globalThis.document = pageStub();
  try { return await fn(); } finally { if (!had) delete globalThis.document; }
}

test("leads.js: leadsPage(params), openLeadDrawer(placeId) and closeDrawer; the old table and Start outreach are gone", async () => {
  const leads = await withPage(() => import("../public/js/leads.js"));
  for (const name of ["leadsPage", "openLeadDrawer", "closeDrawer"]) assert.equal(typeof leads[name], "function", name);
  for (const gone of ["leadsTable", "bindTable", "openDrawer", "enrol", "saveLead", "STATUSES", "FILTERS", "NO_SITE"]) {
    assert.equal(leads[gone], undefined, gone);
  }
  const src = js("leads.js");
  assert.ok(src.includes('import("./compose.js")'), "stage 6's composer, loaded only when pressed");
  assert.ok(src.includes('"Writing emails arrives with the next stage."'));
  assert.ok(src.includes("mountEmail("));
  assert.ok(src.includes('toast("Marked not a fit. It won\'t show in Ready to email.")'));
  assert.ok(src.includes("/not-a-fit`"));
  assert.ok(src.includes("/api/research/${encodeURIComponent(id)}/wrong"), "stage 2's Research is wrong route");
  assert.ok(src.includes("SEARCH_WAIT_MS = 300"));
  // Today's room comes in the panel's own answer, so it's never unknown (opened from Home, or long after the list).
  assert.match(src, /\(\{ detail, capacity \} = await api\(`\/api\/leads\/\$\{encodeURIComponent\(id\)\}`\)\)/);
  assert.match(src, /drawerHtml\(detail, \{ capacity: capacity \?\? null,/);
  assert.doesNotMatch(src, /CAPACITY_FRESH_MS|capacityAt/, "no second-hand room from the list");
  assert.doesNotMatch(src, /\/api\/outreach\/enrol|Start outreach|\/api\/research\/\$\{encodeURIComponent\(id\)\}`\)/,
    "no Start outreach, and the research comes in the panel's one request");
  assert.doesNotMatch(src, /innerHTML\s*=\s*`[^`]*\$\{(?!icon\(|esc\(|pageHead\(|inner\})/, "anything put in the page by hand is escaped");
});

test("app.js routes through parseRoute and PAGES; #/lead/<id> opens the Leads page then its panel", () => {
  const app = js("app.js");
  assert.match(app, /import \{ parseRoute \} from "\.\/leadview\.js";/);
  assert.match(app, /parseRoute\(location\.hash\)/);
  assert.match(app, /PAGES\.find\(\(p\) => p\.route === name\) \|\| PAGES\.find\(\(p\) => p\.route === "home"\)/);
  assert.match(app, /\{ route: "leads", label: "Leads", icon: "users", render: \(params\) => leadsPage\(params\) \}/);
  assert.ok(app.indexOf("await page.render(params)") < app.indexOf("openLeadDrawer(leadId)"));
  assert.ok(app.indexOf("closeDrawer();") < app.indexOf("await page.render(params)"));
  assert.doesNotMatch(app, /function currentPage/);
  const routes = [...app.matchAll(/route: "([^"]*)"/g)].map((m) => m[1]);
  // stage 4's Demo page is routed (#/demo) but not in the nav; stage 5–6's Voice page sits after Money
  assert.deepEqual(routes, ["home", "leads", "scraper", "maprank", "money", "voice", "demo", "setup"]);
  assert.match(app, /\{ route: "demo", [^}]*nav: false \}/);
});

test("Lead Scraper: a finished run links to its leads instead of its own table; Home opens the new panel", async () => {
  const src = js("scraper.js");
  assert.doesNotMatch(src, /from "\.\/leads\.js"|leadsTable|bindTable|\/api\/leads\?job=/);
  const { seeLeadsHtml } = await withPage(() => import("../public/js/scraper.js"));
  const html = seeLeadsHtml({ id: "j 1&x", status: "done", found: 41, pitchable: 12 });
  assert.match(html, /href="#\/leads\?view=all&amp;job=j%201%26x&amp;excluded=1"/);
  assert.match(plain(html), /12 worth pitching of 41 found\. See these 41 leads$/);
  assert.match(plain(seeLeadsHtml({ id: "j", found: 1, pitchable: 1 })), /See this lead$/);
  assert.match(plain(seeLeadsHtml({ id: "j", found: "7", pitchable: "3" })), /See these 7 leads$/, "D1 numbers as text");
  assert.equal(plain(seeLeadsHtml({ id: "j", found: 0, pitchable: 0 })), "This search didn't find any businesses.");
  noRawHtml(seeLeadsHtml({ id: XSS, found: 3, pitchable: XSS }));
  // The button counts the run's leads now (GET /api/jobs leads_now), not its history: a later search moves the
  // leads it finds again under that run, so the link lists fewer.
  const moved = seeLeadsHtml({ id: "j", status: "done", found: 41, pitchable: 12, leads_now: 30 });
  assert.match(plain(moved),
    /^12 worth pitching of 41 found\. 11 of them were found again by a later search, so they're listed under that run\. See these 30 leads$/);
  assert.match(moved, /href="#\/leads\?view=all&amp;job=j&amp;excluded=1"/);
  assert.match(plain(seeLeadsHtml({ id: "j", found: 3, pitchable: 3, leads_now: 2 })),
    /1 of them was found again by a later search, so it's listed under that run\. See these 2 leads$/);
  assert.match(plain(seeLeadsHtml({ id: "j", found: 3, pitchable: 3, leads_now: 1 })), /See this lead$/);
  assert.equal(plain(seeLeadsHtml({ id: "j", found: 41, pitchable: 12, leads_now: 41 })), "12 worth pitching of 41 found. See these 41 leads");
  assert.match(plain(seeLeadsHtml({ id: "j", found: "7", pitchable: "3", leads_now: "5" })), /See these 5 leads$/, "D1 numbers as text");
  const allMoved = seeLeadsHtml({ id: "j", found: 5, leads_now: 0 });
  assert.equal(plain(allMoved), "A later search found all of these again: they're listed under that run. See all leads");
  assert.doesNotMatch(allMoved, /class="btn|job=/, "no button to an empty list");
  assert.match(allMoved, /href="#\/leads\?view=all"/);
  noRawHtml(seeLeadsHtml({ id: XSS, found: 3, pitchable: XSS, leads_now: XSS }));
  const home = js("home.js");
  assert.match(home, /import \{ openLeadDrawer \} from "\.\/leads\.js";/);
  assert.match(home, /openLeadDrawer\(next\[Number\(el\.dataset\.i\)\]\?\.place_id\)/);
  assert.doesNotMatch(home, /openDrawer\(/);
  // its "All leads" and "See all" links say All leads, so they open All leads (#/leads alone is Ready to email)
  assert.match(home, /href="#\/leads\?view=all">All leads<\/a>/);
  assert.match(home, /href="#\/leads\?view=all">See all<\/a>/);
});

test("GET /api/jobs: leads_now is what the run's See these leads link then lists", async () => {
  const DB = fakeD1();
  for (const [id, found, created_at] of [["job0", 2, "2026-08-01T06:00:00Z"], ["job1", 3, "2026-09-01T06:00:00Z"], ["job2", 5, "2026-10-01T06:00:00Z"]]) {
    await DB.prepare(`INSERT INTO jobs (id, trade, town, max_results, status, found, pitchable, created_at, updated_at)
      VALUES (?1, 'landscaper', 'Warrington', 60, 'done', ?2, 1, ?3, ?3)`).bind(id, found, created_at).run();
  }
  // job0 found x4 and x5, job1 x1–x3; then job2 found x1, x2, x4 and x5 again (the scraper's upsert moves their
  // last_job_id to it) and an excluded chain, which the link lists too (Show excluded is on).
  for (const id of ["x4", "x5"]) await seedLead(DB, { place_id: id, last_job_id: "job0" });
  for (const id of ["x1", "x2", "x3"]) await seedLead(DB, { place_id: id, last_job_id: "job1" });
  await DB.prepare("UPDATE leads SET last_job_id = 'job2' WHERE place_id IN ('x1', 'x2', 'x4', 'x5')").run();
  await seedLead(DB, { place_id: "chain", last_job_id: "job2", excluded: 1, exclude_reason: "Chain" });
  const { onRequestGet: jobsRoute } = await import("../functions/api/jobs.js");
  const { jobs } = await (await jobsRoute({ env: { DB } })).json();
  assert.deepEqual(jobs.map((j) => [j.id, j.found, j.leads_now]), [["job2", 5, 5], ["job1", 3, 1], ["job0", 2, 0]]);
  const { seeLeadsHtml } = await withPage(() => import("../public/js/scraper.js"));
  for (const job of jobs) {
    const listed = await listLeads(DB, parseLeadFilters(new URLSearchParams(`view=all&job=${job.id}&excluded=1`)), NOW);
    assert.equal(listed.total, job.leads_now, job.id);
    const button = plain(seeLeadsHtml(job)).match(/See (?:these (\d+) leads|this lead)$/);
    assert.equal(button ? Number(button[1] ?? 1) : 0, listed.total, `${job.id}'s button`);
  }
});

test("style.css: one set of grade rules extended for the badges, and the new page's pieces", () => {
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.equal(css.match(/^\.grade \{/gm).length, 1, "one .grade rule");
  assert.equal(css.match(/^\.grade\.aplus \{/gm).length, 1, "one .grade.aplus rule");
  assert.match(css, /^\.grade\.aplus \{[^}]*background: var\(--gold\); color: var\(--gold-ink\)/m, "A+ gold fill, charcoal letter");
  assert.match(css, /^\.grade\.a \{[^}]*border-color: var\(--gold\)/m, "A gold outline");
  for (const g of ["b", "c", "d", "none"]) assert.match(css, new RegExp(`^\\.grade\\.${g} \\{`, "m"), g);
  for (const g of ["b", "c", "d", "none"]) assert.doesNotMatch(css.match(new RegExp(`^\\.grade\\.${g} \\{[^}]*\\}`, "m"))[0], /gold/, `${g} isn't gold`);
  for (const sel of [".chips {", ".chip.on", ".chip.off", ".banner.ok", ".banner.info", ".banner.warn", ".msg {", ".pager {"]) assert.ok(css.includes(sel), sel);
  assert.match(css, /\.msg-body \{[^}]*white-space: pre-wrap/);
  assert.equal(css.split("{").length, css.split("}").length, "braces balance");
});
