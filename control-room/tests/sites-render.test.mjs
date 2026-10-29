// Live mode of the template engine for client sites (stage 10, docs/rebuild/09-build.md Part A §7, Part B Task 4):
// siteData(content, opts) turns a SiteContent document into DemoData + live, and renderSite(..., {mode: "live",
// page: <path>}) draws any of its pages with the client's nav, NAP footer, map, contact form, JSON-LD and chat tag.
// Demo mode is untouched (demo-render.test.mjs keeps its look lock). Uses the valid Smith Roofing fixture from Task 2.
// Run: node --test control-room/tests/sites-render.test.mjs control-room/tests/demo*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderSite } from "../functions/_lib/demo/render.js";
import * as generic from "../functions/_lib/demo/templates/generic.js";
import * as landscaper from "../functions/_lib/demo/templates/landscaper.js";
import { h } from "../functions/_lib/demo/text.js";
import { bodyHtml } from "../functions/_lib/sites/body.js";
import { siteData } from "../functions/_lib/sites/sitedata.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const CTX = JSON.parse(readFileSync(new URL("./fixtures/site-ctx.json", import.meta.url), "utf8"));
const fx = () => structuredClone(FX);
const NOW = new Date("2026-10-28T10:00:00Z");
const HOST = "www.smithroofing.co.uk";
const LEAD = {
  place_id: "p1", name: "Smith Roofing Ltd", trade: "roofer", town: "Swindon", search_town: "Swindon",
  phone: "01793 123456", maps_url: "https://maps.google.com/?cid=1234567890", rating: 4.9, review_count: 23,
};
const REVIEW_URL = "https://search.google.com/local/writereview?placeid=p1";
const OPTS = { lead: LEAD, host: HOST, base: "", reviewUrl: REVIEW_URL, chat: false, noindex: false, previewBar: "", files: CTX.files };
const PREVIEW = "Preview of Smith Roofing's site · Ready to approve";

const pageOf = (c, path) => c.pages.find((p) => p.path === path);
const data = (o = {}, c = fx()) => siteData(c, { ...OPTS, ...o });
const render = (path, o = {}, c = fx()) => renderSite(data(o, c), { mode: "live", page: path, now: NOW });
const count = (html, s) => html.split(s).length - 1;
const imgsOf = (html) => html.match(/<img\b[^>]*>/g) ?? [];
const between = (html, open, close) => {
  const at = html.indexOf(open);
  assert.ok(at >= 0, `${open} is in the page`);
  return html.slice(at, html.indexOf(close, at) + close.length);
};
const footerOf = (html) => between(html, "<footer", "</footer>");
const navOf = (html) => between(html, '<nav class="nav"', "</nav>");
const hrefsOf = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const styleOf = (html) => between(html, "<style>", "</style>");

const PAGES = ["/", "/services/roof-repairs"];

// ---------------------------------------------------------------- the spec's tests

test("home and a service page: title, meta, one H1, canonical, indexable, no demo bits", () => {
  for (const path of PAGES) {
    const p = pageOf(FX, path);
    const html = render(path);
    assert.equal(between(html, "<title>", "</title>"), `<title>${h(p.title)}</title>`, path);
    assert.ok(html.includes(`<meta name="description" content="${h(p.meta)}">`), `${path}: meta description`);
    assert.equal(count(html, "<h1"), 1, `${path}: exactly one <h1>`);
    assert.match(html, new RegExp(`<h1>${h(p.h1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`), `${path}: H1`);
    const canonical = path === "/" ? "https://www.smithroofing.co.uk/" : `https://www.smithroofing.co.uk${path}`;
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`), `${path}: canonical`);
    assert.doesNotMatch(html, /noindex/, path);
    assert.doesNotMatch(html, /ae-bar/, path);
    assert.doesNotMatch(html, /\/d\/|sendBeacon/, `${path}: no demo beacon, no /d/ link`);
  }
  assert.ok(render("/services/roof-repairs").includes('<link rel="canonical" href="https://www.smithroofing.co.uk/services/roof-repairs">'));
});

test("footer: name, phone, town, legal line, review link, privacy, Website by Aetos Websites", () => {
  for (const path of PAGES) {
    const foot = footerOf(render(path));
    for (const s of ["Smith Roofing", "01793 123456", "Swindon", "John Smith trading as Smith Roofing", "Leave us a Google review", 'href="/privacy"', "Website by Aetos Websites"]) {
      assert.ok(foot.includes(s), `${path}: footer has ${s}`);
    }
    assert.ok(foot.includes(`href="${h(REVIEW_URL)}"`), `${path}: the review link`);
  }
  // No review URL: no review link.
  assert.doesNotMatch(footerOf(render("/", { reviewUrl: "" })), /Leave us a Google review/);
  // A review URL that isn't https is never printed.
  assert.doesNotMatch(render("/", { reviewUrl: "javascript:alert(1)" }), /javascript:|Leave us a Google review/);
});

test("one JSON-LD script that parses, with the business node", () => {
  for (const path of PAGES) {
    const scripts = ldOf(render(path));
    assert.equal(scripts.length, 1, path);
    const nodes = JSON.parse(scripts[0]);
    assert.ok(Array.isArray(nodes) && nodes.length >= 1, path);
    assert.equal(nodes[0]["@id"], "https://www.smithroofing.co.uk/#business", path);
    if (path !== "/") assert.ok(nodes.some((n) => n["@type"] === "BreadcrumbList"), path);
  }
  const svc = JSON.parse(ldOf(render("/services/roof-repairs"))[0]);
  assert.ok(svc.some((n) => n["@type"] === "Service"));
  assert.ok(svc.some((n) => n["@type"] === "FAQPage"));
});

test("nav links every top-level page", () => {
  for (const path of PAGES) {
    const nav = hrefsOf(navOf(render(path)));
    for (const p of ["/", "/services", "/areas", "/about", "/reviews", "/contact"]) assert.ok(nav.includes(p), `${path}: nav links ${p}`);
    const html = navOf(render(path));
    for (const label of ["Home", "Services", "Areas", "About", "Reviews", "Contact"]) assert.ok(html.includes(`>${label}</a>`), label);
  }
  assert.match(navOf(render("/services/roof-repairs")), /href="\/services" aria-current="page"|aria-current="page" href="\/services"/);
});

test("a review with <script> renders escaped", () => {
  const c = fx();
  c.reviews[0].text = "<script>alert(1)</script>";
  for (const path of ["/", "/reviews"]) {
    const html = render(path, {}, c);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), path);
    assert.doesNotMatch(html, /<script>alert/, path);
  }
});

test("bodyHtml: escaped paragraphs, lists and internal links under the base", () => {
  assert.match(bodyHtml("[a](/areas/x)", "/c/s1"), /<a href="\/c\/s1\/areas\/x">a<\/a>/);
  assert.equal(bodyHtml("[a](/areas/x)", "/c/s1"), '<p><a href="/c/s1/areas/x">a</a></p>');
  assert.equal(bodyHtml("[a](/areas/x)", ""), '<p><a href="/areas/x">a</a></p>');
  assert.equal(bodyHtml("[Home](/)", "/c/s1"), '<p><a href="/c/s1/">Home</a></p>');
  assert.equal(bodyHtml("One\ntwo.\n\n- a\n- b [c](/about)\n\nEnd & <b>", ""),
    '<p>One two.</p>\n<ul><li>a</li><li>b <a href="/about">c</a></li></ul>\n<p>End &amp; &lt;b&gt;</p>');
  // Not an internal path: printed as words, never a link.
  for (const bad of ["[us](https://x.com)", "[us](//x.com/a)", "[us](javascript:alert(1))", "[us](/a\"b)"]) {
    assert.doesNotMatch(bodyHtml(bad, ""), /<a /, bad);
  }
  // A base that isn't a plain path prefix is ignored.
  assert.equal(bodyHtml("[a](/x)", '"><script>'), '<p><a href="/x">a</a></p>');
  assert.equal(bodyHtml("", ""), "");
  assert.equal(bodyHtml(null, ""), "");
});

test("chat tag only when chat is on", () => {
  for (const path of PAGES) {
    assert.ok(render(path, { chat: true }).includes('<script src="/s/chat.js" defer></script>'), path);
    assert.doesNotMatch(render(path, { chat: false }), /chat\.js/, path);
  }
});

test("noindex when asked", () => {
  for (const path of PAGES) assert.match(render(path, { noindex: true }), /<meta name="robots" content="noindex">/, path);
});

test("performance budget: inline CSS ≤ 16 KB, page ≤ 120 KB, every <img> sized with alt, lazy but the hero", () => {
  for (const p of FX.pages) {
    const html = render(p.path, { chat: true });
    assert.equal(count(html, "<style"), 1, p.path);
    assert.ok(Buffer.byteLength(styleOf(html)) <= 16384, `${p.path}: CSS is ${Buffer.byteLength(styleOf(html))} bytes`);
    assert.ok(Buffer.byteLength(html) <= 120 * 1024, `${p.path}: page is ${Buffer.byteLength(html)} bytes`);
    assert.doesNotMatch(html, /@font-face|@import|fonts\.googleapis/, p.path);
    const imgs = imgsOf(html);
    for (const img of imgs) {
      assert.match(img, / width="\d+"/, `${p.path}: ${img}`);
      assert.match(img, / height="\d+"/, `${p.path}: ${img}`);
      assert.match(img, / alt="[^"]+"/, `${p.path}: ${img}`);
    }
    // Part A §7: loading="lazy" on every <img> except the hero (fetchpriority="high"); the hero is the first photo in
    // <main> (the header's logo comes before it in the markup and is lazy too).
    const eager = imgs.filter((i) => !i.includes('loading="lazy"'));
    assert.ok(eager.length <= 1, `${p.path}: at most one image isn't lazy`);
    for (const i of eager) assert.match(i, /fetchpriority="high"/, p.path);
    const main = html.slice(html.indexOf("<main>"));
    if (eager.length) assert.equal(imgsOf(main)[0], eager[0], `${p.path}: the eager image is the first one in <main>`);
    assert.equal(count(html, 'fetchpriority="high"'), eager.length, p.path);
  }
  // Home has a hero photo (the first) and every other image lazy; the logo carries its real proportions.
  const home = render("/");
  const imgs = imgsOf(home);
  assert.ok(imgs.length >= 3);
  assert.match(imgs[0], /class="logo"[^>]*loading="lazy"|loading="lazy"[^>]*class="logo"/);
  assert.equal(imgs.filter((i) => i.includes('fetchpriority="high"')).length, 1);
  assert.ok(imgs.slice(1).filter((i) => !i.includes("fetchpriority")).every((i) => i.includes('loading="lazy"')));
  assert.match(home, /<img class="hero-img" src="https:\/\/smithroofing\.co\.uk\/images\/slate-roof\.jpg" alt="Slate roof repaired on a terraced house in Old Town, Swindon" width="1200" height="800" fetchpriority="high"/);
  // Step 1's rule as written ("all but the first have loading=lazy") holds whenever the hero is the first <img>: a
  // site with no logo (the wordmark instead) and a hero photo.
  const noLogo = fx();
  noLogo.theme.logo = "";
  for (const path of ["/", "/services/chimney-repairs"]) {
    const all = imgsOf(render(path, {}, noLogo));
    assert.ok(all.length >= (path === "/" ? 2 : 1), path);
    assert.match(all[0], /fetchpriority="high"/, path);
    assert.doesNotMatch(all[0], /loading=/, path);
    for (const i of all.slice(1)) assert.match(i, /loading="lazy"/, `${path}: ${i}`);
  }
  // A copied file (/s/f/<id>) is a photo too, with its own size and alt.
  assert.match(render("/services/chimney-repairs"), /<img class="hero-img" src="\/s\/f\/a1b2c3d4e5f60718293a4b5c6d7e8f90" alt="Rebuilt brick chimney stack with new lead flashing in Swindon" width="1200" height="900"/);
});

test("preview: bar, every nav link under /c/<slug>/, a note instead of the form", () => {
  for (const path of PAGES) {
    const html = render(path, { previewBar: PREVIEW, base: "/c/s1", noindex: true, chat: true });
    // The bar text as written (element text: only & < > need escaping, so the apostrophe stays as it is).
    assert.ok(html.includes(PREVIEW), `${path}: the bar text`);
    assert.match(html, /<div class="ae-bar"><p>Preview of Smith Roofing's site · Ready to approve · <a href="\/#\/sites">Back to the Control Room<\/a><\/p><\/div>/);
    for (const href of hrefsOf(navOf(html))) assert.ok(href.startsWith("/c/s1/"), `${path}: nav ${href}`);
    assert.ok(html.includes("Works once the site is live."), `${path}: the note`);
    assert.doesNotMatch(html, /<form method="post"|<form[^>]*method="post"/, path);
    assert.doesNotMatch(html, /chat\.js/, `${path}: no chat in the preview`);
    assert.match(html, /noindex/);
    // Body links and the privacy link stay in the preview too.
    for (const href of hrefsOf(html).filter((x) => x.startsWith("/") && !x.startsWith("/#") && !x.startsWith("/s/f/"))) {
      assert.ok(href.startsWith("/c/s1/"), `${path}: link ${href}`);
    }
  }
});

test("live HTML has none of stage 4's demo words", () => {
  for (const p of FX.pages) {
    assert.doesNotMatch(render(p.path, { chat: true }), /Preview made|GUARANTEED|sendBeacon|Preview by Aetos/, p.path);
  }
});

// ---------------------------------------------------------------- more of Part A §7

test("every fixture page renders in both looks, with its own title and H1", () => {
  for (const trade of ["roofer", "landscaper"]) {
    const c = fx();
    c.business.trade = trade;
    for (const p of c.pages) {
      const html = render(p.path, {}, c);
      assert.match(html, new RegExp(`<body data-template="${trade === "roofer" ? "generic" : "landscaper"}"`), p.path);
      assert.ok(html.includes(`<title>${h(p.title)}</title>`), `${trade} ${p.path}`);
      assert.equal(count(html, "<h1"), 1, `${trade} ${p.path}`);
      if (p.intro) assert.ok(html.includes(h(p.intro)), `${trade} ${p.path}: intro`);
      for (const s of p.sections ?? []) assert.ok(html.includes(`<h2>${h(s.h2)}</h2>`), `${trade} ${p.path}: ${s.h2}`);
      for (const f of p.faq ?? []) {
        assert.ok(html.includes(h(f.q)) && html.includes(h(f.a)), `${trade} ${p.path}: FAQ ${f.q}`);
      }
    }
  }
  // The landscaper look has a live page() of its own (its own CSS), like generic.
  assert.equal(typeof generic.page, "function");
  assert.equal(typeof landscaper.page, "function");
  const d = data();
  assert.notEqual(generic.page(d, "live").css, landscaper.page({ ...d, template: "landscaper" }, "live").css);
});

test("a path that isn't a page throws; home is the default page", () => {
  assert.throws(() => render("/nope"), /no page "\/nope"/);
  assert.equal(renderSite(data(), { mode: "live", now: NOW }), render("/"));
  assert.equal(renderSite(data(), { mode: "live", page: "home", now: NOW }), render("/"));
});

test("body text: paragraphs, bullets and internal links from the content", () => {
  const html = render("/");
  assert.ok(html.includes('<a href="/services/roof-repairs">roof repairs in Swindon</a>'));
  assert.ok(html.includes('<a href="/areas/wroughton">Wroughton</a>'));
  assert.match(html, /<ul><li>A free quote after we have seen the roof, not a guess over the phone<\/li><li>/);
  // Home lists the service pages and the area pages as links.
  for (const p of FX.pages.filter((x) => x.key === "service" || x.key === "area")) {
    assert.ok(html.includes(`<a href="${p.path}"`), `home links ${p.path}`);
  }
});

test("contact form: section 9's fields on contact, home, service and area pages; none on the others", () => {
  for (const path of ["/contact", "/", "/services/roof-repairs", "/areas/wroughton"]) {
    const html = render(path);
    assert.equal(count(html, "<form"), 1, path);
    const form = between(html, "<form", "</form>");
    assert.match(form, /^<form class="quote" id="cf" method="post" action="\/s\/contact">/, path);
    assert.match(form, /<input name="name" autocomplete="name" required>/);
    assert.match(form, /<input name="phone" type="tel" autocomplete="tel">/);
    assert.match(form, /<input name="email" type="email" autocomplete="email">/);
    assert.match(form, /What do you need\?<textarea name="message" rows="5" maxlength="2000"><\/textarea>/);
    assert.match(form, /<input name="website" tabindex="-1" autocomplete="off">/);
    assert.match(form, /<input type="hidden" name="t" value="">/);
    assert.ok(form.includes(`<input type="hidden" name="page" value="${path}">`), path);
    assert.match(form, /<button type="submit">Send<\/button>/);
    assert.match(html, /f\.elements\.t\.value=String\(Date\.now\(\)-s\)/);
  }
  for (const path of ["/about", "/reviews", "/services", "/areas"]) assert.doesNotMatch(render(path), /<form/, path);
  // On the temporary link the form posts under its base.
  assert.match(render("/contact", { base: "/w/s1" }), /action="\/w\/s1\/s\/contact"/);
});

test("map: on home and contact only, lazy, the town when the address is hidden", () => {
  for (const path of ["/", "/contact"]) {
    const html = render(path);
    assert.match(html, /<iframe class="map" title="Map of Swindon" src="https:\/\/maps\.google\.com\/maps\?q=Swindon&amp;output=embed" loading="lazy"/, path);
  }
  for (const path of ["/services/roof-repairs", "/about", "/areas/wroughton"]) assert.doesNotMatch(render(path), /<iframe/, path);
  // Home-based: the street and postcode are never on any page.
  for (const p of FX.pages) assert.doesNotMatch(render(p.path), /12 High St|SN1 1AA/, p.path);
  // Address shown: the full address in the footer and the map.
  const c = fx();
  c.business.show_address = true;
  const html = render("/contact", {}, c);
  assert.ok(footerOf(html).includes("12 High St, Swindon SN1 1AA"));
  assert.match(html, /src="https:\/\/maps\.google\.com\/maps\?q=Smith%20Roofing%2C%2012%20High%20St%2C%20Swindon%20SN1%201AA&amp;output=embed"/);
  // No town and no address: no map.
  const none = fx();
  none.business.address.town = "";
  assert.doesNotMatch(render("/", {}, none), /<iframe/);
});

test("header: logo linking home, the phone as a call button; rating from the lead row", () => {
  const html = render("/services/roof-repairs");
  assert.match(html, /<header class="top"><div class="wrap"><a class="home" href="\/"><img class="logo" src="https:\/\/smithroofing\.co\.uk\/images\/logo\.png" alt="Smith Roofing logo"/);
  assert.match(html, /<a class="top-ph top-call" href="tel:01793123456">Call 01793 123456<\/a>/);
  assert.match(html, /<p class="rate">4\.9 ★ from 23 Google reviews<\/p>/);
  assert.doesNotMatch(render("/", { lead: { ...LEAD, rating: null, review_count: 0 } }), /class="rate"/);
  // Their colour from the theme.
  assert.match(html, /:root\{--main:#1e4f86\}/);
  const c = fx();
  c.theme.main = "red;}</style><script>";
  assert.match(render("/", {}, c), /:root\{--main:#1a1c20\}/);
});

test("reviews page shows every content review; home shows three", () => {
  const reviews = render("/reviews");
  assert.equal(count(reviews, '<figure class="rev">'), FX.reviews.length);
  assert.match(reviews, /<figcaption>Dave P\.<\/figcaption>/);
  assert.match(reviews, /Reviews from Google/);
  assert.ok(reviews.includes("Leave us a Google review"));
  assert.ok(count(render("/"), '<figure class="rev">') <= 3);
});

test("both review links open the review URL in a new tab with rel=noopener; none without a review URL", () => {
  const NEW_TAB = 'target="_blank" rel="noopener">Leave us a Google review';
  for (const trade of ["roofer", "landscaper"]) {
    const c = fx();
    c.business.trade = trade;
    const reviews = render("/reviews", {}, c);
    const foot = footerOf(reviews);
    const body = reviews.replace(foot, "");
    assert.ok(body.includes(`<a class="btn" href="${h(REVIEW_URL)}" ${NEW_TAB}`), `${trade}: the /reviews button`);
    assert.ok(foot.includes(`<a href="${h(REVIEW_URL)}" ${NEW_TAB}`), `${trade}: the footer link`);
    // Privacy is on the same site: same tab.
    assert.match(foot, /<a href="\/privacy">Privacy<\/a>/, `${trade}: privacy stays in the same tab`);
    for (const path of ["/", "/reviews", "/contact"]) {
      assert.doesNotMatch(render(path, { reviewUrl: "" }, c), /Leave us a Google review|writereview/, `${trade} ${path}: no review link`);
    }
  }
});

test("services and areas hubs list the extra form services and areas without pages", () => {
  const form = structuredClone(CTX.form);
  form.services.push({ name: "Fascias and soffits", on: true, own: true });
  form.areas.push("Purton");
  const html = render("/services", { form });
  assert.ok(html.includes("Fascias and soffits"));
  for (const p of FX.pages.filter((x) => x.key === "service")) assert.ok(html.includes(`<a href="${p.path}"`), p.path);
  const areas = render("/areas", { form });
  assert.ok(areas.includes("Purton"));
  assert.ok(areas.includes("Swindon"));
  // Unticked services never show; the extra area is in JSON-LD areaServed.
  assert.doesNotMatch(html, /Guttering/);
  const ld = JSON.parse(ldOf(areas)[0]);
  assert.ok(ld[0].areaServed.some((a) => a.name === "Purton"));
});

test("hostile content never becomes markup", () => {
  const c = fx();
  const X = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  c.business.name = `Smith ${X}`;
  c.business.legal_line = X;
  c.business.hours = X;
  c.pages[0].title = X;
  c.pages[0].meta = X;
  c.pages[0].h1 = X;
  c.pages[0].intro = X;
  c.pages[0].sections[0].h2 = X;
  c.pages[0].sections[0].body = `${X}\n\n- ${X}\n\n[${X}](/about)`;
  c.pages[0].faq[0].q = X;
  c.photos[0].alt = X;
  c.photos[1].url = 'javascript:alert(1)';
  c.reviews[0].author = X;
  for (const path of ["/", "/reviews", "/contact"]) {
    const html = render(path, { chat: true, previewBar: X }, c);
    assert.ok(html.includes('<div class="ae-bar"><p>"&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt; · '), `${path}: the bar is escaped`);
    // h() leaves "onerror=alert(1)" readable as plain text (it can't run): the tags themselves are checked below.
    assert.doesNotMatch(html, /<img src=x|<script>alert|"\s*onerror=alert|javascript:/, path);
    // Only the fixed handlers, only our own scripts.
    for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) assert.match(m[1], /^this\.(remove\(\)|nextElementSibling\.hidden=false;this\.remove\(\))$/, path);
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    for (const s of scripts) assert.ok([' type="application/ld+json"', "", ' src="/s/chat.js" defer'].includes(s), `${path}: script ${s}`);
    for (const ld of ldOf(html)) assert.doesNotMatch(ld, /[<>]/, path);
  }
});

test("no host: no canonical and no JSON-LD (a preview before the domain is known)", () => {
  const html = render("/", { host: "", noindex: true, previewBar: PREVIEW, base: "/c/s1" });
  assert.doesNotMatch(html, /rel="canonical"|application\/ld\+json/);
});

test("siteData: DemoData with demo null and the live fields", () => {
  const d = data({ chat: true });
  assert.equal(d.demo, null);
  assert.equal(d.template, "generic");
  assert.equal(d.business.name, "Smith Roofing");
  assert.equal(d.business.town, "Swindon");
  assert.equal(d.rating, 4.9);
  assert.equal(d.review_count, 23);
  for (const k of ["form_action", "canonical_url", "page", "nav", "footer", "map_query", "ld", "chat", "noindex", "preview_bar", "base", "photo_sizes"]) {
    assert.ok(Object.hasOwn(d.live, k), k);
  }
  assert.equal(d.live.form_action, "/s/contact");
  assert.equal(d.live.page.path, "/");
  assert.equal(d.live.chat, true);
  assert.deepEqual(d.live.nav.map((n) => n.label), ["Home", "Services", "Areas", "About", "Reviews", "Contact"]);
  assert.deepEqual(Object.keys(d.live.footer).sort(), ["legal_line", "nap", "privacy_href", "review_url"]);
  assert.equal(d.live.footer.privacy_href, "/privacy");
  assert.deepEqual(d.live.photo_sizes["/s/f/a1b2c3d4e5f60718293a4b5c6d7e8f90"], { w: 1200, h: 900 });
  // Preview: no form action, chat off, the bar text kept.
  const p = data({ previewBar: PREVIEW, base: "/c/s1", chat: true });
  assert.equal(p.live.form_action, "");
  assert.equal(p.live.chat, false);
  assert.equal(p.live.preview_bar, PREVIEW);
  assert.equal(p.live.footer.privacy_href, "/c/s1/privacy");
  assert.throws(() => siteData(null, OPTS), /SiteContent/);
});

test("logo: its real proportions from the content or the site's file, 52 px high", () => {
  const c = fx();
  c.theme.logo_w = 300;
  c.theme.logo_h = 100;
  assert.match(render("/", {}, c), /<img class="logo" src="https:\/\/smithroofing\.co\.uk\/images\/logo\.png" alt="Smith Roofing logo" width="156" height="52" loading="lazy"/);
  // A very wide logo is held to 200 px wide (the CSS max-width).
  c.theme.logo_w = 1000;
  assert.match(render("/", {}, c), /alt="Smith Roofing logo" width="200" height="52"/);
  const f = fx();
  f.theme.logo = "/s/f/a1b2c3d4e5f60718293a4b5c6d7e8f90";
  assert.match(render("/", {}, f), /<img class="logo" src="\/s\/f\/a1b2c3d4e5f60718293a4b5c6d7e8f90" alt="Smith Roofing logo" width="69" height="52"/);
  // A logo that isn't https or one of their files: the name as the wordmark, no <img>.
  const bad = fx();
  bad.theme.logo = "http://smithroofing.co.uk/logo.png";
  const html = render("/", {}, bad);
  assert.doesNotMatch(html, /class="logo"/);
  assert.match(html, /<a class="home" href="\/"><span class="wordmark">Smith Roofing<\/span><\/a>/);
});

test("preview in the landscaper look: the bar, links under the base, the note, no form and no chat", () => {
  const c = fx();
  c.business.trade = "landscaper";
  for (const p of c.pages) {
    const html = render(p.path, { previewBar: PREVIEW, base: "/c/s1", noindex: true, chat: true }, c);
    assert.match(html, /<body data-template="landscaper"/, p.path);
    assert.ok(html.includes('<div class="ae-bar">'), p.path);
    for (const href of hrefsOf(html).filter((x) => x.startsWith("/") && !x.startsWith("/#") && !x.startsWith("/s/f/"))) {
      assert.ok(href.startsWith("/c/s1/"), `${p.path}: link ${href}`);
    }
    assert.doesNotMatch(html, /<form|chat\.js/, p.path);
    if (["home", "service", "area", "contact"].includes(p.key)) assert.ok(html.includes("Works once the site is live."), p.path);
  }
});
