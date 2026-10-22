// The public site on the root domain: landing page, privacy notice, 404 page, robots.txt and the middleware's host
// routing (stage 0, Task 22; Part A "Host routing and the public site", "Landing page copy", "Privacy notice copy").
// A stage that adds a public prefix adds it in _middleware.js and to the root-host list below, and gives it a
// catch-all functions/<prefix>/[[path]].js (the 404 page; checked below).
// Run: node --test control-room/tests/site.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { BUILD_GUARANTEE, GUARANTEE } from "../functions/_lib/offer.js";
import { setSetting } from "../functions/_lib/settings.js";
import {
  DEFAULT_CONTACT, DEFAULT_ROOT_HOST, PRIVACY_UPDATED, ROBOTS, loadSiteSettings, renderLanding, renderNotFound,
  renderPrivacy, rootHostFor, siteResponse, traderLine,
} from "../functions/_lib/site.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const WEEKDAY = new Date("2026-10-21T10:00:00Z"); // Wednesday
const SATURDAY = new Date("2026-10-24T10:00:00Z");
const landing = (opts = {}) => renderLanding({ business: {}, contactEmail: "hello@aetoswebsites.com", now: WEEKDAY, ...opts });
const count = (haystack, needle) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------- Step 1: the landing page

test("weekday landing: £1,950, £249, 60 days free, both guarantees and the build guarantee; never £2,000", () => {
  const html = landing({ now: WEEKDAY });
  assert.ok(html.includes("£1,950"));
  assert.ok(html.includes("£249"));
  assert.ok(html.includes("First 60 days free"));
  assert.ok(html.includes(GUARANTEE.headline));
  assert.ok(html.includes(GUARANTEE.section));
  assert.ok(html.includes(BUILD_GUARANTEE));
  assert.ok(!html.includes("£2,000"));
});

test("Saturday landing: <s>£1,950</s> £1,750 and 90 days free; never £2,000", () => {
  const html = landing({ now: SATURDAY });
  assert.ok(html.includes("<s>£1,950</s>"));
  assert.ok(html.includes("£1,750"));
  assert.ok(html.includes("First 90 days free"));
  assert.ok(!html.includes("£2,000"));
});

test("default extras: no review booster, no reviews item, no chatbot; extras.reviews shows both review lines", () => {
  const html = landing();
  assert.ok(!html.includes("Review booster"));
  assert.ok(!html.includes("More reviews, the honest way"));
  assert.doesNotMatch(html, /chatbot|chat assistant/i);
  const reviews = landing({ extras: { reviews: true } });
  assert.ok(reviews.includes("Review booster"));
  assert.ok(reviews.includes("More reviews, the honest way"));
});

test("traderLine: the full sentence when name and address are filled, else empty", () => {
  assert.equal(traderLine({ legal_name: "N", address: "1 St" }), "Aetos Websites is a trading name of N, 1 St.");
  assert.equal(traderLine({ legal_name: "N", address: "" }), "");
});

test("landing: no 'SEO', no phone number, the mailto and the Setup check's marker", () => {
  const html = landing();
  assert.doesNotMatch(html, /\bSEO\b/i);
  assert.doesNotMatch(html, /\b0\d{3,4}\s?\d{3}\s?\d{3,4}\b/);
  assert.ok(html.includes("mailto:hello@aetoswebsites.com"));
  assert.ok(html.includes("data-aetos-landing"));
});

test("landing escapes business details; empty ones leave no '[' or 'undefined'", () => {
  const html = landing({ business: { legal_name: "N <b>", address: "1 St & Co" } });
  assert.ok(html.includes("N &lt;b&gt;"));
  assert.ok(html.includes("1 St &amp; Co"));
  const empty = landing({ business: { legal_name: "", address: "" } });
  assert.ok(!empty.includes("["));
  assert.ok(!empty.includes("undefined"));
});

test("privacy notice: legitimate interest, the ICO link and phone, \"no thanks\" and 12 months", () => {
  const html = renderPrivacy({ business: { legal_name: "N", address: "1 St" }, contactEmail: "hello@aetoswebsites.com", updated: PRIVACY_UPDATED });
  assert.ok(html.includes("legitimate interest"));
  assert.ok(html.includes("https://ico.org.uk/make-a-complaint/"));
  assert.ok(html.includes("0303 123 1113"));
  assert.ok(html.includes('"no thanks"'));
  assert.ok(html.includes("12 months"));
});

// ---------------------------------------------------------------- Step 1: the middleware

const PASSWORD = "test-password-123";
const COOKIE = `cr_session=${createHmac("sha256", PASSWORD).update("goldbar-control-room-session").digest("hex")}`;

// A fresh database per call, so rootHostFor's 60-second cache (kept per database) never leaks between tests.
function site(DB = fakeD1()) {
  const env = { CONTROL_ROOM_PASSWORD: PASSWORD, DB };
  const nexts = [];
  const next = async () => {
    nexts.push(true);
    return new Response("from next", { status: 200 });
  };
  const call = (url, init) => onRequest({ request: new Request(url, init), env, next });
  return { DB, env, call, nexts };
}

test("middleware, root aetoswebsites.com: GET / is the landing page (200 HTML, no x-robots-tag)", async () => {
  const { call, nexts } = site();
  const res = await call("https://aetoswebsites.com/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-robots-tag"), null);
  assert.ok((await res.text()).includes("data-aetos-landing"));
  assert.equal(nexts.length, 0);
});

test("middleware: www.<root> is a 301 to the root with the same path and query", async () => {
  const { call } = site();
  const res = await call("https://www.aetoswebsites.com/privacy?x=1");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://aetoswebsites.com/privacy?x=1");
});

test("middleware: /login on the root host is the 404 page with a link to /", async () => {
  const { call, nexts } = site();
  const res = await call("https://aetoswebsites.com/login");
  assert.equal(res.status, 404);
  assert.ok((await res.text()).includes('href="/"'));
  assert.equal(nexts.length, 0);
});

test("middleware: /d/abc on the root host goes to its function with no cookie", async () => {
  const { call, nexts } = site();
  const res = await call("https://aetoswebsites.com/d/abc");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "from next");
  assert.equal(nexts.length, 1);
});

test("middleware: /api/agent/heartbeat on the root host is a 404", async () => {
  const { call, nexts } = site();
  const res = await call("https://aetoswebsites.com/api/agent/heartbeat", { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
  assert.equal(nexts.length, 0);
});

test("middleware: /robots.txt on the root host disallows /d/", async () => {
  const { call } = site();
  const res = await call("https://aetoswebsites.com/robots.txt");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Disallow: \/d\//);
});

test("middleware: the Control Room's own host is unchanged (no cookie → 303 to /login)", async () => {
  const { call } = site();
  const res = await call("https://control.aetoswebsites.com/");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login");
});

test("middleware: the site:root_host setting moves the landing page to that host", async () => {
  const DB = fakeD1();
  await setSetting(DB, "site:root_host", "example.org");
  const { call } = site(DB);
  const res = await call("https://example.org/");
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("data-aetos-landing"));
  // aetoswebsites.com is now just another host: the Control Room's login gate.
  assert.equal((await call("https://aetoswebsites.com/")).status, 303);
  const www = await call("https://www.example.org/a?b=1");
  assert.equal(www.status, 301);
  assert.equal(www.headers.get("location"), "https://example.org/a?b=1");
});

// ---------------------------------------------------------------- more on the landing page

test("landing: the exact Part A copy, in order", () => {
  const html = landing({ extras: { reviews: true } });
  const inOrder = [
    "<title>Aetos Websites | More work from Google for local trades</title>",
    '<meta name="description" content="Websites for local trades, live in 7 days, and the top 3 on Google in your area in 90 days, guaranteed.">',
    'src="/logo.png"',
    "AETOS",
    "WEBSITES",
    "Email us",
    "More jobs from Google for local trades.",
    "A new website, live in 7 days, and your business in the top 3 on Google in your area.",
    GUARANTEE.headline,
    "Email us",
    "Send your business name and town. We'll build you a free preview of your new site.",
    "Built for owner-run trades",
    "Roofers, plumbers, heating engineers, electricians, landscapers, removals, mechanics, locksmiths, pest control, independent car dealers, driving schools and martial arts gyms. If your customers search Google for what you do in your town, this is for you.",
    "What you get",
    "A website that wins work.",
    "Written for your trade and your town, with your own photos, your reviews and an easy way to call or message you. Live in 7 days.",
    "Found on Google.",
    "We set up and look after your Google Business Profile and your site, so people searching for your service in your area find you first.",
    "More reviews, the honest way.",
    "Your Google review link, a QR card for jobs, and ready-to-send messages to ask every customer.",
    "Looked after every month.",
    "Hosting, updates and changes, plus a short monthly report on where you rank and how your reviews are growing.",
    "Prices",
    "Full Package",
    "<strong>£1,950</strong> to build, then <strong>£249 a month</strong>. <strong>First 60 days free.</strong>",
    BUILD_GUARANTEE,
    GUARANTEE.headline,
    "Google Business Profile set up and looked after",
    "Review booster",
    "Monthly care and report",
    "Website Only",
    "<strong>£1,750</strong> one-off. Nothing monthly.",
    BUILD_GUARANTEE,
    "Yours to keep",
    "The 7 days start when you've filled in our short onboarding form.",
    "The guarantee",
    GUARANTEE.section,
    "We measure it on Google's results for your main service and your town, searched from your area. The map results at the top count.",
    "How it works",
    "Email us your business name and town.",
    "We build a preview of your new website, free, so you can see it before you pay anything.",
    "Like it? Pay online, fill in a short form, and your site is live within 7 days.",
    "No contract",
    "No contract and no cancellation fees. If we're not making you money, we don't want your money. If you stop paying, you keep your website and the monthly work stops.",
    "Talk to us",
    "with your business name and town, and we'll take it from there.",
    'href="/privacy">Privacy notice</a>',
    "© 2026 Aetos Websites",
  ];
  let from = 0;
  for (const piece of inOrder) {
    const at = html.indexOf(piece, from);
    assert.ok(at >= 0, `missing or out of order: ${piece}`);
    from = at + piece.length;
  }
});

test("landing: the two gold 'Email us' buttons share the mailto with its subject", () => {
  const html = landing({ contactEmail: "nik@aetoswebsites.com" });
  const mailto = 'href="mailto:nik@aetoswebsites.com?subject=Website%20for%20my%20business"';
  assert.equal(count(html, `class="btn" ${mailto}>Email us</a>`) + count(html, `class="btn btn-big" ${mailto}>Email us</a>`), 2);
  assert.ok(html.includes("<strong><a"), "the contact email is bold under Talk to us");
  assert.ok(!html.includes("hello@aetoswebsites.com"), "the setting replaces the default everywhere");
});

test("landing: Saturday shows the weekend tag and the struck-through real weekday price; weekdays don't", () => {
  const sat = landing({ now: SATURDAY });
  assert.ok(sat.includes("Weekend deal: ends Sunday midnight"));
  assert.ok(sat.includes("<strong>£1,750</strong> to build, then <strong>£249 a month</strong>. <strong>First 90 days free.</strong>"));
  assert.ok(!sat.includes("First 60 days free"));
  const wed = landing({ now: WEEKDAY });
  assert.ok(!wed.includes("Weekend deal"));
  assert.ok(!wed.includes("<s>"));
  assert.ok(!wed.includes("First 90 days free"));
});

test("landing: Friday 23:30 UTC in BST is already Saturday in the UK (weekend prices)", () => {
  const html = landing({ now: new Date("2026-10-23T23:30:00Z") });
  assert.ok(html.includes("<s>£1,950</s>"));
  assert.ok(html.includes("First 90 days free"));
  const friday = landing({ now: new Date("2026-10-23T22:59:00Z") }); // 23:59 Friday UK
  assert.ok(friday.includes("First 60 days free"));
});

test("landing: the review lines appear once each, and only with extras.reviews", () => {
  const html = landing({ extras: { chatbot: false, reviews: true } });
  assert.equal(count(html, "Review booster"), 1);
  assert.equal(count(html, "More reviews, the honest way"), 1);
  // The chatbot is stage 10's to write: nothing about it here even with the switch on.
  assert.doesNotMatch(landing({ extras: { chatbot: true } }), /chatbot|chat assistant/i);
});

test("landing footer: the trader line when both are filled, else just 'Aetos Websites'", () => {
  const full = landing({ business: { legal_name: "Nikiforos Surname", address: "1 High St\nLeeds\nLS1 1AA" } });
  assert.ok(full.includes("Aetos Websites is a trading name of Nikiforos Surname, 1 High St, Leeds, LS1 1AA."));
  const none = landing({ business: { legal_name: "Nikiforos Surname", address: "  " } });
  assert.ok(!none.includes("trading name"));
  assert.match(none, /<footer[\s\S]*<p>Aetos Websites<\/p>/);
  const missing = renderLanding({ now: WEEKDAY });
  assert.ok(missing.includes(`mailto:${DEFAULT_CONTACT}`));
  assert.ok(!missing.includes("undefined"));
});

test("landing: a contact email that isn't an email address falls back to the default", () => {
  for (const bad of ["", "not an email", "a@b.com?cc=x@y.com", "a@b.com\nBcc: x", '"><script>@x.com']) {
    const html = landing({ contactEmail: bad });
    assert.ok(html.includes("mailto:hello@aetoswebsites.com?subject="), JSON.stringify(bad));
    assert.ok(!html.includes("<script>"), JSON.stringify(bad));
  }
});

test("landing: Inter from Google Fonts is the only external resource, all CSS inline, brand colours", () => {
  const html = landing();
  const external = [...html.matchAll(/(?:href|src)="(https?:[^"]*)"/g)].map((m) => m[1]);
  assert.ok(external.length > 0);
  for (const url of external) assert.match(url, /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/);
  assert.match(html, /family=Inter/);
  assert.match(html, /<style>/);
  assert.ok(!/<link[^>]+rel="stylesheet"[^>]+href="\//.test(html), "no local stylesheet");
  assert.ok(!/<script/i.test(html), "no scripts");
  for (const colour of ["#1A1C20", "#F6F4EF", "#5C6066", "#C9A13B", "#7A5C14"]) assert.ok(html.includes(colour), colour);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<html lang="en-GB" data-aetos-landing>/);
});

test("landing: UK year in the footer (New Year's Eve 23:30 UTC is still that year in the UK)", () => {
  assert.ok(landing({ now: new Date("2026-12-31T23:30:00Z") }).includes("© 2026 Aetos Websites"));
  assert.ok(landing({ now: new Date("2027-01-01T00:00:00Z") }).includes("© 2027 Aetos Websites"));
});

// ---------------------------------------------------------------- traderLine

test("traderLine: trims, joins address lines, never ends '..', and is raw text (callers escape)", () => {
  assert.equal(traderLine({ legal_name: "  N  ", address: " 1 St. " }), "Aetos Websites is a trading name of N, 1 St.");
  assert.equal(traderLine({ legal_name: "N", address: "1 High St,\r\nLeeds\n\nLS1 1AA" }), "Aetos Websites is a trading name of N, 1 High St, Leeds, LS1 1AA.");
  assert.equal(traderLine({ legal_name: "N <b>", address: "1 St & Co" }), "Aetos Websites is a trading name of N <b>, 1 St & Co.");
  assert.equal(traderLine({ legal_name: "", address: "1 St" }), "");
  assert.equal(traderLine({ legal_name: "   ", address: "1 St" }), "");
  assert.equal(traderLine({}), "");
  assert.equal(traderLine(null), "");
  assert.equal(traderLine(undefined), "");
  assert.equal(traderLine({ legal_name: null, address: null }), "");
});

// ---------------------------------------------------------------- privacy notice and 404

test("privacy: the Part A copy, in order", () => {
  const html = renderPrivacy({ business: { legal_name: "N", address: "1 St", ico_number: "ZA123456" }, contactEmail: "hello@aetoswebsites.com", updated: "2026-10-22" });
  const inOrder = [
    "<title>Privacy notice | Aetos Websites</title>",
    "Privacy notice",
    "Last updated 22 October 2026.",
    "Who we are",
    "Aetos Websites is a trading name of N, a sole trader in the UK, 1 St. Email: ",
    "hello@aetoswebsites.com",
    "We decide how the information below is used (we're the \"controller\"). ICO registration number: ZA123456.",
    "What this covers",
    "We build websites for local trade businesses and help them get found on Google. To do that, we look for businesses we could help and email them. This notice explains what we hold about you if we've contacted you, if you've contacted us, or if you're a customer.",
    "What we collect and where from",
    "If we've contacted you, we found your business through public sources:",
    "your Google Business listing: business name, address, phone number, website, opening hours, star rating and public reviews;",
    "your own website: contact email addresses, the names of the people who run the business, your services, your logo, colours and photos;",
    "the Companies House register, if your business is a company: directors' names;",
    "public business directories and your business's social media pages.",
    "We also keep the emails we exchange with you, and the date and time of each visit to the preview website we made for you. Our emails contain no tracking pixels.",
    "If you become a customer, we also hold your contact details, your answers to our onboarding form and your payment records. Card payments are handled by Stripe; we never see your full card number.",
    "Why we use it, and our legal basis",
    "To offer you our services by email, and to build the preview website we show you: our legitimate interest in telling local businesses about a service that can help them. We only use business contact details and information about your business. We only write about our own services, and every email lets you opt out with one reply.",
    "To decide who to contact first, we score businesses on things like how easy they are to find on Google. This has no legal or similar effect on you.",
    "If you're a customer: to provide the service you paid for (contract), and to keep accounts (legal obligation).",
    "Who we share it with",
    "Only the service providers that run our business, under contracts that require them to protect it:",
    "Cloudflare: website hosting and database.",
    "Namecheap: email.",
    "Stripe: payments.",
    "Google: business listing data.",
    "Anthropic: an AI assistant that helps research businesses and draft replies.",
    "GitHub: runs our software.",
    "Some of them are in the USA. Those transfers are covered by the UK's approved safeguards (the UK–US data bridge or standard contract clauses). We never sell your information.",
    "How long we keep it",
    "If we contacted you and you didn't become a customer, we delete your details 12 months after our last contact.",
    "If you ask us to stop, we delete them but keep your email address on a do-not-contact list, so we never email you again.",
    "Customer records are kept for 6 years after you stop being a customer, because HMRC requires it.",
    "Your rights",
    "You can ask us for a copy of your information, ask us to correct or delete it, or ask us to stop using it. You can object to marketing at any time: reply \"no thanks\" to any of our emails, or email ",
    "and we'll stop straight away. We answer any other request within one month.",
    "Cookies",
    "This website sets no cookies and uses no tracking.",
    "Complaints",
    "If you're unhappy with how we've handled your information, please tell us first at ",
    "You can also complain to the Information Commissioner's Office: ",
    "https://ico.org.uk/make-a-complaint/",
    " or 0303 123 1113.",
  ];
  let from = 0;
  for (const piece of inOrder) {
    const at = html.indexOf(piece, from);
    assert.ok(at >= 0, `missing or out of order: ${piece}`);
    from = at + piece.length;
  }
  assert.ok(!html.includes("data-aetos-landing"), "only the landing page carries the Setup check's marker");
});

test("privacy: optional parts left out cleanly; settings escaped", () => {
  const plain = renderPrivacy({ business: { legal_name: "N", address: "" }, contactEmail: "hello@aetoswebsites.com", updated: "2026-10-22" });
  assert.ok(plain.includes("Aetos Websites is a trading name of N, a sole trader in the UK. Email: "));
  assert.ok(!plain.includes("ICO registration number"));
  // No name yet: never a blank or a placeholder.
  const noName = renderPrivacy({ business: {}, contactEmail: "", updated: "2026-10-22" });
  assert.ok(noName.includes("Aetos Websites is a trading name of a sole trader in the UK. Email: "));
  assert.ok(noName.includes(`mailto:${DEFAULT_CONTACT}`));
  assert.ok(!noName.includes("undefined") && !noName.includes("null") && !noName.includes("["));
  const hostile = renderPrivacy({ business: { legal_name: "N <script>", address: "1 St & Co", ico_number: '"><img>' }, contactEmail: "hello@aetoswebsites.com", updated: "2026-10-22" });
  assert.ok(hostile.includes("N &lt;script&gt;, a sole trader in the UK, 1 St &amp; Co."));
  assert.ok(hostile.includes("ICO registration number: &quot;&gt;&lt;img&gt;."));
  assert.ok(!hostile.includes("<script>") && !hostile.includes("<img>"));
});

test("privacy: 'Last updated' defaults to PRIVACY_UPDATED, a fixed date (never today's)", () => {
  assert.match(PRIVACY_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  const html = renderPrivacy({ business: {}, contactEmail: "hello@aetoswebsites.com" });
  const [y, m, d] = PRIVACY_UPDATED.split("-").map(Number);
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
  assert.ok(html.includes(`Last updated ${d} ${month} ${y}.`));
  assert.ok(renderPrivacy({ business: {}, updated: "2026-03-01" }).includes("Last updated 1 March 2026."));
});

test("404 page: the Part A text and a gold link home, same look", () => {
  const html = renderNotFound();
  assert.ok(html.includes("That page doesn't exist."));
  assert.match(html, /<a class="home" href="\/">Go to the home page<\/a>/);
  assert.ok(html.includes("#7A5C14"), "gold link on Marble uses Deep Gold");
  assert.ok(html.includes("family=Inter"));
  assert.ok(!html.includes("data-aetos-landing"));
});

test("siteResponse: the landing headers, 200 by default; ROBOTS is the Part A text", async () => {
  const res = siteResponse("<p>x</p>");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-robots-tag"), null);
  assert.equal(await res.text(), "<p>x</p>");
  assert.equal(siteResponse("x", 404).status, 404);
  assert.equal(ROBOTS, "User-agent: *\nDisallow: /d/\nDisallow: /onboard/\nDisallow: /s/\nDisallow: /api/\n");
});

// ---------------------------------------------------------------- settings and the root host

test("loadSiteSettings: one query for business details, contact email and the extras switches", async () => {
  const DB = fakeD1();
  const counted = countingDB(DB);
  assert.deepEqual(await loadSiteSettings(counted.DB), {
    business: { legal_name: "", address: "", ico_number: "" },
    contactEmail: DEFAULT_CONTACT,
    extras: { chatbot: false, reviews: false },
  });
  assert.equal(counted.used(), 1);
  for (const [k, v] of [["business:legal_name", "N"], ["business:address", "1 St"], ["business:ico_number", "ZA1"], ["site:contact_email", "nik@aetoswebsites.com"], ["offer:chatbot_live", "1"], ["offer:review_booster_live", "1"], ["business:sender_name", "Nik"]]) {
    await setSetting(DB, k, v);
  }
  assert.deepEqual(await loadSiteSettings(DB), {
    business: { legal_name: "N", address: "1 St", ico_number: "ZA1" },
    contactEmail: "nik@aetoswebsites.com",
    extras: { chatbot: true, reviews: true },
  });
  await setSetting(DB, "offer:review_booster_live", "0");
  assert.equal((await loadSiteSettings(DB)).extras.reviews, false);
});

test("rootHostFor: default aetoswebsites.com, the setting (tidied), cached 60 s per database", async () => {
  assert.equal(DEFAULT_ROOT_HOST, "aetoswebsites.com");
  assert.equal(await rootHostFor({ DB: fakeD1() }), "aetoswebsites.com");
  assert.equal(await rootHostFor({}, undefined), "aetoswebsites.com", "no database: the default");

  const DB = fakeD1();
  await setSetting(DB, "site:root_host", " https://Example.ORG./ ");
  const counted = countingDB(DB);
  assert.equal(await rootHostFor({ DB }, counted.DB), "example.org");
  assert.equal(await rootHostFor({ DB }, counted.DB), "example.org");
  assert.equal(counted.used(), 1, "the second call is served from the cache");
  // A change is picked up after the cache expires (60 s); until then the cached value stays.
  await setSetting(DB, "site:root_host", "other.org");
  assert.equal(await rootHostFor({ DB }, counted.DB), "example.org");

  const blank = fakeD1();
  await setSetting(blank, "site:root_host", "   ");
  assert.equal(await rootHostFor({ DB: blank }, blank), "aetoswebsites.com");
});

test("rootHostFor: a database error gives the default and isn't cached", async () => {
  let calls = 0;
  const broken = { prepare() { calls++; throw new Error("D1_ERROR: database down"); } };
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.equal(await rootHostFor({ DB: broken }, broken), "aetoswebsites.com");
    assert.equal(await rootHostFor({ DB: broken }, broken), "aetoswebsites.com");
  } finally {
    console.error = original;
  }
  assert.equal(calls, 2, "tried again on the next request");
  assert.equal(logged.length, 2);
});

// ---------------------------------------------------------------- more on the middleware

test("middleware: every public path on the root host reaches its function without a cookie", async () => {
  // A stage adding a public prefix adds it here too.
  for (const path of ["/logo.png", "/favicon.png", "/apple-touch-icon.png", "/d/abc", "/d/abc/order", "/onboard/tok123", "/s/f/0123", "/s/chat.js", "/api/tick", "/api/tick?reason=cron"]) {
    const { call, nexts } = site();
    const res = await call(`https://aetoswebsites.com${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "from next", path);
    assert.equal(nexts.length, 1, path);
  }
  const { call } = site();
  assert.equal((await call("https://aetoswebsites.com/api/stripe/webhook", { method: "POST", body: "{}" })).status, 200);
  assert.equal((await call("https://aetoswebsites.com/api/tick?reason=cron", { method: "POST" })).status, 200);
});

test("middleware: everything else on the root host is the 404 page, even with the login cookie", async () => {
  for (const path of ["/index.html", "/login.html", "/style.css", "/js/app.js", "/robots", "/api/leads", "/api/setup", "/api/agent/x", "/logout", "/d", "/onboard", "/s", "/privacy/x", "/anything"]) {
    for (const headers of [{}, { cookie: COOKIE }]) {
      const { call, nexts } = site();
      const res = await call(`https://aetoswebsites.com${path}`, { headers });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("set-cookie"), null, path);
      const html = await res.text();
      assert.ok(html.includes("That page doesn't exist."), path);
      assert.equal(nexts.length, 0, path);
    }
  }
  // POST /login on the root host never logs anyone in.
  const { call } = site();
  const form = new FormData();
  form.set("password", PASSWORD);
  const login = await call("https://aetoswebsites.com/login", { method: "POST", body: form });
  assert.equal(login.status, 404);
  assert.equal(login.headers.get("set-cookie"), null);
  // Only GET and HEAD read the pages.
  assert.equal((await call("https://aetoswebsites.com/", { method: "POST", body: "x" })).status, 404);
});

test("middleware: /privacy and the landing page read the business settings; HEAD has no body", async () => {
  const DB = fakeD1();
  await setSetting(DB, "business:legal_name", "Nikiforos <Surname>");
  await setSetting(DB, "business:address", "1 High St, Leeds");
  await setSetting(DB, "site:contact_email", "nik@aetoswebsites.com");
  await setSetting(DB, "offer:review_booster_live", "1");
  const { call } = site(DB);
  const home = await call("https://aetoswebsites.com/");
  const homeHtml = await home.text();
  assert.equal(home.headers.get("cache-control"), "public, max-age=300");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.ok(homeHtml.includes("Aetos Websites is a trading name of Nikiforos &lt;Surname&gt;, 1 High St, Leeds."));
  assert.ok(homeHtml.includes("mailto:nik@aetoswebsites.com?subject=Website%20for%20my%20business"));
  assert.ok(homeHtml.includes("Review booster"));
  assert.doesNotMatch(homeHtml, /chatbot|chat assistant/i);

  const privacy = await call("https://aetoswebsites.com/privacy");
  assert.equal(privacy.status, 200);
  assert.equal(privacy.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(privacy.headers.get("x-robots-tag"), null);
  const privacyHtml = await privacy.text();
  assert.ok(privacyHtml.includes("Aetos Websites is a trading name of Nikiforos &lt;Surname&gt;, a sole trader in the UK, 1 High St, Leeds."));
  assert.ok(privacyHtml.includes("legitimate interest"));

  const head = await call("https://aetoswebsites.com/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await head.text(), "");

  const robots = await call("https://aetoswebsites.com/robots.txt");
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await robots.text(), ROBOTS);
});

test("middleware: the root host's pages still work when the database is down (defaults, no trader line)", async () => {
  const broken = { prepare() { throw new Error("D1_ERROR: database down"); }, batch() { throw new Error("D1_ERROR: database down"); } };
  const { call } = site(broken);
  const original = console.error;
  console.error = () => {};
  try {
    const res = await call("https://aetoswebsites.com/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("data-aetos-landing"));
    assert.ok(html.includes(`mailto:${DEFAULT_CONTACT}`));
    assert.ok(!html.includes("trading name"));
    assert.ok(!html.includes("D1_ERROR"));
    assert.equal((await call("https://aetoswebsites.com/privacy")).status, 200);
  } finally {
    console.error = original;
  }
});

test("middleware: *.pages.dev hosts and paths public on every host never query D1 (the tick keeps its 50)", async () => {
  const DB = fakeD1();
  const counted = countingDB(DB);
  const { call } = site(counted.DB);
  const pagesDev = await call("https://goldbarwebsites.pages.dev/");
  assert.equal(pagesDev.status, 303);
  assert.equal((await call("https://abc123.goldbarwebsites.pages.dev/api/leads")).status, 401);
  assert.equal((await call("https://goldbarwebsites.pages.dev/api/agent/heartbeat")).status, 200);
  for (const path of ["/api/tick?reason=cron", "/api/tick?reason=health", "/d/abc", "/onboard/x", "/s/x", "/api/stripe/webhook", "/logo.png"]) {
    assert.equal((await call(`https://control.aetoswebsites.com${path}`)).status, 200, path);
    assert.equal((await call(`https://aetoswebsites.com${path}`)).status, 200, path);
  }
  assert.equal(counted.used(), 0);
});

test("middleware: the Control Room host is otherwise unchanged (agent API, login, logged in)", async () => {
  const { call, nexts } = site();
  assert.equal((await call("https://control.aetoswebsites.com/api/agent/heartbeat", { method: "POST" })).status, 200);
  assert.equal((await call("https://control.aetoswebsites.com/login")).status, 200);
  assert.equal((await call("https://control.aetoswebsites.com/robots.txt")).status, 200);
  assert.equal((await call("https://control.aetoswebsites.com/api/leads")).status, 401);
  assert.equal((await call("https://control.aetoswebsites.com/api/leads", { headers: { cookie: COOKIE } })).status, 200);
  assert.equal((await call("https://control.aetoswebsites.com/", { headers: { cookie: COOKIE } })).status, 200);
  assert.equal(nexts.length, 5);
  // www of a host that isn't the root isn't redirected.
  assert.equal((await call("https://www.control.aetoswebsites.com/")).status, 303);
  // Still a 500 with no password set, on the Control Room host.
  const none = await onRequest({ request: new Request("https://control.aetoswebsites.com/"), env: { DB: fakeD1() }, next: async () => new Response("x") });
  assert.equal(none.status, 500);
});

test("middleware: the www redirect keeps the bare path too", async () => {
  const { call } = site();
  const res = await call("https://www.aetoswebsites.com/");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://aetoswebsites.com/");
});

test("middleware: www.<root> redirects every path and method, the always-public ones included", async () => {
  const { call, nexts } = site();
  for (const [path, init] of [["/d/abc?x=1", {}], ["/api/tick?reason=cron", { method: "POST" }], ["/robots.txt", {}], ["/login", { method: "POST", body: "password=x" }]]) {
    const res = await call(`https://www.aetoswebsites.com${path}`, init);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get("location"), `https://aetoswebsites.com${path}`, path);
    assert.equal(res.headers.get("set-cookie"), null, path);
  }
  assert.equal(nexts.length, 0);
});

test("middleware: HEAD keeps the status and headers of the 404 page and robots.txt, with no body", async () => {
  const { call } = site();
  const missing = await call("https://aetoswebsites.com/nope", { method: "HEAD" });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await missing.text(), "");
  const robots = await call("https://aetoswebsites.com/robots.txt", { method: "HEAD" });
  assert.equal(robots.status, 200);
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await robots.text(), "");
  assert.equal((await call("https://aetoswebsites.com/privacy", { method: "POST", body: "x" })).status, 404);
});

// The middleware lets every PUBLIC_PREFIXES path through without a login, on both hosts. A path no function answers
// would fall through to Pages' single-page-app fallback: the Control Room's index.html with 200, on the public
// aetoswebsites.com too. So each prefix has a catch-all functions/<prefix>/[[path]].js that is the 404 page; the
// pages a stage builds there (/d/:slug, /onboard/:token, /s/...) are more specific, so Pages runs them first.
const PREFIX_STUBS = (() => {
  const src = readFileSync(new URL("../functions/_middleware.js", import.meta.url), "utf8");
  const list = /const PUBLIC_PREFIXES = \[([^\]]*)\]/.exec(src);
  assert.ok(list, "PUBLIC_PREFIXES is in _middleware.js");
  return [...list[1].matchAll(/"\/([^"/]+)\/"/g)].map((m) => m[1]);
})();

async function prefixStub(prefix) {
  const file = new URL(`../functions/${prefix}/[[path]].js`, import.meta.url);
  assert.ok(existsSync(file), `functions/${prefix}/[[path]].js answers /${prefix}/* with the 404 page`);
  return (await import(file.href)).onRequest;
}

test("catch-all stubs: every public prefix has one, and it's the branded 404 page (GET, POST and HEAD)", async () => {
  for (const prefix of ["d", "onboard", "s"]) assert.ok(PREFIX_STUBS.includes(prefix), `read ${prefix} from PUBLIC_PREFIXES`);
  for (const prefix of PREFIX_STUBS) {
    const stub = await prefixStub(prefix);
    assert.equal(typeof stub, "function", prefix);
    for (const path of [`/${prefix}/`, `/${prefix}/x`, `/${prefix}/abc/foo`]) {
      const res = await stub({ request: new Request(`https://aetoswebsites.com${path}`), env: {}, params: {} });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", path);
      const html = await res.text();
      assert.ok(html.includes("<title>Page not found | Aetos Websites</title>"), path);
      assert.ok(html.includes("That page doesn't exist."), path);
      assert.ok(!html.includes("Control Room"), path);
    }
    const post = await stub({ request: new Request(`https://aetoswebsites.com/${prefix}/x`, { method: "POST", body: "x" }), env: {}, params: {} });
    assert.equal(post.status, 404, prefix);
    const head = await stub({ request: new Request(`https://aetoswebsites.com/${prefix}/x`, { method: "HEAD" }), env: {}, params: {} });
    assert.equal(head.status, 404, prefix);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8", prefix);
    assert.equal(await head.text(), "", prefix);
  }
});

test("middleware + stubs: unbuilt /onboard/*, /s/* and bare /d/ are the 404 page on both hosts, never the Control Room", async () => {
  for (const [path, prefix] of [["/s/x", "s"], ["/onboard/abc", "onboard"], ["/onboard/", "onboard"], ["/d/", "d"], ["/d/abc/foo", "d"]]) {
    const stub = await prefixStub(prefix);
    for (const host of ["aetoswebsites.com", "goldbarwebsites.pages.dev", "control.aetoswebsites.com"]) {
      const env = { CONTROL_ROOM_PASSWORD: PASSWORD, DB: fakeD1() };
      const request = new Request(`https://${host}${path}`);
      const res = await onRequest({ request, env, next: () => stub({ request, env, params: {} }) });
      assert.equal(res.status, 404, `${host}${path}`);
      const html = await res.text();
      assert.ok(html.includes("Page not found | Aetos Websites"), `${host}${path}`);
      assert.ok(!html.includes("Aetos Control Room"), `${host}${path}`);
    }
  }
});

test("rootHostFor: a changed setting is read again once the 60 s cache has expired", async () => {
  const DB = fakeD1();
  await setSetting(DB, "site:root_host", "first.org");
  const counted = countingDB(DB);
  const realNow = Date.now;
  let t = Date.parse("2026-10-21T10:00:00Z");
  Date.now = () => t;
  try {
    assert.equal(await rootHostFor({ DB }, counted.DB), "first.org");
    await setSetting(DB, "site:root_host", "second.org");
    t += 59_999;
    assert.equal(await rootHostFor({ DB }, counted.DB), "first.org", "still cached just under 60 s");
    assert.equal(counted.used(), 1);
    t += 1;
    assert.equal(await rootHostFor({ DB }, counted.DB), "second.org", "read again at 60 s");
    assert.equal(counted.used(), 2);
  } finally {
    Date.now = realNow;
  }
});

test("landing: the weekend deal ends at Sunday midnight UK, across the 25 Oct clock change", () => {
  // 25 Oct 2026: clocks go back at 02:00 BST, so 23:59 Sunday UK is 23:59Z and Monday starts at 00:00Z.
  const sunday = landing({ now: new Date("2026-10-25T23:59:00Z") });
  assert.ok(sunday.includes("Weekend deal: ends Sunday midnight"));
  assert.ok(sunday.includes("First 90 days free"));
  const monday = landing({ now: new Date("2026-10-26T00:00:00Z") });
  assert.ok(!monday.includes("Weekend deal"));
  assert.ok(monday.includes("First 60 days free"));
  // In BST, Saturday starts at 23:00Z on Friday.
  assert.ok(landing({ now: new Date("2026-10-23T23:00:00Z") }).includes("First 90 days free"));
});

test("pages: one column with a 16 px gutter at phone width, and long words wrap instead of scrolling sideways", () => {
  for (const html of [landing(), renderPrivacy({ business: { address: "Unit-1-Very-Long-Industrial-Estate-Name-Without-Spaces" } }), renderNotFound()]) {
    assert.match(html, /\.wrap\{[^}]*padding:0 16px/);
    assert.match(html, /body\{[^}]*overflow-wrap:break-word/);
    assert.match(html, /@media \(min-width:720px\)\{.*\.gets,\.cards\{grid-template-columns:1fr 1fr\}/);
    assert.doesNotMatch(html.replace(/@media[^\n]*/g, ""), /grid-template-columns/, "below 720 px everything is one column");
  }
});
