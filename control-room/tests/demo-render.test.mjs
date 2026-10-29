// Template engine (renderSite, renderExpired, renderNotFound), the generic look (docs/rebuild/05-demo.md Part A §3, §6,
// §10; Task 6) and the landscaper look with the look lock (Task 7). Every fixture lead must pass checkDemoHtml in both
// looks, the copy is Part A's word for word, hostile scraped text never becomes markup, and a look can't change
// without its version changing. Run: node --test control-room/tests/demo-render.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkDemoHtml } from "../functions/_lib/demo/check.js";
import { buildDemoData } from "../functions/_lib/demo/data.js";
import { TEMPLATES, guaranteeStrip, renderExpired, renderNotFound, renderSite } from "../functions/_lib/demo/render.js";
import * as generic from "../functions/_lib/demo/templates/generic.js";
import * as landscaper from "../functions/_lib/demo/templates/landscaper.js";
import { h } from "../functions/_lib/demo/text.js";
import { GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { LEADS, NASTY, nastyLead } from "./fixtures/demo-fixtures.mjs";

const OFFER = { weekend: false, full: { freeDays: 60 } };
const WEEKEND = { weekend: true, full: { freeDays: 90 } };
const DEMO = { slug: "green-leaf-landscapes-7k2p9q" };
const NOW = new Date("2026-10-21T10:00:00Z"); // a Wednesday

const build = (lead, o = {}) => buildDemoData({ lead, research: lead.research, demo: DEMO, offer: OFFER, now: NOW, ...o });
const slugFor = (key) => `${key.toLowerCase()}-abc234`;
// The generic look whatever the trade (the landscaper fixtures get their own look from Task 7).
const asGeneric = (d) => ({ ...d, template: "generic" });
// The landscaper look whatever the trade, so all 10 fixtures are checked in both looks (Perfect when 3).
const asLandscaper = (d) => ({ ...d, template: "landscaper" });
const LOOKS = ["landscaper", "generic"];
const LANDSCAPER_KEYS = ["full", "noPhotos", "httpPhotos", "paleColour", "bare"];
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const imgsOf = (html) => html.match(/<img\b[^>]*>/g) ?? [];
const count = (html, s) => html.split(s).length - 1;

// ---- markup helpers for the hostile-input tests

// Every opening tag with its attributes. h() escapes every "<", ">" and quote in text and attribute values, so every
// "<" left in the page starts a real tag.
const TAG = /<([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
const tagsOf = (html) => [...html.matchAll(TAG)].map(([, name, rest]) => ({
  name: name.toLowerCase(),
  attrs: [...rest.matchAll(ATTR)].map(([, k, dq, sq, bare]) => [k.toLowerCase(), dq ?? sq ?? bare ?? ""]),
}));
// The only event handlers the shell writes (fixed text, nothing from the lead).
const HANDLERS = new Set(["this.remove()", "this.nextElementSibling.hidden=false;this.remove()"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "srcset", "poster", "xlink:href", "background", "data", "ping"]);
const SAFE_URL = /^(?:https:\/\/[^\s"'<>()\\]+|\/(?![/\\])[^\s"'<>()\\]*|#[a-z-]+|tel:\+?\d{10,13}|mailto:[^\s"'<>]+)$/;
// The characters h() removes: control characters (but tab, LF, CR) and the bidi embedding/override/isolate ones.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

/** No handler but the fixed image ones, no inline style attribute, every URL attribute a safe URL, one inline
 * <style>, and no <script> but the beacon. */
function assertSafeMarkup(html, label) {
  const tags = tagsOf(html);
  for (const t of tags) {
    for (const [k, v] of t.attrs) {
      if (k.startsWith("on")) assert.ok(k === "onerror" && HANDLERS.has(v), `${label}: event handler ${k}="${v}"`);
      if (k === "style") assert.fail(`${label}: style attribute on <${t.name}>`);
      if (URL_ATTRS.has(k)) assert.match(v, SAFE_URL, `${label}: ${k}="${v}" on <${t.name}>`);
    }
  }
  assert.equal(tags.filter((t) => t.name === "style").length, 1, `${label}: one <style>`);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(count(html.toLowerCase(), "<script"), scripts.length, `${label}: every <script> is closed`);
  assert.ok(scripts.length <= 1, `${label}: at most one script`);
  for (const [, body] of scripts) assert.ok(body.startsWith("(function(){if(navigator.webdriver)return;"), `${label}: the only script is the beacon`);
}

// Every string inside a value (the DemoData strings the template prints).
const stringsIn = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(stringsIn) : []);
// The page with every correctly escaped data string taken out (longest first): what's left is markup and our own
// wording. An unescaped string (raw "<", ">" or quotes) doesn't match its h() form, so it stays and is caught.
const withoutEscapedData = (html, d) => [...new Set(stringsIn(d).map(h).filter(Boolean))]
  .sort((a, b) => b.length - a.length)
  .reduce((page, s) => page.split(s).join(" "), html);

// ---------------------------------------------------------------- the spec's tests

test("every fixture lead passes checkDemoHtml in demo mode", () => {
  const now = new Date();
  for (const [key, lead] of Object.entries(LEADS)) {
    const d = buildDemoData({ lead, research: lead.research, demo: { slug: slugFor(key) }, offer: offerFor(now), now });
    assert.deepEqual(checkDemoHtml(renderSite(d), d, { now }), [], key);
  }
  // Weekday and weekend, at a fixed time, in both looks (all 10 fixtures in both templates: Perfect when 3).
  for (const [key, lead] of Object.entries(LEADS)) {
    for (const offer of [OFFER, WEEKEND]) {
      const d = build(lead, { demo: { slug: slugFor(key) }, offer });
      for (const data of [asLandscaper(d), asGeneric(d)]) {
        const html = renderSite(data, { now: NOW });
        assert.match(html, new RegExp(`<body data-template="${data.template}"`), `${key} ${data.template}`);
        assert.deepEqual(checkDemoHtml(html, data, { now: NOW }), [], `${key} ${data.template}`);
      }
    }
  }
});

test("demo mode shows the preview bar, guarantee and a disabled form", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  assert.match(html, /Preview made for <b>Green Leaf Landscapes<\/b> by Aetos Websites · Visits to this page are counted/);
  assert.match(html, /href="\/d\/green-leaf-landscapes-7k2p9q\/order"[^>]*>Order this site/);
  assert.match(html, /Top 3 in Google search results in 90 days\. GUARANTEED\./);
  assert.match(html, /The guarantee: we will work for FREE if you aren&#39;t in the top 3 of Google results within 90 days\./);
  assert.match(html, /First 60 days of the monthly plan free\. No contract\./);
  assert.match(html, /<fieldset disabled/);
  assert.match(html, /Preview only: on your live site, this form sends enquiries straight to your phone and inbox\./);
  assert.match(html, /href="tel:07969770905"/);
});

test("demo footer links the privacy notice", () => {
  const d = build(LEADS.full);
  assert.match(renderSite(d, { now: NOW }), /<a href="https:\/\/aetoswebsites\.com\/privacy"[^>]*>How we use your information<\/a>/);
  assert.ok(!renderSite(d, { mode: "live", now: NOW }).includes("How we use your information"));
});

test("weekend offer line", () => {
  const html = renderSite(build(LEADS.full, { offer: WEEKEND }), { now: NOW });
  assert.match(html, /Weekend deal: first 90 days of the monthly plan free\. No contract\./);
  assert.doesNotMatch(html, /First 60 days/);
});

test("live mode has no Aetos bits", () => {
  const d = build(LEADS.full);
  assert.doesNotMatch(renderSite(d, { mode: "live" }), /Preview made|GUARANTEED|noindex|sendBeacon|Preview by Aetos/);
  const live = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: null, offer: OFFER, now: NOW, live: { form_action: "https://forms.example/x", canonical_url: "https://greenleaf-landscapes.example/" } });
  const html = renderSite(live, { mode: "live", now: NOW });
  assert.doesNotMatch(html, /Preview made|GUARANTEED|noindex|sendBeacon|Preview by Aetos/);
  assert.match(html, /<form class="quote" method="post" action="https:\/\/forms\.example\/x">/);  // enabled, posts there
  assert.match(html, /<fieldset>/);
  assert.doesNotMatch(html, /<[a-z]+\b[^>]*\sdisabled[\s>]/);           // no disabled tag (the CSS rule for one is fine)
  assert.match(html, /<input name="name" autocomplete="name" required>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/greenleaf-landscapes\.example\/">/);
  assert.doesNotMatch(html, /Preview only|Order this site|<script|name="robots"|name="referrer"/);
  // A same-site path (stage 10's "/c/<slug>/s/contact") is a form action too.
  assert.match(renderSite({ ...live, live: { ...live.live, form_action: "/c/green/s/contact" } }, { mode: "live" }), /action="\/c\/green\/s\/contact"/);
});

test("bare lead renders placeholder and hides empty sections", () => {
  const d = build(LEADS.bare);
  for (const data of [d, asGeneric(d)]) {
    const html = renderSite(data, { now: NOW });
    assert.match(html, /Your services will go here/);
    assert.match(html, /Preview placeholder: we&#39;ll fill this in with you/);
    assert.doesNotMatch(html, /What customers say|Areas we cover|About |Recent work|<img[^>]+Work by/);
    assert.ok(html.includes("hero-plain"));
    assert.match(html, /class="hero hero-plain"/);
    assert.equal(imgsOf(html).length, 0);                                  // no logo, no photos
    assert.match(html, /<span class="wordmark">Tidy Gardens<\/span>/);     // the name as a wordmark
    assert.doesNotMatch(html, /tel:|class="callbar"|\d\.\d ★/);           // no phone, no rating
    assert.match(html, /© 2026 Tidy Gardens<\/p>/);                        // no town: no " · "
  }
});

test("nasty input never escapes", () => {
  const BAD = /<script>alert|onerror=alert|onmouseover=|<\/style><script|javascript:/i;
  for (const n of NASTY) {
    const lead = nastyLead(n);
    // n in every field, URLs and colour included; then the same with their real https logo and photos, so the
    // hostile name also lands in the images' alt attributes.
    const withPhotos = { ...lead, audit: { ...lead.audit, brand: LEADS.full.audit.brand } };
    for (const [variant, l] of [["", lead], [" with photos", withPhotos]]) for (const mode of ["demo", "live"]) for (const id of LOOKS) {
      // Every look: the hostile trade never matches a landscaper word, so the look is forced.
      const d = { ...buildDemoData({ lead: l, research: l.research, demo: DEMO, offer: OFFER, now: NOW }), template: id };
      const html = renderSite(d, { mode, now: NOW });
      const label = `${JSON.stringify(n)}${variant} (${mode}, ${id})`;
      assert.match(html, new RegExp(`<body data-template="${id}"`), label);
      if (variant) assert.ok(html.includes(`alt="Work by ${h(n)}"`), `${label}: the name is in the photos' alt text`);
      // h() leaves some hostile strings readable as plain text ("onerror=alert(1)", "javascript:alert(1)",
      // "onmouseover="), which can't run. So the pattern is checked on the page with the correctly escaped data taken
      // out; for every other string, on the whole page as it is.
      assert.ok(!BAD.test(withoutEscapedData(html, d)), `${label}: unescaped markup`);
      if (!BAD.test(h(n))) assert.ok(!BAD.test(html), `${label}: unescaped markup in the page`);
      assertSafeMarkup(html, label);
      assert.ok(!html.includes("<!--") && !html.includes("]]>"), `${label}: a comment or "]]>" in the page`);
      assert.doesNotMatch(html, INVISIBLE, `${label}: a control or bidi character reached the page`);
      const problems = checkDemoHtml(html, d, { mode, now: NOW });
      assert.ok(!problems.some((p) => p.startsWith("Unescaped text")), `${label}: ${problems}`);
      assert.deepEqual(problems, [], label);
    }
  }
});

test("images are lazy except the top ones", () => {
  for (const [key, lead] of Object.entries(LEADS)) {
    for (const data of [build(lead), asGeneric(build(lead)), asLandscaper(build(lead))]) {
      const imgs = imgsOf(renderSite(data, { now: NOW }));
      imgs.slice(2).forEach((img) => assert.match(img, /loading="lazy"/, `${key}: ${img}`));
      imgs.forEach((img) => assert.match(img, /alt="[^"]+"/, `${key}: ${img}`));
      imgs.forEach((img) => assert.match(img, /width="\d+" height="\d+"/, `${key}: ${img}`));
    }
  }
  for (const data of [asGeneric(build(LEADS.full)), asLandscaper(build(LEADS.full))]) {
    const imgs = imgsOf(renderSite(data, { now: NOW }));
    assert.equal(imgs.length, 7, data.template);                             // logo, hero photo, photos 2-6
    assert.match(imgs[0], /class="logo"[^>]*alt="Green Leaf Landscapes logo"/);
    assert.doesNotMatch(imgs[0], /loading=/);
    assert.match(imgs[1], /alt="Work by Green Leaf Landscapes"[^>]*fetchpriority="high"/);
    assert.doesNotMatch(imgs[1], /loading=/);
    imgs.slice(2).forEach((img) => assert.doesNotMatch(img, /fetchpriority/, data.template));
    imgs.forEach((img) => assert.match(img, /onerror="this\.(?:nextElementSibling\.hidden=false;this\.)?remove\(\)"/));
  }
});

test("size", () => {
  const sizes = Object.entries(LEADS).map(([key, lead]) => [key, Buffer.byteLength(renderSite(build(lead), { now: NOW }))]);
  const [key, biggest] = sizes.sort((a, b) => b[1] - a[1])[0];
  assert.ok(biggest < 100000, `${key}: ${biggest} bytes`);
  // The biggest a lead can get: every field at its clip length, 2048-character photo URLs, every list full.
  const url = (i) => `https://cdn.example/${String(i).repeat(2000)}.jpg`;
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 10}`).join(" ");
  const max = {
    ...LEADS.full,
    name: "N".repeat(80),
    audit: { brand: { logo: url(0), colour: "#2e7d32", photos: [1, 2, 3, 4, 5, 6].map(url) },
      reviews: [1, 2, 3].map((i) => ({ author: "Sarah Kent", rating: 5, text: words(80) + i })) },
    research: { ...LEADS.full.research, copy: { headline: words(30), intro: words(80), about: words(200),
      services: Array.from({ length: 8 }, (_, i) => words(12) + i), areas: Array.from({ length: 12 }, (_, i) => words(8) + i) } },
  };
  const d = build(max);
  for (const data of [asGeneric(d), asLandscaper(d)]) {
    const html = renderSite(data, { now: NOW });
    assert.ok(Buffer.byteLength(html) < 100000, `${data.template}: ${Buffer.byteLength(html)} bytes`);
    assert.deepEqual(checkDemoHtml(html, data, { now: NOW }), [], data.template);
  }
  // The real fixtures stay under the 40 KB target in both looks.
  for (const [key, lead] of Object.entries(LEADS)) for (const id of LOOKS) {
    const bytes = Buffer.byteLength(renderSite({ ...build(lead), template: id }, { now: NOW }));
    assert.ok(bytes < 40000, `${key} ${id}: ${bytes} bytes`);
  }
});

test("expired and not-found pages", () => {
  const ended = renderExpired({ name: "Green Leaf Landscapes", contact_email: "nik@aetoswebsites.com" });
  assert.match(ended, /This preview has ended/);
  assert.match(ended, /The website we made for Green Leaf Landscapes is no longer on show\. Reply to our email and we&#39;ll switch it back on\./);
  assert.match(ended, /mailto:nik@aetoswebsites\.com/);
  assert.match(ended, /or email <a href="mailto:nik@aetoswebsites\.com">nik@aetoswebsites\.com<\/a>/);
  assert.match(ended, /Aetos Websites<\/p>\s*<\/main>/);                     // "Aetos Websites" at the bottom
  assert.match(renderNotFound(), /This page doesn&#39;t exist\./);
});

// ---------------------------------------------------------------- more of Part A

test("the generic template is the Everything else look, version 1", () => {
  assert.deepEqual({ ...generic.TEMPLATE }, { id: "generic", version: 1, label: "Everything else" });
  assert.equal(TEMPLATES.generic, generic);
  assert.equal(TEMPLATES.generic.TEMPLATE.version, 1);
  const { css, body } = generic.home(build(LEADS.kickboxing), "demo");
  assert.equal(typeof body, "string");
  assert.equal(count(css, "@media"), 1);                                    // mobile-first, one desktop block
  assert.equal(count(css, "@media (min-width: 900px)"), 1);
  assert.doesNotMatch(css, /max-width:\s*\d+px\)/);
  assert.doesNotMatch(body, /<html|<head>|<body|ae-bar|class="foot"|<script/); // the shell's parts aren't in it
});

test("generic section order follows Part A: hero, services, recent work, areas, reviews, guarantee, about, contact", () => {
  const html = renderSite(asGeneric(build(LEADS.full)), { now: NOW });
  const at = ["<h1>", "What we do", "Recent work", "Areas we cover", "What customers say", "GUARANTEED", "About Green Leaf Landscapes", "Ask for a quote</h2>", 'class="foot"'].map((s) => html.indexOf(s));
  at.forEach((i) => assert.ok(i > 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(html.indexOf('class="ae-bar"') < html.indexOf('class="top"'));
  assert.ok(html.indexOf('class="top"') < html.indexOf("<h1>"));
});

test("head: title, metas, the colour and nothing from outside", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  assert.match(html, /^<!doctype html>\n<html lang="en-GB">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<title>Green Leaf Landscapes · Warrington<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /:root\{--main:#2e7d32\}/);
  assert.doesNotMatch(html, /<link\b|@import|@font-face|url\(|<!--/);
  assert.match(renderSite(build(LEADS.paleColour), { now: NOW }), /--main:#1a1c20\}/);   // too pale: Charcoal
  // A colour that isn't #rrggbb never reaches the CSS, even in hand-built data.
  const d = build(LEADS.full);
  const odd = renderSite({ ...d, brand: { ...d.brand, colour: "red;}body{display:none" } }, { now: NOW });
  assert.match(odd, /--main:#1a1c20\}/);
  assert.doesNotMatch(odd, /body\{display:none/);
  assert.match(renderSite(build(LEADS.plumber), { now: NOW }), /<title>Flowright Plumbing &amp; Heating · Manchester<\/title>/);
});

test("the beacon is the exact script, only in demo mode with views counted", () => {
  const d = build(LEADS.full);
  const beacon = `<script>(function(){if(navigator.webdriver)return;var u="/d/green-leaf-landscapes-7k2p9q/e";function s(k){try{navigator.sendBeacon(u,JSON.stringify({kind:k}))}catch(e){}}
setTimeout(function(){if(document.visibilityState==="visible")s("view")},4000);
document.querySelectorAll("[data-ev]").forEach(function(a){a.addEventListener("click",function(){s(a.getAttribute("data-ev"))})});})();</script>`;
  const html = renderSite(d, { now: NOW });
  assert.equal(count(html, beacon), 1);
  assert.ok(html.indexOf(beacon) > html.lastIndexOf("data-ev="));          // after the links it listens to
  assert.equal(count(html, '<script'), 1);
  assert.equal(count(html, 'href="/d/green-leaf-landscapes-7k2p9q/order" class="ae-btn" data-ev="order_page">Order this site</a>'), 2); // bar + strip
  // The Control Room's previews don't count views; live sites have no beacon.
  assert.doesNotMatch(renderSite({ ...d, demo: { ...d.demo, count_views: false } }), /<script/);
  assert.match(renderSite({ ...d, demo: { ...d.demo, count_views: false } }), /Order this site/);
  assert.doesNotMatch(renderSite(d, { mode: "live" }), /<script|data-ev=/);
  // No demo row: the bar still says what it is, but there's nothing to order or count.
  const none = renderSite({ ...d, demo: null }, { now: NOW });
  assert.match(none, /Preview made for/);
  assert.doesNotMatch(none, /<script|Order this site/);
  // A slug that isn't one slugFor makes is never printed into the script or a link.
  assert.throws(() => renderSite({ ...d, demo: { ...d.demo, slug: '"</script><script>alert(1)//' } }), /slug isn't valid/);
});

test("phone: tap-to-call only when it dials; the call bar is the name", () => {
  const full = renderSite(build(LEADS.full), { now: NOW });
  assert.match(full, /<a class="top-ph" href="tel:07969770905">07969 770905<\/a>/);
  assert.match(full, /<a class="btn" href="tel:07969770905">Call 07969 770905<\/a>/);
  assert.match(full, /<a class="callbar" href="tel:07969770905">Call Green Leaf Landscapes<\/a>/);
  assert.match(full, /<body data-template="[a-z]+" class="has-call">/);
  assert.match(renderSite(build(LEADS.roofer), { now: NOW }), /href="tel:\+441632960077"/);
  // "0161 496 07" has too few digits: shown as Google gives it, but no link, button or call bar.
  const plumber = renderSite(build(LEADS.plumber), { now: NOW });
  assert.match(plumber, /<span class="top-ph">0161 496 07<\/span>/);
  assert.doesNotMatch(plumber, /tel:|class="callbar"|Call 0161|class="has-call"/);
  // Hand-built data can't sneak a script URL into the tel: link.
  const d = build(LEADS.full);
  const odd = renderSite({ ...d, business: { ...d.business, phone_href: "javascript:alert(1)" } }, { now: NOW });
  assert.doesNotMatch(odd, /href="(?:tel:)?javascript/);
  assert.doesNotMatch(odd, /class="callbar"/);
});

test("hero: headline, intro, rating badge, buttons; their first photo or the photo-free panel", () => {
  const d = asGeneric(build(LEADS.full));
  const html = renderSite(d, { now: NOW });
  assert.match(html, /<section class="hero"><div class="wrap hero-grid">/);
  assert.match(html, /<h1>Patios, lawns and garden makeovers in Warrington<\/h1>/);
  assert.match(html, /<p class="intro">Dave Green and his small team design and build gardens/);
  assert.match(html, /<p class="rate">4\.8 ★ from 37 Google reviews<\/p>/);
  assert.match(html, /<a class="btn btn-alt" href="#quote">Ask for a quote<\/a>/);
  assert.match(html, /id="quote"/);
  assert.match(html, /<img class="hero-img" src="https:\/\/greenleaf-landscapes\.example\/img\/patio\.jpg"/);
  assert.doesNotMatch(html, /class="hero hero-plain"|<svg/);
  // No photos: the panel in their colour with the line icon.
  const plain = renderSite(asGeneric(build(LEADS.noPhotos)), { now: NOW });
  assert.match(plain, /<section class="hero hero-plain"><div class="wrap hero-grid">/);
  assert.match(plain, /<svg class="hero-icon"[^>]*aria-hidden="true"/);
  assert.match(plain, /repeating-linear-gradient\(/);
  assert.match(plain, /\.hero-plain\{[^}]*var\(--main\)/);
  // Rating 5 shows as "5.0"; one review is "review".
  assert.match(renderSite(build(LEADS.httpPhotos), { now: NOW }), /5\.0 ★ from 3 Google reviews/);
  const one = renderSite({ ...d, rating: 5, review_count: 1 }, { now: NOW });
  assert.match(one, /5\.0 ★ from 1 Google review<\/p>/);
  assert.doesNotMatch(renderSite({ ...d, rating: null, review_count: null }, { now: NOW }), /class="rate"/);
  // No intro: left out, not an empty paragraph.
  assert.doesNotMatch(renderSite({ ...d, copy: { ...d.copy, intro: "" } }, { now: NOW }), /class="intro"/);
});

test("services, recent work, areas, reviews and about show only their data", () => {
  const d = asGeneric(build(LEADS.full));
  const html = renderSite(d, { now: NOW });
  for (const s of d.business.services) assert.ok(html.includes(`<li class="card">${h(s)}</li>`), s);
  assert.equal(count(html, '<li class="card">'), 8);
  for (const a of d.business.areas) assert.ok(html.includes(`<li>${h(a)}</li>`), a);
  assert.equal(count(html, "<figure class=\"rev\">"), 3);
  assert.match(html, /<h2>What customers say<\/h2>\s*<p class="sub">Reviews from Google<\/p>/);
  assert.match(html, /<span class="stars" role="img" aria-label="5 out of 5 stars">★★★★★<\/span><blockquote>“Dave and the team/);
  assert.match(html, /<figcaption>Sarah K\.<\/figcaption>/);
  assert.match(html, /aria-label="4 out of 5 stars">★★★★☆</);
  assert.match(html, /<h2>About Green Leaf Landscapes<\/h2>\s*<p class="text">Green Leaf Landscapes is Dave Green&#39;s business\./);
  assert.match(html, /<div class="work">(?:<img [^>]*loading="lazy"[^>]*>){5}<\/div>/);  // photos 2-6
  assert.doesNotMatch(html, /Your services will go here/);
  // The street address and postcode are never shown (sole traders often work from home).
  assert.doesNotMatch(html, /Example Road|WA1 1AA/);
  // Two photos: the hero and one in Recent work. One photo: hero only.
  assert.match(renderSite(asGeneric(build(LEADS.paleColour)), { now: NOW }), /<h2>Recent work<\/h2>\s*<div class="work"><img [^>]*patio-two\.jpg[^>]*><\/div>/);
  const plumber = renderSite(asGeneric(build(LEADS.plumber)), { now: NOW });
  assert.doesNotMatch(plumber, /Recent work/);
  assert.match(plumber, /class="hero-img" src="https:\/\/flowright\.example\/bathroom\.jpg"/);
  // Hand-built data: an unrated or 3-star review, an http photo and a javascript: logo are never shown.
  const odd = renderSite({ ...d, reviews: [{ author: "X", rating: 3, text: "three stars only" }, { author: "Y", text: "no rating at all" }], brand: { ...d.brand, logo: "javascript:alert(1)", photos: ["http://x.example/a.jpg"] } }, { now: NOW });
  assert.doesNotMatch(odd, /three stars only|no rating at all|What customers say|<img|javascript:/);
  assert.match(odd, /<span class="wordmark">Green Leaf Landscapes<\/span>/);
});

test("generic layout: the desktop hero never grows past the page; Recent work hides when none of its photos load", () => {
  const { css } = generic.home(asGeneric(build(LEADS.full)), "demo");
  const desktop = css.slice(css.indexOf("@media"));
  // A long unbroken word in the intro (a web address) can't widen the text column past the page: a 1fr column grows
  // to fit its longest word, minmax(0, …) doesn't (the landscaper look has the same rule).
  assert.match(desktop, /\.hero-grid\{display:grid;grid-template-columns:minmax\(0,1\.1fr\) minmax\(0,1fr\);/);
  // Their host blocks hot-linking: every photo removes itself and the section hides. That needs the grid to be really
  // empty once they're gone: no text or whitespace between the photos (:empty counts it).
  assert.match(css, /#work:has\(\.work:empty\)\{display:none\}/);
  assert.match(renderSite(asGeneric(build(LEADS.full)), { now: NOW }), /<section class="sec[^"]*" id="work"><div class="wrap">\n<h2>Recent work<\/h2>\n<div class="work"><img [^>]*>(?:<img [^>]*>){4}<\/div>/);
});

test("the logo falls back to the wordmark; broken photos remove themselves", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  assert.match(html, /<img class="logo" src="https:\/\/greenleaf-landscapes\.example\/img\/logo\.png" alt="Green Leaf Landscapes logo" width="160" height="52" onerror="this\.nextElementSibling\.hidden=false;this\.remove\(\)"><span class="wordmark" hidden>Green Leaf Landscapes<\/span>/);
  assert.match(html, /\[hidden\]\{display:none!important\}/);
});

test("contact form in demo mode: disabled, fields inside the fieldset, the note above it", () => {
  const html = renderSite(build(LEADS.kickboxing), { now: NOW });
  const form = html.slice(html.indexOf('<p class="note">'), html.indexOf("</form>") + 7);
  assert.match(form, /^<p class="note">Preview only: on your live site, this form sends enquiries straight to your phone and inbox\.<\/p>\s*<form class="quote"><fieldset disabled>/);
  assert.match(form, /<label>Your name<input name="name" autocomplete="name"><\/label>/);
  assert.match(form, /<label>Your phone number<input name="phone" type="tel" autocomplete="tel"><\/label>/);
  assert.match(form, /<label>Your message<textarea name="message" rows="4"><\/textarea><\/label>/);
  assert.match(form, /<button type="submit">Send<\/button>\s*<\/fieldset><\/form>$/);
  assert.doesNotMatch(form, /action=|method=/);
  assert.match(html, /<h2>Ask for a quote<\/h2>/);
});

test("live mode: no form without a form action, no placeholder, footer without Aetos", () => {
  const live = buildDemoData({ lead: LEADS.bare, research: null, offer: OFFER, now: NOW, live: { form_action: "", canonical_url: "" } });
  const html = renderSite(live, { mode: "live", now: NOW });
  assert.doesNotMatch(html, /<form|Ask for a quote|href="#quote"|Your services will go here|What we do|<link/);
  assert.match(html, /<footer class="foot"><div class="wrap"><p>© 2026 Tidy Gardens<\/p><\/div><\/footer>/);
  // A form action that isn't https or a path on their own site is dropped (hand-built data).
  const d = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, offer: OFFER, now: NOW, live: { form_action: "https://forms.example/x", canonical_url: "" } });
  for (const bad of ["javascript:alert(1)", "//evil.example/x", "http://forms.example/x", '/x" onmouseover="y'])
    assert.doesNotMatch(renderSite({ ...d, live: { ...d.live, form_action: bad } }, { mode: "live" }), /<form/, bad);
  // Demo mode always renders the home page; live mode asks the template for the page.
  assert.equal(renderSite(build(LEADS.full), { page: "contact", now: NOW }), renderSite(build(LEADS.full), { now: NOW }));
  assert.throws(() => renderSite(d, { mode: "live", page: "contact" }), /has no "contact" page/);
  assert.throws(() => renderSite(d, { mode: "preview" }), /mode must be "demo" or "live"/);
});

test("footer: © year, name and town; Preview by Aetos Websites in demo mode", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  assert.match(html, /<footer class="foot"><div class="wrap"><p>© 2026 Green Leaf Landscapes · Warrington<\/p><p>Preview by Aetos Websites · <a href="https:\/\/aetoswebsites\.com\/privacy">How we use your information<\/a><\/p><\/div><\/footer>/);
  assert.match(renderSite(build(LEADS.full), { now: new Date("2027-01-01T00:30:00Z") }), /© 2027 Green Leaf/);
});

test("guarantee strip: addressed to the owner, lines from data.guarantee, Aetos look", () => {
  const d = build(LEADS.full);
  const strip = guaranteeStrip(d);
  assert.match(strip, /^<section class="ae-strip">/);
  assert.match(strip, /<p class="ae-for">For Green Leaf Landscapes, from Aetos Websites<\/p>/);
  assert.ok(strip.includes(`<h2>${h(GUARANTEE.headline)}</h2>`));
  assert.ok(strip.includes(`<p>${h(GUARANTEE.section)}</p>`));
  assert.match(strip, /<p class="ae-offer">First 60 days of the monthly plan free\. No contract\.<\/p>/);
  assert.match(strip, /href="\/d\/green-leaf-landscapes-7k2p9q\/order" class="ae-btn" data-ev="order_page">Order this site<\/a>/);
  // The wording is whatever offer.js says (DemoData carries it), never a copy of it here.
  const other = guaranteeStrip({ ...d, guarantee: { headline: "Headline <x>", section: "Section text" } });
  assert.match(other, /<h2>Headline &lt;x&gt;<\/h2>/);
  assert.match(other, /<p>Section text<\/p>/);
  assert.match(renderSite(d, { now: NOW }), /\.ae-strip\{[^}]*background:#1a1c20/);
  assert.match(renderSite(d, { now: NOW }), /\.ae-btn\{[^}]*background:#c9a13b;color:#1a1c20/);
});

test("templates: an unknown id gets the generic look; landscaper trades get the landscaper look", () => {
  const d = build(LEADS.kickboxing);
  assert.match(renderSite(d, { now: NOW }), /<body data-template="generic"/);
  for (const id of ["toString", "__proto__", "constructor", "", undefined, "Landscaper", "landscapers"])
    assert.match(renderSite({ ...d, template: id }, { now: NOW }), /<body data-template="generic"/, String(id));
  assert.match(renderSite(build(LEADS.full), { now: NOW }), /<body data-template="landscaper"/);
  assert.match(renderSite({ ...d, template: "landscaper" }, { now: NOW }), /<body data-template="landscaper"/);
});

test("the template's own words make no claims and never say SEO", () => {
  for (const [key, lead] of Object.entries(LEADS)) for (const id of LOOKS) {
    const html = renderSite({ ...build(lead), template: id }, { now: NOW });
    assert.doesNotMatch(html, /\bSEO\b/i, `${key} ${id}`);
  }
  // Bare lead: every word on the page is ours or theirs; none of the banned claims appear.
  for (const id of LOOKS) {
    const bare = renderSite({ ...build(LEADS.bare), template: id }, { now: NOW });
    assert.doesNotMatch(bare, /free quote|fully insured|years of experience|24\/7|family run|award|no\.1|\bbest\b/i, id);
  }
});

test("renderExpired and renderNotFound: safe with odd input, noindex, Aetos look", () => {
  const plain = renderExpired();
  assert.match(plain, /The website we made for you is no longer on show\./);
  assert.doesNotMatch(plain, /or email|mailto:/);
  assert.match(renderExpired(null), /This preview has ended/);
  assert.match(renderExpired({ name: "Green Leaf Landscapes Ltd" }), /made for Green Leaf Landscapes is no longer/);   // their short name
  const hostile = renderExpired({ name: '<script>alert(1)</script>"', contact_email: 'x@y.co" onclick="z' });
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;/);
  assert.doesNotMatch(hostile, /<script|mailto:|onclick/);
  assert.doesNotMatch(renderExpired({ contact_email: "nik@aetoswebsites.com?cc=x@y.co" }), /mailto:/);
  for (const page of [renderExpired({ name: "A" }), renderNotFound()]) {
    assert.match(page, /^<!doctype html>/);
    assert.match(page, /<meta name="robots" content="noindex,nofollow">/);
    assert.match(page, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(page, /background:#1a1c20/);
    assert.match(page, /Aetos Websites/);
    assert.doesNotMatch(page, /<script|<link|<img|url\(/);
  }
  assert.doesNotMatch(renderNotFound(), /preview|made for/i);                // never says whose
});

// ---------------------------------------------------------------- review additions (Part A §3–§6 edge cases)

test("bidi override and control characters never reach the page", () => {
  const spoof = "Smith\u202E gnifooR\u0007";
  const lead = { ...LEADS.full, name: spoof, town: `War\u2066rington`,
    audit: { ...LEADS.full.audit, reviews: [{ author: spoof, rating: 5, text: `${spoof} rebuilt our patio and laid a new lawn in a week` }] },
    research: { ...LEADS.full.research, copy: { ...LEADS.full.research.copy, headline: spoof, intro: spoof, about: spoof, services: [spoof], areas: [spoof] } } };
  for (const mode of ["demo", "live"]) {
    const d = build(lead);
    // Hand-built data straight from the lead's raw text too: render.js's h() removes them, not only data.js.
    for (const data of [d, { ...d, business: { ...d.business, name: spoof, town: spoof }, copy: { ...d.copy, headline: spoof } }]) {
      const html = renderSite(data, { mode, now: NOW });
      assert.doesNotMatch(html, INVISIBLE, mode);
      assert.ok(html.includes("Smith gnifooR"), mode);
    }
  }
});

test("http-only photos and logo: photo-free hero, the name as wordmark, no http image", () => {
  for (const data of [build(LEADS.httpPhotos), asGeneric(build(LEADS.httpPhotos))]) {
    const html = renderSite(data, { now: NOW });
    assert.match(html, /class="hero hero-plain"/);
    assert.match(html, /<span class="wordmark">Oakfield Turf and Paving<\/span>/);
    assert.equal(imgsOf(html).length, 0);
    assert.doesNotMatch(html, /src="http:|Recent work/);
    assert.match(html, /--main:#2f6b3a\}/);                                   // no colour found: the landscaper default
  }
});

test("the page shows at most 8 services, 12 areas, 3 reviews and 6 photos, even from hand-built data", () => {
  for (const id of LOOKS) {
    const d = { ...build(LEADS.full), template: id };
    const photos = Array.from({ length: 9 }, (_, i) => `https://greenleaf-landscapes.example/img/p${i}.jpg`);
    const many = {
      ...d,
      business: { ...d.business, services: Array.from({ length: 10 }, (_, i) => `Service ${i}`), areas: Array.from({ length: 15 }, (_, i) => `Area ${i}`) },
      brand: { ...d.brand, photos: [...photos, photos[0], d.brand.logo] },
      reviews: Array.from({ length: 5 }, (_, i) => ({ author: `Person ${i}`, rating: 5, text: `Review number ${i} of five, all of them real and rated` })),
    };
    const html = renderSite(many, { now: NOW });
    assert.match(html, new RegExp(`<body data-template="${id}"`));
    assert.equal(count(html, '<li class="card"'), 8, id);                     // service cards (not the placeholder)
    assert.ok(html.includes("Service 7") && !html.includes("Service 8"), id);
    assert.equal(count(html, '<ul class="chips">'), 1, id);
    assert.equal(html.slice(html.indexOf('<ul class="chips">')).split("</ul>")[0].split("<li>").length - 1, 12, id);
    assert.equal(count(html, '<figure class="rev">'), 3, id);
    const shown = imgsOf(html).filter((i) => /alt="Work by/.test(i));
    assert.equal(shown.length, 6, id);                                        // hero + 5 in Recent work
    assert.equal(new Set(shown.map((i) => i.match(/src="([^"]+)"/)[1])).size, 6, id);  // no repeats, never the logo
    assert.ok(shown.every((i) => !i.includes(d.brand.logo)), id);
  }
});

test("their colour is only behind white text or a thin accent line (Part A §5)", () => {
  const ALLOWED = /^(?:background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|text-decoration-color|outline(?:-color)?)$/;
  for (const id of Object.keys(TEMPLATES)) {
    for (const lead of [LEADS.full, LEADS.noPhotos, LEADS.bare]) {
      const html = renderSite({ ...build(lead), template: id }, { now: NOW });
      const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = body.split(";").map((x) => x.trim()).filter(Boolean).map((x) => [x.slice(0, x.indexOf(":")).trim(), x.slice(x.indexOf(":") + 1).trim()]);
        for (const [prop, value] of decls) {
          if (!value.includes("var(--main)")) continue;
          assert.match(prop, ALLOWED, `${id}: ${selector.trim()}{${prop}:${value}} uses their colour for text`);
          if (/^background/.test(prop)) assert.ok(decls.some(([p, v]) => p === "color" && v === "#fff"), `${id}: ${selector.trim()} has their colour behind text that isn't white`);
        }
      }
    }
  }
});

test("render.js and the templates load in any order", () => {
  const dir = new URL("../functions/_lib/demo/", import.meta.url).href;
  for (const first of ["templates/generic.js", "templates/landscaper.js", "render.js"]) {
    const code = `await import(${JSON.stringify(`${dir}${first}`)});
const g = await import(${JSON.stringify(`${dir}templates/generic.js`)});
const l = await import(${JSON.stringify(`${dir}templates/landscaper.js`)});
const r = await import(${JSON.stringify(`${dir}render.js`)});
const d = await import(${JSON.stringify(`${dir}data.js`)});
const page = (trade) => r.renderSite(d.buildDemoData({ lead: { name: "A B", trade, search_town: "Leeds" }, demo: { slug: "a-b-abcdef" } }));
console.log(r.TEMPLATES.generic === g, r.TEMPLATES.landscaper === l, g.TEMPLATE.id, l.TEMPLATE.id,
  page("plumber").includes('data-template="generic"'), page("landscaper").includes('data-template="landscaper"'));`;
    const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(out.trim(), "true true generic landscaper true true", first);
  }
});

// ---------------------------------------------------------------- the landscaper look and the look lock (Task 7)

test("landscaper fixtures use the landscaper look", () => {
  for (const key of LANDSCAPER_KEYS) {
    const html = renderSite(build(LEADS[key]), { now: NOW });
    assert.match(html, /<body data-template="landscaper"/, key);
  }
  for (const key of ["kickboxing", "roofer", "plumber", "locksmith", "electrician"])
    assert.match(renderSite(build(LEADS[key]), { now: NOW }), /<body data-template="generic"/, key);
  // With photos the "Recent work" heading comes before "What we do" (landscaping sells on photos).
  for (const key of ["full", "paleColour"]) {
    const html = renderSite(build(LEADS[key]), { now: NOW });
    assert.ok(html.indexOf("Recent work") > 0, key);
    assert.ok(html.indexOf("Recent work") < html.indexOf("What we do"), key);
  }
});

test("the look is locked to its version", () => {
  const fix = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: DEMO, offer: OFFER, now: NOW });
  const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const LOCK = { landscaper: { version: 1, hash: "6901e5c0d52e5db1" }, generic: { version: 1, hash: "8c145cc61ac92af4" } };
  for (const id of ["landscaper", "generic"]) {
    // A fixed now: the footer's © year would otherwise change the hash every 1 January.
    const html = renderSite({ ...fix, template: id }, { now: NOW });
    assert.equal(TEMPLATES[id].TEMPLATE.version, LOCK[id].version, `${id} version changed: update LOCK`);
    assert.equal(sha(html), LOCK[id].hash, `The ${id} look changed: bump TEMPLATE.version so Nik re-approves it, then update LOCK`);
  }
});

test("the look lock also covers the photo-free, two-photo, one-photo, bare and weekend layouts", () => {
  // LEADS.full alone never draws the photo-free hero, a one-photo Recent work, the services placeholder, a phone that
  // doesn't dial (the plumber's, shown as text; one photo, so no Recent work) or the weekend offer line.
  const LAYOUT_LOCK = { landscaper: { version: 1, hash: "f0cc7884d9a85fb3" }, generic: { version: 1, hash: "c53b773804d5410e" } };
  for (const id of LOOKS) {
    const pages = ["noPhotos", "paleColour", "bare", "plumber"].map((key) => renderSite({ ...build(LEADS[key]), template: id }, { now: NOW }));
    pages.push(renderSite({ ...build(LEADS.full, { offer: WEEKEND }), template: id }, { now: NOW }));
    const html = pages.join("\n");
    assert.equal(TEMPLATES[id].TEMPLATE.version, LAYOUT_LOCK[id].version, `${id} version changed: update LAYOUT_LOCK`);
    assert.equal(sha(html), LAYOUT_LOCK[id].hash, `The ${id} look changed: bump TEMPLATE.version so Nik re-approves it, then update LOCK and LAYOUT_LOCK`);
  }
});

test("the landscaper template is the Landscaper look, version 1", () => {
  assert.deepEqual({ ...landscaper.TEMPLATE }, { id: "landscaper", version: 1, label: "Landscaper" });
  assert.ok(Object.isFrozen(landscaper.TEMPLATE));
  assert.equal(TEMPLATES.landscaper, landscaper);
  assert.equal(TEMPLATES.generic, generic);
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ["generic", "landscaper"]);
  assert.ok(Object.isFrozen(TEMPLATES));
  // A template exports its demo home page and stage 10's client-site page(): no helper may be exported by mistake.
  for (const mod of [generic, landscaper]) assert.deepEqual(Object.keys(mod).sort(), ["TEMPLATE", "home", "page"], mod.TEMPLATE.id);
  const { css, body } = landscaper.home(build(LEADS.full), "demo");
  assert.equal(typeof css, "string");
  assert.equal(count(css, "@media"), 1);                                    // mobile-first, one desktop block
  assert.equal(count(css, "@media (min-width: 900px)"), 1);
  assert.doesNotMatch(css, /max-width:\s*\d+px\)/);
  assert.doesNotMatch(css, /url\(|@import|@font-face/);
  assert.doesNotMatch(body, /<html|<head>|<body|ae-bar|class="foot"|<script|<style/); // the shell's parts aren't in it
  assert.notEqual(css, generic.home(build(LEADS.full), "demo").css);       // a look of its own
});

test("landscaper section order: hero, recent work, services, areas, reviews, guarantee, about, contact", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  const at = ["<h1>", "Recent work", "What we do", "Areas we cover", "What customers say", "GUARANTEED", "About Green Leaf Landscapes", "Ask for a quote</h2>", 'class="foot"'].map((s) => html.indexOf(s));
  at.forEach((i) => assert.ok(i > 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(html.indexOf('class="ae-bar"') < html.indexOf('class="top"'));
  assert.ok(html.indexOf('class="top"') < html.indexOf("<h1>"));
  // Recent work is straight after the hero: no section between them.
  assert.match(html, /<\/div><\/section>\n<section class="sec[^"]*" id="work"><div class="wrap">\n<h2>Recent work<\/h2>/);
  // Live mode: the same order without the guarantee strip.
  const live = renderSite(buildDemoData({ lead: LEADS.full, research: LEADS.full.research, offer: OFFER, now: NOW, live: { form_action: "https://forms.example/x", canonical_url: "" } }), { mode: "live", now: NOW });
  const atLive = ["<h1>", "Recent work", "What we do", "Areas we cover", "What customers say", "About Green Leaf Landscapes", "Ask for a quote</h2>", 'class="foot"'].map((s) => live.indexOf(s));
  atLive.forEach((i) => assert.ok(i > 0));
  assert.deepEqual([...atLive].sort((a, b) => a - b), atLive);
  assert.doesNotMatch(live, /GUARANTEED|ae-strip"|Order this site/);
});

test("landscaper hero: photo right on desktop, below the buttons on mobile; photo-free panel with the leaf", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  const hero = html.slice(html.indexOf("<section class=\"hero"), html.indexOf("</section>", html.indexOf("<section class=\"hero")));
  assert.match(hero, /^<section class="hero"><div class="wrap hero-grid">/);
  assert.match(hero, /<h1>Patios, lawns and garden makeovers in Warrington<\/h1>/);
  assert.match(hero, /<p class="intro">Dave Green and his small team design and build gardens/);
  assert.match(hero, /<p class="rate">4\.8 ★ from 37 Google reviews<\/p>/);
  assert.match(hero, /<a class="btn" href="tel:07969770905">Call 07969 770905<\/a><a class="btn btn-alt" href="#quote">Ask for a quote<\/a>/);
  assert.match(hero, /<img class="hero-img" src="https:\/\/greenleaf-landscapes\.example\/img\/patio\.jpg" alt="Work by Green Leaf Landscapes"[^>]*fetchpriority="high"/);
  assert.ok(hero.indexOf('class="btns"') < hero.indexOf('class="hero-img"'));   // in the markup: below the buttons
  assert.doesNotMatch(hero, /hero-plain|hero-icon/);
  const { css } = landscaper.home(build(LEADS.full), "demo");
  const desktop = css.slice(css.indexOf("@media (min-width: 900px)"));
  assert.match(css.slice(0, css.indexOf("@media")), /\.hero-grid\{display:flex;flex-direction:column\}/);   // mobile: stacked
  assert.match(desktop, /\.hero-grid\{display:grid;grid-template-columns:[^;}]+ [^;}]+;/);                  // desktop: text | photo
  // No photos: the panel in their colour with a CSS pattern and the leaf line icon.
  for (const key of ["noPhotos", "httpPhotos", "bare", "locksmith"]) {
    const plain = renderSite(asLandscaper(build(LEADS[key])), { now: NOW });
    assert.match(plain, /<section class="hero hero-plain"><div class="wrap hero-grid">/, key);
    assert.match(plain, /<svg class="hero-icon"[^>]*aria-hidden="true"[^>]*>/, key);
    assert.match(plain, /\.hero-plain\{[^}]*background:var\(--main\) repeating-linear-gradient\(/, key);
    assert.doesNotMatch(plain, /class="hero-img"/, key);
  }
  // A long unbroken word in the intro (a web address) can't widen the text column past the page: a 1fr column grows
  // to fit its longest word, minmax(0, …) doesn't (seen in Chromium at 1280 px before the fix).
  assert.match(desktop, /\.hero-grid\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.15fr\);/);
  // The leaf, not the generic look's map pin.
  const heroIcon = (page) => page.match(/<svg class="hero-icon"[\s\S]*?<\/svg>/)[0];
  const leaf = heroIcon(renderSite(build(LEADS.noPhotos), { now: NOW }));
  assert.notEqual(leaf, heroIcon(renderSite(asGeneric(build(LEADS.noPhotos)), { now: NOW })));
});

test("landscaper recent work: photos 2-6 in a 2-column grid on mobile", () => {
  const html = renderSite(build(LEADS.full), { now: NOW });
  assert.match(html, /<h2>Recent work<\/h2>\n<div class="work">(?:<img [^>]*alt="Work by Green Leaf Landscapes"[^>]*loading="lazy"[^>]*>){5}<\/div>/);
  for (const p of ["lawn", "fence", "deck", "border", "path"]) assert.ok(html.includes(`/img/${p}.jpg`), p);
  assert.doesNotMatch(html, /old\.jpg|src="http:/);                           // http photo dropped
  assert.equal(count(html, "/img/patio.jpg"), 1);                             // the hero photo isn't repeated
  const { css } = landscaper.home(build(LEADS.full), "demo");
  assert.match(css.slice(0, css.indexOf("@media")), /\.work\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // Two photos: the hero and one in Recent work. One photo: hero only, no Recent work.
  assert.match(renderSite(build(LEADS.paleColour), { now: NOW }), /<h2>Recent work<\/h2>\n<div class="work"><img [^>]*patio-two\.jpg[^>]*><\/div>/);
  const plumber = renderSite(asLandscaper(build(LEADS.plumber)), { now: NOW });
  assert.doesNotMatch(plumber, /Recent work|id="work"/);
  assert.match(plumber, /class="hero-img" src="https:\/\/flowright\.example\/bathroom\.jpg"/);
  // Their host blocks hot-linking: every photo removes itself, and the section hides rather than show "Recent work"
  // over nothing straight under the hero. That needs the grid to be really empty once they're gone: no text or
  // whitespace between the photos (:empty counts it).
  assert.match(css, /#work:has\(\.work:empty\)\{display:none\}/);
  assert.match(html, /<div class="work"><img [^>]*>(?:<img [^>]*>)*<\/div>/);
});

test("landscaper services: a card with a leaf per service; none → the placeholder card", () => {
  const d = build(LEADS.full);
  const html = renderSite(d, { now: NOW });
  assert.equal(count(html, '<li class="card"><span class="leaf" aria-hidden="true"><svg '), 8);
  for (const s of d.business.services) assert.ok(html.includes(`<span>${h(s)}</span></li>`), s);
  assert.doesNotMatch(html, /Your services will go here/);
  const bare = renderSite(build(LEADS.bare), { now: NOW });
  assert.match(bare, /<h2>What we do<\/h2>\n<ul class="cards"><li class="card card-ph"><b>Your services will go here<\/b><small>Preview placeholder: we&#39;ll fill this in with you<\/small><\/li><\/ul>/);
  assert.equal(count(bare, 'class="leaf"'), 0);
  // A service that is one long word (up to 60 characters) wraps beside its leaf instead of pushing a 390 px page
  // sideways: a flex item never shrinks below its longest word unless its min-width is 0 (seen in Chromium).
  assert.match(landscaper.home(d, "demo").css, /\.card>span\{min-width:0\}/);
  // Live mode never shows the placeholder: no services, no section.
  const live = renderSite(buildDemoData({ lead: LEADS.bare, research: null, offer: OFFER, now: NOW, live: { form_action: "https://forms.example/x", canonical_url: "" } }), { mode: "live", now: NOW });
  assert.doesNotMatch(live, /What we do|Your services will go here|id="services"/);
  assert.match(live, /<form class="quote" method="post" action="https:\/\/forms\.example\/x">/);
});

test("landscaper areas, reviews and about show only their data", () => {
  const d = build(LEADS.full);
  const html = renderSite(d, { now: NOW });
  for (const a of d.business.areas) assert.ok(html.includes(`<li>${h(a)}</li>`), a);
  assert.equal(count(html, '<figure class="rev">'), 3);
  assert.match(html, /<h2>What customers say<\/h2>\n<p class="sub">Reviews from Google<\/p>/);
  assert.match(html, /<span class="stars" role="img" aria-label="5 out of 5 stars">★★★★★<\/span><blockquote>“Dave and the team/);
  assert.match(html, /<figcaption>Sarah K\.<\/figcaption>/);
  assert.match(html, /<h2>About Green Leaf Landscapes<\/h2>\n<p class="text">Green Leaf Landscapes is Dave Green&#39;s business\./);
  assert.doesNotMatch(html, /Example Road|WA1 1AA|Mark Unrated|Jo Lowe|Ben String|Great job, thanks/);
  // The contact form: the note and a disabled fieldset, from the shell.
  assert.match(html, /<h2>Ask for a quote<\/h2>\n<p class="note">Preview only: on your live site, this form sends enquiries straight to your phone and inbox\.<\/p>\n<form class="quote"><fieldset disabled>/);
  assert.match(html, /id="quote"/);
  // Hand-built data: an unrated or 3-star review, an http photo and a javascript: logo are never shown.
  const odd = renderSite({ ...d, reviews: [{ author: "X", rating: 3, text: "three stars only" }, { author: "Y", text: "no rating at all" }], brand: { ...d.brand, logo: "javascript:alert(1)", photos: ["http://x.example/a.jpg"] } }, { now: NOW });
  assert.doesNotMatch(odd, /three stars only|no rating at all|What customers say|<img|javascript:/);
  assert.match(odd, /<span class="wordmark">Green Leaf Landscapes<\/span>/);
  assert.match(odd, /class="hero hero-plain"/);
});
