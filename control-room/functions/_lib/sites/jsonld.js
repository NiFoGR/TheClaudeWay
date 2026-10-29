// LocalBusiness JSON-LD for client sites (stage 10, pure; 09-build.md Part A §7, Part B Task 3). The renderer puts
// pageLd(...) in the page's one <script type="application/ld+json">. Every page carries the business node; service
// pages add a Service and an FAQPage, area pages an FAQPage, every page but home a BreadcrumbList. Never
// aggregateRating or review (Google treats them as self-serving for LocalBusiness) and never priceRange (this stage
// shows no prices). Empty fields are left out rather than written empty, so validator.schema.org shows no warnings.
// Tested in control-room/tests/sites-jsonld.test.mjs.
import { normaliseHost } from "./hosts.js";

const CONTEXT = "https://schema.org";

// Section 7's trade → schema.org type list, first match wins (so "car dealer" never reads as a garage).
const TYPES = [
  [/roof/, "RoofingContractor"],
  [/plumb/, "Plumber"],
  [/heat|gas|boiler/, "HVACBusiness"],
  [/electric/, "Electrician"],
  [/locksmith/, "Locksmith"],
  [/removal/, "MovingCompany"],
  [/mechanic|garage/, "AutoRepair"],
  [/car dealer|car sales/, "AutoDealer"],
  [/landscap|garden|fenc|paving/, "HomeAndConstructionBusiness"],
  [/gym|boxing|martial|kickbox|muay|mma/, "ExerciseGym"],
];

/** The schema.org type for a trade ("roofer" → "RoofingContractor"); "LocalBusiness" for anything else. */
export function schemaType(trade) {
  const t = String(trade ?? "").toLowerCase().replace(/[_-]+/g, " "); // "car_dealer" / "car-dealer" read as "car dealer"
  for (const [re, type] of TYPES) if (re.test(t)) return type;
  return "LocalBusiness";
}

// The national number after the 0, by its first digit: mobiles (7) and 02/03/05/09 numbers have 10 digits; 01 and 08
// numbers may have 9 (e.g. 016977 xxxx, 0800 xxxxxx). 0, 4 and 6 never start a UK number.
const NSN = /^(?:[1-9]\d{9}|[18]\d{8})$/;

/**
 * A UK phone number as E.164 ("01793 123456", "+44 (0)1793 123456", "0044 1793 123456" → "+441793123456"); null when
 * it isn't one (too short or long, letters, another country).
 */
export function toE164UK(phone) {
  if (typeof phone !== "string") return null;
  let s = phone.trim().replace(/\(0\)/g, "").replace(/[\s().-]/g, "");
  if (s.startsWith("+44")) s = s.slice(3);
  else if (s.startsWith("0044")) s = s.slice(4);
  else if (s.startsWith("0") && !s.startsWith("00")) s = s.slice(1);
  else return null;
  if (s.startsWith("0")) s = s.slice(1); // "+44 01793 …" written without the brackets
  if (!NSN.test(s) || /^[046]/.test(s)) return null;
  if (s.startsWith("7") && s.length !== 10) return null;
  return `+44${s}`;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const httpsUrl = (v) => (/^https:\/\/[^\s"<>]+$/i.test(str(v)) ? str(v) : "");

// An address the page can use: an https URL as it is, a path on the site ("/s/f/<id>") made absolute; "" otherwise.
function absUrl(v, origin) {
  const s = str(v);
  if (/^\/(?![/\\])[^\s"<>\\]*$/.test(s)) return `${origin}${s}`;
  return httpsUrl(s);
}

// The towns they cover: their home town, each area page, then any extra areas (form areas beyond the 8 pages), once
// each (ignoring case), in that order.
function areasServed(content, extra) {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const n = str(name);
    if (!n || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    out.push({ "@type": "City", name: n });
  };
  add(content?.business?.address?.town);
  for (const p of content?.pages ?? []) if (p?.key === "area") add(p.name);
  for (const a of Array.isArray(extra) ? extra : []) add(a);
  return out;
}

function address(b) {
  const a = b?.address ?? {};
  const town = str(a.town);
  if (b?.show_address === true) {
    const full = { "@type": "PostalAddress" };
    if (str(a.street)) full.streetAddress = str(a.street);
    if (town) full.addressLocality = town;
    if (str(a.postcode)) full.postalCode = str(a.postcode);
    full.addressCountry = "GB";
    return full;
  }
  // Home-based: the town only, never the street or postcode.
  const short = { "@type": "PostalAddress" };
  if (town) short.addressLocality = town;
  short.addressCountry = "GB";
  return short;
}

function businessNode(content, origin, id, mapsUrl, areaServed) {
  const b = content?.business ?? {};
  // The trade picks the type; with no trade, the Google category Claude wrote ("Roofing contractor") does.
  const type = schemaType(str(b.trade) || content?.primary_category);
  const node = { "@context": CONTEXT, "@type": type, "@id": id, name: str(b.name), url: `${origin}/` };
  const tel = toE164UK(b.phone);
  if (tel) node.telephone = tel;
  if (str(b.email)) node.email = str(b.email);
  const logo = absUrl(content?.theme?.logo, origin);
  const photos = Array.isArray(content?.photos) ? content.photos : [];
  const image = absUrl(photos[0]?.url, origin) || logo;
  if (image) node.image = image;
  if (logo) node.logo = logo;
  node.address = address(b);
  if (areaServed.length) node.areaServed = areaServed;
  const socials = (Array.isArray(b.socials) ? b.socials : []).map(httpsUrl).filter(Boolean);
  const sameAs = [...new Set([mapsUrl, ...socials].filter(Boolean))];
  if (sameAs.length) node.sameAs = sameAs;
  if (mapsUrl) node.hasMap = mapsUrl;
  return node;
}

function faqNode(page) {
  const faq = (Array.isArray(page?.faq) ? page.faq : []).filter((f) => str(f?.q) && str(f?.a));
  if (!faq.length) return null;
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: str(f.q), acceptedAnswer: { "@type": "Answer", text: str(f.a) } })),
  };
}

// The nav's words for the top-level pages; service and area pages use their own name.
const LABELS = { home: "Home", services: "Services", areas: "Areas", about: "About", reviews: "Reviews", contact: "Contact" };
const PARENT = { service: ["Services", "/services"], area: ["Areas", "/areas"] };

function breadcrumbNode(page, origin) {
  const crumbs = [["Home", "/"]];
  if (PARENT[page.key]) crumbs.push(PARENT[page.key]);
  const name = LABELS[page.key] || str(page.name) || str(page.h1) || str(page.title) || page.path;
  crumbs.push([name, page.path]);
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map(([n, path], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: n,
      item: path === "/" ? `${origin}/` : `${origin}${path}`,
    })),
  };
}

/**
 * The JSON-LD nodes for one page of a client site (each with its own @context, so the array is valid JSON-LD as it
 * is). `host` is the canonical host (www.<domain>); `mapsUrl` is the lead's Google Maps URL (sameAs + hasMap, https
 * only); `areas` (optional) are extra towns from the form that have no page of their own (section 15), added to
 * areaServed after the home town and the area pages.
 */
export function pageLd(content, page, { host, mapsUrl, areas } = {}) {
  const origin = `https://${normaliseHost(host)}`;
  const id = `${origin}/#business`;
  const maps = httpsUrl(mapsUrl);
  const served = areasServed(content, areas);
  const nodes = [businessNode(content, origin, id, maps, served)];
  if (!page || page.key === "home" || page.path === "/") return nodes;
  if (page.key === "service") {
    const svc = { "@context": CONTEXT, "@type": "Service", serviceType: str(page.name), name: str(page.name) };
    svc.provider = { "@id": id };
    if (served.length) svc.areaServed = served;
    svc.url = `${origin}${page.path}`;
    nodes.push(svc);
  }
  if (page.key === "service" || page.key === "area") {
    const faq = faqNode(page);
    if (faq) nodes.push(faq);
  }
  nodes.push(breadcrumbNode(page, origin));
  return nodes;
}

/**
 * The nodes as the text of the page's one <script type="application/ld+json">: JSON with "<", ">", "&" and the line
 * separators U+2028/U+2029 written as \u escapes, so no text inside (Claude-written or scraped) can close the script
 * tag or open a comment. JSON.parse gives back exactly the same nodes.
 */
export function ldJson(nodes) {
  return JSON.stringify(nodes).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
