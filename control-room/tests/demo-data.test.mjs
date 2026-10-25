// DemoData (pure): a lead and its research turned into exactly what a demo template prints, from their real data only
// (docs/rebuild/05-demo.md Part A §3–§5, Task 4). Run: node --test control-room/tests/demo-data.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildDemoData, templateIdFor } from "../functions/_lib/demo/data.js";
import { GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { LEADS, NASTY, nastyLead } from "./fixtures/demo-fixtures.mjs";

const OFFER = { weekend: false, full: { freeDays: 60 } };
const DEMO = { slug: "green-leaf-landscapes-7k2p9q" };
const NOW = new Date("2026-10-21T10:00:00Z"); // a Wednesday
const SAT = new Date("2026-10-24T10:00:00Z");

const build = (lead, o = {}) => buildDemoData({ lead, research: lead.research, demo: DEMO, offer: OFFER, now: NOW, ...o });
// LEADS.full with its audit or its copy changed.
const withAudit = (audit) => ({ ...LEADS.full, audit });
const withCopy = (copy) => ({ ...LEADS.full.research, copy });
const fullAudit = LEADS.full.audit;
// Every string inside a value.
const stringsIn = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(stringsIn) : []);
const INVISIBLE = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

test("spec: DemoData from the full lead, the bare lead and the fallbacks", () => {
  const d = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: { slug: "green-leaf-landscapes-7k2p9q" }, offer: { weekend: false, full: { freeDays: 60 } }, now: new Date("2026-10-21T10:00:00Z") });
  assert.equal(d.template, "landscaper");
  assert.equal(d.business.name, "Green Leaf Landscapes");
  assert.deepEqual(d.business.services, LEADS.full.research.copy.services.slice(0, 8));
  assert.equal(d.demo.order_url, "/d/green-leaf-landscapes-7k2p9q/order");
  assert.ok(d.reviews.every((r) => r.rating >= 4) && d.reviews.length <= 3);
  assert.equal(d.reviews[0].author, "Sarah K.");
  assert.equal(d.offer.free_days, 60);
  assert.equal(d.guarantee, GUARANTEE);                       // the one from ../functions/_lib/offer.js
  assert.equal(buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: DEMO, offer: offerFor(new Date("2026-10-24T10:00:00Z")) }).offer.free_days, 90);   // Saturday
  const bare = buildDemoData({ lead: LEADS.bare, research: null, offer: { weekend: true, full: { freeDays: 90 } }, now: new Date("2026-10-24T10:00:00Z"), demo: { slug: "x-abcdef" } });
  assert.deepEqual(bare.business.services, []);
  assert.equal(bare.copy.headline, bare.business.name);     // no copy.headline and no town → the business name
  assert.equal(bare.rating, null);
  const noCopy = buildDemoData({ lead: LEADS.full, research: { ...LEADS.full.research, copy: null }, offer: OFFER, demo: DEMO });
  assert.equal(noCopy.copy.headline, "Landscaping in Warrington");   // "<Trade> in <Town>"
  assert.deepEqual(buildDemoData({ lead: LEADS.httpPhotos, research: LEADS.httpPhotos.research, offer: OFFER, demo: DEMO }).brand.photos, []);
  assert.equal(buildDemoData({ lead: { ...LEADS.full, rating: 4.8, review_count: 0 }, research: LEADS.full.research, offer: OFFER, demo: DEMO }).rating, null);
  assert.equal(templateIdFor("Kickboxing"), "generic");
  assert.equal(templateIdFor("Garden maintenance"), "landscaper");
});

test("the full lead's DemoData, field for field, in the contract's shape", () => {
  const d = build(LEADS.full);
  const GL = "https://greenleaf-landscapes.example/img";
  assert.deepEqual(d, {
    template: "landscaper",
    business: {
      name: "Green Leaf Landscapes", trade: "Landscaping", phone: "07969 770905", phone_href: "07969770905",
      town: "Warrington", areas: LEADS.full.research.copy.areas, services: LEADS.full.research.copy.services,
    },
    brand: {
      logo: `${GL}/logo.png`, colour: "#2e7d32", colour_source: "theirs",
      photos: [`${GL}/patio.jpg`, `${GL}/lawn.jpg`, `${GL}/fence.jpg`, `${GL}/deck.jpg`, `${GL}/border.jpg`, `${GL}/path.jpg`],
    },
    reviews: [
      { author: "Sarah K.", rating: 5, text: fullAudit.reviews[5].text },
      { author: "Tom H.", rating: 5, text: fullAudit.reviews[4].text },
      { author: "Google reviewer", rating: 4, text: fullAudit.reviews[6].text },
    ],
    rating: 4.8, review_count: 37,
    copy: { headline: LEADS.full.research.copy.headline, intro: LEADS.full.research.copy.intro, about: LEADS.full.research.copy.about },
    guarantee: GUARANTEE,
    offer: { weekend: false, free_days: 60 },
    demo: { slug: "green-leaf-landscapes-7k2p9q", order_url: "/d/green-leaf-landscapes-7k2p9q/order", count_views: true },
    live: null,
  });
  assert.deepEqual(Object.keys(d), ["template", "business", "brand", "reviews", "rating", "review_count", "copy", "guarantee", "offer", "demo", "live"]);
  assert.deepEqual(Object.keys(d.business), ["name", "trade", "phone", "phone_href", "town", "areas", "services"]);
  assert.deepEqual(Object.keys(d.brand), ["logo", "colour", "colour_source", "photos"]);
  assert.deepEqual(Object.keys(d.copy), ["headline", "intro", "about"]);
});

test("JSON text and objects read the same; unreadable JSON counts as missing", () => {
  const asText = {
    lead: { ...LEADS.full, audit: JSON.stringify(fullAudit) },
    research: { ...LEADS.full.research, copy: JSON.stringify(LEADS.full.research.copy) },
  };
  assert.deepEqual(buildDemoData({ ...asText, demo: DEMO, offer: OFFER }), build(LEADS.full));
  // the brand inside the audit as JSON text too
  assert.deepEqual(build(withAudit({ ...fullAudit, brand: JSON.stringify(fullAudit.brand) })).brand, build(LEADS.full).brand);
  // an already-parsed research row (parseResearch's shape) works as well
  assert.deepEqual(build(LEADS.full, { research: { ...LEADS.full.research, owner: JSON.parse(LEADS.full.research.owner) } }), build(LEADS.full));
  for (const bad of ["{not json", "", null, "null", "[1,2]", "42", '"text"']) {
    const d = build(withAudit(bad), { research: withCopy(bad) });
    assert.deepEqual(d.brand, { logo: "", colour: "#2f6b3a", colour_source: "trade", photos: [] }, String(bad));
    assert.deepEqual(d.reviews, []);
    assert.deepEqual([d.business.services, d.business.areas], [[], []]);
    assert.deepEqual(d.copy, { headline: "Landscaping in Warrington", intro: "", about: "" });
  }
});

test("reviews: only a real 4–5 star rating and 8+ words; the 3 longest; first name + initial; clipped at 320", () => {
  // full: an unrated one, a 3-star, a rating sent as text and a 3-word one are dropped although most are longer.
  assert.deepEqual(build(LEADS.full).reviews.map((r) => r.author), ["Sarah K.", "Tom H.", "Google reviewer"]);
  // plumber: exactly 8 words is kept, 7 isn't, 2 stars isn't
  assert.deepEqual(build(LEADS.plumber).reviews, [{ author: "Asha P.", rating: 4, text: "Fixed our leaking pipe quickly and explained everything." }]);
  // electrician: 4 qualify, the 3 longest are kept, each cut at a word to at most 320 characters with "…"
  const long = build(LEADS.electrician).reviews;
  assert.deepEqual(long.map((r) => r.author), ["Natalie B.", "Dev M.", "Claire H."]);
  for (const r of long) {
    assert.ok(r.text.length <= 320 && r.text.endsWith("…"), r.text);
    assert.ok(!/[^\S ]|  /.test(r.text), "line breaks and runs of spaces collapsed");
  }
  assert.ok(audit(LEADS.electrician).reviews[1].text.replace(/\s+/g, " ").startsWith(long[1].text.slice(0, -1)));
  // the rating is the review's own number, never defaulted; edge ratings
  const one = (r) => build(withAudit({ reviews: [{ author: "Amy Lee", text: "one two three four five six seven eight", ...r }] })).reviews;
  assert.deepEqual(one({ rating: 4 }), [{ author: "Amy L.", rating: 4, text: "one two three four five six seven eight" }]);
  assert.equal(one({ rating: 4.5 })[0].rating, 4.5);
  for (const rating of [undefined, null, 3.9, 6, NaN, Infinity, "5", true, [5]]) assert.deepEqual(one({ rating }), [], String(rating));
  // text must be text; whitespace-only words don't count; authors: idempotent, "Google reviewer" when missing
  assert.deepEqual(one({ rating: 5, text: 12345678 }), []);
  assert.deepEqual(one({ rating: 5, text: "one two three four   \n\n five six seven" }), []);
  assert.equal(one({ rating: 5, author: "Sarah K." })[0].author, "Sarah K.");
  assert.equal(one({ rating: 5, author: null })[0].author, "Google reviewer");
  // what the lead manager's brand.top_reviews stores (names already shortened, "Google reviewer" for no name) stays
  // as it is: never "Google R.", as if someone called Google had written it
  assert.equal(one({ rating: 5, author: "Google reviewer" })[0].author, "Google reviewer");
  assert.equal(one({ rating: 5, author: " google  REVIEWER " })[0].author, "Google reviewer");
  assert.equal(one({ rating: 5, author: "Priya" })[0].author, "Priya");
  assert.equal(one({ rating: 5, author: { name: "x" } })[0].author, "Google reviewer");
  // not a list, or junk items → none
  for (const reviews of [null, "x", {}, [null, 5, "text"]]) assert.deepEqual(build(withAudit({ reviews })).reviews, []);
  // at most 3, ties keep Google's order
  const same = Array.from({ length: 5 }, (_, i) => ({ author: `R${i} X`, rating: 5, text: "one two three four five six seven eight" }));
  assert.deepEqual(build(withAudit({ reviews: same })).reviews.map((r) => r.author), ["R0 X.", "R1 X.", "R2 X."]);
});

test("photos and logo: https only, the logo not repeated, no duplicates, at most 6; never stock photos", () => {
  const brand = (b) => build(withAudit({ brand: b })).brand;
  const u = (i) => `https://ex.example/p${i}.jpg`;
  assert.deepEqual(brand({ logo: u(0), photos: [u(0), u(1), u(1), "", null, 7, "http://ex.example/x.jpg", "//ex.example/y.jpg", u(2)] }).photos, [u(1), u(2)]);
  assert.deepEqual(brand({ photos: [1, 2, 3, 4, 5, 6, 7, 8].map(u) }).photos, [1, 2, 3, 4, 5, 6].map(u));
  assert.deepEqual(brand({ photos: [" " + u(1) + " "] }).photos, [u(1)]);              // trimmed like safeHttps does
  assert.equal(brand({ logo: "http://ex.example/logo.png" }).logo, "");
  assert.equal(brand({ logo: 'https://ex.example/l.png" onerror="x' }).logo, "");
  assert.deepEqual(brand({ photos: "https://ex.example/p1.jpg" }).photos, []);             // not a list
  assert.deepEqual(build(LEADS.noPhotos).brand.photos, []);
  assert.deepEqual(build(LEADS.bare).brand, { logo: "", colour: "#2f6b3a", colour_source: "trade", photos: [] });
});

test("colour: theirs, a darker shade of it, Charcoal when too pale, the trade's default when missing or hostile", () => {
  assert.deepEqual(pick(LEADS.full), ["#2e7d32", "theirs"]);
  assert.deepEqual(pick(LEADS.paleColour), ["#1a1c20", "charcoal"]);
  assert.deepEqual(pick(LEADS.roofer), ["#1a78c2", "darkened"]);
  assert.deepEqual(pick(LEADS.httpPhotos), ["#2f6b3a", "trade"]);                        // landscaper default
  assert.deepEqual(pick({ ...LEADS.roofer, audit: {} }), ["#1a1c20", "trade"]);          // generic default
  assert.deepEqual(pick(withAudit({ brand: { colour: "red;}body{display:none" } })), ["#2f6b3a", "trade"]);
  assert.deepEqual(pick(withAudit({ brand: { colour: "#2E7D32" } })), ["#2e7d32", "theirs"]);
  for (const l of Object.values(LEADS)) assert.match(build(l).brand.colour, /^#[0-9a-f]{6}$/);
});
function pick(lead) {
  const { colour, colour_source } = build(lead).brand;
  return [colour, colour_source];
}
function audit(lead) {
  return typeof lead.audit === "string" ? JSON.parse(lead.audit) : lead.audit;
}

test("rating and review count: shown only when both are above 0, rating to 1 decimal", () => {
  const rc = (rating, review_count) => {
    const d = build({ ...LEADS.full, rating, review_count });
    return [d.rating, d.review_count];
  };
  assert.deepEqual(rc(4.8, 37), [4.8, 37]);
  assert.deepEqual(rc(4.83, 37), [4.8, 37]);
  assert.deepEqual(rc(5, 3), [5, 3]);
  assert.deepEqual(rc("4.6", "12"), [4.6, 12]);                // D1 text still counts
  assert.deepEqual(rc(4.8, 0), [null, null]);
  assert.deepEqual(rc(0, 37), [null, null]);
  assert.deepEqual(rc(null, 37), [null, null]);
  assert.deepEqual(rc(4.8, null), [null, null]);
  assert.deepEqual(rc(6, 10), [null, null]);                   // not a Google rating
  assert.deepEqual(rc(4.8, 2.5), [null, null]);                // not a count
  assert.deepEqual(rc("", ""), [null, null]);
  assert.deepEqual(rc(true, true), [null, null]);
  // the rating as shown must be a real Google one (1 to 5): 0.04 would read "0 ★"
  assert.deepEqual(rc(0.04, 37), [null, null]);
  assert.deepEqual(rc(0.5, 37), [null, null]);
  assert.deepEqual(rc(1, 2), [1, 2]);
  // text only as plain decimals: hex, exponents and Infinity aren't D1 numbers
  assert.deepEqual(rc(4.8, "0x25"), [null, null]);
  assert.deepEqual(rc("4.8", "1e1"), [null, null]);
  assert.deepEqual(rc("Infinity", 37), [null, null]);
  assert.deepEqual(rc(4.8, -3), [null, null]);
  assert.deepEqual(rc(4.8, 2 ** 60), [null, null]);
  const bare = build(LEADS.bare);
  assert.deepEqual([bare.rating, bare.review_count], [null, null]);
});

test("copy: clipped to Part A's lengths at a word, empty and repeated items dropped, at most 8 services and 12 areas", () => {
  const words = (n, w = "word") => Array.from({ length: n }, () => w).join(" ");
  const d = build(LEADS.full, {
    research: withCopy({
      headline: words(30), intro: words(80), about: words(150),
      services: ["", "  ", 42, null, words(15), "Decking", "decking", ...Array.from({ length: 10 }, (_, i) => `Service ${i}`)],
      areas: [words(10), ...Array.from({ length: 15 }, (_, i) => `Area ${i}`)],
    }),
  });
  assert.ok(d.copy.headline.length <= 90 && d.copy.headline.endsWith("word…"));
  assert.ok(d.copy.intro.length <= 300 && d.copy.intro.endsWith("…"));
  assert.ok(d.copy.about.length <= 700 && d.copy.about.endsWith("…"));
  assert.equal(d.business.services.length, 8);
  assert.ok(d.business.services[0].length <= 60 && d.business.services[0].endsWith("…"));
  assert.deepEqual(d.business.services.slice(1), ["Decking", "Service 0", "Service 1", "Service 2", "Service 3", "Service 4", "Service 5"]);
  assert.equal(d.business.areas.length, 12);
  assert.ok(d.business.areas[0].length <= 40 && d.business.areas[0].endsWith("…"));
  assert.equal(d.business.areas[11], "Area 10");
  // copy that isn't text or a list → left out
  const odd = build(LEADS.full, { research: withCopy({ headline: 5, intro: ["x"], about: { a: 1 }, services: "Decking", areas: { x: "y" } }) });
  assert.deepEqual([odd.copy.intro, odd.copy.about, odd.business.services, odd.business.areas], ["", "", [], []]);
  assert.equal(odd.copy.headline, "Landscaping in Warrington");
  // whitespace collapsed, invisible characters removed
  assert.equal(build(LEADS.full, { research: withCopy({ headline: "  Patios\n\nin \u202EWarrington\u0007 " }) }).copy.headline, "Patios in Warrington");
});

test("services: only theirs; none means [] (the template shows its placeholder), never a trade's default list", () => {
  for (const copy of [null, {}, { services: [] }]) assert.deepEqual(build(LEADS.full, { research: withCopy(copy) }).business.services, []);
  assert.deepEqual(build(LEADS.full, { research: null }).business.services, []);
  assert.deepEqual(build(LEADS.bare).business.services, []);
  assert.deepEqual(build(LEADS.bare).business.areas, []);
  // the generic and landscaper templates get the same: no invented services for any trade
  for (const trade of ["plumber", "roofer", "kickboxing gym", "locksmith", "landscaper"]) {
    assert.deepEqual(build({ ...LEADS.full, trade }, { research: null }).business.services, [], trade);
  }
});

test("headline: theirs, else '<Trade> in <Town>', else the name; Landscaper(s) reads Landscaping", () => {
  const headline = (lead, copy = null) => build(lead, { research: copy === null ? null : withCopy(copy) }).copy.headline;
  assert.equal(headline(LEADS.plumber, JSON.parse(LEADS.plumber.research.copy)), "Plumber in Manchester");   // "" headline, searched town
  assert.equal(headline({ ...LEADS.full, trade: "Landscapers" }), "Landscaping in Warrington");
  assert.equal(headline({ ...LEADS.full, trade: "LANDSCAPER" }), "Landscaping in Warrington");
  assert.equal(headline(LEADS.paleColour), "Landscaping in St Helens");
  assert.equal(headline({ ...LEADS.full, trade: "heating engineer", town: "Leeds" }), "Heating Engineer in Leeds");
  assert.equal(headline({ ...LEADS.full, trade: "garden maintenance" }), "Garden Maintenance in Warrington");
  // abbreviations as people write them ("hvac" is one of the scraper's trades), never "Hvac"
  assert.equal(headline({ ...LEADS.full, trade: "hvac" }), "HVAC in Warrington");
  assert.equal(headline({ ...LEADS.full, trade: "EV charger installer" }), "EV Charger Installer in Warrington");
  assert.equal(headline({ ...LEADS.full, trade: "upvc windows" }), "uPVC Windows in Warrington");
  assert.equal(headline({ ...LEADS.full, trade: "constructor" }), "Constructor in Warrington");   // not Object's own keys
  assert.equal(headline({ ...LEADS.full, town: null, search_town: "Lymm" }), "Landscaping in Lymm");
  assert.equal(headline({ ...LEADS.full, town: "  ", search_town: "Lymm" }), "Landscaping in Lymm");
  assert.equal(headline({ ...LEADS.full, town: null, search_town: "" }), "Green Leaf Landscapes");
  assert.equal(headline({ ...LEADS.full, trade: "" }), "Green Leaf Landscapes");
  assert.equal(headline(LEADS.full, { headline: "   " }), "Landscaping in Warrington");
  assert.equal(headline(LEADS.locksmith), "Locksmith in Stockport");
  // an 80-character name with no town stays whole (≤ 90); never empty
  assert.equal(headline({ ...LEADS.locksmith, town: null, search_town: "" }), LEADS.locksmith.name);
  assert.ok(headline({ ...LEADS.full, name: "", trade: "", town: null, search_town: "" }).length > 0);
  const long = headline({ ...LEADS.locksmith, trade: "emergency locksmiths and home security specialists for homes, shops and offices" });
  assert.ok(long.length <= 90 && long.endsWith("…") && long.startsWith("Emergency Locksmiths And Home Security"), long);
  // the business's town is shown as they're known by: town, else the searched town
  assert.equal(build({ ...LEADS.full, town: null, search_town: "Lymm" }).business.town, "Lymm");
  assert.equal(build(LEADS.bare).business.town, "");
});

test("business name and trade: shortName of their Google name, title-cased trade", () => {
  assert.equal(build(LEADS.kickboxing).business.name, "Diamond Kickboxing Academy");
  assert.equal(build(LEADS.roofer).business.name, "Smith & Sons Roofing");
  assert.equal(build(LEADS.plumber).business.name, "Flowright Plumbing & Heating");
  assert.equal(build(LEADS.locksmith).business.name, LEADS.locksmith.name);
  assert.equal(build(LEADS.locksmith).business.name.length, 80);
  assert.equal(build({ ...LEADS.full, name: "Green\u202E Leaf\u0000  Landscapes LTD" }).business.name, "Green Leaf Landscapes");
  assert.deepEqual(Object.values(LEADS).map((l) => build(l).business.trade),
    ["Landscaping", "Garden Maintenance", "Landscaping", "Landscaping", "Landscaping", "Kickboxing Gym", "Roofer", "Plumber", "Locksmith", "Electrician"]);
});

test("the street address, postcode and email addresses never reach the page data", () => {
  for (const lead of Object.values(LEADS)) {
    const s = JSON.stringify(build(lead));
    for (const secret of ["Example Road", "WA1 1AA", "@", "greenleaf-landscapes.example/contact"]) assert.ok(!s.includes(secret), `${lead.place_id}: ${secret}`);
  }
});

test("phone: as Google gives it; tap-to-call only with 10–13 digits", () => {
  const ph = (phone) => {
    const b = build({ ...LEADS.full, phone }).business;
    return [b.phone, b.phone_href];
  };
  assert.deepEqual(ph("07969 770905"), ["07969 770905", "07969770905"]);
  assert.deepEqual(ph("+44 7969 770905"), ["+44 7969 770905", "+447969770905"]);
  assert.deepEqual(ph("0161 496 07"), ["0161 496 07", ""]);           // shown, not dialable
  assert.deepEqual(ph("  01204\u00A0496077 "), ["01204 496077", "01204496077"]);
  assert.deepEqual(ph(null), ["", ""]);
  assert.deepEqual(ph(7969770905), ["", ""]);                          // not text: not from Google
  assert.deepEqual(ph("<b>0800</b>"), ["<b>0800</b>", ""]);             // escaping is the template's job (h())
  assert.deepEqual([build(LEADS.plumber).business.phone_href, build(LEADS.roofer).business.phone_href], ["", "+441632960077"]);
});

test("demo: count_views defaults to true, false is kept, null without a demo; a bad slug is refused", () => {
  assert.equal(build(LEADS.full).demo.count_views, true);
  assert.deepEqual(build(LEADS.full, { demo: { slug: "a-b-7k2p9q", count_views: false } }).demo,
    { slug: "a-b-7k2p9q", order_url: "/d/a-b-7k2p9q/order", count_views: false });
  assert.equal(build(LEADS.full, { demo: { ...DEMO, expires_at: "2027-04-19T10:00:00Z", place_id: "fx-full" } }).demo.count_views, true);
  assert.equal(build(LEADS.full, { demo: null }).demo, null);
  assert.equal(buildDemoData({ lead: LEADS.full, research: LEADS.full.research, offer: OFFER }).demo, null);
  for (const slug of ["", "ab", "../etc", "Green-Leaf", "a b c", 'x"><script>', "a".repeat(61), null, 42]) {
    assert.throws(() => build(LEADS.full, { demo: { slug } }), /slug/, String(slug));
  }
});

test("live: null unless given; only an https URL or a path on their own site for the form, https for canonical", () => {
  assert.equal(build(LEADS.full).live, null);
  const live = (l) => build(LEADS.full, { demo: null, live: l }).live;
  assert.deepEqual(live({ form_action: "https://forms.example/x", canonical_url: "https://www.greenleaf.example/" }),
    { form_action: "https://forms.example/x", canonical_url: "https://www.greenleaf.example/" });
  assert.deepEqual(live({ form_action: "/c/s1/s/contact", canonical_url: "" }), { form_action: "/c/s1/s/contact", canonical_url: "" });
  assert.deepEqual(live({}), { form_action: "", canonical_url: "" });
  for (const bad of ["javascript:alert(1)", "//evil.example/x", "/\\evil.example", 'https://x.co/" onerror="x', "http://forms.example/x", "/a b", "/a\u202Eb"]) {
    assert.deepEqual(live({ form_action: bad, canonical_url: bad }), { form_action: "", canonical_url: "" }, bad);
  }
});

test("offer: weekday 60 free days, the weekend deal on Saturday, offerFor(now) when none is given", () => {
  assert.deepEqual(build(LEADS.full).offer, { weekend: false, free_days: 60 });
  assert.deepEqual(build(LEADS.full, { offer: offerFor(SAT) }).offer, { weekend: true, free_days: 90 });
  assert.deepEqual(build(LEADS.full, { offer: offerFor(NOW) }).offer, { weekend: false, free_days: offerFor(NOW).full.freeDays });
  assert.deepEqual(build(LEADS.full, { offer: undefined, now: SAT }).offer, { weekend: true, free_days: offerFor(SAT).full.freeDays });
  assert.deepEqual(build(LEADS.full, { offer: undefined, now: NOW }).offer, { weekend: false, free_days: 60 });
  // an offer that can't be read is replaced by the real one for `now`, never half-used
  for (const bad of [null, {}, { weekend: true }, { weekend: "yes", full: { freeDays: 90 } }, { weekend: false, full: { freeDays: "60" } }]) {
    assert.deepEqual(build(LEADS.full, { offer: bad, now: SAT }).offer, { weekend: true, free_days: 90 }, JSON.stringify(bad));
  }
  assert.equal(build(LEADS.full).guarantee, GUARANTEE);
});

test("every fixture builds and covers the cases Part A lists", () => {
  const all = Object.entries(LEADS);
  assert.equal(all.length, 10);
  assert.deepEqual(all.map(([, l]) => templateIdFor(l.trade)),
    ["landscaper", "landscaper", "landscaper", "landscaper", "landscaper", "generic", "generic", "generic", "generic", "generic"]);
  for (const [key, lead] of all) {
    assert.ok(["A+", "A", "B"].includes(lead.research.grade) && lead.research.status === "done" && lead.research.best_email, key);
    assert.equal(lead.research.place_id, lead.place_id, key);
    const d = build(lead);
    assert.ok(d.copy.headline, key);
    assert.ok(d.reviews.length <= 3 && d.reviews.every((r) => r.rating >= 4 && r.rating <= 5), key);
    assert.ok(d.brand.photos.length <= 6 && d.brand.photos.every((p) => p.startsWith("https://")), key);
    assert.ok(stringsIn(d).every((s) => !INVISIBLE.test(s.replace(/[\n\t\r]/g, ""))), key);
  }
  const d = Object.fromEntries(all.map(([k, l]) => [k, build(l)]));
  assert.ok(d.full.brand.photos.length === 6 && d.full.brand.logo && d.full.reviews.length === 3 && d.full.rating);
  assert.ok(d.noPhotos.brand.photos.length === 0 && d.noPhotos.brand.logo);
  assert.ok(d.httpPhotos.brand.photos.length === 0 && !d.httpPhotos.brand.logo);
  assert.equal(audit(LEADS.httpPhotos).brand.photos.length, 3);
  assert.equal(d.paleColour.brand.colour_source, "charcoal");
  assert.equal(audit(LEADS.paleColour).brand.colour, "#a0ffff");
  assert.equal(d.paleColour.brand.photos.length, 2);
  assert.deepEqual([d.bare.business.phone, d.bare.business.town, d.bare.reviews, d.bare.rating, d.bare.brand.logo, d.bare.copy.intro, d.bare.copy.about],
    ["", "", [], null, "", "", ""]);
  assert.equal(LEADS.bare.research.copy, null);
  assert.equal(LEADS.locksmith.name.length, 80);
  assert.ok(audit(LEADS.electrician).reviews.every((r) => r.text.length > 320));
  assert.equal(d.electrician.reviews.length, 3);
  // both JSON text and objects are among the fixtures
  assert.ok(all.some(([, l]) => typeof l.audit === "string") && all.some(([, l]) => l.audit && typeof l.audit === "object"));
  assert.ok(all.some(([, l]) => typeof l.research.copy === "string") && typeof LEADS.full.research.copy === "object");
});

test("fixtures are frozen and buildDemoData hands back new lists, so no test can change another's data", () => {
  assert.ok(Object.isFrozen(LEADS) && Object.isFrozen(LEADS.full.audit.brand.photos) && Object.isFrozen(NASTY));
  assert.throws(() => { LEADS.full.research.copy.services.push("x"); }, TypeError);
  const d = build(LEADS.full);
  assert.notEqual(d.business.services, LEADS.full.research.copy.services);
  assert.notEqual(d.business.areas, LEADS.full.research.copy.areas);
  d.business.services.push("changed");
  d.reviews.length = 0;
  assert.equal(build(LEADS.full).business.services.length, 8);
  assert.equal(build(LEADS.full).reviews.length, 3);
});

test("NASTY: the 12 hostile strings, exactly", () => {
  assert.deepEqual(NASTY, [
    "<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "</style><script>x()</script>", "javascript:alert(1)",
    "' onmouseover='x", "{{7*7}}", "\u202Eevil", "red;}body{display:none", 'https://x.co/a.jpg" onerror="x', "<!--", "]]>",
    "&amp;lt;",
  ]);
  assert.equal(NASTY[6].codePointAt(0), 0x202e);                     // a real right-to-left override character
  assert.equal(NASTY[6].length, 5);
});

test("NASTY everywhere: no URL, colour or invisible character gets through; the text stays (escaped later by h())", () => {
  for (const n of NASTY) {
    const lead = nastyLead(n);
    const d = buildDemoData({ lead, research: lead.research, demo: DEMO, offer: OFFER, now: NOW, live: { form_action: n, canonical_url: n } });
    assert.equal(d.brand.logo, "", n);
    assert.deepEqual(d.brand.photos, [], n);
    assert.match(d.brand.colour, /^#[0-9a-f]{6}$/, n);
    assert.equal(d.brand.colour_source, "trade", n);
    assert.equal(d.business.phone_href, "", n);
    assert.deepEqual(d.live, { form_action: "", canonical_url: "" }, n);
    assert.equal(d.template, "generic", n);
    assert.ok(stringsIn(d).every((s) => !INVISIBLE.test(s)), n);
    assert.equal(d.reviews.length, 1, n);                             // the review is kept, so templates render it
    assert.ok(d.business.services.length >= 1 && d.business.areas.length >= 1 && d.copy.intro && d.copy.about, n);
  }
  const bidi = nastyLead(NASTY[6]);
  assert.equal(build(bidi).business.name, "evil");
});

test("templateIdFor: the landscaper look for /landscap|garden|lawn|turf|paving|patio|fenc/i, every other trade generic", () => {
  for (const t of ["landscaper", "Landscapers", "LANDSCAPE GARDENER", "Garden maintenance", "gardener", "lawn care", "Turfing",
    "block paving", "Patio installer", "fencing contractor", "Fence installer"]) assert.equal(templateIdFor(t), "landscaper", t);
  for (const t of ["Kickboxing", "roofer", "plumber", "electrician", "locksmith", "driving school", "", null, undefined, 42, {}]) {
    assert.equal(templateIdFor(t), "generic", String(t));
  }
  // the same answer however often it is asked (no stateful regex)
  assert.deepEqual([1, 2, 3].map(() => templateIdFor("landscaper")), ["landscaper", "landscaper", "landscaper"]);
});

test("buildDemoData needs a lead row", () => {
  for (const lead of [undefined, null, "fx-full", []]) assert.throws(() => buildDemoData({ lead, offer: OFFER }), /lead/);
});

test("data.js runs on Workers: no node: imports, no offer or guarantee wording of its own, nothing done at load", () => {
  const src = readFileSync(new URL("../functions/_lib/demo/data.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:|require\(/);
  assert.doesNotMatch(src, /GUARANTEED|work for FREE|(freeDays|free_days)\s*:\s*\d|\bmonthly plan\b/);
  assert.doesNotMatch(src, /from\s+["']\.\.\/demo\.js["']/);          // never the old demo.js (its isWeekendUK copy)
  // the only top-level statements are imports, constants and functions
  const top = src.split("\n").filter((line) => /^\S/.test(line) && !/^(\/\/|\/\*|\*| \*|\}|\)|import |export (function|const) |function |const )/.test(line));
  assert.deepEqual(top, []);
  // no raw bidi characters in the source (they make code read differently from what it does): \u escapes only
  for (const f of ["../functions/_lib/demo/data.js", "./fixtures/demo-fixtures.mjs", "./demo-data.test.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /[\u202A-\u202E\u2066-\u2069]/, f);
  }
});
