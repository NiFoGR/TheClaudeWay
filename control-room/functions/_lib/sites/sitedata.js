// A client's site as the template engine reads it (stage 10, docs/rebuild/09-build.md Part A §7, Part B Task 4).
// siteData(content, opts) maps a SiteContent v1 document (client_sites.content, already checked by validateContent)
// into stage 4's DemoData with `demo: null` and `live` extended (Cross-stage interfaces), so
// renderSite(siteData(...), {mode: "live", page: "/services/roof-repairs"}) draws any page of the site.
//
// Every page is prepared here (its JSON-LD from pageLd and its canonical URL), and renderSite picks the one asked for
// by path; `live.page` / `live.ld` / `live.canonical_url` start as the home page's. Text is cleaned (control and bidi
// characters out) but never clipped: the validator has already held it to the limits. Escaping happens when it is
// printed (h()). Photo and logo URLs must be https or one of this site's files (/s/f/<32 hex>), and every one gets a
// width and height (from the content, else from `files`, the client's site_files rows). The rating and review count
// come from the lead row at render time. Pure. Tested in control-room/tests/sites-render.test.mjs.
import { pickColour } from "../demo/colour.js";
import { templateIdFor } from "../demo/data.js";
import { cleanText, safeHttps, shortAuthor, telHref } from "../demo/text.js";
import { cleanBase, hrefFor } from "./body.js";
import { normaliseHost } from "./hosts.js";
import { pageLd } from "./jsonld.js";

// The nav (section 7): every page of the site has these six.
export const NAV = Object.freeze([
  ["Home", "/"], ["Services", "/services"], ["Areas", "/areas"], ["About", "/about"], ["Reviews", "/reviews"], ["Contact", "/contact"],
]);

const FILE_URL = /^\/s\/f\/([0-9a-f]{32})$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PAGE_PATH = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?)?$/;
const PAGE_KEYS = new Set(["home", "service", "area", "services", "areas", "about", "reviews", "contact"]);
const DECIMAL = /^\s*\d+(?:\.\d+)?\s*$/;
const NO_AUTHOR = /^google reviewer$/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => cleanText(typeof v === "string" ? v : "");
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && DECIMAL.test(v) ? Number(v) : NaN);
const size = (v) => (Number.isSafeInteger(v) && v > 0 && v <= 20000 ? v : 0);

/** An image URL the site may print: https, or one of this client's copied files. "" otherwise. */
export function imageUrl(u) {
  const s = typeof u === "string" ? u.trim() : "";
  return FILE_URL.test(s) ? s : safeHttps(s);
}

// Google rating (1 decimal) and review count from the lead row, only when both are real (data.js's rule).
function ratingOf(lead) {
  const rating = Math.round(num(lead?.rating) * 10) / 10;
  const count = num(lead?.review_count);
  return rating >= 1 && rating <= 5 && Number.isSafeInteger(count) && count > 0
    ? { rating, review_count: count } : { rating: null, review_count: null };
}

// The client's site_files rows by id: {w, h, alt}.
function filesById(files) {
  const out = new Map();
  for (const f of list(files)) {
    if (!isObj(f)) continue;
    const id = typeof f.id === "string" ? f.id : FILE_URL.exec(String(f.url ?? ""))?.[1];
    if (id) out.set(id, { w: size(f.width ?? f.w), h: size(f.height ?? f.h), alt: text(f.alt) });
  }
  return out;
}

// One page of the content, cleaned: the fields the templates print, nothing else.
function pageOf(p) {
  const out = {
    key: p.key,
    path: p.path,
    name: text(p.name),
    title: text(p.title),
    meta: text(p.meta),
    h1: text(p.h1),
    intro: text(p.intro),
    sections: list(p.sections).filter(isObj).map((s) => ({ h2: text(s.h2), body: typeof s.body === "string" ? s.body : "" })),
    faq: list(p.faq).filter((f) => isObj(f) && text(f.q) && text(f.a)).map((f) => ({ q: text(f.q), a: text(f.a) })),
    photo: Number.isSafeInteger(p.photo) && p.photo >= 0 ? p.photo : null,
  };
  return out;
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * DemoData for one client site. `content` is the parsed SiteContent; opts:
 * - `lead`: the lead row (rating, review_count, maps_url, trade); may be null.
 * - `host`: the canonical host (www.<domain>); without one there is no canonical link and no JSON-LD (a preview
 *   before the domain is known).
 * - `base`: the path prefix the pages are served under ("" on their host, "/c/<slug>" preview, "/w/<slug>" temporary
 *   link); every internal link, the privacy link and the form action start with it.
 * - `reviewUrl`: the Google write-a-review link (footer, reviews page), https only.
 * - `chat`: the chat widget is on (never in a preview). `noindex`: add robots noindex.
 * - `previewBar`: Nik's preview bar text; when set, the contact form and chat become "Works once the site is live."
 * - `files`: the client's site_files rows ({id, width, height, alt}), for sizes the content lacks.
 * - `form` (optional): the onboarding form, so services and areas without a page of their own (more than 12 / 8) are
 *   still listed on /services and /areas and in JSON-LD areaServed (section 15).
 */
export function siteData(content, opts = {}) {
  if (!isObj(content) || !isObj(content.business) || !Array.isArray(content.pages)) {
    throw new TypeError("siteData needs a site's SiteContent (client_sites.content, parsed).");
  }
  const { lead = null, host = "", base = "", reviewUrl = "", chat = false, noindex = false, previewBar = "", files = [], form = null } = opts ?? {};
  const b = content.business;
  const addr = isObj(b.address) ? b.address : {};
  const prefix = cleanBase(base);
  const bar = text(previewBar);
  const preview = Boolean(bar);
  const canonicalHost = normaliseHost(typeof host === "string" ? host : "");
  const origin = HOST.test(canonicalHost) ? `https://${canonicalHost}` : "";

  const template = templateIdFor(text(b.trade) || text(lead?.trade));
  const name = text(b.name);
  const phone = text(b.phone);
  const town = text(addr.town);
  const showAddress = b.show_address === true;
  const address = showAddress
    ? [text(addr.street), [town, text(addr.postcode)].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : town;

  // Photos keep their content index (pages[].photo points into it); one that can't be printed is null.
  const byId = filesById(files);
  const photo_sizes = {};
  const sizeFor = (url, w, hgt) => {
    const file = byId.get(FILE_URL.exec(url)?.[1]);
    const out = { w: size(w) || file?.w || 0, h: size(hgt) || file?.h || 0 };
    if (out.w && out.h) photo_sizes[url] = out;
    return file;
  };
  const photos = list(content.photos).map((ph) => {
    const url = isObj(ph) ? imageUrl(ph.url) : "";
    if (!url) return null;
    const file = sizeFor(url, ph.w, ph.h);
    return { url, alt: text(ph.alt) || file?.alt || `Work by ${name}` };
  });
  const theme = isObj(content.theme) ? content.theme : {};
  const logo = imageUrl(theme.logo);
  if (logo) sizeFor(logo, theme.logo_w, theme.logo_h);

  const pages = content.pages
    .filter((p) => isObj(p) && PAGE_KEYS.has(p.key) && typeof p.path === "string" && PAGE_PATH.test(p.path))
    .map(pageOf);
  const formAreas = list(form?.areas).map(text).filter(Boolean);
  for (const p of pages) {
    p.canonical_url = origin ? (p.path === "/" ? `${origin}/` : `${origin}${p.path}`) : "";
    p.ld = origin ? pageLd(content, p, { host: canonicalHost, mapsUrl: lead?.maps_url, areas: formAreas }) : [];
  }
  const home = pages.find((p) => p.key === "home") ?? pages[0];
  if (!home) throw new TypeError("siteData needs a site's SiteContent with its pages (client_sites.content, parsed).");

  const servicePages = pages.filter((p) => p.key === "service");
  const areaPages = pages.filter((p) => p.key === "area");
  const ticked = list(form?.services).filter((s) => isObj(s) && s.on === true).map((s) => text(s.name)).filter(Boolean);
  const moreServices = ticked.filter((s, i) => !servicePages.some((p) => sameName(p.name, s)) && ticked.findIndex((x) => sameName(x, s)) === i);
  const moreAreas = formAreas.filter((a, i) => !sameName(a, town) && !areaPages.some((p) => sameName(p.name, a))
    && formAreas.findIndex((x) => sameName(x, a)) === i);

  const reviews = list(content.reviews)
    .filter((r) => isObj(r) && typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5 && text(r.text))
    .map((r) => ({ author: NO_AUTHOR.test(text(r.author)) || !text(r.author) ? "Google reviewer" : shortAuthor(text(r.author)), rating: r.rating, text: text(r.text) }));

  const { colour, source } = pickColour(theme.main, template);
  const { rating, review_count } = ratingOf(lead);

  return {
    template,
    business: {
      name, trade: text(b.trade), phone, phone_href: telHref(phone), town,
      areas: [town, ...areaPages.map((p) => p.name), ...moreAreas].filter(Boolean),
      services: [...servicePages.map((p) => p.name), ...moreServices],
    },
    brand: { logo, colour, colour_source: source, photos: [...new Set(photos.filter(Boolean).map((p) => p.url))] },
    reviews,
    rating,
    review_count,
    copy: { headline: home.h1, intro: home.intro, about: "" },
    guarantee: null,
    offer: null,
    demo: null,
    live: {
      form_action: preview ? "" : `${prefix}/s/contact`,
      canonical_url: home.canonical_url,
      page: home,
      pages,
      nav: NAV.map(([label, path]) => ({ label, path, href: hrefFor(prefix, path) })),
      footer: {
        nap: { name, phone, address, email: text(b.email), hours: text(b.hours) },
        legal_line: text(b.legal_line),
        review_url: safeHttps(reviewUrl),
        privacy_href: hrefFor(prefix, "/privacy"),
      },
      map_query: showAddress && text(addr.street) ? [name, address].filter(Boolean).join(", ") : town,
      ld: home.ld,
      chat: Boolean(chat) && !preview,
      noindex: Boolean(noindex),
      preview_bar: bar,
      base: prefix,
      photo_sizes,
      photos,
      logo_href: hrefFor(prefix, "/"),
      services: servicePages.map((p) => ({ name: p.name, href: hrefFor(prefix, p.path) })),
      areas: areaPages.map((p) => ({ name: p.name, href: hrefFor(prefix, p.path) })),
      more: { services: moreServices, areas: moreAreas },
    },
  };
}
