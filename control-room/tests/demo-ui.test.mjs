// The Demo page (#/demo) and the lead drawer's Demo site card (stage 4, docs/rebuild/05-demo.md Task 14 and Part A
// "What Nik sees"): public/js/demo.js's pure renderers. demoCardHtml (mounted by leads.js into stage 3's #d-demo slot
// from GET /api/demo/lead/:id), lookCardHtml (one card per look, from GET /api/demo), demosTableHtml (the Demo sites
// table) and demoBodyHtml (the page under its title). "Open demo" is always the relative /d/<slug> (Nik's login cookie
// goes with it, so his own views never count); "Copy link" copies the https link the email carries. Everything from a
// lead, Claude or the server is escaped. demo.js touches no page when it loads, so this file needs none.
// Run: node --test control-room/tests/demo-ui.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { approveTemplate, ensureDemo } from "../functions/_lib/demo-db.js";
import { db } from "../functions/_lib/util.js";
import { onRequestGet as demoRoute } from "../functions/api/demo/index.js";
import { onRequestGet as leadRoute } from "../functions/api/demo/lead/[id].js";
import {
  demoBodyHtml, demoCardErrorHtml, demoCardHtml, demosTableHtml, lookCardHtml,
} from "../public/js/demo.js";
import { gradeBadge } from "../public/js/leadview.js";
import { LEADS } from "./fixtures/demo-fixtures.mjs";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedLead, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

// demo.js (and html.js, leadview.js) loaded above with no page at all.
const PURE = typeof globalThis.document === "undefined";

const NOW = new Date("2026-10-21T10:00:00Z"); // Wed 21 Oct 2026, 11:00 UK (BST)
const XSS = `"><img src=x onerror=alert(1)>`;
const noRawHtml = (html) => assert.doesNotMatch(html, /<img|<script|onerror="|href="javascript:/i);
const count = (html, s) => html.split(s).length - 1;
// The text a person reads: tags dropped, entities decoded, spaces collapsed (none left before a full stop).
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ \./g, ".").trim();
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const READY = {
  demo: { slug: "a-b-7k2p9q", url: "https://aetoswebsites.com/d/a-b-7k2p9q", expires_at: "2027-04-17T10:00:00Z" },
  views: 3, last_view_at: "2026-10-20T13:05:00Z", ready: { ok: true, reason: "", url: "https://aetoswebsites.com/d/a-b-7k2p9q", slug: "a-b-7k2p9q" },
};
const WAITING = "Waiting for you to approve the Landscaper look on the Demo page";
const PREVIEWS = [
  { place_id: "fx-full", name: "Green Leaf Landscapes", town: "Warrington", photos: 6, problems: [] },
  { place_id: "fx-no-photos", name: "Hedge & Edge Garden Services", town: "Widnes", photos: 0, problems: ['Number "250" isn\'t in their data'] },
  { place_id: "fx-bare", name: "Tidy Gardens", town: "", photos: 0, problems: [] },
];
const LOOK = { id: "landscaper", label: "Landscaper", version: 1, approved: false, approved_at: null, approved_version: null, waiting: 6, previews: PREVIEWS };

test("pure: demo.js loads in node with no page, and imports nothing that touches one", () => {
  assert.equal(PURE, true);
  const src = read("../public/js/demo.js");
  assert.doesNotMatch(src, /^import[^;]*from "\.\/lib\.js"/m, "lib.js reads the page when it loads: only a dynamic import inside demoPage()");
  assert.match(src, /import\("\.\/lib\.js"\)/);
  assert.match(src, /^import \{[^}]*\besc\b[^}]*\} from "\.\/html\.js";$/m);
});

test("Task 14 Step 1", () => {
  assert.match(demoCardHtml({ demo: { slug: "a-b", url: "https://aetoswebsites.com/d/a-b", expires_at: "2027-04-17T10:00:00Z" }, views: 3, last_view_at: "2026-10-20T13:05:00Z", ready: { ok: true } }), /Viewed 3×/);
  assert.match(demoCardHtml({ demo: null, views: 0, ready: { ok: false, reason: "No demo yet: Grade C: only A+, A and B get a demo" } }), /No demo: Grade C: only A\+, A and B get a demo/);
  assert.match(demoCardHtml({ demo: { slug: "a-b", url: "…", expires_at: "…" }, views: 0, ready: { ok: false, reason: "Waiting for you to approve the Landscaper look on the Demo page" } }), /waiting for you to approve the Landscaper look/);
  assert.match(lookCardHtml({ id: "landscaper", label: "Landscaper", version: 1, approved: false, waiting: 6, previews: [] }), /6 leads are waiting for this look before their first email can go\./);
  assert.match(lookCardHtml({ id: "landscaper", label: "Landscaper", version: 2, approved: false, approved_version: 1, waiting: 0, previews: [] }), /This look changed since you approved version 1\./);
  assert.doesNotMatch(demoCardHtml({ demo: { slug: "x", url: "javascript:alert(1)", expires_at: "x" }, views: 0, ready: { ok: true } }), /href="javascript/);
  const ready = demoCardHtml({ demo: { slug: "a-b-7k2p9q", url: "https://aetoswebsites.com/d/a-b-7k2p9q", expires_at: "2027-04-17T10:00:00Z" }, views: 0, ready: { ok: true } });
  assert.match(ready, /href="\/d\/a-b-7k2p9q"[^>]*>Open demo/);          // relative: Nik's cookie goes with it, so his views never count
  assert.doesNotMatch(ready, /href="https:\/\/aetoswebsites\.com\/d\/a-b-7k2p9q"[^>]*>Open demo/);
});

// ---------------------------------------------------------------- the lead drawer's card (moved from leadview.test.mjs)

test("drawer card, ready: the link, views, expiry, Open demo (new tab) and Copy link", () => {
  const html = demoCardHtml(READY, { now: NOW });
  assert.match(html, /^<div class="demo-card">/);
  assert.equal(plain(html), "aetoswebsites.com/d/a-b-7k2p9q Viewed 3× · last Tue 14:05 Ends 17 Apr 2027 Open demo Copy link");
  assert.match(html, /<a class="btn secondary sm" href="\/d\/a-b-7k2p9q" target="_blank" rel="noopener">Open demo<\/a>/);
  assert.match(html, /<button class="btn secondary sm" type="button" data-copy-demo="https:\/\/aetoswebsites\.com\/d\/a-b-7k2p9q">Copy link<\/button>/);
  // the full https link is only what Copy link copies and the text shown: never a link Nik clicks (his view would count)
  assert.doesNotMatch(html, /href="https?:/);
  assert.equal(count(html, "href="), 1);
  // Not viewed yet, once, a view more than 6 days ago (no weekday: it would read as this week), and a UK winter time
  assert.match(plain(demoCardHtml({ ...READY, views: 0, last_view_at: null }, { now: NOW })), /Not viewed yet Ends 17 Apr 2027/);
  assert.match(plain(demoCardHtml({ ...READY, views: 1, last_view_at: "2026-10-21T09:59:00Z" }, { now: NOW })), /Viewed 1× · last Wed 10:59 /);
  assert.match(plain(demoCardHtml({ ...READY, last_view_at: "2026-10-03T16:00:00Z" }, { now: NOW })), /Viewed 3× · last 3 Oct /);
  assert.match(plain(demoCardHtml({ ...READY, last_view_at: "2025-12-30T16:00:00Z" }, { now: NOW })), /Viewed 3× · last 30 Dec 2025 /);
  assert.match(plain(demoCardHtml({ ...READY, last_view_at: "2026-12-01T09:30:00Z" }, { now: new Date("2026-12-02T10:00:00Z") })), /last Tue 09:30 /);
  assert.match(plain(demoCardHtml({ ...READY, last_view_at: "garbage" }, { now: NOW })), /Viewed 3× Ends/);
  // A view badge stands out (gold); not viewed yet is plain grey.
  assert.match(html, /<span class="badge gold">Viewed 3×/);
  assert.match(demoCardHtml({ ...READY, views: 0 }), /<span class="badge">Not viewed yet<\/span>/);
});

test("drawer card, won: their page never ends (Part A §2), so no end date; every other stage keeps it", () => {
  const won = demoCardHtml({ ...READY, stage: "won", demo: { ...READY.demo, expires_at: "2026-01-01T00:00:00Z" } }, { now: NOW });
  assert.equal(plain(won), "aetoswebsites.com/d/a-b-7k2p9q Viewed 3× · last Tue 14:05 Open demo Copy link");
  assert.doesNotMatch(won, /Ends|Ended/);
  for (const stage of [undefined, null, "ready", "emailed", "viewed", "replied", "needs_nik", "call_booked", "lost"]) {
    assert.match(plain(demoCardHtml({ ...READY, stage }, { now: NOW })), / Ends 17 Apr 2027 /, String(stage));
  }
});

test("drawer card, not ready: why, in Part A's words, and never a demo it doesn't have", () => {
  const gradeC = demoCardHtml({ demo: null, views: 0, last_view_at: null, ready: { ok: false, reason: "No demo yet: Grade C: only A+, A and B get a demo", url: null, slug: null } });
  assert.equal(plain(gradeC), "No demo: Grade C: only A+, A and B get a demo");
  assert.doesNotMatch(gradeC, /Open demo|Copy link|made automatically|Viewed|Ends/);
  assert.equal(plain(demoCardHtml({ demo: null, views: 0, ready: { ok: false, reason: "No demo yet: Lead not found" } })), "No demo: Lead not found");
  assert.equal(plain(demoCardHtml({ demo: null, views: 0, ready: { ok: false, reason: "No demo yet: Excluded: Chain / national brand" } })),
    "No demo: Excluded: Chain / national brand");
  // A lead that had a demo, re-graded C before its prospect existed: the reason, not the old demo's facts.
  assert.equal(plain(demoCardHtml({ ...READY, ready: { ok: false, reason: "No demo yet: Grade C: only A+, A and B get a demo" } })),
    "No demo: Grade C: only A+, A and B get a demo");
  // Expired: demoReady's own words, no button to an ended page.
  const expired = demoCardHtml({ ...READY, demo: { ...READY.demo, expires_at: "2026-01-01T00:00:00Z" }, ready: { ok: false, reason: "Their demo has expired: a new one is being made" } });
  assert.equal(plain(expired), "Their demo has expired: a new one is being made");
  assert.doesNotMatch(expired, /Open demo|Copy link/);
  // No answer worth reading: nothing promised.
  for (const info of [null, undefined, {}, { ready: null }, { ready: { ok: true } }, { demo: { slug: "a-b" }, ready: "x" }]) {
    assert.equal(plain(demoCardHtml(info)), "No demo yet.", JSON.stringify(info));
  }
});

test("drawer card, waiting for the look: made, which look, a link to the Demo page, and the facts", () => {
  const html = demoCardHtml({ ...READY, views: 0, last_view_at: null, ready: { ok: false, reason: WAITING, url: null, slug: null } }, { now: NOW });
  assert.match(plain(html), /^Demo made · waiting for you to approve the Landscaper look on the Demo page\. aetoswebsites\.com\/d\/a-b-7k2p9q Not viewed yet Ends 17 Apr 2027 Open demo Copy link$/);
  assert.match(html, /<a href="#\/demo">Demo page<\/a>/);
  // A redesigned look also holds back leads already emailed: their views still show.
  assert.match(plain(demoCardHtml({ ...READY, ready: { ok: false, reason: WAITING } }, { now: NOW })), /Viewed 3× · last Tue 14:05/);
  assert.match(plain(demoCardHtml({ ...READY, ready: { ok: false, reason: "Waiting for you to approve the Everything else look on the Demo page" } })),
    /^Demo made · waiting for you to approve the Everything else look on the Demo page\./);
  // no demo row to show: the line and the link only
  assert.equal(plain(demoCardHtml({ demo: null, views: 0, ready: { ok: false, reason: WAITING } })),
    "Demo made · waiting for you to approve the Landscaper look on the Demo page.");
});

test("drawer card: links only from a valid slug and an https link; everything escaped", () => {
  // Open demo only from a slug the server could have made (^[a-z0-9-]{3,60}$), never from demo.url.
  for (const slug of ["x", "../etc", "A-B-C", "a b c", "a/b/c", "a".repeat(61), XSS, 7, null]) {
    const html = demoCardHtml({ ...READY, demo: { ...READY.demo, slug } });
    assert.doesNotMatch(html, /Open demo/, String(slug));
    noRawHtml(html);
  }
  // Copy link (and the link shown) only for an https link.
  for (const url of ["http://aetoswebsites.com/d/a-b-7k2p9q", "javascript:alert(1)", "//evil.example/d/x", "/d/a-b-7k2p9q", "", null, XSS]) {
    const html = demoCardHtml({ ...READY, demo: { ...READY.demo, url } });
    assert.doesNotMatch(html, /Copy link|data-copy-demo/, String(url));
    assert.match(html, /href="\/d\/a-b-7k2p9q"[^>]*>Open demo/);
    noRawHtml(html);
  }
  const evil = demoCardHtml({ demo: { slug: XSS, url: XSS, expires_at: XSS }, views: XSS, last_view_at: XSS, ready: { ok: false, reason: `No demo yet: Excluded: ${XSS}` } });
  noRawHtml(evil);
  assert.equal(plain(evil), `No demo: Excluded: ${XSS}`);
  noRawHtml(demoCardHtml({ ...READY, ready: { ok: false, reason: `Waiting for you to approve the ${XSS} look on the Demo page` } }));
  noRawHtml(demoCardHtml({ ...READY, ready: { ok: false, reason: XSS } }));
  const quote = demoCardHtml({ ...READY, demo: { ...READY.demo, url: 'https://aetoswebsites.com/d/a-b-7k2p9q"onclick="x' } });
  assert.doesNotMatch(quote, /"onclick=/);
});

test("drawer card's error: what went wrong and what to do, escaped", () => {
  assert.equal(plain(demoCardErrorHtml("Request failed (500).")),
    "Couldn't load this lead's demo site (Request failed (500)). Close this lead and open it again.");
  assert.match(demoCardErrorHtml("x"), /^<p class="error">/);
  noRawHtml(demoCardErrorHtml(XSS));
});

// ---------------------------------------------------------------- the Demo page's look cards

const frames = (html) => [...html.matchAll(/<iframe [^>]*>/g)].map((m) => m[0]);

test("look card, not approved: Needs your OK, three sandboxed phone-sized previews, problems in red, Approve this look", () => {
  const html = lookCardHtml(LOOK);
  assert.match(html, /^<section class="card demo-look" data-look="landscaper">/);
  assert.match(html, /<h2>Landscaper look<\/h2>/);
  assert.match(html, /<span class="badge warn">Needs your OK<\/span>/);
  assert.match(plain(html), /6 leads are waiting for this look before their first email can go\./);
  assert.match(plain(lookCardHtml({ ...LOOK, waiting: 1 })), /1 lead is waiting for this look before their first email can go\./);
  assert.doesNotMatch(plain(lookCardHtml({ ...LOOK, waiting: 0 })), /waiting for this look/, "nobody waiting: no line saying 0");
  // one frame per preview, in order, each sandboxed so nothing in it runs, lazy, from the preview route
  const list = frames(html);
  assert.equal(list.length, 3);
  for (const [i, p] of PREVIEWS.entries()) {
    assert.match(list[i], /^<iframe class="demo-frame" sandbox="" loading="lazy" /);
    assert.ok(list[i].includes(`src="/api/demo/preview?template=landscaper&amp;place_id=${encodeURIComponent(p.place_id)}"`), list[i]);
  }
  // titled with the lead's name and town (no town: the name only)
  assert.match(html, /<figcaption><b>Green Leaf Landscapes<\/b> · Warrington<\/figcaption>/);
  assert.match(html, /<figcaption><b>Hedge &amp; Edge Garden Services<\/b> · Widnes<\/figcaption>/);
  assert.match(html, /<figcaption><b>Tidy Gardens<\/b><\/figcaption>/);
  assert.match(list[0], /title="Landscaper look for Green Leaf Landscapes · Warrington"/);
  // the quality check's problems in red under their preview; a clean one says so
  assert.match(html, /<ul class="demo-problems"><li>Number &quot;250&quot; isn&#39;t in their data<\/li><\/ul>/);
  assert.equal(count(html, "Passes every check."), 2);
  assert.ok(html.indexOf("Hedge &amp; Edge") < html.indexOf("demo-problems") && html.indexOf("demo-problems") < html.indexOf("Tidy Gardens"));
  // then the button, after the previews
  assert.match(html, /<button class="btn" type="button" data-approve="landscaper">Approve this look<\/button>/);
  assert.ok(html.lastIndexOf("<iframe") < html.indexOf("Approve this look"));
  assert.doesNotMatch(html, /<template|Look again|Approved/);
  // two (or one) graded leads: what there is
  assert.equal(frames(lookCardHtml({ ...LOOK, previews: PREVIEWS.slice(0, 1) })).length, 1);
  // the place_id is URI-encoded, the look too
  const odd = lookCardHtml({ ...LOOK, id: "a&b", previews: [{ ...PREVIEWS[0], place_id: "a&b/c d" }] });
  assert.ok(odd.includes('src="/api/demo/preview?template=a%26b&amp;place_id=a%26b%2Fc%20d"'));
});

test("look card, approved: the date, Leads can get their first email, and its previews only after Look again", () => {
  const html = lookCardHtml({ ...LOOK, approved: true, approved_at: "2026-10-21T08:30:00Z", approved_version: 1, waiting: 0 });
  assert.match(html, /<span class="badge good">Approved 21 Oct<\/span>/);
  assert.match(plain(html), /Leads can get their first email\./);
  assert.match(html, /<button class="btn secondary sm" type="button" data-look-again aria-expanded="false">Look again<\/button>/);
  assert.doesNotMatch(html, /data-approve|Approve this look|Needs your OK|waiting for this look/);
  // the frames wait in an inert <template> (a hidden iframe would still load), copied out on Look again
  const tpl = html.slice(html.indexOf("<template"), html.indexOf("</template>") + "</template>".length);
  assert.match(tpl, /^<template data-look-frames>/);
  assert.equal(frames(tpl).length, 3);
  assert.equal(count(html.replace(tpl, ""), "<iframe"), 0, "no frame outside the template");
  assert.match(html, /<div class="demo-look-box" data-look-box hidden><\/div>/);
  // UK date: just after midnight UK is the next day
  assert.match(lookCardHtml({ ...LOOK, approved: true, approved_at: "2026-10-20T23:30:00Z", approved_version: 1 }), /Approved 21 Oct/);
  assert.match(lookCardHtml({ ...LOOK, approved: true, approved_at: "x", approved_version: 1 }), /<span class="badge good">Approved<\/span>/);
  // approved, nothing to show: no Look again
  const none = lookCardHtml({ ...LOOK, approved: true, approved_at: "2026-10-21T08:30:00Z", approved_version: 1, previews: [] });
  assert.doesNotMatch(none, /Look again|<template|No graded leads/);
});

test("look card, changed since approval: Changed: look again, the version approved, previews and Approve this look", () => {
  const html = lookCardHtml({ ...LOOK, version: 2, approved: false, approved_at: "2026-10-01T08:30:00Z", approved_version: 1, waiting: 4 });
  assert.match(html, /<span class="badge warn">Changed: look again<\/span>/);
  assert.match(plain(html), /This look changed since you approved version 1\. 4 leads are waiting for this look before their first email can go\./);
  assert.equal(frames(html).length, 3);
  assert.match(html, /data-approve="landscaper">Approve this look/);
  assert.doesNotMatch(html, /Needs your OK|Leads can get their first email/);
});

test("look card, no graded lead yet: Part A's line, no previews and no Approve (the server would refuse it)", () => {
  const html = lookCardHtml({ id: "generic", label: "Everything else", version: 1, approved: false, approved_at: null, approved_version: null, waiting: 0, previews: [] });
  assert.match(html, /<h2>Everything else look<\/h2>/);
  assert.match(html, /Needs your OK/);
  assert.match(plain(html), /No graded leads for this look yet\. Previews appear once research grades one\./);
  assert.doesNotMatch(html, /<iframe|data-approve|Approve this look/);
  // with leads waiting (graded earlier, since re-graded): both lines
  assert.match(plain(lookCardHtml({ ...LOOK, previews: [] })),
    /6 leads are waiting for this look before their first email can go\. No graded leads for this look yet\. Previews appear once research grades one\./);
});

test("look card: everything escaped, a broken answer still draws", () => {
  const html = lookCardHtml({ id: XSS, label: XSS, version: XSS, approved: false, approved_version: XSS, waiting: XSS,
    previews: [{ place_id: XSS, name: XSS, town: XSS, photos: XSS, problems: [XSS, 7, null] }] });
  noRawHtml(html);
  assert.ok(plain(html).includes(XSS));
  noRawHtml(lookCardHtml({ ...LOOK, approved: true, approved_at: XSS, approved_version: 1 }));
  for (const t of [null, undefined, {}, { previews: "x" }, { previews: [null, 7] }]) {
    const out = lookCardHtml(t);
    assert.match(out, /^<section class="card demo-look"/);
    assert.doesNotMatch(out, /<iframe/);
  }
});

// ---------------------------------------------------------------- the Demo sites table

const DEMOS = [
  { place_id: "fx-full", name: "Green Leaf Landscapes Ltd", grade: "A", stage: "viewed", slug: "green-leaf-landscapes-7k2p9q",
    url: "https://aetoswebsites.com/d/green-leaf-landscapes-7k2p9q", views: 3, last_view_at: "2026-10-20T13:05:00Z", expires_at: "2027-04-17T10:00:00Z" },
  { place_id: "fx-no-photos", name: "Hedge & Edge Garden Services", grade: "B", stage: "ready", slug: "hedge-and-edge-garden-services-a2b3c4",
    url: "https://aetoswebsites.com/d/hedge-and-edge-garden-services-a2b3c4", views: 0, last_view_at: null, expires_at: "2027-04-19T10:00:00Z" },
  { place_id: "fx-old", name: "Old Lead", grade: null, stage: null, slug: "old-lead-zzzzzz",
    url: "https://aetoswebsites.com/d/old-lead-zzzzzz", views: 0, last_view_at: null, expires_at: "2026-01-01T00:00:00Z" },
];
const rows = (html) => [...html.matchAll(/<tr>[^]*?<\/tr>/g)].map((m) => m[0]);

test("demo sites table: Business (with grade), Stage, Views, Last viewed, Ends, Open and Copy link, in the server's order", () => {
  const html = demosTableHtml(DEMOS, { now: NOW });
  assert.match(html, /^<div class="table-card"><div class="table-wrap"><table class="demos-table">/);
  assert.equal(plain(html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"))), "Business Stage Views Last viewed Ends");
  const [a, b, c, extra] = rows(html.slice(html.indexOf("<tbody>")));
  assert.equal(extra, undefined);
  assert.equal(plain(a), "A Green Leaf Landscapes Ltd Opened demo 3 Tue 14:05 17 Apr 2027 Open Copy link");
  assert.equal(plain(b), "B Hedge & Edge Garden Services Ready to email 0 – 19 Apr 2027 Open Copy link");
  assert.equal(plain(c), "– Old Lead Not contacted 0 – Ended 1 Jan 2026 Open Copy link");
  assert.ok(a.includes(gradeBadge("A")), "stage 3's grade badge");
  // the business opens its lead panel; Open is the relative /d/<slug>; Copy link copies the https link
  assert.match(a, /<a href="#\/lead\/fx-full">Green Leaf Landscapes Ltd<\/a>/);
  assert.match(a, /<a class="btn secondary sm" href="\/d\/green-leaf-landscapes-7k2p9q" target="_blank" rel="noopener">Open<\/a>/);
  assert.match(a, /data-copy-demo="https:\/\/aetoswebsites\.com\/d\/green-leaf-landscapes-7k2p9q">Copy link</);
  assert.doesNotMatch(html, /href="https?:/);
  assert.match(demosTableHtml([{ ...DEMOS[0], place_id: "a&b/c d" }]), /href="#\/lead\/a%26b%2Fc%20d"/);
  // bad slug: no Open; not https: no Copy link
  const bad = demosTableHtml([{ ...DEMOS[0], slug: "../x", url: "http://aetoswebsites.com/d/x" }], { now: NOW });
  assert.doesNotMatch(bad, /Open<\/a>|Copy link/);
  // an unknown stage shows as given (escaped)
  assert.match(plain(demosTableHtml([{ ...DEMOS[0], stage: "paused" }])), / paused /);
  // a won prospect's page never ends (Part A §2), even past its expires_at: never "Ended" or a date it won't end on
  for (const expires_at of [DEMOS[2].expires_at, DEMOS[0].expires_at]) {
    const html = demosTableHtml([{ ...DEMOS[2], stage: "won", expires_at }], { now: NOW });
    assert.equal(plain(rows(html.slice(html.indexOf("<tbody>")))[0]), "– Old Lead Won 0 – Never (won) Open Copy link");
  }
});

test("demo sites table: Part A's empty line, everything escaped", () => {
  for (const none of [[], null, undefined, "x", [null, 7]]) {
    const html = demosTableHtml(none);
    assert.equal(plain(html), "No demo sites yet. One is made automatically when Claude grades a lead A+, A or B and finds an email.");
    assert.doesNotMatch(html, /<table/);
  }
  const evil = demosTableHtml([{ place_id: XSS, name: XSS, grade: XSS, stage: XSS, slug: XSS, url: XSS, views: XSS, last_view_at: XSS, expires_at: XSS }]);
  noRawHtml(evil);
  assert.ok(plain(evil).includes(XSS));
});

test("the page body: Looks, then Demo sites", () => {
  const html = demoBodyHtml({ templates: [LOOK, { id: "generic", label: "Everything else", version: 1, approved: true, approved_at: "2026-10-01T09:00:00Z", approved_version: 1, waiting: 0, previews: [] }], demos: DEMOS }, { now: NOW });
  const at = (s) => html.indexOf(s);
  assert.ok(at("<h2>Looks</h2>") < at("Landscaper look"));
  assert.ok(at("Landscaper look") < at("Everything else look"));
  assert.ok(at("Everything else look") < at("<h2>Demo sites</h2>"));
  assert.ok(at("<h2>Demo sites</h2>") < at('<table class="demos-table">'));
  assert.equal(count(html, '<section class="card demo-look"'), 2);
  const empty = demoBodyHtml({}, { now: NOW });
  assert.match(plain(empty), /No demo sites yet\./);
  noRawHtml(demoBodyHtml({ templates: [{ id: XSS, label: XSS, previews: [{ name: XSS, place_id: XSS }] }], demos: [{ name: XSS }] }));
});

// ---------------------------------------------------------------- real answers from Task 13's routes

/** The 5 landscaper fixtures researched; full and noPhotos with their demo and ready prospect; a C-grade roofer. */
async function scenario() {
  const DB = fakeD1();
  await db({ DB });
  for (const key of ["full", "paleColour", "noPhotos", "httpPhotos", "bare"]) {
    const { research, ...lead } = LEADS[key];
    await seedLead(DB, lead);
    await seedResearch(DB, research);
  }
  const { research, ...roofer } = LEADS.roofer;
  await seedLead(DB, roofer);
  await seedResearch(DB, { ...research, grade: "C" });
  for (const id of ["fx-full", "fx-no-photos"]) assert.equal((await ensureDemo(DB, id, NOW)).ok, true, id);
  return DB;
}
const get = async (route, path, params = {}, DB) =>
  (await route({ request: new Request(`https://control.example${path}`), env: { DB }, params, now: NOW })).json();

test("GET /api/demo and GET /api/demo/lead/:id answers render as Part A says", async () => {
  const DB = await scenario();
  const page = await get(demoRoute, "/api/demo", {}, DB);
  const html = demoBodyHtml(page, { now: NOW });
  const landscaper = html.slice(html.indexOf('data-look="landscaper"'), html.indexOf('data-look="generic"'));
  assert.match(landscaper, /Needs your OK/);
  assert.match(plain(landscaper), /2 leads are waiting for this look before their first email can go\./);
  assert.equal(frames(landscaper).length, 3);
  assert.match(landscaper, /data-approve="landscaper">Approve this look/);
  const generic = html.slice(html.indexOf('data-look="generic"'));
  assert.match(plain(generic), /No graded leads for this look yet\./);
  // the table: both demos, each opened relatively and copied as the email's link
  for (const id of ["fx-full", "fx-no-photos"]) {
    const { slug } = DB.raw.prepare("SELECT slug FROM demos WHERE place_id = ?").get(id);
    assert.ok(html.includes(`href="/d/${slug}" target="_blank" rel="noopener">Open</a>`), id);
    assert.ok(html.includes(`data-copy-demo="https://aetoswebsites.com/d/${slug}"`), id);
  }
  noRawHtml(html);

  // the drawer card: waiting for the look, then (approved) ready; the C-grade roofer says why; a gone lead too
  const { slug } = DB.raw.prepare("SELECT slug FROM demos WHERE place_id = 'fx-full'").get();
  const waiting = demoCardHtml(await get(leadRoute, "/api/demo/lead/fx-full", { id: "fx-full" }, DB), { now: NOW });
  assert.match(plain(waiting), /^Demo made · waiting for you to approve the Landscaper look on the Demo page\./);
  await approveTemplate(DB, "landscaper", 1, NOW);
  const ready = demoCardHtml(await get(leadRoute, "/api/demo/lead/fx-full", { id: "fx-full" }, DB), { now: NOW });
  assert.equal(plain(ready), `aetoswebsites.com/d/${slug} Not viewed yet Ends 19 Apr 2027 Open demo Copy link`);
  assert.ok(ready.includes(`href="/d/${slug}" target="_blank" rel="noopener">Open demo</a>`));
  // a view counted on the prospect shows
  DB.raw.prepare("UPDATE prospects SET views = 2, last_view_at = '2026-10-20T18:45:00Z' WHERE place_id = 'fx-full'").run();
  assert.match(plain(demoCardHtml(await get(leadRoute, "/api/demo/lead/fx-full", { id: "fx-full" }, DB), { now: NOW })),
    /Viewed 2× · last Tue 19:45/);
  const after = demoBodyHtml(await get(demoRoute, "/api/demo", {}, DB), { now: NOW });
  assert.match(after.slice(after.indexOf('data-look="landscaper"'), after.indexOf('data-look="generic"')), /Approved 21 Oct[^]*Look again/);
  assert.equal(plain(demoCardHtml(await get(leadRoute, "/api/demo/lead/fx-roofer", { id: "fx-roofer" }, DB))),
    "No demo: Grade C: only A+, A and B get a demo");
  assert.equal(plain(demoCardHtml(await get(leadRoute, "/api/demo/lead/nope", { id: "nope" }, DB))), "No demo: Lead not found");
  // an emailed prospect is never touched by the card (it only reads)
  await seedProspect(DB, { place_id: "fx-roofer", stage: "emailed" });
  await get(leadRoute, "/api/demo/lead/fx-roofer", { id: "fx-roofer" }, DB);
  assert.equal(DB.raw.prepare("SELECT stage FROM prospects WHERE place_id = 'fx-roofer'").get().stage, "emailed");
});

// ---------------------------------------------------------------- the wiring (needs a page, so read as text)

test("app.js routes #/demo to demoPage with no nav item", () => {
  const app = read("../public/js/app.js");
  assert.match(app, /^import \{ demoPage \} from "\.\/demo\.js";$/m);
  assert.match(app, /\{ route: "demo", label: "Demo", icon: "layout", render: \(\) => demoPage\(\), nav: false \}/);
  // the nav builder leaves nav: false out (routable only), and an unknown route still goes home
  assert.match(app, /const place = \(p\) => \(p\.nav === false \? null :/);
  assert.match(app, /PAGES\.find\(\(p\) => p\.route === name\) \|\| PAGES\.find\(\(p\) => p\.route === "home"\)/);
});

test("demo.js: the page loads GET /api/demo, approves with {template, version} and shows the API's error in a toast", () => {
  const src = read("../public/js/demo.js");
  assert.match(src, /export async function demoPage\(\)/);
  // titled as everything else names it ("the Demo page") and as its PAGES label
  assert.match(src, /^const TITLE = "Demo";/m);
  assert.match(src, /pageHead\(TITLE, SUB\)/);
  assert.match(src, /api\("\/api\/demo"\)/);
  assert.match(src, /api\("\/api\/demo\/approve", \{ method: "POST", body: JSON\.stringify\(\{ template: look\.id, version: look\.version \}\) \}\)/);
  assert.match(src, /toast\(err\.message\)/);
  assert.match(src, /navigator\.clipboard\.writeText\(/);
  // a stale answer (Nik has moved on, or a newer load started) is never drawn
  assert.match(src, /if \(ask !== pageAsk \|\| !el\) return;/);
  assert.doesNotMatch(src, /\/api\/demos\b|\?preview=1/);
  assert.doesNotMatch(src, /innerHTML\s*=\s*`[^`]*\$\{(?!pageHead\()/, "anything put in the page by hand comes from the pure renderers");
});

test("leads.js: the drawer's #d-demo gets the card from GET /api/demo/lead/:id, only while that lead is still open", () => {
  const src = read("../public/js/leads.js");
  assert.match(src, /import \{ bindCopyLinks, demoCardErrorHtml, demoCardHtml \} from "\.\/demo\.js";/);
  assert.ok(src.includes("api(`/api/demo/lead/${encodeURIComponent(id)}`)"));
  const fn = src.slice(src.indexOf("async function loadDemoCard"), src.indexOf("\n}\n", src.indexOf("async function loadDemoCard")));
  assert.ok(fn.length > 0, "loadDemoCard");
  assert.match(fn, /r\.querySelector\("#d-demo"\)/);
  assert.match(fn, /if \(ask !== drawerAsk \|\| !slot\.isConnected\) return;\s*slot\.innerHTML = demoCardHtml\(info\);/);
  assert.match(fn, /bindCopyLinks\(slot, toast\)/);
  assert.match(src, /loadDemoCard\(r, id, ask\);/);
});

test("style.css: the Demo page's looks, 390 × 700 preview frames and the drawer's card", () => {
  const css = read("../public/style.css");
  assert.match(css, /^\.demo-look \{/m);
  assert.match(css, /^\.demo-frame \{[^}]*width: 100%;[^}]*height: 700px;/m);
  assert.match(css, /^\.demo-shot \{[^}]*width: min\(390px, 100%\);/m);
  assert.match(css, /^\.demo-previews \{[^}]*overflow-x: auto;/m);
  assert.match(css, /^\.demo-card \{/m);
  assert.match(css, /^\.demo-problems \{[^}]*color: var\(--bad\)/m);
  assert.doesNotMatch(css, /\.demo-facts/, "the old demo facts are the card's now");
  assert.equal(css.split("{").length, css.split("}").length, "braces balance");
});
