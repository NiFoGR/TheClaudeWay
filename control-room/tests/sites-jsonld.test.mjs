// LocalBusiness JSON-LD for client sites (09-build.md Part A §7, Part B Task 3): the business node on every page, a
// Service + FAQPage on service pages, an FAQPage on area pages, a BreadcrumbList on every page but home. Never
// aggregateRating, review or priceRange (self-serving for LocalBusiness; this stage shows no prices). Uses the valid
// Smith Roofing fixture from Task 2. Run: node --test control-room/tests/sites-jsonld.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ldJson, pageLd, schemaType, toE164UK } from "../functions/_lib/sites/jsonld.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const fx = () => structuredClone(FX);
const HOST = "www.smithroofing.co.uk";
const MAPS = "https://maps.google.com/?cid=1234567890";
const OPTS = { host: HOST, mapsUrl: MAPS };
const ID = "https://www.smithroofing.co.uk/#business";
const page = (c, path) => c.pages.find((p) => p.path === path);
const ld = (c, path, opts = OPTS) => pageLd(c, page(c, path), opts);
const ofType = (nodes, type) => nodes.filter((n) => n["@type"] === type);
const business = (nodes) => nodes.find((n) => n["@id"] === ID);

// Every key anywhere in a JSON value, however deep.
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), allKeys(x, out));
  return out;
}

test("schemaType maps trades to schema.org types", () => {
  assert.equal(schemaType("roofer"), "RoofingContractor");
  assert.equal(schemaType("heating engineer"), "HVACBusiness");
  assert.equal(schemaType("landscaper"), "HomeAndConstructionBusiness");
  assert.equal(schemaType("kickboxing gym"), "ExerciseGym");
  assert.equal(schemaType("florist"), "LocalBusiness");
  // the rest of section 7's list
  assert.equal(schemaType("Plumber"), "Plumber");
  assert.equal(schemaType("gas engineer"), "HVACBusiness");
  assert.equal(schemaType("boiler repair"), "HVACBusiness");
  assert.equal(schemaType("electrician"), "Electrician");
  assert.equal(schemaType("locksmith"), "Locksmith");
  assert.equal(schemaType("removals"), "MovingCompany");
  assert.equal(schemaType("mechanic"), "AutoRepair");
  assert.equal(schemaType("garage"), "AutoRepair");
  assert.equal(schemaType("independent car dealer"), "AutoDealer");
  assert.equal(schemaType("car sales"), "AutoDealer");
  assert.equal(schemaType("gardener"), "HomeAndConstructionBusiness");
  assert.equal(schemaType("fencing"), "HomeAndConstructionBusiness");
  assert.equal(schemaType("paving"), "HomeAndConstructionBusiness");
  assert.equal(schemaType("boxing gym"), "ExerciseGym");
  assert.equal(schemaType("martial arts gym"), "ExerciseGym");
  assert.equal(schemaType("muay thai"), "ExerciseGym");
  assert.equal(schemaType("MMA"), "ExerciseGym");
  assert.equal(schemaType(""), "LocalBusiness");
  assert.equal(schemaType(undefined), "LocalBusiness");
});

test("toE164UK", () => {
  assert.equal(toE164UK("01793 123456"), "+441793123456");
  assert.equal(toE164UK("07700 900123"), "+447700900123");
  assert.equal(toE164UK("+44 (0)1793 123456"), "+441793123456");
  assert.equal(toE164UK("123"), null);
  assert.equal(toE164UK("+44 7700 900123"), "+447700900123");
  assert.equal(toE164UK("0044 1793 123456"), "+441793123456");
  assert.equal(toE164UK("(01793) 123-456"), "+441793123456");
  assert.equal(toE164UK("0800 123 4567"), "+448001234567");
  assert.equal(toE164UK("077009001234"), null); // a mobile with a digit too many
  assert.equal(toE164UK("+33 1 23 45 67 89"), null); // not a UK number
  assert.equal(toE164UK("01793 12345x"), null);
  assert.equal(toE164UK(""), null);
  assert.equal(toE164UK(null), null);
});

test("home page: business node with town-only address when show_address is false", () => {
  const c = fx();
  assert.equal(c.business.show_address, false);
  const nodes = ld(c, "/");
  const b = business(nodes);
  assert.ok(b, "business node");
  assert.equal(b["@id"], ID);
  assert.equal(b["@context"], "https://schema.org");
  assert.equal(b["@type"], "RoofingContractor");
  assert.equal(b.name, "Smith Roofing");
  assert.equal(b.url, "https://www.smithroofing.co.uk/");
  assert.equal(b.telephone, "+441793123456");
  assert.equal(b.email, "info@smithroofing.co.uk");
  assert.deepEqual(b.address, { "@type": "PostalAddress", addressLocality: "Swindon", addressCountry: "GB" });
  assert.deepEqual(Object.keys(b.address).filter((k) => k !== "@type").sort(), ["addressCountry", "addressLocality"]);
  assert.deepEqual(b.areaServed, [
    { "@type": "City", name: "Swindon" },
    { "@type": "City", name: "Wroughton" },
    { "@type": "City", name: "Old Town" },
  ]);
  assert.deepEqual(b.sameAs, [MAPS, "https://www.facebook.com/smithroofing"]);
  assert.equal(b.hasMap, MAPS);
  assert.equal(b.logo, "https://smithroofing.co.uk/images/logo.png");
  assert.equal(b.image, "https://smithroofing.co.uk/images/slate-roof.jpg");
  // home: just the business node, no breadcrumb
  assert.equal(nodes.length, 1);
  assert.equal(ofType(nodes, "BreadcrumbList").length, 0);
  // the street and postcode never appear when the address is hidden
  const json = JSON.stringify(nodes);
  assert.doesNotMatch(json, /12 High St|SN1 1AA/);
});

test("full PostalAddress when show_address is true", () => {
  const c = fx();
  c.business.show_address = true;
  const b = business(ld(c, "/"));
  assert.deepEqual(b.address, {
    "@type": "PostalAddress",
    streetAddress: "12 High St",
    addressLocality: "Swindon",
    postalCode: "SN1 1AA",
    addressCountry: "GB",
  });
});

test("no aggregateRating, review or priceRange keys anywhere", () => {
  const c = fx();
  for (const p of c.pages) {
    const keys = allKeys(ld(c, p.path));
    for (const bad of ["aggregateRating", "review", "reviews", "priceRange"]) assert.ok(!keys.has(bad), `${p.path} ${bad}`);
  }
});

test("service page: Service with provider @id, FAQPage with every question, breadcrumb", () => {
  const c = fx();
  const p = page(c, "/services/roof-repairs");
  const nodes = ld(c, p.path);
  assert.ok(business(nodes));
  const [svc] = ofType(nodes, "Service");
  assert.ok(svc, "Service node");
  assert.equal(svc.serviceType, "Roof repairs");
  assert.equal(svc.provider["@id"], ID);
  assert.equal(svc.provider["@id"], business(nodes)["@id"]);
  assert.ok(Array.isArray(svc.areaServed) && svc.areaServed.length >= 1);
  const [faq] = ofType(nodes, "FAQPage");
  assert.ok(faq, "FAQPage node");
  assert.equal(faq.mainEntity.length, p.faq.length);
  assert.deepEqual(faq.mainEntity[0], {
    "@type": "Question",
    name: p.faq[0].q,
    acceptedAnswer: { "@type": "Answer", text: p.faq[0].a },
  });
  const [bc] = ofType(nodes, "BreadcrumbList");
  assert.deepEqual(
    bc.itemListElement.map((i) => [i["@type"], i.position, i.name, i.item]),
    [
      ["ListItem", 1, "Home", "https://www.smithroofing.co.uk/"],
      ["ListItem", 2, "Services", "https://www.smithroofing.co.uk/services"],
      ["ListItem", 3, "Roof repairs", "https://www.smithroofing.co.uk/services/roof-repairs"],
    ],
  );
});

test("area page: FAQPage and a 3-item breadcrumb, no Service", () => {
  const c = fx();
  const p = page(c, "/areas/old-town");
  const nodes = ld(c, p.path);
  const [faq] = ofType(nodes, "FAQPage");
  assert.ok(faq, "FAQPage node");
  assert.equal(faq.mainEntity.length, p.faq.length);
  assert.equal(ofType(nodes, "Service").length, 0);
  const [bc] = ofType(nodes, "BreadcrumbList");
  assert.deepEqual(bc.itemListElement.map((i) => i.name), ["Home", "Areas", "Old Town"]);
});

test("every non-home page has a BreadcrumbList with 2 or 3 items; top-level pages have 2", () => {
  const c = fx();
  for (const p of c.pages.filter((x) => x.key !== "home")) {
    const bcs = ofType(ld(c, p.path), "BreadcrumbList");
    assert.equal(bcs.length, 1, p.path);
    const n = bcs[0].itemListElement.length;
    assert.ok(n === 2 || n === 3, `${p.path} has ${n} items`);
    assert.equal(n, p.key === "service" || p.key === "area" ? 3 : 2, p.path);
    assert.equal(bcs[0].itemListElement.at(-1).item, `https://www.smithroofing.co.uk${p.path}`);
  }
  const about = ofType(ld(c, "/about"), "BreadcrumbList")[0];
  assert.deepEqual(about.itemListElement.map((i) => i.name), ["Home", "About"]);
});

test("pages other than service/area have no FAQPage or Service", () => {
  const c = fx();
  for (const path of ["/", "/services", "/areas", "/about", "/reviews", "/contact"]) {
    const nodes = ld(c, path);
    assert.equal(ofType(nodes, "FAQPage").length, 0, path);
    assert.equal(ofType(nodes, "Service").length, 0, path);
  }
});

test("JSON.stringify of every node round-trips, and every node has @context", () => {
  const c = fx();
  for (const p of c.pages) {
    for (const node of ld(c, p.path)) {
      assert.deepEqual(JSON.parse(JSON.stringify(node)), node);
      assert.equal(node["@context"], "https://schema.org");
    }
  }
});

test("relative /s/f/ URLs are made absolute on the host; extra areas join areaServed", () => {
  const c = fx();
  c.theme.logo = "/s/f/0123456789abcdef0123456789abcdef";
  c.photos[0].url = "/s/f/a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const b = business(pageLd(c, page(c, "/"), { ...OPTS, areas: ["Swindon", "Highworth", "wroughton"] }));
  assert.equal(b.logo, "https://www.smithroofing.co.uk/s/f/0123456789abcdef0123456789abcdef");
  assert.equal(b.image, "https://www.smithroofing.co.uk/s/f/a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.deepEqual(b.areaServed.map((a) => a.name), ["Swindon", "Wroughton", "Old Town", "Highworth"]);
});

test("missing bits are left out, not written empty", () => {
  const c = fx();
  c.business.phone = "123";
  c.business.email = "";
  c.business.socials = ["javascript:alert(1)", "not a url"];
  c.photos = [];
  delete c.theme.logo;
  const b = business(pageLd(c, page(c, "/"), { host: HOST }));
  for (const k of ["telephone", "email", "image", "logo", "sameAs", "hasMap"]) assert.ok(!(k in b), k);
  // a maps URL that isn't https is ignored too
  const b2 = business(pageLd(c, page(c, "/"), { host: HOST, mapsUrl: "javascript:alert(1)" }));
  assert.ok(!("hasMap" in b2) && !("sameAs" in b2));
});

test("host is normalised (upper case, trailing dot) for @id and urls", () => {
  const c = fx();
  const b = business(pageLd(c, page(c, "/"), { host: "WWW.SmithRoofing.co.uk.", mapsUrl: MAPS }));
  assert.equal(b["@id"], ID);
  assert.equal(b.url, "https://www.smithroofing.co.uk/");
});

test("schemaType reads Google-style trade words and falls back to the primary category", () => {
  assert.equal(schemaType("car_dealer"), "AutoDealer");
  assert.equal(schemaType("car-sales"), "AutoDealer");
  assert.equal(schemaType("roofing_contractor"), "RoofingContractor");
  const c = fx();
  c.business.trade = "";
  assert.equal(business(ld(c, "/"))["@type"], "RoofingContractor"); // primary_category "Roofing contractor"
  c.business.trade = "florist";
  assert.equal(business(ld(c, "/"))["@type"], "LocalBusiness"); // the trade wins when there is one
});

test("odd logo/photo paths are dropped, not made into URLs", () => {
  const c = fx();
  c.theme.logo = "//evil.example/logo.png";
  c.photos = [{ url: '/s/f/x"<script>', alt: "x", w: 1, h: 1 }];
  const b = business(ld(c, "/"));
  assert.ok(!("logo" in b) && !("image" in b));
});

test("ldJson: nothing in the text can close the script tag; it parses back to the same nodes", () => {
  const c = fx();
  const p = page(c, "/services/roof-repairs");
  p.faq[0].a = "Fine </script><script>alert(1)</script> & <!-- \u2028 done";
  const nodes = pageLd(c, p, OPTS);
  const text = ldJson(nodes);
  assert.doesNotMatch(text, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(text), nodes);
  assert.equal(JSON.parse(text).find((n) => n["@type"] === "FAQPage").mainEntity[0].acceptedAnswer.text, p.faq[0].a);
});
