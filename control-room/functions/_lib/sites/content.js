// Site content (stage 10, docs/rebuild/09-build.md Part A §5): the one JSON document (SiteContent v1) the build Routine
// writes for a paying client's site, and the checks every POST of it passes before it is stored. Pure: no D1, no
// fetch. Tested in control-room/tests/sites-content.test.mjs with tests/fixtures/site-content.json + site-ctx.json.
//
// Everything on the site must be true and say only what the client's form, their Google reviews or a page Claude
// opened proves. So the checker refuses invented reviews, unsourced claims ("20 years", "fully insured"), prices,
// HTML, links to other sites and copy pasted between area pages, and makes the name, phone and email match the form.
// Every problem is listed at once, each as one plain-English line naming the page, so Claude can fix them all in one
// retry. LIMITS is the only place the numbers live (the Routine reads them from GET /api/agent/build/:client_id).

/** Every number the checker uses (section 5). Read-only. */
export const LIMITS = deepFreeze({
  title: { min: 30, max: 120 },
  meta: { min: 70, max: 155 },
  h1: { min: 10, max: 70 },
  words: { home: 400, service: 600, area: 400, about: 200, services: 150, areas: 150, contact: 60, reviews: 0 },
  faq: { service: [3, 6], area: [2, 4], home: [0, 6] }, // any other page: no FAQs
  pages: { service: 12, area: 8 },
  links: 10,
  dupShare: 0.2,
  reviews: 12,
  photos: 12,
  redirects: 50,
  bytes: 600000,
  // Also section 5's table, kept here so nothing else hard-codes them.
  faqAnswer: 600, // characters per FAQ answer
  slug: 60, // characters in /services/<slug> and /areas/<slug>
  serviceAreaLinks: [2, 4], // area pages a service page links (all of them when there are fewer than 2)
  areaServiceLinks: [3, 6], // service pages an area page links (all of them when there are fewer than 3)
  hubServiceLinks: 3, // service pages home and contact link at least (all of them when there are fewer)
  sentenceWords: 8, // a sentence this long or longer counts in the duplicate-copy share
  errors: 50, // lines in one refusal at most (the last says how many more)
});

// The page types and the paths of the one-of-each pages.
const SINGLE_PATHS = Object.freeze({ home: "/", services: "/services", areas: "/areas", about: "/about", reviews: "/reviews", contact: "/contact" });
const SINGLES = Object.keys(SINGLE_PATHS);
const PAGE_KEYS = new Set([...SINGLES, "service", "area"]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// [words](/path): link words without brackets or line breaks, a target without spaces or brackets.
const LINK = /\[([^[\]\n]+)\]\(([^()\s]+)\)/g;
const HEX = /^#[0-9a-f]{6}$/i;
const FILE_URL = /^\/s\/f\/([0-9a-f]{32})$/;
const HTTPS = /^https:\/\/[^\s"'<>()\\]+$/i;
// Addresses every client site answers itself (sections 7–8), so no old path can be redirected from them.
const SERVED = new Set(["/privacy", "/sitemap.xml", "/robots.txt"]);
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
// A UK phone number written in the copy (01793 123456, 07700 900123, +44 (0)1793 123456): it must be theirs.
const PHONE_IN_TEXT = /(?:\+44[\s-]?(?:\(0\)[\s-]?)?|\b0)\d(?:[\s-]?\d){8,9}(?!\d)/g;
const EMAIL_IN_TEXT = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A year named in the copy ("since 1995") must be in a fact too, so the copy can't move their start date.
const YEAR = /\b(?:19|20)\d{2}\b/g;
// An old path that can be redirected: path characters only (no spaces, quotes, angle brackets, ? or #).
const OLD_PATH = /^\/[A-Za-z0-9\-._~%!$&'*+,;=:@/]*$/;

// Banned anywhere in the text (section 5), each with the line Claude gets. "$&" is the text that matched.
const BANNED = Object.freeze([
  [/\bSEO\b/i, `says "SEO": never use that word on the site`],
  [/steroid|trenbolone/i, `says "$&": no hype`],
  [/cheapest|lowest price/i, `says "$&": no claims about being cheapest`],
  // (?<!\d) starts the digits at the start of a number: the same matches, but a long run of digits stays linear.
  [/£\s?\d|(?<!\d)\d+\s?(?:pounds|quid)|per hour/i, `mentions a price ("$&"): no prices on the site`],
  [/[<>]/, `has "$&": no HTML, plain text only`],
  [/\]\(http/i, `links to another site: only link to pages on this site`],
]);

// Claims that need a fact (section 5): a sentence matching one is allowed only when the same pattern matches at least
// one facts[].text. No g flag: test() with g remembers where it stopped.
const CLAIMS = Object.freeze([
  // Section 5's pattern, plus the number written as a word ("over twenty years"), which says the same thing.
  ["years", /\b(?:\d+\+?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\s+years?\b/i],
  ["accreditation", /accredit|certified|registered|approved|member of|checkatrade|trustmark|gas safe|niceic|federation|guild/i],
  ["award", /award/i],
  ["insurance", /insured|insurance/i],
  ["guarantee", /guarantee|warrant/i],
  ["emergency", /24\/7|24 hours|emergenc/i],
  ["free quote", /free quote/i],
]);

// Fields that hold addresses, not words people read: skipped by the banned-words scan (a photo saved as
// ".../seo-roof.jpg" isn't the site saying "SEO"); each is checked as an address instead.
const NOT_TEXT = new Set(["photos.url", "theme.logo", "theme.main", "business.socials", "facts.source", "pages.path", "pages.photo", "redirects.from", "redirects.to"]);

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const norm = (v) => str(v).replace(/\s+/g, " ").trim();
const fold = (v) => norm(v).toLowerCase();
const chars = (s) => [...s].length;
const clip = (s, n) => (chars(s) > n ? `${[...s].slice(0, n - 1).join("")}…` : s);
const range = ([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Text parts of a line: plain text and [words](/path) links.
function inline(line) {
  const parts = [];
  let at = 0;
  for (const m of line.matchAll(LINK)) {
    if (m.index > at) parts.push({ text: line.slice(at, m.index) });
    parts.push({ text: m[1].trim(), href: m[2] });
    at = m.index + m[0].length;
  }
  if (at < line.length) parts.push({ text: line.slice(at) });
  return parts.filter((p) => p.text !== "");
}

/**
 * Body text as blocks: paragraphs (lines joined by a space; a blank line starts a new one) and bullet lists (lines
 * starting "- "). `parts` are plain-text pieces `{text}` and internal links `{text, href}`; nothing is escaped here
 * (that's the renderer's h()). A "ul" block also has `items`: one parts list per bullet, which is what a renderer
 * prints; its `parts` is every item's parts in order (handy for counting links).
 */
export function parseBody(text) {
  const blocks = [];
  let para = null;
  let list = null;
  const flush = () => {
    if (para) blocks.push({ type: "p", parts: inline(para.join(" ")) });
    if (list) {
      const items = list.map(inline);
      blocks.push({ type: "ul", parts: items.flat(), items });
    }
    para = list = null;
  };
  for (const raw of str(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) flush();
    else if (line.startsWith("- ")) {
      if (para) flush();
      const item = line.slice(2).trim();
      if (item) (list ??= []).push(item);
    } else {
      if (list) flush();
      (para ??= []).push(line);
    }
  }
  flush();
  return blocks;
}

const sectionsOf = (page) => (Array.isArray(page?.sections) ? page.sections.filter(isObj) : []);
const faqOf = (page) => (Array.isArray(page?.faq) ? page.faq.filter(isObj) : []);
const WORD = /[\p{L}\p{N}]/u;
const words = (s) => s.split(/\s+/).filter((w) => WORD.test(w)).length;
const SENTENCE_END = /(?<=[.!?])\s+/;
const sentences = (lines) => lines.map(norm).filter(Boolean).flatMap((l) => l.split(SENTENCE_END));

// One page read once: its readable lines (intro, each body paragraph and bullet, FAQ questions and answers), its
// section headings, its body links and its sentences (`all` adds title, meta, H1 and headings, first).
function readPage(page) {
  const lines = [str(page?.intro)];
  const h2s = [];
  const links = [];
  for (const s of sectionsOf(page)) {
    h2s.push(str(s.h2));
    for (const b of parseBody(s.body)) {
      for (const p of b.parts) if (p.href !== undefined) links.push(p);
      for (const parts of b.type === "ul" ? b.items : [b.parts]) lines.push(parts.map((p) => p.text).join(""));
    }
  }
  for (const f of faqOf(page)) lines.push(str(f.q), str(f.a));
  const text = sentences(lines);
  const all = [...sentences([str(page?.title), str(page?.meta), str(page?.h1), ...h2s]), ...text];
  return { lines, h2s, links, text, all };
}

const countWords = (r) => [...r.lines, ...r.h2s].reduce((n, l) => n + words(l), 0);

/** Words a page's reader gets: its intro, every section (heading and body, links counted by their words) and FAQ. */
export function wordCount(page) {
  return countWords(readPage(page));
}

/** The paths of the content's pages, in order (the server's /privacy isn't one). */
export function pagePaths(content) {
  const pages = Array.isArray(content?.pages) ? content.pages : [];
  return pages.filter((p) => isObj(p) && typeof p.path === "string").map((p) => p.path);
}

/**
 * The facts the client's own form answers prove, so the copy may state them (GET /api/agent/build/:client_id):
 * "Started in {year}", their accreditations, their guarantee, "Free quotes", "Emergency call-outs",
 * "Opening hours: {hours}"; each only when they gave it.
 */
export function formFacts(form) {
  const f = isObj(form) ? form : {};
  const out = [];
  const started = norm(f.started);
  if (/^\d{4}$/.test(started)) out.push(`Started in ${started}`);
  if (norm(f.accreditations)) out.push(norm(f.accreditations));
  if (norm(f.guarantee)) out.push(norm(f.guarantee));
  if (f.free_quotes === "yes") out.push("Free quotes");
  if (f.emergency === "yes") out.push("Emergency call-outs");
  if (norm(f.hours)) out.push(`Opening hours: ${norm(f.hours)}`);
  return out.map((text) => ({ text, source: "form" }));
}

// "home", "service /services/roof-repairs", "area /areas/wroughton", or "pages[3]" for a page of no known type.
function labelOf(page, i) {
  if (!isObj(page) || !PAGE_KEYS.has(page.key)) return `pages[${i}]`;
  if (page.key === "service" || page.key === "area") return `${page.key} ${typeof page.path === "string" && page.path ? clip(page.path, 80) : `pages[${i}]`}`;
  return page.key;
}

// A sentence as the duplicate check compares it: lower case, no punctuation, single spaces.
const dupKey = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

// Every string in a value with its field name ("pages.title", "reviews.text"), skipping NOT_TEXT fields.
function textsOf(value, field, out) {
  if (NOT_TEXT.has(field)) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) textsOf(v, field, out);
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) textsOf(v, field ? `${field}.${k}` : k, out);
  return out;
}

/**
 * Check one SiteContent document against section 5's rules. `ctx` = {form (the onboarding form JSON), reviews (the
 * lead's Google reviews [{author, rating, text}]), brand ({logo, colour, photos} from the lead's audit), files (this
 * client's site_files [{id, kind, url, alt}]), package}. Returns {ok, errors}: every problem, one line each.
 */
export function validateContent(content, ctx = {}) {
  const lines = new Set(); // in the order found, each once
  const add = (line) => {
    lines.add(line);
  };
  // At most LIMITS.errors lines (they're stored in client_sites.last_errors and shown on the Site page).
  const done = () => {
    const all = [...lines];
    const errors = all.length > LIMITS.errors ? [...all.slice(0, LIMITS.errors - 1), `…and ${all.length - LIMITS.errors + 1} more problems like these`] : all;
    return { ok: lines.size === 0, errors };
  };

  if (!isObj(content)) {
    add("The site content must be one JSON object (SiteContent version 1)");
    return done();
  }
  const bytes = new TextEncoder().encode(JSON.stringify(content)).length;
  if (bytes > LIMITS.bytes) {
    add(`The site content is ${Math.ceil(bytes / 1000)} KB; the limit is ${LIMITS.bytes / 1000} KB`);
    return done();
  }

  const form = isObj(ctx.form) ? ctx.form : {};
  const formBiz = isObj(form.business) ? form.business : {};
  const biz = isObj(content.business) ? content.business : {};
  const category = norm(content.primary_category);
  const formAreas = [];
  for (const a of Array.isArray(form.areas) ? form.areas : []) {
    if (norm(a) && !formAreas.some((x) => fold(x) === fold(a))) formAreas.push(norm(a));
  }
  const town = formAreas[0] ?? "";
  const pageAreas = formAreas.slice(1, 1 + LIMITS.pages.area);
  const ticked = (Array.isArray(form.services) ? form.services : []).filter((s) => isObj(s) && s.on === true && norm(s.name)).map((s) => norm(s.name));

  if (content.version !== 1) add("version must be 1");
  if (!norm(content.keyword)) add(`keyword is missing: the main search the site is built for, like "roofer ${town || "Swindon"}"`);
  if (!category) add(`primary_category is missing: their trade as Google names it, like "Roofing contractor"`);

  // Page set and paths.
  if (!Array.isArray(content.pages)) add("pages must be a list of pages");
  const all = Array.isArray(content.pages) ? content.pages : [];
  const pages = [];
  all.forEach((p, i) => {
    if (!isObj(p)) return add(`pages[${i}] must be an object`);
    if (p.key === "privacy" || p.path === "/privacy") return add(`pages[${i}]: don't write /privacy; the server adds it`);
    if (!PAGE_KEYS.has(p.key)) return add(`pages[${i}]: "${clip(str(p.key), 30)}" isn't a page type (use home, service, area, services, areas, about, reviews or contact)`);
    pages.push({ page: p, label: labelOf(p, i), read: readPage(p) });
  });
  const ofKey = (k) => pages.filter((x) => x.page.key === k);
  for (const k of SINGLES) {
    const n = ofKey(k).length;
    if (n === 0) add(`pages: there's no ${k} page; the site needs exactly one`);
    if (n > 1) add(`pages: there are ${n} ${k} pages; the site needs exactly one`);
  }
  const services = ofKey("service");
  const areas = ofKey("area");
  if (services.length === 0) add("pages: there are no service pages; the site needs at least 1");
  if (services.length > LIMITS.pages.service) add(`pages: there are ${services.length} service pages; the site can have at most ${LIMITS.pages.service} service pages (the rest are only listed on /services)`);
  if (areas.length > LIMITS.pages.area) add(`pages: there are ${areas.length} area pages; the site can have at most ${LIMITS.pages.area} area pages (the rest are only listed on /areas)`);

  const seenPaths = new Set();
  for (const { page, label } of pages) {
    const path = str(page.path);
    if (SINGLE_PATHS[page.key] !== undefined) {
      if (path !== SINGLE_PATHS[page.key]) add(`${label}: path must be "${SINGLE_PATHS[page.key]}"`);
    } else {
      const base = page.key === "service" ? "/services/" : "/areas/";
      const slug = path.startsWith(base) ? path.slice(base.length) : "";
      if (!SLUG.test(slug) || slug.length > LIMITS.slug) {
        add(`${label}: path must be ${base}<slug>, the slug lower-case letters and digits joined by single hyphens, at most ${LIMITS.slug} characters`);
      }
    }
    if (path && seenPaths.has(path)) add(`${label}: the path ${path} is used by more than one page`);
    seenPaths.add(path);
  }
  const paths = new Set(pagePaths({ pages: pages.map((x) => x.page) }));
  const areaPaths = areas.map((x) => str(x.page.path));
  const servicePaths = services.map((x) => str(x.page.path));

  // Service and area pages match the form.
  let lastIndex = -1;
  let ordered = true;
  const servicesSeen = new Set();
  for (const { page, label } of services) {
    const name = norm(page.name);
    const at = ticked.findIndex((s) => fold(s) === fold(name));
    if (!name) add(`${label}: name is missing (the service, as their form names it)`);
    else if (at < 0) add(`${label}: "${clip(name, 60)}" isn't a ticked service in their form`);
    else {
      if (servicesSeen.has(at)) add(`pages: there's more than one page for the service "${ticked[at]}"`);
      servicesSeen.add(at);
      if (at < lastIndex) ordered = false;
      lastIndex = at;
    }
  }
  if (!ordered) add(`pages: service pages must follow the order of their form (${ticked.slice(0, LIMITS.pages.service).join(", ")})`);
  const areasSeen = new Set();
  for (const { page, label } of areas) {
    const name = norm(page.name);
    const at = pageAreas.findIndex((a) => fold(a) === fold(name));
    if (!name) add(`${label}: name is missing (the area, as their form names it)`);
    else if (at < 0) add(`${label}: area "${clip(name, 60)}" isn't one of the areas in their form that get a page (areas 2–${LIMITS.pages.area + 1}; the first, ${town || "their town"}, is the home page's)`);
    else {
      if (areasSeen.has(at)) add(`pages: there's more than one page for the area "${pageAreas[at]}"`);
      areasSeen.add(at);
    }
  }
  pageAreas.forEach((a, i) => {
    if (!areasSeen.has(i)) add(`pages: area "${a}" from their form has no page`);
  });

  // Title, meta description, H1.
  const lengthRule = (label, what, value, { min, max }) => {
    const n = chars(norm(value));
    if (n === 0) add(`${label}: ${what} is missing`);
    else if (n > max) add(`${label}: ${what} is ${n} characters; the limit is ${max}`);
    else if (n < min) add(`${label}: ${what} is ${n} characters; it needs at least ${min}`);
  };
  const unique = (field, what) => {
    const seen = new Map();
    for (const { page, label } of pages) {
      const k = fold(page[field]);
      if (!k) continue;
      if (seen.has(k)) add(`${label}: ${what} is the same as ${seen.get(k)}'s; each page needs its own`);
      else seen.set(k, label);
    }
  };
  const names = (text, ...want) => want.every((w) => fold(text).includes(fold(w)));
  for (const { page, label } of pages) {
    lengthRule(label, "title", page.title, LIMITS.title);
    lengthRule(label, "meta description", page.meta, LIMITS.meta);
    lengthRule(label, "H1", page.h1, LIMITS.h1);
    if (page.key === "home") {
      if (!names(page.title, category, town)) add(`home: title must name "${category}" and "${town}"`);
      if (!names(page.h1, category, town)) add(`home: H1 must name "${category}" and "${town}"`);
    }
    if ((page.key === "service" || page.key === "area") && norm(page.name) && !names(page.h1, page.name)) {
      add(`${label}: H1 must name "${norm(page.name)}"`);
    }
  }
  unique("title", "title");
  unique("meta", "meta description");

  // Shape, words, FAQ.
  for (const { page, label, read } of pages) {
    if (page.intro !== undefined && typeof page.intro !== "string") add(`${label}: intro must be text`);
    if (page.sections !== undefined && (!Array.isArray(page.sections) || !page.sections.every((s) => isObj(s) && typeof s.h2 === "string" && typeof s.body === "string"))) {
      add(`${label}: sections must be a list of {"h2": text, "body": text}`);
    }
    if (page.faq !== undefined && (!Array.isArray(page.faq) || !page.faq.every((f) => isObj(f) && norm(f.q) && norm(f.a)))) {
      add(`${label}: faq must be a list of {"q": question, "a": answer}, neither empty`);
    }
    const need = LIMITS.words[page.key] ?? 0;
    const n = countWords(read);
    if (n < need) add(`${label}: body has ${n} words; it needs at least ${need}`);
    const [lo, hi] = LIMITS.faq[page.key] ?? [0, 0];
    const faqs = faqOf(page);
    if (hi === 0 && faqs.length > 0) add(`${label}: has ${plural(faqs.length, "FAQ")}; this page has no FAQs`);
    else if (faqs.length < lo || faqs.length > hi) add(`${label}: has ${plural(faqs.length, "FAQ")}; it needs ${range([lo, hi])}`);
    faqs.forEach((f, i) => {
      const n2 = chars(norm(f.a));
      if (n2 > LIMITS.faqAnswer) add(`${label}: FAQ ${i + 1}'s answer is ${n2} characters; the limit is ${LIMITS.faqAnswer}`);
    });
    const linkIn = [str(page.intro), ...sectionsOf(page).map((s) => str(s.h2)), ...faqOf(page).flatMap((f) => [str(f.q), str(f.a)])];
    if (linkIn.some((t) => /\[[^[\]\n]+\]\([^()\s]+\)/.test(t))) add(`${label}: links can only go in a section's body, not the intro, headings or FAQs`);
    if (page.photo !== undefined) {
      const count = Array.isArray(content.photos) ? content.photos.length : 0;
      if (!Number.isInteger(page.photo) || page.photo < 0 || page.photo >= count) add(`${label}: photo must be the number of one of the photos (0 to ${Math.max(0, count - 1)})`);
    }
  }

  // Links.
  for (const { page, label, read } of pages) {
    const { links } = read;
    if (links.length > LIMITS.links) add(`${label}: has ${links.length} links; the limit is ${LIMITS.links}`);
    for (const { href } of links) {
      if (!href.startsWith("/") || href.startsWith("//")) add(`${label}: "${clip(href, 60)}" isn't a page here: only link to pages on this site`);
      else if (!paths.has(href)) add(`${label}: links to "${clip(href, 60)}", which isn't a page on this site`);
    }
    const to = new Set(links.map((l) => l.href));
    const linkedAreas = areaPaths.filter((p) => to.has(p)).length;
    const linkedServices = servicePaths.filter((p) => to.has(p)).length;
    if (page.key === "service") {
      const [lo, hi] = LIMITS.serviceAreaLinks;
      if (areaPaths.length >= lo && (linkedAreas < lo || linkedAreas > hi)) add(`${label}: links to ${plural(linkedAreas, "area page")}; it must link ${range([lo, hi])} area pages`);
      if (areaPaths.length < lo && linkedAreas < areaPaths.length) add(`${label}: links to ${plural(linkedAreas, "area page")}; it must link every area page (${areaPaths.length})`);
    }
    if (page.key === "area") {
      const [lo, hi] = LIMITS.areaServiceLinks;
      if (servicePaths.length >= lo && (linkedServices < lo || linkedServices > hi)) add(`${label}: links to ${plural(linkedServices, "service page")}; it must link ${range([lo, hi])} service pages`);
      if (servicePaths.length < lo && linkedServices < servicePaths.length) add(`${label}: links to ${plural(linkedServices, "service page")}; it must link every service page (${servicePaths.length})`);
    }
    if (page.key === "home" || page.key === "contact") {
      for (const p of areaPaths) if (!to.has(p)) add(`${label}: doesn't link the area page ${p}; home and contact link every area page`);
      const need = Math.min(LIMITS.hubServiceLinks, servicePaths.length);
      if (linkedServices < need) add(`${label}: links to ${plural(linkedServices, "service page")}; it must link at least ${need}`);
    }
  }

  // Duplicate copy between pages.
  const sentenceSets = pages.map(({ read }) => new Set(read.text.filter((s) => s.split(" ").length >= LIMITS.sentenceWords).map(dupKey).filter((s) => s.split(" ").length >= LIMITS.sentenceWords)));
  pages.forEach(({ label }, i) => {
    const mine = sentenceSets[i];
    if (mine.size === 0) return;
    let shared = 0;
    const withPages = [];
    for (const s of mine) {
      let found = false;
      sentenceSets.forEach((other, j) => {
        if (j === i || !other.has(s)) return;
        found = true;
        const p = str(pages[j].page.path) || pages[j].label;
        if (!withPages.includes(p)) withPages.push(p);
      });
      if (found) shared++;
    }
    const pct = Math.ceil((shared * 100) / mine.size);
    if (shared / mine.size > LIMITS.dupShare) {
      add(`${label}: shares ${pct}% of its sentences with ${withPages.join(", ")}; the limit is ${Math.round(LIMITS.dupShare * 100)}%: write this page's own copy`);
    }
  });

  // Name, address, phone.
  for (const f of ["name", "phone", "email"]) {
    if (norm(biz[f]) !== norm(formBiz[f])) add(`business.${f} must match the form ("${clip(norm(formBiz[f]), 80)}")`);
  }
  // The footer's legal line is the law's "John Smith trading as …": their own words, exactly.
  if (norm(formBiz.legal_line) && norm(biz.legal_line) !== norm(formBiz.legal_line)) {
    add(`business.legal_line must match the form ("${clip(norm(formBiz.legal_line), 120)}")`);
  }
  // Every phone number and email address written in the copy is theirs: a typo there loses them the call.
  const ukDigits = (s) => {
    const d = str(s).replace(/\(0\)/g, "").replace(/\D/g, "");
    return d.startsWith("44") ? `0${d.slice(2)}` : d;
  };
  const phoneDigits = ukDigits(formBiz.phone);
  const emails = new Set([fold(formBiz.email), fold(formBiz.leads_email)].filter(Boolean));
  for (const { label, read } of pages) {
    const text = read.all.join(" ");
    for (const m of text.matchAll(PHONE_IN_TEXT)) {
      if (ukDigits(m[0]) !== phoneDigits) add(`${label}: says the phone number "${m[0]}", but the number on their form is "${clip(norm(formBiz.phone), 40)}"`);
    }
    for (const m of text.matchAll(EMAIL_IN_TEXT)) {
      if (!emails.has(m[0].toLowerCase())) add(`${label}: says the email "${clip(m[0], 80)}", but it isn't the email on their form ("${clip(norm(formBiz.email), 80)}")`);
    }
  }
  const showAddress = formBiz.show_address === "yes";
  if (biz.show_address !== showAddress) add(`business.show_address must match the form (${showAddress})`);
  if (!showAddress) {
    const addr = isObj(biz.address) ? biz.address : {};
    const hidden = [norm(addr.street)];
    const formAddr = norm(formBiz.address);
    const firstLine = norm(formAddr.split(",")[0]);
    if (/\d/.test(firstLine) && firstLine !== formAddr) hidden.push(firstLine);
    const postcodes = [norm(addr.postcode), POSTCODE.exec(formAddr)?.[0] ?? ""].map((p) => p.replace(/\s+/g, "").toLowerCase()).filter(Boolean);
    const shows = (t) => {
      const text = fold(t);
      const squashed = text.replace(/\s+/g, "");
      return hidden.some((s) => s && text.includes(s.toLowerCase())) || postcodes.some((p) => squashed.includes(p));
    };
    for (const { label, read } of pages) {
      if (shows(read.all.join(" "))) add(`${label}: shows the street or postcode, but they chose to show their town only`);
    }
    // Alt text is in the page too (and read out by screen readers).
    (Array.isArray(content.photos) ? content.photos : []).forEach((p, i) => {
      if (isObj(p) && shows(str(p.alt))) add(`photos[${i}]: the alt text shows the street or postcode, but they chose to show their town only`);
    });
  }
  if (biz.socials !== undefined && (!Array.isArray(biz.socials) || !biz.socials.every((u) => typeof u === "string" && HTTPS.test(u)))) {
    add("business.socials must be a list of https:// links");
  }

  // Reviews: their own Google reviews, word for word.
  const google = (Array.isArray(ctx.reviews) ? ctx.reviews : []).filter(isObj);
  const reviews = Array.isArray(content.reviews) ? content.reviews : [];
  if (content.reviews !== undefined && !Array.isArray(content.reviews)) add("reviews must be a list");
  if (reviews.length > LIMITS.reviews) add(`reviews: there are ${reviews.length}; the limit is ${LIMITS.reviews}`);
  const usedReviews = new Set();
  reviews.forEach((r, i) => {
    const match = isObj(r) && google.find((g) => norm(g.text) === norm(r.text) && norm(g.author) === norm(r.author) && norm(r.text));
    if (!match) add(`reviews[${i}]: this review isn't one of their Google reviews (copy the author and text exactly)`);
    else if (usedReviews.has(match)) add(`reviews[${i}]: this review is already on the site; show each one once`);
    else if (typeof match.rating === "number" && r.rating !== match.rating) add(`reviews[${i}]: rating must be the Google one (${match.rating})`);
    if (match) usedReviews.add(match);
  });

  // Photos and logo: theirs, or files copied for this client.
  const brand = isObj(ctx.brand) ? ctx.brand : {};
  const theirs = new Set([str(brand.logo), ...(Array.isArray(brand.photos) ? brand.photos : []).map(str)].filter(Boolean));
  const files = (Array.isArray(ctx.files) ? ctx.files : []).filter(isObj);
  const fileIds = new Set(files.map((f) => str(f.id)));
  const fileUrls = new Set(files.map((f) => str(f.url)).filter(Boolean));
  const allowed = (u) => typeof u === "string" && (theirs.has(u) || fileUrls.has(u) || fileIds.has(FILE_URL.exec(u)?.[1] ?? "\0"));
  // Section 10 copies only https:// images into site_files; an http:// one would stay hot-linked and the site's
  // content-security-policy (img-src 'self') would block it.
  const copyable = (u) => FILE_URL.test(u) || fileUrls.has(u) || /^https:\/\//i.test(u);
  const photos = Array.isArray(content.photos) ? content.photos : [];
  if (content.photos !== undefined && !Array.isArray(content.photos)) add("photos must be a list");
  if (photos.length > LIMITS.photos) add(`photos: there are ${photos.length}; the limit is ${LIMITS.photos}`);
  photos.forEach((p, i) => {
    if (!isObj(p) || !allowed(p.url)) add(`photos[${i}]: not one of their photos (use a URL from brand.photos, brand.logo or files)`);
    else if (!copyable(p.url)) add(`photos[${i}]: only https:// photos can be copied to the site; leave this one out (Nik can add it on the Site page)`);
    else if (!norm(p.alt)) add(`photos[${i}]: alt is missing (a short, local description of the photo)`);
  });
  const theme = isObj(content.theme) ? content.theme : {};
  if (theme.main !== undefined && !(typeof theme.main === "string" && HEX.test(theme.main))) add(`theme.main must be a colour like "#1e4f86"`);
  if (theme.logo !== undefined && theme.logo !== "" && !allowed(theme.logo)) add("theme.logo: not their logo (use brand.logo or one of files)");
  else if (theme.logo !== undefined && theme.logo !== "" && !copyable(theme.logo)) add("theme.logo: only an https:// logo can be copied to the site; leave it out (Nik can add it on the Site page)");

  // Banned words, anywhere people can read.
  const scan = (label, value, field) => {
    for (const t of textsOf(value, field, [])) {
      for (const [re, msg] of BANNED) {
        const m = re.exec(t);
        if (m) add(`${label}: ${msg.replace("$&", m[0])}`);
      }
    }
  };
  for (const { page, label } of pages) scan(label, page, "pages");
  for (const [k, v] of Object.entries(content)) {
    if (k === "pages") continue;
    if (Array.isArray(v)) v.forEach((item, i) => scan(`${k}[${i}]`, item, k));
    else scan(k, v, k);
  }

  // Claims need a fact.
  const facts = Array.isArray(content.facts) ? content.facts : [];
  if (content.facts !== undefined && !Array.isArray(content.facts)) add("facts must be a list");
  const factTexts = facts.filter(isObj).map((f) => str(f.text));
  for (const { label, read } of pages) {
    for (const [name, re] of CLAIMS) {
      if (factTexts.some((t) => re.test(t))) continue;
      const s = read.all.find((x) => re.test(x));
      if (s) add(`${label}: "${clip(s, 80)}" needs a fact: "${name}" (add the fact to facts with where it's from, or take it out)`);
    }
    const years = new Set();
    for (const x of read.all) {
      for (const [y] of x.replace(PHONE_IN_TEXT, " ").matchAll(YEAR)) { // "020 2019 1234" is a phone number, not a year
        if (years.has(y) || factTexts.some((t) => t.includes(y))) continue;
        years.add(y);
        add(`${label}: "${clip(x, 80)}" needs a fact: "${y}" (add the fact to facts with where it's from, or take it out)`);
      }
    }
  }
  // A fact "from the form" must be something the form really says: one of formFacts(form), or words from its answers.
  const fromForm = new Set(formFacts(form).map((f) => fold(f.text)));
  const formWords = fold(
    [form.about, form.notes, form.photos_note, form.accreditations, form.guarantee, form.hours, form.started, formBiz.legal_line, ...ticked, ...formAreas]
      .map(str)
      .join("\n"),
  );
  facts.forEach((f, i) => {
    if (!isObj(f) || !norm(f.text)) return add(`facts[${i}]: text is missing`);
    if (!(f.source === "form" || (typeof f.source === "string" && HTTPS.test(f.source)))) add(`facts[${i}]: source must be "form" or the https:// page it was seen on`);
    else if (f.source === "form" && !fromForm.has(fold(f.text)) && !formWords.includes(fold(f.text))) {
      add(`facts[${i}]: "${clip(norm(f.text), 80)}" isn't in their form: use the form's own words, or the https:// page it was seen on`);
    }
  });

  // Redirects from the old site.
  const redirects = Array.isArray(content.redirects) ? content.redirects : [];
  if (content.redirects !== undefined && !Array.isArray(content.redirects)) add("redirects must be a list");
  if (redirects.length > LIMITS.redirects) add(`redirects: there are ${redirects.length}; the limit is ${LIMITS.redirects}`);
  const froms = new Set();
  redirects.forEach((r, i) => {
    const from = str(r?.from);
    const to = str(r?.to);
    if (!OLD_PATH.test(from) || from.startsWith("//")) add(`redirects[${i}]: from must be an old path starting with "/" (path only: no spaces, quotes, "?" or "#"; percent-encode anything else)`);
    else if (from.length > 1 && from.endsWith("/")) add(`redirects[${i}]: "${clip(from, 60)}" ends with "/"; give the path without it (the site already drops a trailing "/")`);
    else if (SERVED.has(from) || from.startsWith("/s/")) add(`redirects[${i}]: "${clip(from, 60)}" is an address the site itself uses, so it can't redirect`);
    else if (paths.has(from)) add(`redirects[${i}]: "${clip(from, 60)}" is a page on the new site, so it can't redirect`);
    else if (froms.has(from)) add(`redirects[${i}]: "${clip(from, 60)}" is redirected twice`);
    froms.add(from);
    if (!paths.has(to)) add(`redirects[${i}]: "${clip(to, 60)}" isn't a page on the new site`);
  });

  return done();
}
