// A client site's fixed pages (stage 10, docs/rebuild/09-build.md Part A §7–8, Part B Task 5): /sitemap.xml,
// /robots.txt, /privacy, the 404 page with the site's own header and nav, and the "isn't set up yet" page.
// Uses the valid Smith Roofing fixture from Task 2.
// Run: node --test control-room/tests/sites-pages.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { siteData } from "../functions/_lib/sites/sitedata.js";
import {
  renderMissingPage, renderNotSetUp, renderPrivacy, renderRobots, renderSitemap,
} from "../functions/_lib/sites/pages.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const CTX = JSON.parse(readFileSync(new URL("./fixtures/site-ctx.json", import.meta.url), "utf8"));
const fx = () => structuredClone(FX);
const HOST = "www.smithroofing.co.uk";
const LEAD = { place_id: "p1", name: "Smith Roofing Ltd", trade: "roofer", maps_url: "https://maps.google.com/?cid=1234567890", rating: 4.9, review_count: 23 };
const OPTS = { lead: LEAD, host: HOST, base: "", reviewUrl: "https://search.google.com/local/writereview?placeid=p1", chat: false, noindex: false, previewBar: "", files: CTX.files };
const data = (o = {}, c = fx()) => siteData(c, { ...OPTS, ...o });

// What a reader sees: tags out, the entities h() writes turned back into characters.
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#96;": "`" };
const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (e) => ENTITIES[e]).replace(/\s+/g, " ");
const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
const navOf = (html) => {
  const at = html.indexOf('<nav class="nav"');
  assert.ok(at >= 0, "the page has the site's nav");
  return html.slice(at, html.indexOf("</nav>", at));
};

// ---------------------------------------------------------------- the spec's tests

test("sitemap: one <loc> per page (11), none for /privacy, lastmod is the UK date of content_at", () => {
  const xml = renderSitemap(fx(), HOST, "2026-10-24T22:30:00Z");
  const locs = locsOf(xml);
  assert.equal(locs.length, 11);
  assert.deepEqual(locs, FX.pages.map((p) => `https://www.smithroofing.co.uk${p.path}`));
  assert.ok(locs.includes("https://www.smithroofing.co.uk/"));
  assert.ok(!locs.some((l) => l.includes("/privacy")));
  assert.equal(xml.split("<lastmod>2026-10-24</lastmod>").length - 1, 11);
});

test("robots: non-test and test sites, exactly", () => {
  assert.equal(renderRobots(HOST, false), "User-agent: *\nAllow: /\nAllow: /s/f/\nDisallow: /s/\nSitemap: https://www.smithroofing.co.uk/sitemap.xml\n");
  assert.equal(renderRobots(HOST, true), "User-agent: *\nDisallow: /\n");
});

test("privacy: legal line, 12 months, no cookies, noindex,follow", () => {
  const html = renderPrivacy(fx(), data());
  assert.ok(html.includes("John Smith trading as Smith Roofing"));
  assert.ok(html.includes("12 months"));
  assert.ok(html.includes("no cookies"));
  assert.ok(html.includes('<meta name="robots" content="noindex,follow">'));
});

test("not-found: 'Sorry, that page isn't here.' and a link to /", () => {
  const html = renderMissingPage(data());
  assert.ok(html.includes("Sorry, that page isn't here."));
  assert.match(html, /<h1>Sorry, that page isn't here\.<\/h1>/);
  assert.match(html, /<a href="\/">Go to the home page<\/a>/);
});

test("not-set-up: 'This website isn't set up yet.' and noindex", () => {
  const html = renderNotSetUp();
  assert.ok(html.includes("This website isn't set up yet."));
  assert.match(html, /noindex/);
});

// ---------------------------------------------------------------- the rest of section 8

test("sitemap: a well-formed urlset, the UK date across the clocks going back, no lastmod without content_at", () => {
  const xml = renderSitemap(fx(), HOST, "2026-10-24T22:30:00Z");
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
  assert.ok(xml.endsWith("</urlset>\n"));
  assert.equal(xml.split("<url>").length - 1, 11);
  // 23:30 UTC on 24 Oct is 00:30 BST on the 25th (the clocks go back at 01:00 UTC that night).
  assert.equal(renderSitemap(fx(), HOST, "2026-10-24T23:30:00Z").split("<lastmod>2026-10-25</lastmod>").length - 1, 11);
  // In GMT the UK date is the UTC date.
  assert.ok(renderSitemap(fx(), HOST, "2026-10-26T23:30:00Z").includes("<lastmod>2026-10-26</lastmod>"));
  for (const at of [null, undefined, "", "not a date"]) {
    const plain = renderSitemap(fx(), HOST, at);
    assert.equal(locsOf(plain).length, 11, String(at));
    assert.doesNotMatch(plain, /<lastmod>/, String(at));
  }
});

test("sitemap: a /privacy page in the content, repeats and odd paths are left out; the host is normalised", () => {
  const c = fx();
  c.pages.push({ key: "about", path: "/privacy" }, { key: "about", path: "/about" }, { key: "x", path: "https://evil.example/" }, { key: "x", path: "/a<b" });
  const locs = locsOf(renderSitemap(c, "WWW.SmithRoofing.co.uk.:443", "2026-10-24T22:30:00Z"));
  assert.equal(locs.length, 11);
  assert.ok(locs.every((l) => l.startsWith("https://www.smithroofing.co.uk/")));
});

test("sitemap and robots need a real host", () => {
  for (const bad of ["", null, "not a host", "smith roofing"]) {
    assert.throws(() => renderSitemap(fx(), bad, "2026-10-24T22:30:00Z"), /needs the site's host/);
    assert.throws(() => renderRobots(bad, false), /needs the site's host/);
  }
  assert.equal(renderRobots("", true), "User-agent: *\nDisallow: /\n"); // a test site blocks everything, host or not
  assert.equal(renderRobots("WWW.SmithRoofing.co.uk.", false).split("\n")[4], "Sitemap: https://www.smithroofing.co.uk/sitemap.xml");
});

test("privacy: who runs it (town only when the address is hidden), what is collected and why, deletion, Aetos line", () => {
  const html = renderPrivacy(fx(), data());
  const t = textOf(html);
  assert.ok(t.includes("John Smith trading as Smith Roofing, Swindon"));
  assert.doesNotMatch(t, /12 High St|SN1 1AA/);
  assert.ok(t.includes("name, phone number, email and message"));
  assert.ok(t.includes("to reply to you"));
  assert.ok(t.includes("Enquiries are kept for 12 months."));
  assert.ok(t.includes("This website sets no cookies and uses no tracking."));
  assert.ok(t.includes("Website by Aetos Websites, which processes enquiries for Smith Roofing."));
  assert.ok(t.includes("email info@smithroofing.co.uk"));
  assert.ok(t.includes("deleted"));
  assert.equal(html.split('<meta name="robots"').length - 1, 1);
  assert.equal(html.split("<h1").length - 1, 1);
  assert.ok(html.includes("<title>Privacy · Smith Roofing</title>"));
  assert.ok(html.includes('<link rel="canonical" href="https://www.smithroofing.co.uk/privacy">'));
  assert.doesNotMatch(html, /<form/);
  // The site's own nav and footer.
  const nav = navOf(html);
  for (const href of ["/", "/services", "/areas", "/about", "/reviews", "/contact"]) assert.ok(nav.includes(`href="${href}"`), href);
  assert.ok(html.includes("Website by Aetos Websites</p>"));
  // Without chat, the page says nothing about one.
  assert.doesNotMatch(t, /chat/i);
});

test("privacy: the full address when shown, the chat lines when chat is on, the map line only with a map", () => {
  const c = fx();
  c.business.show_address = true;
  const t = textOf(renderPrivacy(c, data({ chat: true }, c)));
  assert.ok(t.includes("John Smith trading as Smith Roofing, 12 High St, Swindon SN1 1AA"));
  assert.ok(t.includes("contact form or the chat"));
  assert.ok(t.includes("Chats are not kept unless you leave your details."));
  assert.ok(t.includes("Google Maps"));
  const noTown = fx();
  noTown.business.address.town = "";
  assert.doesNotMatch(textOf(renderPrivacy(noTown, data({}, noTown))), /Google Maps/);
});

test("privacy: link syntax in their name or legal line stays words, never a link", () => {
  const c = fx();
  c.business.legal_line = "John Smith [click here](/contact) trading as Smith Roofing";
  const html = renderPrivacy(c, data({}, c));
  assert.doesNotMatch(html, />click here<\/a>/);
  assert.ok(textOf(html).includes("John Smith [click here] (/contact) trading as Smith Roofing"));
});

test("not-found: the same sentence in the landscaper look", () => {
  const c = fx();
  c.business.trade = "landscaper";
  const html = renderMissingPage(data({}, c));
  assert.match(html, /data-template="landscaper"/);
  assert.match(html, /<h1>Sorry, that page isn't here\.<\/h1>/);
  assert.match(html, /<a href="\/">Go to the home page<\/a>/);
});

test("privacy: their text is escaped; a test site's noindex stays one noindex,follow", () => {
  const c = fx();
  c.business.legal_line = "J <script>alert(1)</script> & Co";
  const html = renderPrivacy(c, data({ noindex: true }, c));
  assert.doesNotMatch(html, /<script>alert/);
  assert.ok(html.includes("J &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co"));
  assert.equal(html.split('<meta name="robots"').length - 1, 1);
  assert.ok(html.includes('<meta name="robots" content="noindex,follow">'));
});

test("privacy and not-found in Nik's preview: links under the base, no canonical without a host", () => {
  const d = data({ base: "/c/s1", host: "", previewBar: "Preview of Smith Roofing's site · Ready to approve" });
  const privacy = renderPrivacy(fx(), d);
  assert.doesNotMatch(privacy, /rel="canonical"/);
  assert.ok(navOf(privacy).includes('href="/c/s1/services"'));
  const missing = renderMissingPage(d);
  assert.match(missing, /<a href="\/c\/s1\/">Go to the home page<\/a>/);
  assert.ok(missing.includes("Back to the Control Room"));
});

test("not-found: the site's header and nav, noindex, no canonical, no JSON-LD, no form", () => {
  const html = renderMissingPage(data({ chat: true }));
  const nav = navOf(html);
  for (const href of ["/", "/services", "/areas", "/about", "/reviews", "/contact"]) assert.ok(nav.includes(`href="${href}"`), href);
  assert.ok(html.includes('<header class="top">'));
  assert.ok(html.includes("Smith Roofing"));
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.doesNotMatch(html, /application\/ld\+json/);
  assert.doesNotMatch(html, /<form/);
  assert.ok(html.includes("<title>Page not found · Smith Roofing</title>"));
  assert.equal(html.split("<h1").length - 1, 1);
  assert.ok(html.includes("<footer"));
});

test("not-set-up: a plain page that names nobody", () => {
  const html = renderNotSetUp();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.doesNotMatch(html, /<script|<link|https?:/);
});

test("renderers refuse what isn't a site", () => {
  assert.throws(() => renderSitemap(null, HOST, "2026-10-24T22:30:00Z"), /SiteContent/);
  assert.throws(() => renderPrivacy(null, data()), /SiteContent/);
  assert.throws(() => renderPrivacy(fx(), null), /siteData/);
  assert.throws(() => renderMissingPage({}), /siteData/);
});
