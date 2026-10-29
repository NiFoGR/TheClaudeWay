// The "Landscaper" look (05-demo.md Part A §3, Task 7): the demo template for landscapers, gardeners, turf, paving,
// patio and fencing trades (data.js's templateIdFor). Landscaping sells on photos, so Recent work comes straight after
// the hero. home(data, mode) lays out the sections between the shell's preview bar and footer (render.js owns those,
// the guarantee strip and the shared pieces imported below). Section order: hero (their first photo right of the text
// on desktop, below the buttons on mobile), recent work (photos 2–6, two columns on mobile), services (cards with a
// leaf icon), areas, reviews, guarantee strip (demo mode only), about, contact. Empty sections are left out, never
// padded: only their data is shown, and the template's own words make no claims (no numbers, no "free quote", no
// "best").
//
// Only TEMPLATE, home and page are exported: page(data, mode) is a client site's page (stage 10, live mode only;
// 09-build.md §7, at the end of this file). Nothing here touches render.js's exports at load time (the two modules
// import each other).
// Any change to what this renders must bump TEMPLATE.version, so Nik approves the new look before emails link to it;
// the lock test in control-room/tests/demo-render.test.mjs fails until it's bumped.
import {
  SERVICES_PLACEHOLDER, callHref, guaranteeStrip, hasQuote, logoHtml, photoHtml, photoList, quoteHtml, ratingHtml, siteContactHtml,
  siteFaqHtml, siteHeader, siteHeroPhoto, siteLinks, siteMapHtml, sitePhotoHtml, sitePhotos, siteReachHtml, siteReviewLink,
  siteReviewsHtml, siteSections, starsHtml,
} from "../render.js";
import { h } from "../text.js";

export const TEMPLATE = Object.freeze({ id: "landscaper", version: 1, label: "Landscaper" });

const MAX_SERVICES = 8;
const MAX_AREAS = 12;
const MAX_REVIEWS = 3;

// The line icon: a leaf on its stem. Big in the photo-free hero, small in a disc of their colour on each service card.
const LEAF_PATHS = '<path d="M14 50C10 28 24 12 54 10c2 30-14 44-40 40z"/><path d="M14 50 40 24"/><path d="M8 56l6-6"/>';
const svg = (cls, width) => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${LEAF_PATHS}</svg>`;
const HERO_ICON = svg("hero-icon", 2.5);
const CARD_ICON = `<span class="leaf" aria-hidden="true">${svg("", 5)}</span>`;

// Mobile first; one desktop block. Soft sage panels; --main only behind white text and for thin accent lines.
// Recent work: two columns on a phone (an odd count lets the first photo run full width); six tracks on desktop so
// every row is full: 1 photo wide, 2 or 4 in halves, 3 in thirds, 5 as two halves over three thirds. A photo that
// fails to load removes itself and the grid re-flows; when none loads (a host that blocks hot-linking), the whole
// section hides instead of showing "Recent work" over nothing.
// A long unbroken word (a service, an intro with a web address) wraps instead of pushing the page sideways: the text
// beside each leaf may shrink (min-width:0) and the desktop hero's columns are minmax(0, …), never wider than the page.
const CSS = `.top{background:#fff;border-bottom:1px solid #dfe4d8}
.top .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;min-height:72px;padding-top:10px;padding-bottom:10px}
.logo{width:auto;height:52px;max-width:200px;object-fit:contain}
.wordmark{min-width:0;font-size:21px;font-weight:800;line-height:1.25;letter-spacing:-.01em}
.top-ph{font-weight:700;text-decoration:none;white-space:nowrap}
a.top-ph{text-decoration-line:underline;text-decoration-color:var(--main);text-decoration-thickness:2px;text-underline-offset:4px}
.hero{padding:32px 0 40px;background:#f2f5ee}
.hero-grid{display:flex;flex-direction:column}
.hero h1{margin:0 0 12px;font-size:34px;line-height:1.12;letter-spacing:-.01em}
.intro{margin:0 0 16px;font-size:18px}
.rate{display:inline-block;margin:0 0 20px;padding:6px 14px;border:1px solid #cdd5c4;border-radius:99px;background:#fff;font-size:15px;font-weight:600}
.btns{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-block;padding:13px 22px;border:2px solid var(--main);border-radius:99px;background:var(--main);color:#fff;font-weight:700;text-decoration:none}
.btn-alt{background:#fff;color:#1d2125}
.hero-img{width:100%;height:auto;margin-top:24px;aspect-ratio:4/3;border-radius:16px;border-bottom:5px solid var(--main);background:#dfe4d8;object-fit:cover}
.hero-icon{order:-1;width:56px;height:56px;margin:0 0 16px}
.hero-plain{background:var(--main) repeating-linear-gradient(90deg,rgba(0,0,0,.1) 0 44px,transparent 44px 88px);color:#fff}
.hero-plain .rate{border-color:rgba(255,255,255,.55);background:rgba(0,0,0,.28)}
.hero-plain .btn{border-color:#fff;background:#fff;color:#1d2125}
.hero-plain .btn-alt{background:transparent;color:#fff}
.sec{padding:44px 0}
.alt{background:#f2f5ee}
.sec h2{margin:0 0 20px;font-size:27px;line-height:1.2}
.sec h2::after{content:"";display:block;width:44px;margin-top:10px;border-top:3px solid var(--main)}
#quote{scroll-margin-top:72px}
.work{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.work img{width:100%;height:auto;aspect-ratio:4/3;border-radius:12px;background:#dfe4d8;object-fit:cover}
.work img:first-child:nth-last-child(odd){grid-column:span 2}
#work:has(.work:empty){display:none}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:12px;margin:0;padding:0;list-style:none}
.card{display:flex;align-items:center;gap:14px;min-width:0;padding:14px 16px;border:1px solid #dfe4d8;border-radius:12px;background:#fff;font-weight:600}
.card>span{min-width:0}
.leaf{display:grid;flex:none;width:40px;height:40px;place-items:center;border-radius:50%;background:var(--main);color:#fff}
.leaf svg{width:22px;height:22px}
.card-ph{display:block;border:2px dashed #8a9099;font-weight:400}
.card-ph b{display:block}
.card-ph small{color:#5c6066;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.chips li{max-width:100%;padding:6px 14px;border:1px solid var(--main);border-radius:99px;background:#fff}
.sub{margin:-8px 0 20px;color:#5c6066}
.revs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
.rev{margin:0;padding:20px;border:1px solid #dfe4d8;border-top:4px solid var(--main);border-radius:12px;background:#fff}
.stars{color:#8a5a00;letter-spacing:2px}
.rev blockquote{margin:8px 0 12px}
.rev figcaption{color:#5c6066;font-weight:600}
.text{max-width:720px;margin:0}
@media (min-width: 900px){.hero{padding:72px 0}.hero h1{font-size:48px}.hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:48px;align-items:center}.hero-img{margin-top:0}.hero-icon{order:0;width:180px;height:180px;margin:0 auto}.sec{padding:64px 0}.sec h2{font-size:34px}.work{grid-template-columns:repeat(6,minmax(0,1fr));gap:14px}.work img,.work img:first-child:nth-last-child(odd){grid-column:span 2}.work img:first-child:last-child{grid-column:span 6;aspect-ratio:2/1}.work img:first-child:nth-last-child(even),.work img:first-child:nth-last-child(even)~img,.work img:first-child:nth-last-child(5),.work img:first-child:nth-last-child(5)+img{grid-column:span 3}}`;

const texts = (v, n) => (Array.isArray(v) ? v : []).filter((s) => typeof s === "string" && s).slice(0, n);

function header(data, tel) {
  const phone = data.business.phone;
  const ph = tel ? `<a class="top-ph" href="${h(tel)}">${h(phone)}</a>` : phone ? `<span class="top-ph">${h(phone)}</span>` : "";
  return `<header class="top"><div class="wrap">${logoHtml(data)}${ph}</div></header>`;
}

// Headline, intro, rating badge, the two buttons; their first photo right of the text (desktop) or below the buttons
// (mobile), or the photo-free panel in their colour with the leaf.
function hero(data, photos, tel, quote) {
  const buttons = [
    tel ? `<a class="btn" href="${h(tel)}">Call ${h(data.business.phone)}</a>` : "",
    quote ? '<a class="btn btn-alt" href="#quote">Ask for a quote</a>' : "",
  ].join("");
  const text = [
    '<div class="hero-text">',
    `<h1>${h(data.copy.headline)}</h1>`,
    data.copy.intro ? `<p class="intro">${h(data.copy.intro)}</p>` : "",
    ratingHtml(data),
    buttons ? `<div class="btns">${buttons}</div>` : "",
    "</div>",
  ].filter(Boolean).join("\n");
  const art = photos.length ? photoHtml(photos[0], data, { top: true, cls: "hero-img" }) : HERO_ICON;
  return `<section class="hero${photos.length ? "" : " hero-plain"}"><div class="wrap hero-grid">\n${text}\n${art}\n</div></section>`;
}

// Photos 2–6, only when there are 2 or more.
function work(data, photos) {
  if (photos.length < 2) return "";
  return `<h2>Recent work</h2>\n<div class="work">${photos.slice(1).map((u) => photoHtml(u, data)).join("")}</div>`;
}

// One card with a leaf per service of theirs; none → the dashed placeholder card (demo mode only, never a trade's
// default list).
function services(data, mode) {
  const items = texts(data.business.services, MAX_SERVICES);
  if (items.length) return `<h2>What we do</h2>\n<ul class="cards">${items.map((s) => `<li class="card">${CARD_ICON}<span>${h(s)}</span></li>`).join("")}</ul>`;
  if (mode !== "demo") return "";
  return `<h2>What we do</h2>\n<ul class="cards"><li class="card card-ph"><b>${h(SERVICES_PLACEHOLDER.title)}</b><small>${h(SERVICES_PLACEHOLDER.label)}</small></li></ul>`;
}

function areas(data) {
  const items = texts(data.business.areas, MAX_AREAS);
  return items.length ? `<h2>Areas we cover</h2>\n<ul class="chips">${items.map((a) => `<li>${h(a)}</li>`).join("")}</ul>` : "";
}

// Their real Google reviews only: rated 4 or 5, with text.
function reviews(data) {
  const items = (Array.isArray(data.reviews) ? data.reviews : [])
    .filter((r) => r && typeof r.rating === "number" && r.rating >= 4 && r.rating <= 5 && typeof r.text === "string" && r.text)
    .slice(0, MAX_REVIEWS);
  if (!items.length) return "";
  const cards = items.map((r) => `<figure class="rev">${starsHtml(r.rating)}<blockquote>“${h(r.text)}”</blockquote><figcaption>${h(r.author || "Google reviewer")}</figcaption></figure>`);
  return `<h2>What customers say</h2>\n<p class="sub">Reviews from Google</p>\n<div class="revs">${cards.join("")}</div>`;
}

function about(data) {
  return data.copy.about ? `<h2>About ${h(data.business.name)}</h2>\n<p class="text">${h(data.copy.about)}</p>` : "";
}

/** The home page's sections (the shell adds the bar, footer, call bar and beacon). */
export function home(data, mode) {
  const tel = callHref(data);
  const photos = photoList(data);
  const quote = hasQuote(data, mode);
  const blocks = [
    ["work", work(data, photos)],
    ["services", services(data, mode)],
    ["areas", areas(data)],
    ["reviews", reviews(data)],
    ["strip", mode === "demo" ? guaranteeStrip(data) : ""],
    ["about", about(data)],
    ["quote", quote ? `<h2>Ask for a quote</h2>\n${quoteHtml(data, mode)}` : ""],
  ].filter(([, html]) => html);
  let tone = 0; // white and sage take turns after the sage hero, whichever sections are shown
  const sections = blocks.map(([id, html]) => (id === "strip" ? html
    : `<section class="sec${tone++ % 2 ? " alt" : ""}" id="${id}"><div class="wrap">\n${html}\n</div></section>`));
  return { css: CSS, body: [header(data, tel), "<main>", hero(data, photos, tel, quote), ...sections, "</main>"].join("\n") };
}

// ---------------------------------------------------------------- client sites (stage 10, live mode only)
// page(data, mode) draws whichever page data.live.page is (renderSite picks it by path). Photos sell landscaping, so
// on the home page Recent work comes straight after the hero, as in the demo; then the content's sections, what that
// kind of page lists (service cards with the leaf, area links, reviews, contact details, map), its FAQ, and the
// contact form last on home, service, area and contact pages. Only the client's own data; the words make no claims.

const MAX_WORK = 6;
const FORM_PAGES = new Set(["home", "service", "area", "contact"]);

// The page's H1, intro, rating and buttons, its photo right of the text (desktop) or below the buttons (mobile).
function siteHero(data, tel, quote) {
  const p = data.live.page;
  const photo = siteHeroPhoto(data);
  const buttons = [
    tel ? `<a class="btn" href="${h(tel)}">Call ${h(data.business.phone)}</a>` : "",
    quote ? `<a class="btn btn-alt" href="#quote">${p.key === "contact" ? "Send a message" : "Ask for a quote"}</a>` : "",
  ].join("");
  const text = [
    '<div class="hero-text">',
    `<h1>${h(p.h1)}</h1>`,
    p.intro ? `<p class="intro">${h(p.intro)}</p>` : "",
    ratingHtml(data),
    buttons ? `<div class="btns">${buttons}</div>` : "",
    "</div>",
  ].filter(Boolean).join("\n");
  const art = photo ? sitePhotoHtml(data, photo, { top: true, cls: "hero-img" }) : HERO_ICON;
  return `<section class="hero${photo ? "" : " hero-plain"}"><div class="wrap hero-grid">\n${text}\n${art}\n</div></section>`;
}

// A card with the leaf linking each service page; on /services also the ticked services without a page.
function siteServices(data, { more = false, heading = "What we do" } = {}) {
  const cards = siteLinks(data, "services").map((s) => `<li class="card">${CARD_ICON}<span><a href="${h(s.href)}">${h(s.name)}</a></span></li>`);
  if (more) for (const s of data.live.more?.services ?? []) cards.push(`<li class="card">${CARD_ICON}<span>${h(s)}</span></li>`);
  return cards.length ? `<h2>${h(heading)}</h2>\n<ul class="cards">${cards.join("")}</ul>` : "";
}

// Their home town, then a chip linking each area page; on /areas also the areas without a page of their own.
function siteAreas(data, { more = false, map = "" } = {}) {
  const town = data.business.town;
  const chips = [town ? `<li>${h(town)}</li>` : "", ...siteLinks(data, "areas").map((a) => `<li><a href="${h(a.href)}">${h(a.name)}</a></li>`)];
  if (more) for (const a of data.live.more?.areas ?? []) chips.push(`<li>${h(a)}</li>`);
  const items = chips.filter(Boolean);
  return items.length || map ? `<h2>Areas we cover</h2>\n${items.length ? `<ul class="chips">${items.join("")}</ul>` : ""}${map ? `\n${map}` : ""}` : "";
}

// Their photos except the page's top one, at most 6.
function siteWork(data) {
  const top = siteHeroPhoto(data);
  const rest = sitePhotos(data).filter((p) => p && p.url !== top?.url).slice(0, MAX_WORK);
  return rest.length ? `<h2>Recent work</h2>\n<div class="work">${rest.map((p) => sitePhotoHtml(data, p)).join("")}</div>` : "";
}

/** A client site's page (live mode): the shell adds the head, preview bar, footer, call bar and chat tag. */
export function page(data, mode) {
  const p = data.live.page;
  const tel = callHref(data);
  const form = FORM_PAGES.has(p.key) ? siteContactHtml(data) : "";
  const sections = siteSections(data).map((s, i) => [`s${i + 1}`, `${s.h2 ? `<h2>${h(s.h2)}</h2>\n` : ""}<div class="prose">\n${s.html}\n</div>`]);
  const map = siteMapHtml(data);
  const before = {
    home: [["work", siteWork(data)]],
    contact: [["reach", `<h2>How to reach us</h2>\n${siteReachHtml(data, tel)}${map ? `\n${map}` : ""}`]],
  }[p.key] ?? [];
  const after = {
    home: [["services", siteServices(data)], ["areas", siteAreas(data, { map })], ["reviews", siteReviewsHtml(data, 3)]],
    services: [["services", siteServices(data, { more: true, heading: "All our services" })]],
    areas: [["areas", siteAreas(data, { more: true })]],
    about: [["work", siteWork(data)]],
    reviews: [["reviews", `${siteReviewsHtml(data, 12, { heading: false })}${siteReviewLink(data) ? `\n${siteReviewLink(data)}` : ""}`]],
  }[p.key] ?? [];
  const blocks = [
    ...before,
    ...sections,
    ...after,
    ["faq", siteFaqHtml(data)],
    ["quote", form ? `<h2>${p.key === "contact" ? "Send a message" : "Ask for a quote"}</h2>\n${form}` : ""],
  ].filter(([, html]) => html);
  let tone = 0; // white and sage take turns after the sage hero
  const out = blocks.map(([id, html]) => `<section class="sec${tone++ % 2 ? " alt" : ""}" id="${id}"><div class="wrap">\n${html}\n</div></section>`);
  return { css: CSS, body: [siteHeader(data, tel), "<main>", siteHero(data, tel, Boolean(form)), ...out, "</main>"].join("\n") };
}
