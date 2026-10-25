// The public demo page (stage 4, docs/rebuild/05-demo.md Task 10): GET /d/:slug draws the lead's demo with the template
// engine (200), the "This preview has ended" page (410) or the not-found page (404), each with the demo page's headers
// (Part A §6: the exact CSP, noindex, no-referrer, plus page()'s no-store and DENY framing). page()'s own headers stay
// as they were for the order page.
// Counting real views (Task 11, Part A §8): POST /d/:slug/e always answers 204 and stores nothing for a bot or an empty
// user-agent, Nik's login cookie, an unknown kind, a body over 200 bytes, a missing or ended demo, or a prospect that is
// missing or still `ready`; a view goes through countView (one per 30 minutes), order_page/order_click through
// recordEvent. session.js holds the login cookie the middleware has always set; bots.js the user-agents never counted.
// Run: node --test control-room/tests/demo-routes.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";
import * as oldDemo from "../functions/_lib/demo.js";
import { BOT_UA, isBotUA } from "../functions/_lib/demo/bots.js";
import { checkDemoHtml } from "../functions/_lib/demo/check.js";
import { buildDemoData } from "../functions/_lib/demo/data.js";
import { countView, EVENT_KINDS } from "../functions/_lib/demo-db.js";
import { offerFor } from "../functions/_lib/offer.js";
import { page } from "../functions/_lib/page.js";
import { isOwnerRequest, SESSION_COOKIE, sessionToken } from "../functions/_lib/session.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { db } from "../functions/_lib/util.js";
import { onRequestPost } from "../functions/d/[slug]/e.js";
import { onRequestGet, onRequestHead } from "../functions/d/[slug]/index.js";
import { LEADS } from "./fixtures/demo-fixtures.mjs";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { SEED_AT, seedDemo, seedLead, seedMailbox, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

// Part A §6, word for word.
const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const SLUG = "green-leaf-landscapes-7k2p9q";
const NOW = new Date("2026-10-21T10:00:00Z"); // a Wednesday
const SATURDAY = new Date("2026-10-24T10:00:00Z");
const PLACE = LEADS.full.place_id;

/** A database with LEADS.full (Green Leaf Landscapes Ltd, Warrington), its research and its live demo SLUG. */
async function seed({ demo = {}, prospect = null, research = true, mailbox = false } = {}) {
  const DB = fakeD1();
  const { research: row, ...lead } = LEADS.full;
  await seedLead(DB, lead);
  if (research) await seedResearch(DB, row);
  if (mailbox) await seedMailbox(DB, { id: "m1" });
  await seedDemo(DB, { place_id: PLACE, slug: SLUG, created_at: "2026-10-20T09:00:00Z", expires_at: "2027-04-18T09:00:00Z", ...demo });
  if (prospect) await seedProspect(DB, { place_id: PLACE, ...prospect });
  return DB;
}

const get = (DB, slug) => onRequestGet({ env: { DB }, params: { slug } });
// The clock the route reads (new Date()), fixed for one test; node:test puts it back afterwards.
const at = (t, now) => t.mock.timers.enable({ apis: ["Date"], now });

/** page()'s headers plus the demo page's: what every response of GET /d/:slug carries. */
function assertDemoHeaders(res, label) {
  assert.equal(res.headers.get("content-security-policy"), CSP, `${label}: CSP`);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow", `${label}: x-robots-tag`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${label}: referrer-policy`);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", `${label}: content-type`);
  assert.equal(res.headers.get("cache-control"), "no-store", `${label}: cache-control`);
  assert.equal(res.headers.get("x-frame-options"), "DENY", `${label}: x-frame-options`);
}

// ---------------------------------------------------------------- the spec's tests (Task 10, Step 1)

test("a live demo → 200 with the preview, the exact CSP and noindex", async (t) => {
  at(t, NOW);
  const res = await get(await seed(), SLUG);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Preview made for/);
  assert.equal(res.headers.get("content-security-policy"), CSP);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assertDemoHeaders(res, "live demo");
});

test("an unknown slug and ../etc → 404 with the not-found page", async (t) => {
  at(t, NOW);
  const DB = await seed();
  for (const slug of ["nobody-here-abc234", "../etc"]) {
    const res = await get(DB, slug);
    assert.equal(res.status, 404, slug);
    const html = await res.text();
    assert.match(html, /This page doesn&#39;t exist/, slug);
    assertDemoHeaders(res, slug);
  }
});

test("an expired demo → 410 with the ended page; the same slug with a won prospect → 200", async (t) => {
  at(t, NOW);
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } });
  const ended = await get(DB, SLUG);
  assert.equal(ended.status, 410);
  assert.match(await ended.text(), /This preview has ended/);
  assertDemoHeaders(ended, "expired");

  await seedProspect(DB, { place_id: PLACE, stage: "won" });
  const won = await get(DB, SLUG);
  assert.equal(won.status, 200);
  assert.match(await won.text(), /Preview made for/);
  assertDemoHeaders(won, "won");
});

// ---------------------------------------------------------------- more

test("the page is the template engine's: their research, their look, the order link and the beacon", async (t) => {
  at(t, NOW);
  const html = await (await get(await seed(), SLUG)).text();
  assert.match(html, /<body data-template="landscaper"/);
  assert.match(html, /Preview made for <b>Green Leaf Landscapes<\/b> by Aetos Websites · Visits to this page are counted/);
  assert.ok(html.includes("Patios, lawns and garden makeovers in Warrington"), "research.copy.headline");
  assert.ok(html.includes("Turfing and new lawns"), "research.copy.services");
  assert.match(html, /href="\/d\/green-leaf-landscapes-7k2p9q\/order"[^>]*>Order this site/);
  assert.match(html, /href="tel:07969770905"/);
  assert.ok(html.includes(`"/d/${SLUG}/e"`), "the view beacon posts to this demo");
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.ok(html.includes(`© ${NOW.getUTCFullYear()} Green Leaf Landscapes · Warrington`), "footer year from the route's clock");
  // the old demo page is gone: no trade default list, no invented claims, no "Make it mine"
  for (const old of ["Make it mine", "preview until", "Free quote, no obligation", "Get a free quote", "Clear prices"]) {
    assert.ok(!html.includes(old), `old demo text "${old}"`);
  }
  // every quality check passes on what the route sends (the data as the fixture builds it)
  const data = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: { slug: SLUG }, offer: offerFor(NOW), now: NOW });
  assert.deepEqual(checkDemoHtml(html, data, { now: NOW }), []);
  assert.ok(Buffer.byteLength(html) < 100000);
});

test("the offer line follows the UK weekend from the route's clock", async (t) => {
  at(t, NOW);
  const DB = await seed();
  const weekday = await (await get(DB, SLUG)).text();
  assert.match(weekday, /First 60 days of the monthly plan free\. No contract\./);
  assert.doesNotMatch(weekday, /Weekend deal/);
  t.mock.timers.setTime(SATURDAY.getTime());
  const weekend = await (await get(DB, SLUG)).text();
  assert.match(weekend, /Weekend deal: first 90 days of the monthly plan free\. No contract\./);
  assert.doesNotMatch(weekend, /First 60 days/);
});

test("the not-found page never says whose: a gone lead, a bad slug, an old-style slug", async (t) => {
  at(t, NOW);
  const DB = await seed();
  for (const slug of ["", "ab", "Green-Leaf", "x y z", "a".repeat(61), undefined, "green-leaf-landscapes-7k2p9q/order"]) {
    const res = await get(DB, slug);
    assert.equal(res.status, 404, String(slug));
    const html = await res.text();
    assert.match(html, /This page doesn&#39;t exist\./, String(slug));
    assert.ok(!/Green Leaf|Warrington|Preview made/.test(html), `${slug}: says nothing about whose`);
  }
  // a re-scrape deleted the lead: its demo row is left, but there's nothing true to draw
  DB.raw.prepare("DELETE FROM leads").run();
  const gone = await get(DB, SLUG);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /This page doesn&#39;t exist\./);
});

test("the ended page names them and offers their thread's mailbox", async (t) => {
  at(t, NOW);
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" }, mailbox: true, prospect: { stage: "emailed", mailbox_id: "m1" } });
  const res = await get(DB, SLUG);
  assert.equal(res.status, 410, "emailed is not won");
  const html = await res.text();
  assert.match(html, /The website we made for Green Leaf Landscapes is no longer on show\. Reply to our email and we&#39;ll switch it back on\./);
  assert.match(html, /mailto:m1@aetoswebsites\.com/);
  assert.ok(!html.includes("Preview made for"), "no demo on the ended page");
  // no mailbox on the thread: no "or email" line
  const plain = await (await get(await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } }), SLUG)).text();
  assert.match(plain, /This preview has ended/);
  assert.ok(!plain.includes("mailto:"), "no address to offer");
});

test("expiry: ended at its exact time, old 14-day millisecond times read too, live a second before", async (t) => {
  at(t, NOW);
  assert.equal((await get(await seed({ demo: { expires_at: "2026-10-21T10:00:00Z" } }), SLUG)).status, 410, "expires_at = now");
  assert.equal((await get(await seed({ demo: { expires_at: "2026-10-15T09:00:00.000Z" } }), SLUG)).status, 410, "the old system's format");
  assert.equal((await get(await seed({ demo: { expires_at: "2026-10-21T10:00:01Z" } }), SLUG)).status, 200, "a second left");
  assert.equal((await get(await seed({ demo: { expires_at: "2026-11-03T09:00:00.000Z" } }), SLUG)).status, 200, "old format, still live");
});

test("a demo whose lead has no research still tells only the truth", async (t) => {
  at(t, NOW);
  const res = await get(await seed({ research: false }), SLUG);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Your services will go here/);
  assert.match(html, /Preview placeholder: we&#39;ll fill this in with you/);
  assert.ok(html.includes("Landscaping in Warrington"), "the headline falls back to <Trade> in <Town>");
  for (const s of LEADS.full.research.copy.services) assert.ok(!html.includes(s), `no service "${s}" without research`);
});

test("page() keeps its headers for the order page and takes the demo's on top", async () => {
  const plain = page("<p>x</p>");
  assert.equal(plain.status, 200);
  assert.equal(await plain.text(), "<p>x</p>");
  assert.deepEqual(Object.fromEntries(plain.headers), {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  });
  assert.equal(page("x", 410).status, 410);
  assert.equal(page("x", 404, {}).headers.get("referrer-policy"), "strict-origin-when-cross-origin");

  const extra = page("x", 200, { "content-security-policy": CSP, "Referrer-Policy": "no-referrer" });
  assert.equal(extra.headers.get("content-security-policy"), CSP);
  assert.equal(extra.headers.get("referrer-policy"), "no-referrer", "replaced, not added to");
  assert.equal(extra.headers.get("cache-control"), "no-store");
  assert.equal(extra.headers.get("x-frame-options"), "DENY");
  assert.equal(extra.headers.get("x-robots-tag"), "noindex, nofollow");
  // one call's extras never leak into the next
  assert.equal(page("x").headers.get("content-security-policy"), null);
});

// The old names are built from parts so this file never holds them: the stage's check
// `grep -rnE "<the three names>" control-room/functions control-room/tests` must print nothing.
const OLD_NAMES = [["render", "Demo"], ["services", "For"], ["PREVIEW", "_DAYS"]].map((parts) => parts.join(""));

test("the old demo renderer is gone and nothing imports it; the order page's pieces stay", () => {
  for (const name of OLD_NAMES) assert.equal(name in oldDemo, false, `${name} still exported`);
  for (const name of ["renderOrder", "renderExpired", "isWeekendUK", "shortName", "slugFor"]) {
    assert.equal(typeof oldDemo[name], "function", `${name} is kept for the order page (stage 9 moves it)`);
  }
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : /\.m?js$/.test(e.name) ? [new URL(e.name, dir)] : []);
  const roots = ["../functions/", "../public/js/", "./"].map((p) => new URL(p, import.meta.url));
  const oldRe = new RegExp(OLD_NAMES.join("|"));
  for (const file of roots.flatMap(files)) {
    const src = readFileSync(file, "utf8");
    assert.ok(!oldRe.test(src), `${file.pathname} still uses the old demo renderer`);
  }
});

// ---------------------------------------------------------------- review additions

test("HEAD answers like GET with no body (Pages would otherwise send it to d/[[path]].js's 404)", async (t) => {
  at(t, NOW);
  const DB = await seed();
  const live = await onRequestHead({ env: { DB }, params: { slug: SLUG } });
  assert.equal(live.status, 200);
  assert.equal(await live.text(), "");
  assertDemoHeaders(live, "HEAD live");
  const unknown = await onRequestHead({ env: { DB }, params: { slug: "nobody-here-abc234" } });
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), "");
  const ended = await onRequestHead({ env: { DB: await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } }) }, params: { slug: SLUG } });
  assert.equal(ended.status, 410);
  assertDemoHeaders(ended, "HEAD expired");
});

test("the weekend deal starts at UK midnight Saturday and ends at UK midnight Monday (BST ends that Sunday)", async (t) => {
  at(t, new Date("2026-10-23T22:59:00Z")); // Fri 23:59 BST
  const DB = await seed();
  assert.match(await (await get(DB, SLUG)).text(), /First 60 days of the monthly plan free\. No contract\./, "Friday night");
  t.mock.timers.setTime(Date.parse("2026-10-23T23:00:00Z")); // Sat 00:00 BST
  assert.match(await (await get(DB, SLUG)).text(), /Weekend deal: first 90 days of the monthly plan free\. No contract\./, "Saturday 00:00 UK");
  t.mock.timers.setTime(Date.parse("2026-10-25T23:59:00Z")); // Sun 23:59 GMT (the clocks went back that morning)
  assert.match(await (await get(DB, SLUG)).text(), /Weekend deal: first 90 days/, "Sunday 23:59 UK");
  t.mock.timers.setTime(Date.parse("2026-10-26T00:00:00Z")); // Mon 00:00 GMT
  assert.match(await (await get(DB, SLUG)).text(), /First 60 days of the monthly plan free\. No contract\./, "Monday 00:00 UK");
});

test("the ended page: the exact 'or email' line and Aetos Websites at the bottom", async (t) => {
  at(t, NOW);
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" }, mailbox: true, prospect: { stage: "viewed", mailbox_id: "m1" } });
  const html = await (await get(DB, SLUG)).text();
  assert.match(html, /<h1>This preview has ended<\/h1>/);
  assert.match(html, /or email <a href="mailto:m1@aetoswebsites\.com">m1@aetoswebsites\.com<\/a>/);
  assert.match(html, /Aetos Websites<\/p>\s*<\/main>/);
  assert.ok(!html.includes("<script"), "no script on the ended page");
});

test("hostile text in their lead row is escaped on the live and the ended page", async (t) => {
  at(t, NOW);
  const nasty = '</style><script>alert(1)</script>"><img src=x onerror=alert(1)>';
  for (const expires_at of ["2027-04-18T09:00:00Z", "2026-10-01T00:00:00Z"]) {
    const DB = await seed({ demo: { expires_at } });
    DB.raw.prepare("UPDATE leads SET name = ?, town = ?, phone = ?").run(`${nasty} Ltd`, nasty, nasty);
    const res = await get(DB, SLUG);
    const html = await res.text();
    assert.ok([200, 410].includes(res.status), expires_at);
    // the text may show (escaped), but never as a tag or an attribute
    assert.ok(!/<script>alert|<img src=x|<\/style><script/i.test(html), `${expires_at}: escaped`);
    assert.ok(html.includes("&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), `${expires_at}: shown as text`);
  }
});

test("the street address and postcode are never shown; a lost prospect's live demo still shows", async (t) => {
  at(t, NOW);
  const res = await get(await seed({ prospect: { stage: "lost", lost_reason: "opt_out" } }), SLUG);
  assert.equal(res.status, 200, "the page keeps working until it ends");
  const html = await res.text();
  assert.ok(!html.includes("12 Example Road"), "street address");
  assert.ok(!html.includes("WA1 1AA"), "postcode");
});

test("one page costs at most 5 D1 statements and writes nothing", async (t) => {
  at(t, NOW);
  const DB = await seed();
  const before = DB.raw.prepare("SELECT (SELECT COUNT(*) FROM demo_events) e, (SELECT COUNT(*) FROM prospects) p").get();
  const c = countingDB(DB);
  assert.equal((await get(c.DB, SLUG)).status, 200);
  assert.ok(c.used() <= 5, `used ${c.used()}`);
  assert.deepEqual(DB.raw.prepare("SELECT (SELECT COUNT(*) FROM demo_events) e, (SELECT COUNT(*) FROM prospects) p").get(), before);
});

// ---------------------------------------------------------------- Task 11: counting real views (POST /d/:slug/e)

const CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const PW = "pw";
const VIEW = '{"kind":"view"}';
const MIN = 60_000;
const BEACON_URL = "https://aetoswebsites.com/d/s/e";

/** POST /d/:slug/e on `DB` as the page's sendBeacon sends it (a small text body). */
const beaconTo = (DB, slug = SLUG, env = {}) => (ua, body = VIEW, cookie = "") => onRequestPost({
  request: new Request(BEACON_URL, { method: "POST", body, headers: { "user-agent": ua, cookie } }),
  env: { DB, CONTROL_ROOM_PASSWORD: PW, ...env },
  params: { slug },
});
const prospectRow = (DB) => {
  const row = DB.raw.prepare("SELECT views, stage, stage_at, last_view_at, updated_at FROM prospects").get();
  return row ? { ...row } : null;
};
const events = (DB) => DB.raw.prepare("SELECT kind, at FROM demo_events ORDER BY rowid").all().map((r) => `${r.kind} ${r.at}`);
const UNTOUCHED = { views: 0, stage: "emailed", stage_at: SEED_AT, last_view_at: null, updated_at: SEED_AT };
/** A JSON view body of exactly `n` bytes. */
const padded = (n) => {
  const base = '{"kind":"view","x":""}';
  return base.replace('""', `"${"a".repeat(n - base.length)}"`);
};

test("Task 11 spec: a real view counts once per 30 minutes; bots, an empty UA, Nik's cookie and unknown kinds never do", async (t) => {
  at(t, NOW);
  const DB = await seed({ prospect: { stage: "emailed" } });
  const slug = SLUG;
  const post = (ua, body = '{"kind":"view"}', cookie = "") => onRequestPost({ request: new Request("https://aetoswebsites.com/d/s/e", { method: "POST", body, headers: { "user-agent": ua, cookie } }), env: { DB, CONTROL_ROOM_PASSWORD: "pw" }, params: { slug } });
  assert.equal((await post(CHROME)).status, 204);
  let p = DB.raw.prepare("SELECT views, stage, last_view_at FROM prospects").get();
  assert.equal(p.views, 1); assert.equal(p.stage, "viewed");
  assert.equal(p.last_view_at, "2026-10-21T10:00:00Z", "now() format");
  assert.equal((await post(CHROME)).status, 204);                      // within 30 minutes
  for (const ua of ["", "Googlebot/2.1", "Mozilla/5.0 HeadlessChrome/120", "python-requests/2.31", "Microsoft Office/16.0 (Outlook)"]) {
    assert.equal((await post(ua)).status, 204, ua);
  }
  assert.equal((await post(CHROME, '{"kind":"view"}', `cr_session=${await sessionToken("pw")}`)).status, 204);
  assert.equal((await post(CHROME, '{"kind":"hack"}')).status, 204);
  assert.equal(DB.raw.prepare("SELECT views FROM prospects").get().views, 1);
  assert.deepEqual(events(DB), ["view 2026-10-21T10:00:00Z"], "one demo_events row: the counted view");
});

test("Task 11 spec: a prospect still in stage ready and an expired demo count nothing; order_page is an event, never a view", async (t) => {
  at(t, NOW);
  // stage ready: no email has gone out, so only Nik or a leak can have the link
  const ready = await seed({ prospect: { stage: "ready" } });
  for (const body of [VIEW, '{"kind":"order_page"}', '{"kind":"order_click"}']) {
    assert.equal((await beaconTo(ready)(CHROME, body)).status, 204, body);
  }
  assert.deepEqual(prospectRow(ready), { ...UNTOUCHED, stage: "ready" });
  assert.deepEqual(events(ready), []);

  // expired demo
  const ended = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" }, prospect: { stage: "emailed" } });
  for (const body of [VIEW, '{"kind":"order_page"}', '{"kind":"order_click"}']) {
    assert.equal((await beaconTo(ended)(CHROME, body)).status, 204, body);
  }
  assert.deepEqual(prospectRow(ended), UNTOUCHED);
  assert.deepEqual(events(ended), []);

  // order_page: a demo_events row, views and stage unchanged
  const DB = await seed({ prospect: { stage: "emailed" } });
  assert.equal((await beaconTo(DB)(CHROME, '{"kind":"order_page"}')).status, 204);
  assert.deepEqual(events(DB), ["order_page 2026-10-21T10:00:00Z"]);
  assert.deepEqual(prospectRow(DB), UNTOUCHED);
});

test("every reason to ignore a beacon stores nothing, even with no view in the last 30 minutes", async (t) => {
  at(t, NOW);
  const token = await sessionToken(PW);
  const IGNORED = [
    ["empty user-agent", ["", VIEW]],
    ["blank user-agent", ["   ", VIEW]],
    ["Googlebot", ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", VIEW]],
    ["HeadlessChrome", ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36", VIEW]],
    ["python", ["python-requests/2.31.0", VIEW]],
    ["Outlook", ["Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17126; Pro)", VIEW]],
    ["curl", ["curl/8.4.0", VIEW]],
    ["Safe Links", ["Mozilla/5.0 (Windows NT 10.0) SafeLinks/1.0", VIEW]],
    ["Mimecast", ["Mimecast URL Protect", VIEW]],
    ["WhatsApp preview", ["WhatsApp/2.23.20.0 A", VIEW]],
    ["Slack unfurl", ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", VIEW]],
    ["Facebook", ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", VIEW]],
    ["Lighthouse", ["Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 Chrome-Lighthouse", VIEW]],
    ["Nik's cookie", [CHROME, VIEW, `${SESSION_COOKIE}=${token}`]],
    ["Nik's cookie among others", [CHROME, VIEW, `theme=dark; ${SESSION_COOKIE}=${token}; x=1`]],
    ["Nik on the order page", [CHROME, '{"kind":"order_page"}', `${SESSION_COOKIE}=${token}`]],
    ["'ordered' (only Stripe says that)", [CHROME, '{"kind":"ordered"}']],
    ["unknown kind", [CHROME, '{"kind":"hack"}']],
    ["upper-case kind", [CHROME, '{"kind":"VIEW"}']],
    ["kind from the prototype", [CHROME, '{"kind":"constructor"}']],
    ["__proto__ kind", [CHROME, '{"kind":"__proto__"}']],
    ["kind not text", [CHROME, '{"kind":["view"]}']],
    ["no kind", [CHROME, "{}"]],
    ["JSON text, not an object", [CHROME, '"view"']],
    ["JSON null", [CHROME, "null"]],
    ["not JSON", [CHROME, "view"]],
    ["empty body", [CHROME, ""]],
    ["201-byte body", [CHROME, padded(201)]],
  ];
  for (const [label, args] of IGNORED) {
    const DB = await seed({ prospect: { stage: "emailed" } });
    const res = await beaconTo(DB)(...args);
    assert.equal(res.status, 204, label);
    assert.equal(await res.text(), "", `${label}: no body`);
    assert.deepEqual(events(DB), [], `${label}: no demo_events row`);
    assert.deepEqual(prospectRow(DB), UNTOUCHED, `${label}: prospect untouched`);
  }
  // a stale or wrong cookie isn't Nik: that view counts
  const DB = await seed({ prospect: { stage: "emailed" } });
  await beaconTo(DB)(CHROME, VIEW, `${SESSION_COOKIE}=${await sessionToken("an-old-password")}`);
  assert.equal(prospectRow(DB).views, 1, "an old password's cookie is a visitor's");
});

test("a missing demo, a bad slug or no prospect: 204 and nothing stored (never a prospect made)", async (t) => {
  at(t, NOW);
  const DB = await seed({ prospect: { stage: "emailed" } });
  for (const params of [{ slug: "nobody-here-abc234" }, { slug: "../etc" }, { slug: "" }, { slug: undefined }, {}, undefined,
    { slug: "Green-Leaf" }, { slug: `${SLUG}/order` }]) {
    const request = new Request(BEACON_URL, { method: "POST", body: VIEW, headers: { "user-agent": CHROME } });
    const res = await onRequestPost({ request, env: { DB, CONTROL_ROOM_PASSWORD: PW }, params });
    assert.equal(res.status, 204, JSON.stringify(params));
  }
  assert.deepEqual(events(DB), []);
  assert.deepEqual(prospectRow(DB), UNTOUCHED);

  const none = await seed();
  for (const body of [VIEW, '{"kind":"order_page"}', '{"kind":"order_click"}']) {
    assert.equal((await beaconTo(none)(CHROME, body)).status, 204, body);
  }
  assert.deepEqual(events(none), [], "no prospect: no email went out, so nothing is counted");
  assert.equal(prospectRow(none), null, "and no prospect is made");
});

test("the 30-minute window: 29 minutes later doesn't count, 31 does; the stage stays viewed", async (t) => {
  at(t, NOW);
  const DB = await seed({ prospect: { stage: "emailed" } });
  const post = beaconTo(DB);
  await post(CHROME);
  assert.deepEqual(prospectRow(DB), { views: 1, stage: "viewed", stage_at: "2026-10-21T10:00:00Z", last_view_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z" });
  t.mock.timers.setTime(NOW.getTime() + 29 * MIN);
  await post(CHROME);
  assert.equal(prospectRow(DB).views, 1, "29 minutes later");
  t.mock.timers.setTime(NOW.getTime() + 31 * MIN);
  await post(CHROME);
  assert.deepEqual(prospectRow(DB), { views: 2, stage: "viewed", stage_at: "2026-10-21T10:00:00Z", last_view_at: "2026-10-21T10:31:00Z", updated_at: "2026-10-21T10:31:00Z" });
  // order events in between are stored but never de-duplicated or counted as views
  await post(CHROME, '{"kind":"order_page"}');
  await post(CHROME, '{"kind":"order_click"}');
  await post(CHROME, '{"kind":"order_click"}');
  assert.deepEqual(events(DB), ["view 2026-10-21T10:00:00Z", "view 2026-10-21T10:31:00Z", "order_page 2026-10-21T10:31:00Z",
    "order_click 2026-10-21T10:31:00Z", "order_click 2026-10-21T10:31:00Z"]);
  assert.equal(prospectRow(DB).views, 2);
});

test("the beacon reads at most 200 bytes of the body", async (t) => {
  at(t, NOW);
  assert.equal(Buffer.byteLength(padded(200)), 200);
  assert.equal(Buffer.byteLength(padded(201)), 201);
  const over = await seed({ prospect: { stage: "emailed" } });
  await beaconTo(over)(CHROME, padded(201));
  assert.deepEqual(prospectRow(over), UNTOUCHED, "201 bytes: ignored");
  await beaconTo(over)(CHROME, padded(200));
  assert.equal(prospectRow(over).views, 1, "200 bytes: read and counted");

  // A body that never ends (a view followed by spaces forever, which is valid JSON if read whole): it stops reading
  // past 200 bytes, cancels the stream and stores nothing.
  const DB = await seed({ prospect: { stage: "emailed" } });
  let pulled = 0;
  let cancelled = false;
  const enc = new TextEncoder();
  const endless = new ReadableStream({
    pull(c) { c.enqueue(enc.encode(pulled++ === 0 ? VIEW : " ".repeat(100))); },
    cancel() { cancelled = true; },
  });
  const res = await onRequestPost({
    request: new Request(BEACON_URL, { method: "POST", body: endless, duplex: "half", headers: { "user-agent": CHROME } }),
    env: { DB, CONTROL_ROOM_PASSWORD: PW },
    params: { slug: SLUG },
  });
  assert.equal(res.status, 204);
  assert.ok(pulled <= 5, `pulled ${pulled} chunks`);
  assert.equal(cancelled, true, "the rest of the body is never read");
  assert.deepEqual(prospectRow(DB), UNTOUCHED);
});

test("the beacon always answers 204, and a database error is one plain log line without secrets", async (t) => {
  at(t, NOW);
  const logged = [];
  t.mock.method(console, "error", (...args) => { logged.push(args.join(" ")); });
  const PASSWORD = "secret-password-123";
  const req = () => new Request(BEACON_URL, { method: "POST", body: VIEW, headers: { "user-agent": CHROME } });
  const none = await onRequestPost({ request: req(), env: { CONTROL_ROOM_PASSWORD: PASSWORD }, params: { slug: SLUG } });
  assert.equal(none.status, 204, "no database bound");
  const broken = {
    prepare() { throw new Error("D1_ERROR: no such table: demos: SQLITE_ERROR\nsecond line"); },
    batch() { throw new Error("D1_ERROR: boom"); },
  };
  const failed = await onRequestPost({ request: req(), env: { DB: broken, CONTROL_ROOM_PASSWORD: PASSWORD }, params: { slug: SLUG } });
  assert.equal(failed.status, 204, "the database throws");
  assert.equal(logged.length, 2, logged.join("\n"));
  const token = await sessionToken(PASSWORD);
  for (const line of logged) {
    assert.match(line, /^The demo page's view counter couldn't store a visit: /);
    assert.ok(!line.includes("\n"), "one line");
    assert.ok(!line.includes(PASSWORD) && !line.includes(token), "no secrets");
  }
  // a bot never reaches the database, so nothing is logged for it
  await onRequestPost({ request: new Request(BEACON_URL, { method: "POST", body: VIEW, headers: { "user-agent": "curl/8" } }), env: { DB: broken, CONTROL_ROOM_PASSWORD: PASSWORD }, params: { slug: SLUG } });
  assert.equal(logged.length, 2);
});

test("the beacon's D1 cost: none for a bot, Nik or a bad body; at most 10 statements for a counted view", async (t) => {
  at(t, NOW);
  await db({ DB: fakeD1() }); // the isolate's one schema check, out of the count
  const DB = await seed({ prospect: { stage: "emailed" } });
  const c = countingDB(DB);
  const post = beaconTo(c.DB);
  await post("Googlebot/2.1");
  await post(CHROME, '{"kind":"hack"}');
  await post(CHROME, padded(201));
  await post(CHROME, VIEW, `${SESSION_COOKIE}=${await sessionToken(PW)}`);
  assert.equal(c.used(), 0, "ignored before any query");
  await post(CHROME);
  assert.ok(c.used() <= 10, `a counted view used ${c.used()}`);
  assert.equal(prospectRow(DB).views, 1);
});

test("the demo page's and the order page's own beacons post kinds the route stores", async (t) => {
  at(t, NOW);
  const DB = await seed({ prospect: { stage: "emailed" } });
  const kindsIn = (html) => [...new Set([
    ...[...html.matchAll(/\bs\("([a-z_]+)"\)/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-ev="([^"]+)"/g)].map((m) => m[1]),
  ])].sort();
  const demoHtml = await (await get(DB, SLUG)).text();
  assert.ok(demoHtml.includes(`var u="/d/${SLUG}/e"`), "the demo page posts to this demo's beacon");
  assert.deepEqual(kindsIn(demoHtml), ["order_page", "view"]);

  const lead = DB.raw.prepare("SELECT * FROM leads").get();
  const demo = DB.raw.prepare("SELECT * FROM demos").get();
  const orderHtml = oldDemo.renderOrder(lead, demo, {}, NOW);
  assert.ok(orderHtml.includes(`var u="/d/${SLUG}/e"`), "the order page posts to the same beacon");
  assert.deepEqual(kindsIn(orderHtml), ["order_click", "order_page"]);

  for (const kind of [...kindsIn(demoHtml), ...kindsIn(orderHtml)]) {
    assert.equal((await beaconTo(DB)(CHROME, JSON.stringify({ kind }))).status, 204, kind);
  }
  assert.deepEqual(events(DB), ["order_page 2026-10-21T10:00:00Z", "view 2026-10-21T10:00:00Z", "order_click 2026-10-21T10:00:00Z",
    "order_page 2026-10-21T10:00:00Z"]);
  assert.equal(prospectRow(DB).views, 1);
  assert.deepEqual(EVENT_KINDS, ["view", "order_page", "order_click", "ordered"], "kept for stage 9");
});

test("countView: one per 30 minutes; views, last_view_at and updated_at in now() format; emailed → viewed", async () => {
  const DB = await seed({ prospect: { stage: "emailed" } });
  const demo = { ...DB.raw.prepare("SELECT * FROM demos").get() };
  assert.equal(await countView(DB, demo, NOW), true);
  assert.deepEqual(prospectRow(DB), { views: 1, stage: "viewed", stage_at: "2026-10-21T10:00:00Z", last_view_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z" });
  assert.equal(await countView(DB, demo, new Date(NOW.getTime() + 29 * MIN)), false);
  assert.equal(await countView(DB, demo, "2026-10-21T10:31:00Z"), true, "ISO text works as `now` too");
  assert.deepEqual(prospectRow(DB), { views: 2, stage: "viewed", stage_at: "2026-10-21T10:00:00Z", last_view_at: "2026-10-21T10:31:00Z", updated_at: "2026-10-21T10:31:00Z" });
  assert.deepEqual(events(DB), ["view 2026-10-21T10:00:00Z", "view 2026-10-21T10:31:00Z"]);
  await assert.rejects(countView(DB, demo, new Date("nope")), /time/i);
  assert.equal(prospectRow(DB).views, 2);
});

test("the 30-minute view check reads demo_events through its index, never the whole table", async () => {
  const DB = await seed({ prospect: { stage: "emailed" } });
  const seen = [];
  // Every statement countView makes is bound before it runs, so recording bind() sees each one with its values.
  const spy = {
    prepare: (sql) => ({ bind: (...args) => { seen.push({ sql, args }); return DB.prepare(sql).bind(...args); } }),
    batch: (stmts) => DB.batch(stmts),
  };
  const demo = { ...DB.raw.prepare("SELECT * FROM demos").get() };
  assert.equal(await countView(spy, demo, NOW), true);
  const insert = seen.find((s) => /INSERT INTO demo_events/.test(s.sql));
  assert.ok(insert, "the view went through recordEvent's INSERT");
  const plan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${insert.sql}`).all(...insert.args).map((r) => r.detail);
  assert.ok(plan.some((d) => /USING (COVERING )?INDEX demo_events_place/.test(d)), plan.join(" | "));
  assert.ok(!plan.some((d) => /^SCAN demo_events/.test(d)), plan.join(" | "));
});

test("countView: later stages count views without moving; a ready or missing prospect and an ended demo count nothing", async () => {
  for (const stage of ["viewed", "replied", "needs_nik", "call_booked", "won", "lost"]) {
    const DB = await seed({ prospect: { stage } });
    const demo = DB.raw.prepare("SELECT * FROM demos").get();
    assert.equal(await countView(DB, demo, NOW), true, stage);
    assert.deepEqual(prospectRow(DB), { views: 1, stage, stage_at: SEED_AT, last_view_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z" }, stage);
  }
  const ready = await seed({ prospect: { stage: "ready" } });
  assert.equal(await countView(ready, ready.raw.prepare("SELECT * FROM demos").get(), NOW), false);
  assert.deepEqual(prospectRow(ready), { ...UNTOUCHED, stage: "ready" });
  assert.deepEqual(events(ready), [], "no event row for a ready prospect");

  const none = await seed();
  assert.equal(await countView(none, none.raw.prepare("SELECT * FROM demos").get(), NOW), false);
  assert.equal(prospectRow(none), null);
  assert.deepEqual(events(none), []);

  const ended = await seed({ demo: { expires_at: "2026-10-21T10:00:00Z" }, prospect: { stage: "emailed" } });
  assert.equal(await countView(ended, ended.raw.prepare("SELECT * FROM demos").get(), NOW), false, "ended at its expires_at");
  assert.deepEqual(prospectRow(ended), UNTOUCHED);
  assert.deepEqual(events(ended), []);
});

test("isBotUA: the exact BOT_UA list, and an empty or missing user-agent", () => {
  assert.equal(BOT_UA.source, String.raw`bot|crawl|spider|slurp|preview|scan|monitor|fetch|headless|lighthouse|pagespeed|python|curl|wget|go-http|java\/|okhttp|axios|node|facebookexternalhit|whatsapp|telegram|skype|slack|discord|outlook|microsoft office|safelinks|proofpoint|mimecast|barracuda|bitdefender`);
  assert.equal(BOT_UA.flags, "i", "case-insensitive, and no g flag: test() keeps no state between calls");
  for (const ua of ["", "   ", undefined, null, 42]) assert.equal(isBotUA(ua), true, String(ua));
  const BOTS = [
    "Googlebot/2.1", "Mozilla/5.0 (compatible; bingbot/2.0)", "Mozilla/5.0 HeadlessChrome/120", "python-requests/2.31",
    "Microsoft Office/16.0 (Outlook)", "curl/8.4.0", "Wget/1.21", "Go-http-client/2.0", "Java/17.0.2", "okhttp/4.12.0",
    "axios/1.6.0", "node-fetch/1.0", "facebookexternalhit/1.1", "WhatsApp/2.23", "TelegramBot (like TwitterBot)",
    "Skype Preview", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Discordbot/2.0)", "Outlook-iOS/709",
    "SafeLinks", "Proofpoint URL Defense", "Mimecast", "Barracuda Sentinel", "Bitdefender scanner",
    "Mozilla/5.0 Chrome-Lighthouse", "Google Page Speed Insights PageSpeed", "Yahoo! Slurp", "Baiduspider", "Site monitor 1.0",
    "Mozilla/5.0 (compatible; crawler)",
  ];
  for (const ua of BOTS) {
    assert.equal(isBotUA(ua), true, ua);
    assert.equal(isBotUA(ua), true, `${ua} (twice: no state)`);
  }
  const PEOPLE = [
    CHROME,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  ];
  for (const ua of PEOPLE) assert.equal(isBotUA(ua), false, ua);
});

test("session.js: the cookie name and token the login has always used, so Nik's live session keeps working", async () => {
  assert.equal(SESSION_COOKIE, "cr_session");
  const expected = createHmac("sha256", "pw").update("goldbar-control-room-session").digest("hex");
  assert.equal(await sessionToken("pw"), expected, "HMAC-SHA256 of 'goldbar-control-room-session' keyed by the password");
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.notEqual(await sessionToken("pw2"), expected);

  // The middleware's login sets exactly that cookie, and its gate takes it back.
  const env = { CONTROL_ROOM_PASSWORD: "pw" };
  let reached = 0;
  const call = (path, init = {}) => middleware({ request: new Request(`https://goldbar.pages.dev${path}`, init), env, next: async () => { reached++; return new Response("ok"); } });
  const form = (password) => { const f = new FormData(); f.set("password", password); return f; };
  const login = await call("/login", { method: "POST", body: form("pw") });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  assert.equal(login.headers.get("set-cookie"), `cr_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure`);
  const wrong = await call("/login", { method: "POST", body: form("nope") });
  assert.equal(wrong.headers.get("location"), "/login?wrong=1");
  assert.equal(wrong.headers.get("set-cookie"), null);
  // An empty or missing password is a wrong one (WebCrypto refuses a zero-length HMAC key, so it used to be a 500).
  const noPassword = new FormData();
  noPassword.set("other", "x");
  for (const body of [form(""), noPassword]) {
    const empty = await call("/login", { method: "POST", body });
    assert.equal(empty.status, 303);
    assert.equal(empty.headers.get("location"), "/login?wrong=1");
    assert.equal(empty.headers.get("set-cookie"), null);
  }
  assert.equal((await call("/api/leads", { headers: { cookie: `cr_session=${expected}` } })).status, 200);
  assert.equal(reached, 1);
  assert.equal((await call("/api/leads", { headers: { cookie: `cr_session=${expected.slice(0, -1)}0` } })).status, 401);
  assert.equal((await call("/logout")).headers.get("set-cookie"), "cr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");

  // one copy: the middleware imports it from session.js
  const src = readFileSync(new URL("../functions/_middleware.js", import.meta.url), "utf8");
  assert.match(src, /from "\.\/_lib\/session\.js"/);
  assert.ok(!/goldbar-control-room-session|"cr_session"|function sessionToken|function safeEqual|function readCookie/.test(src), "no copy left in the middleware");
});

test("isOwnerRequest: only a valid cr_session cookie is Nik", async () => {
  const token = await sessionToken("pw");
  const env = { CONTROL_ROOM_PASSWORD: "pw" };
  const req = (cookie) => new Request(BEACON_URL, { method: "POST", headers: cookie === undefined ? {} : { cookie } });
  assert.equal(await isOwnerRequest(req(`cr_session=${token}`), env), true);
  assert.equal(await isOwnerRequest(req(`theme=dark; cr_session=${token}; other=1`), env), true);
  for (const cookie of [undefined, "", "cr_session=", `cr_session=${token.slice(0, -1)}`, `cr_session=${token}x`,
    `cr_session=${token.toUpperCase()}`, `xcr_session=${token}`, `other=${token}`]) {
    assert.equal(await isOwnerRequest(req(cookie), env), false, String(cookie));
  }
  assert.equal(await isOwnerRequest(req(`cr_session=${await sessionToken("old-password")}`), env), false, "an old password's cookie");
  assert.equal(await isOwnerRequest(req(`cr_session=${token}`), {}), false, "no password set: nobody is Nik");
  assert.equal(await isOwnerRequest(req("cr_session=x"), { CONTROL_ROOM_PASSWORD: "" }), false, "an empty password");
});
