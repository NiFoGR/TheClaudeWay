// The site content validator (09-build.md Part A §5, Part B Task 2): what the build Routine posts is checked against
// the client's form, their Google reviews and their photos before it is stored, so nothing on the site is invented.
// Each test mutates a deep copy of the valid Smith Roofing fixture (11 pages: home, 3 services, Wroughton and Old Town,
// services, areas, about, reviews, contact). Run: node --test control-room/tests/sites-content.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LIMITS, formFacts, pagePaths, parseBody, validateContent, wordCount } from "../functions/_lib/sites/content.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const CTX = JSON.parse(readFileSync(new URL("./fixtures/site-ctx.json", import.meta.url), "utf8"));
const fx = () => structuredClone(FX);
const ctx = () => structuredClone(CTX);
const errs = (c, x = ctx()) => validateContent(c, x).errors.join("\n");
const page = (c, path) => c.pages.find((p) => p.path === path);
// The fixture with a paragraph added to the first section of the Roof repairs page.
const withBody = (text) => {
  const c = fx();
  c.pages[1].sections[0].body += `\n\n${text}`;
  return c;
};
const setTitle = (t) => {
  const c = fx();
  c.pages[1].title = t;
  return c;
};
const setMeta = (m) => {
  const c = fx();
  c.pages[1].meta = m;
  return c;
};
const words = (n, w = "slate") => Array.from({ length: n }, () => w).join(" ");

test("valid fixture passes", () => assert.deepEqual(validateContent(fx(), ctx()).errors, []));

test("the valid fixture is ok and meets every limit with 11 pages", () => {
  const c = fx();
  assert.equal(validateContent(c, ctx()).ok, true);
  assert.equal(c.pages.length, 11);
  assert.deepEqual(pagePaths(c), ["/", "/services/roof-repairs", "/services/flat-roofs", "/services/chimney-repairs",
    "/areas/wroughton", "/areas/old-town", "/services", "/areas", "/about", "/reviews", "/contact"]);
  for (const p of c.pages) assert.ok(wordCount(p) >= LIMITS.words[p.key], `${p.path} has ${wordCount(p)} words`);
  assert.deepEqual(ctx().form.areas, ["Swindon", "Wroughton", "Old Town"]);
  assert.equal(ctx().package, "full");
});

test("LIMITS holds section 5's numbers", () => {
  assert.deepEqual(LIMITS.title, { min: 30, max: 120 });
  assert.deepEqual(LIMITS.meta, { min: 70, max: 155 });
  assert.deepEqual(LIMITS.h1, { min: 10, max: 70 });
  assert.deepEqual(LIMITS.words, { home: 400, service: 600, area: 400, about: 200, services: 150, areas: 150, contact: 60, reviews: 0 });
  assert.deepEqual(LIMITS.faq, { service: [3, 6], area: [2, 4], home: [0, 6] });
  assert.deepEqual(LIMITS.pages, { service: 12, area: 8 });
  assert.equal(LIMITS.links, 10);
  assert.equal(LIMITS.dupShare, 0.2);
  assert.equal(LIMITS.reviews, 12);
  assert.equal(LIMITS.photos, 12);
  assert.equal(LIMITS.redirects, 50);
  assert.equal(LIMITS.bytes, 600000);
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(LIMITS.title));
  assert.deepEqual(JSON.parse(JSON.stringify(LIMITS)), LIMITS); // the build GET sends it as JSON
});

test("invented review", () => {
  const c = fx();
  c.reviews[0].text = "Brilliant, 10/10";
  assert.match(validateContent(c, ctx()).errors.join("\n"), /reviews\[0\]: this review isn't one of their Google reviews/);
});

test("a real review under another author, or with whitespace changes only", () => {
  const c = fx();
  c.reviews[0].author = "Someone Else";
  assert.match(errs(c), /reviews\[0\]: this review isn't one of their Google reviews/);
  const d = fx();
  d.reviews[0].text = `  ${d.reviews[0].text.replace(/ /g, "  ")}\n`;
  assert.deepEqual(validateContent(d, ctx()).errors, []);
});

test("unsourced years claim", () => {
  const c = fx();
  c.pages[1].sections[0].body += "\n\nWe have 20 years' experience.";
  assert.match(errs(c), /needs a fact: "years"/);
});

test("a claim is allowed once a fact proves it", () => {
  const c = withBody("We have 20 years' experience.");
  c.facts.push({ text: "Roofing in Swindon for 20 years", source: "https://smithroofing.co.uk/about" });
  assert.deepEqual(validateContent(c, ctx()).errors, []);
  assert.match(errs(withBody("Fully insured for every job.")), /needs a fact: "insurance"/);
  assert.match(errs(withBody("Proud winners of a local award.")), /needs a fact: "award"/);
  assert.match(errs(withBody("We are TrustMark approved roofers.")), /needs a fact: "accreditation"/);
});

test("facts need a source", () => {
  const c = fx();
  c.facts[0].source = "http://smithroofing.co.uk/about";
  assert.match(errs(c), /facts\[0\]: source must be "form" or the https:\/\/ page it was seen on/);
});

test("price", () => assert.match(errs(withBody("From £250 a day.")), /no prices/));

test("prices in words and per hour", () => {
  assert.match(errs(withBody("It costs about 300 pounds.")), /no prices/);
  assert.match(errs(withBody("We charge by the job, never per hour.")), /no prices/);
});

test("the word SEO", () => assert.match(errs(withBody("Great SEO.")), /"SEO"/));

test("banned words in a review are refused too", () => {
  const c = fx();
  const x = ctx();
  x.reviews[0].text = "The cheapest roofer around and great work, would use again.";
  c.reviews[0].text = x.reviews[0].text;
  assert.match(errs(c, x), /reviews\[0\]: says "cheapest"/);
});

test("external link", () => assert.match(errs(withBody("[us](https://x.com)")), /only link to pages on this site/));

test("a link to a page that doesn't exist", () =>
  assert.match(errs(withBody("See [our blog](/blog).")), /links to "\/blog", which isn't a page on this site/));

test("title 121 chars", () => assert.match(errs(setTitle("x".repeat(121))), /title is 121 characters; the limit is 120/));

test("title too short and repeated", () => {
  assert.match(errs(setTitle("Roof repairs")), /title is 12 characters; it needs at least 30/);
  const c = fx();
  c.pages[2].title = c.pages[1].title;
  assert.match(errs(c), /service \/services\/flat-roofs: title is the same as service \/services\/roof-repairs's/);
});

test("meta 156 chars", () => assert.match(errs(setMeta("x".repeat(156))), /meta description is 156 characters; the limit is 155/));

test("home H1 without town", () => {
  const c = fx();
  c.pages[0].h1 = "Roofing contractor you can rely on";
  assert.match(errs(c), /home: H1 must name "Roofing contractor" and "Swindon"/);
});

test("home title must name the category and the town; service H1 the service", () => {
  const c = fx();
  c.pages[0].title = "Smith Roofing – Roof repairs, flat roofs and chimneys";
  c.pages[1].h1 = "Fixing leaks in Swindon";
  const e = errs(c);
  assert.match(e, /home: title must name "Roofing contractor" and "Swindon"/);
  assert.match(e, /service \/services\/roof-repairs: H1 must name "Roof repairs"/);
});

test("service page 412 words", () => {
  const c = fx();
  const p = c.pages[1];
  const rest = wordCount({ ...p, sections: [] });
  p.sections = [{ h2: "", body: words(412 - rest) }];
  assert.equal(wordCount(p), 412);
  assert.match(errs(c), /service \/services\/roof-repairs: body has 412 words; it needs at least 600/);
});

test("13 service pages", () => {
  const c = fx();
  for (let i = 0; i < 10; i++) c.pages.push({ ...structuredClone(c.pages[1]), path: `/services/extra-${i}`, name: `Extra ${i}` });
  assert.equal(c.pages.filter((p) => p.key === "service").length, 13);
  assert.match(errs(c), /at most 12 service pages/);
});

test("area not in the form's areas 2–9", () => {
  const c = fx();
  const p = page(c, "/areas/wroughton");
  p.name = "Bath";
  p.path = "/areas/bath";
  assert.match(errs(c), /area "Bath" isn't one of the areas in their form/);
});

test("the home town gets no area page", () => {
  const c = fx();
  const p = page(c, "/areas/old-town");
  p.name = "Swindon";
  assert.match(errs(c), /area "Swindon" isn't one of the areas in their form/);
});

test("form area 2 has no page", () => {
  const c = fx();
  c.pages = c.pages.filter((p) => p.path !== "/areas/wroughton");
  assert.match(errs(c), /area "Wroughton" from their form has no page/);
});

test("a service that isn't ticked, and service pages out of form order", () => {
  const c = fx();
  page(c, "/services/flat-roofs").name = "Guttering"; // unticked in the form
  assert.match(errs(c), /"Guttering" isn't a ticked service in their form/);
  const d = fx();
  [d.pages[1], d.pages[2]] = [d.pages[2], d.pages[1]];
  assert.match(errs(d), /service pages must follow the order of their form/);
});

test("page set: one of each, no other kinds, no /privacy", () => {
  const c = fx();
  c.pages = c.pages.filter((p) => p.key !== "about");
  c.pages.push({ key: "blog", path: "/blog" }, { key: "privacy", path: "/privacy" });
  const e = errs(c);
  assert.match(e, /there's no about page/);
  assert.match(e, /"blog" isn't a page type/);
  assert.match(e, /don't write \/privacy/);
  const d = fx();
  d.pages[1].path = "/services/Roof_Repairs";
  assert.match(errs(d), /service \/services\/Roof_Repairs: path must be \/services\/<slug>/);
});

test("service links only 1 area", () => {
  const c = fx();
  for (const s of c.pages[1].sections) s.body = s.body.replace(/\[([^\]]+)\]\(\/areas\/old-town\)/g, "$1");
  assert.match(errs(c), /service \/services\/roof-repairs: links to 1 area page; it must link 2–4 area pages/);
});

test("area pages link the services; home and contact link every area page", () => {
  const c = fx();
  for (const s of page(c, "/areas/wroughton").sections) s.body = s.body.replace(/\[([^\]]+)\]\(\/services\/flat-roofs\)/g, "$1");
  for (const s of page(c, "/contact").sections) s.body = s.body.replace(/\[([^\]]+)\]\(\/areas\/old-town\)/g, "$1");
  const e = errs(c);
  assert.match(e, /area \/areas\/wroughton: links to 2 service pages; it must link 3–6 service pages/);
  assert.match(e, /contact: doesn't link the area page \/areas\/old-town/);
});

test("11 links on a page", () => {
  const c = fx();
  const about = page(c, "/about"); // already links /reviews and /contact
  about.sections.push({ h2: "Get in touch", body: `${Array.from({ length: 9 }, () => "[call us](/contact)").join(" or ")}.` });
  assert.match(errs(c), /about: has 11 links; the limit is 10/);
});

test("area pages 30% the same sentences", () => {
  const c = fx();
  const shared = [
    "Old houses here often have slate roofs that need careful repair work.",
    "Many streets have parking limits, so we plan the scaffold delivery early.",
    "We tidy the site every evening and take every bit of waste away with us.",
  ];
  const own = [
    "Wroughton sits just south of the town on the edge of the downs.",
    "The village has a mix of cottages, council houses and newer estates.",
    "Wind from the downs hits ridge tiles hard during the winter months here.",
    "Chimneys on the older cottages are often the first thing that needs work.",
    "Flat roofs on garages and extensions are very common across the village.",
    "We can usually get to Wroughton within a short drive from the town centre.",
    "Ask us to look at the whole roof while we are up there for one job.",
  ];
  const w = page(c, "/areas/wroughton");
  w.intro = "";
  w.sections = [{ h2: "Roofs in Wroughton", body: [...own, ...shared].join(" ") }];
  w.faq = [{ q: "Do you cover Wroughton?", a: "Yes, often." }, { q: "Do you quote first?", a: "Yes, always." }];
  page(c, "/areas/old-town").sections.push({ h2: "Before we start", body: shared.join(" ") });
  assert.match(errs(c), /area \/areas\/wroughton: shares 30% of its sentences with \/areas\/old-town; the limit is 20%/);
});

test("Task 14's refusal: one bad home title gives exactly one line, no full stop", () => {
  const c = fx();
  c.pages[0].title = `${c.pages[0].title} and chimney repairs`.padEnd(121, "s");
  assert.deepEqual(validateContent(c, ctx()), { ok: false, errors: ["home: title is 121 characters; the limit is 120"] });
});

test("phone differs from form", () => {
  const c = fx();
  c.business.phone = "01793 999999";
  assert.match(errs(c), /business.phone must match the form/);
});

test("name and email match the form; spaces around them don't matter", () => {
  const c = fx();
  c.business.name = "Smith Roofing Ltd";
  c.business.email = "hello@smithroofing.co.uk";
  const e = errs(c);
  assert.match(e, /business.name must match the form/);
  assert.match(e, /business.email must match the form/);
  const d = fx();
  d.business.name = " Smith Roofing ";
  assert.deepEqual(validateContent(d, ctx()).errors, []);
});

test("street shown when show_address is no", () => {
  assert.match(errs(withBody("Find us at 12 High St in the town centre.")), /shows the street or postcode/);
  assert.match(errs(withBody("We are based in sn1 1aa.")), /shows the street or postcode/);
  const c = withBody("Find us at 12 High St in the town centre.");
  c.business.show_address = true;
  const x = ctx();
  x.form.business.show_address = "yes";
  assert.doesNotMatch(errs(c, x), /shows the street or postcode/);
});

test("photo URL not from their site", () => {
  const c = fx();
  c.photos[0].url = "https://stock.example.com/roof.jpg";
  assert.match(errs(c), /photos\[0\]: not one of their photos/);
  const d = fx();
  d.photos[0].url = "/s/f/0123456789abcdef0123456789abcdef"; // not one of this client's files
  assert.match(errs(d), /photos\[0\]: not one of their photos/);
});

test("redirect to a missing page", () => {
  const c = fx();
  c.redirects[0].to = "/x";
  assert.match(errs(c), /redirects\[0\]: "\/x" isn't a page/);
  const d = fx();
  d.redirects[0].from = "/about";
  assert.match(errs(d), /redirects\[0\]: "\/about" is a page on the new site/);
  const e = fx();
  e.redirects.push({ from: "/sitemap.xml", to: "/" }, { from: "/old-page/", to: "/" }, { from: "/roofing-services.html", to: "/" });
  const lines = errs(e);
  assert.match(lines, /redirects\[2\]: "\/sitemap.xml" is an address the site itself uses/);
  assert.match(lines, /redirects\[3\]: "\/old-page\/" ends with "\/"/);
  assert.match(lines, /redirects\[4\]: "\/roofing-services.html" is redirected twice/);
});

test("< in text", () => assert.match(errs(withBody("Call <b>now</b>.")), /no HTML/));

test("content over 600 KB", () => {
  const c = fx();
  c.pages[8].sections.push({ h2: "Notes", body: words(120000, "roof") });
  assert.match(errs(c), /The site content is \d+ KB; the limit is 600 KB/);
});

test("not an object", () => {
  assert.deepEqual(validateContent(null, ctx()), { ok: false, errors: ["The site content must be one JSON object (SiteContent version 1)"] });
});

test("parseBody: paragraphs, bullets and internal links", () => {
  assert.deepEqual(parseBody("Paragraph one\nstill one.\n\n- bullet\n- [Wroughton](/areas/wroughton) too\n\nLast [a link](/areas/old-town)."), [
    { type: "p", parts: [{ text: "Paragraph one still one." }] },
    { type: "ul", parts: [{ text: "bullet" }, { text: "Wroughton", href: "/areas/wroughton" }, { text: " too" }],
      items: [[{ text: "bullet" }], [{ text: "Wroughton", href: "/areas/wroughton" }, { text: " too" }]] },
    { type: "p", parts: [{ text: "Last " }, { text: "a link", href: "/areas/old-town" }, { text: "." }] },
  ]);
  assert.deepEqual(parseBody(""), []);
  assert.deepEqual(parseBody("<b>hi</b>"), [{ type: "p", parts: [{ text: "<b>hi</b>" }] }]); // escaped by the renderer
});

test("wordCount counts intro, sections and FAQ", () => {
  assert.equal(wordCount({ intro: "One two three.", sections: [{ h2: "Four five", body: "- six\n- [seven eight](/x)" }], faq: [{ q: "Nine?", a: "Ten." }] }), 10);
  assert.equal(wordCount({}), 0);
});

test("formFacts", () => assert.deepEqual(formFacts({ started: "2009", free_quotes: "yes", emergency: "no", hours: "", accreditations: "Gas Safe 123456", guarantee: "" }).map((f) => f.text),
  ["Started in 2009", "Gas Safe 123456", "Free quotes"]));

test("formFacts: every answer, all from the form", () => {
  const f = formFacts(ctx().form);
  assert.ok(f.every((x) => x.source === "form"));
  assert.deepEqual(formFacts({ started: "2009", accreditations: "NICEIC", guarantee: "10-year guarantee", free_quotes: "yes", emergency: "yes", hours: "Mon–Fri 8am–6pm" }).map((x) => x.text),
    ["Started in 2009", "NICEIC", "10-year guarantee", "Free quotes", "Emergency call-outs", "Opening hours: Mon–Fri 8am–6pm"]);
  assert.deepEqual(formFacts(null), []);
});

// Review fixes: truth checks the section 5 table implies (NAP in the copy, facts really from the form, years).
test("a years claim written in words needs a fact too", () => {
  assert.match(errs(withBody("We have over twenty years' experience on Swindon roofs.")), /needs a fact: "years"/);
  assert.match(errs(withBody("Two years ago the council changed the parking rules.")), /needs a fact: "years"/);
});

test("a year in the copy must be in a fact", () => {
  assert.match(errs(withBody("We have been fixing roofs here since 1995.")), /since 1995\." needs a fact: "1995"/);
  assert.deepEqual(validateContent(withBody("We have been fixing roofs here since 2009."), ctx()).errors, []); // "Started in 2009"
  assert.deepEqual(validateContent(withBody("Many houses here were built in the 1930s."), ctx()).errors, []);
  const x = ctx();
  x.form.business.phone = "020 2019 1234";
  const c = withBody("Call 020 2019 1234 for a free quote.");
  c.business.phone = "020 2019 1234";
  assert.doesNotMatch(errs(c, x), /needs a fact: "2019"/);
});

test("a fact from the form must be in the form", () => {
  const c = withBody("Fully insured for every job.");
  c.facts.push({ text: "Fully insured", source: "form" });
  assert.match(errs(c), /facts\[6\]: "Fully insured" isn't in their form/);
  const d = fx();
  d.facts.push({ text: "fixing roofs around Swindon since 2009", source: "form" }); // the form's About answer
  assert.deepEqual(validateContent(d, ctx()).errors, []);
});

test("phone numbers and emails in the copy are theirs", () => {
  assert.match(errs(withBody("Call John on 01793 123465 today.")), /says the phone number "01793 123465", but the number on their form is "01793 123456"/);
  assert.match(errs(withBody("Or try his mobile, 07700 900123.")), /says the phone number "07700 900123"/);
  assert.deepEqual(validateContent(withBody("From abroad, call +44 (0)1793 123456."), ctx()).errors, []);
  assert.match(errs(withBody("Email john.smith@gmail.com for a quote.")), /says the email "john.smith@gmail.com", but it isn't the email on their form/);
  assert.deepEqual(validateContent(withBody("Email INFO@smithroofing.co.uk for a quote."), ctx()).errors, []);
});

test("the legal line is the form's", () => {
  const c = fx();
  c.business.legal_line = "Smith Roofing Ltd";
  assert.match(errs(c), /business.legal_line must match the form \("John Smith trading as Smith Roofing"\)/);
});

test("the street in a photo's alt text when show_address is no", () => {
  const c = fx();
  c.photos[0].alt = "New slate roof at 12 High St, Swindon";
  assert.match(errs(c), /photos\[0\]: the alt text shows the street or postcode/);
});

test("the same review twice", () => {
  const c = fx();
  c.reviews.push(structuredClone(c.reviews[0]));
  assert.match(errs(c), /reviews\[3\]: this review is already on the site/);
});

test("an http:// photo of theirs can't be copied", () => {
  const c = fx();
  const x = ctx();
  x.brand.photos[0] = "http://smithroofing.co.uk/images/slate-roof.jpg";
  c.photos[0].url = x.brand.photos[0];
  assert.match(errs(c, x), /photos\[0\]: only https:\/\/ photos can be copied/);
});

test("links only in section bodies; redirects only from plain paths", () => {
  const c = fx();
  c.pages[0].intro += " See [Wroughton](/areas/wroughton).";
  assert.match(errs(c), /home: links can only go in a section's body/);
  const d = fx();
  d.redirects.push({ from: '/a"><b', to: "/" }, { from: "/index.php?page=about", to: "/about" });
  const e = errs(d);
  assert.match(e, /redirects\[2\]: from must be an old path/);
  assert.match(e, /redirects\[3\]: from must be an old path/);
});

test("a refusal lists at most 50 lines", () => {
  const c = fx();
  c.pages[8].sections.push({ h2: "Links", body: Array.from({ length: 80 }, (_, i) => `[x](/nope-${i})`).join(" ") });
  const { ok, errors } = validateContent(c, ctx());
  assert.equal(ok, false);
  assert.equal(errors.length, 50);
  assert.match(errors[49], /^…and \d+ more problems like these$/);
});
