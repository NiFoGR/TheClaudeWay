// The demo template engine (05-demo.md Part A §3, §6, §10; Task 6): DemoData (demo/data.js) in, one HTML page out,
// rendered on every request (nothing is stored but the slug). This file is the shell: <head>, the Aetos preview bar,
// the guarantee strip, the footer, the mobile call bar and the view beacon, plus the pieces every template shares
// (logo, photos, rating, stars, quote form). Each template (templates/<id>.js) only lays out the sections in between:
// home(data, mode) → {css, body}. Any change here changes every look, so it bumps every TEMPLATE.version (Task 7's
// lock test).
//
// Safety: every value from the lead, research or reviews goes through h() (text and attributes), every URL through
// safeHttps(), the colour must be #rrggbb before it reaches the CSS, and nothing scraped is ever put inside a CSS
// url(), the <script> or an event handler: the only script is the beacon (with a slug checked against
// ^[a-z0-9-]{3,60}$) and the only handlers are the two fixed image ones below. No web fonts, no outside files.
// Pure: no D1, no fetch, nothing runs at load (templates import this module back for the shared pieces). The looks:
// templates/generic.js ("Everything else") and templates/landscaper.js ("Landscaper").
// Tested in control-room/tests/demo-render.test.mjs.
//
// Stage 10 (09-build.md §7) renders paying clients' multi-page sites with the same looks in live mode: client-site data
// from sites/sitedata.js, each template's page(), and the client-site shell further down (renderSitePage). Its only
// scripts are the JSON-LD, the contact form's 3-line timer and the chat widget tag. Tested in sites-render.test.mjs.
import { CHARCOAL } from "./colour.js";
import { cleanText, h, safeHttps, shortName, telHref } from "./text.js";
import { bodyHtml } from "../sites/body.js";
import { ldJson } from "../sites/jsonld.js";
import * as generic from "./templates/generic.js";
import * as landscaper from "./templates/landscaper.js";

/** The looks by template id (DemoData.template, from data.js's templateIdFor): each a module with TEMPLATE
 * {id, version, label} and home(). Any other id gets the generic look. */
export const TEMPLATES = Object.freeze({ generic, landscaper });

/** The privacy notice the demo footer links to (the notice at first contact, Q-N). */
export const PRIVACY_URL = "https://aetoswebsites.com/privacy";

/** The one services card a demo shows when research found none (never a trade's default list). Demo mode only. */
export const SERVICES_PLACEHOLDER = Object.freeze({
  title: "Your services will go here",
  label: "Preview placeholder: we'll fill this in with you",
});

const FORM_NOTE = "Preview only: on your live site, this form sends enquiries straight to your phone and inbox.";

const SLUG = /^[a-z0-9-]{3,60}$/;
const HEX = /^#[0-9a-f]{6}$/;
const DIALABLE = /^\+?\d{10,13}$/;
// A live site's form action on its own site, as data.js accepts it: one leading "/" (never "//" or "/\", which
// browsers read as another site), no spaces, quotes, brackets, control or bidi characters. Written as \u escapes:
// literal bidi characters in source code hide what it really says.
const SAME_SITE_PATH = /^\/(?![/\\])[^\s"'<>()\\\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]*$/;
const URL_MAX = 2048;
// A plain address only: it goes into a mailto: link, so nothing that could add ?cc= or break out of the attribute.
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const PAGE_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_PHOTOS = 6;

// The only event handlers on any page: fixed text, nothing from the lead. A logo that fails to load shows the name
// wordmark after it; a photo that fails removes itself.
const LOGO_FAILED = "this.nextElementSibling.hidden=false;this.remove()";
const PHOTO_FAILED = "this.remove()";

// Shared look. Mobile first, one breakpoint (900 px). Aetos parts (bar, strip, form note) in Charcoal #1A1C20 and
// Eagle Gold #C9A13B with Charcoal text; their colour (--main) only behind white text and for thin lines.
const SHELL_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:#fff;color:#1d2125;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}
body.has-call{padding-bottom:60px}
img,svg{display:block;max-width:100%}
a{color:inherit}
h1,h2,h3{overflow-wrap:anywhere}
[hidden]{display:none!important}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
.ae-bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 16px;background:#1a1c20;color:#fff;font-size:13px;line-height:1.4}
.ae-bar p{min-width:0;margin:0}
.ae-btn{display:inline-block;flex:none;padding:10px 14px;border-radius:8px;background:#c9a13b;color:#1a1c20;font-weight:700;line-height:1.2;text-decoration:none;white-space:nowrap}
.ae-btn:hover,.ae-btn:focus-visible{background:#e2c26a}
.ae-strip{padding:44px 0;background:#1a1c20;color:#fff}
.ae-strip h2{margin:0 0 12px;font-size:26px;line-height:1.25}
.ae-strip p{max-width:680px;margin:0 0 12px}
.ae-strip .ae-for{color:#c9a13b;font-size:14px;font-weight:700;letter-spacing:.04em}
.ae-strip .ae-offer{font-weight:700}
.ae-strip .ae-btn{margin-top:8px;padding:14px 22px}
.note{max-width:560px;margin:0 0 18px;padding:12px 14px;border-left:4px solid #c9a13b;background:#fbf6e9;color:#1d2125;font-size:15px}
.quote{max-width:560px}
.quote fieldset{display:grid;gap:14px;min-width:0;margin:0;padding:0;border:0}
.quote fieldset[disabled]{opacity:.6;cursor:not-allowed}
.quote label{display:grid;gap:6px;font-weight:600}
.quote input,.quote textarea{width:100%;padding:12px 14px;border:1px solid #8a9099;border-radius:8px;background:#fff;color:inherit;font:inherit}
.quote button{justify-self:start;padding:14px 28px;border:0;border-radius:10px;background:var(--main);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.foot{padding:28px 0;background:var(--main);color:#fff;font-size:14px}
.foot p{margin:0 0 6px}
.callbar{position:fixed;right:0;bottom:0;left:0;z-index:20;display:block;padding:16px;overflow:hidden;background:var(--main);color:#fff;font-weight:700;text-align:center;text-decoration:none;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 -2px 12px rgba(0,0,0,.2)}
@media (min-width: 900px){body.has-call{padding-bottom:0}.callbar{display:none}.wrap{padding:0 24px}.ae-bar{padding:10px 24px;font-size:14px}.ae-strip{padding:64px 0}.ae-strip h2{font-size:32px}}`;

// The page for an expired demo and an unknown slug: the Aetos look, nothing else.
const NOTICE_CSS = `*{box-sizing:border-box}
body{display:grid;min-height:100vh;margin:0;padding:24px 16px;place-items:center;background:#1a1c20;color:#fff;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;text-align:center;overflow-wrap:break-word}
main{max-width:520px}
h1{margin:0 0 16px;font-size:28px;line-height:1.2}
p{margin:0 0 12px}
a{color:#c9a13b}
.by{margin:32px 0 0;color:#c9a13b;font-weight:700;letter-spacing:.08em}`;

// The view beacon, exactly as 05-demo.md Task 6 gives it (the slug is checked before it's printed).
const beacon = (slug) => `(function(){if(navigator.webdriver)return;var u="/d/${slug}/e";function s(k){try{navigator.sendBeacon(u,JSON.stringify({kind:k}))}catch(e){}}
setTimeout(function(){if(document.visibilityState==="visible")s("view")},4000);
document.querySelectorAll("[data-ev]").forEach(function(a){a.addEventListener("click",function(){s(a.getAttribute("data-ev"))})});})();`;

const str = (v) => (typeof v === "string" ? v : "");
const list = (v) => (Array.isArray(v) ? v : []);

/** The template for an id; any id that isn't one (also "toString", "__proto__") gets the generic look. */
function templateFor(id) {
  return typeof id === "string" && Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : TEMPLATES.generic;
}

/** The demo's slug ("" when there's no demo row); throws when it isn't one slugFor makes, so it never reaches the
 * script or a link. */
function demoSlug(data) {
  if (!data?.demo) return "";
  const slug = data.demo.slug;
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    throw new Error("This demo's slug isn't valid: it must be 3 to 60 lower-case letters, digits or hyphens.");
  }
  return slug;
}

/** Their colour for CSS: exactly #rrggbb, else Charcoal. */
const colourOf = (data) => (typeof data?.brand?.colour === "string" && HEX.test(data.brand.colour) ? data.brand.colour : CHARCOAL);

const orderLink = (slug) => `<a href="/d/${slug}/order" class="ae-btn" data-ev="order_page">Order this site</a>`;

/** "tel:<digits>" when their phone dials (10–13 digits, leading + kept), else "". */
export function callHref(data) {
  const t = telHref(str(data?.business?.phone_href));
  return DIALABLE.test(t) ? `tel:${t}` : "";
}

/** Their own https photos, logo left out, no repeats, at most 6 (DemoData has done this; checked again here). */
export function photoList(data) {
  const logo = safeHttps(data?.brand?.logo);
  const out = [];
  for (const u of list(data?.brand?.photos)) {
    const url = safeHttps(u);
    if (url && url !== logo && !out.includes(url)) out.push(url);
    if (out.length === MAX_PHOTOS) break;
  }
  return out;
}

/** One of their photos: alt "Work by <name>", width/height, lazy unless it's the top one (fetchpriority high); it
 * removes itself if it fails to load. "" when the URL isn't https. */
export function photoHtml(url, data, { top = false, cls = "" } = {}) {
  const src = safeHttps(url);
  if (!src) return "";
  const load = top ? ' fetchpriority="high"' : ' loading="lazy"';
  return `<img${cls ? ` class="${h(cls)}"` : ""} src="${h(src)}" alt="Work by ${h(data.business.name)}" width="800" height="600"${load} decoding="async" onerror="${PHOTO_FAILED}">`;
}

/** Their logo (52 px high) with their name as the wordmark it falls back to; just the wordmark without an https logo. */
export function logoHtml(data) {
  const name = h(data.business.name);
  const logo = safeHttps(data.brand?.logo);
  if (!logo) return `<span class="wordmark">${name}</span>`;
  return `<img class="logo" src="${h(logo)}" alt="${name} logo" width="160" height="52" onerror="${LOGO_FAILED}"><span class="wordmark" hidden>${name}</span>`;
}

/** "4.8 ★ from 37 Google reviews", only when both are known and the count is above 0; else "". */
export function ratingHtml(data) {
  const r = data?.rating;
  const n = data?.review_count;
  if (!(typeof r === "number" && r > 0 && r <= 5 && Number.isSafeInteger(n) && n > 0)) return "";
  return `<p class="rate">${r.toFixed(1)} ★ from ${n} Google review${n === 1 ? "" : "s"}</p>`;
}

/** A review's stars (its own rating, rounded), read out as "5 out of 5 stars". */
export function starsHtml(rating) {
  const n = Math.min(5, Math.max(0, Math.round(typeof rating === "number" && Number.isFinite(rating) ? rating : 0)));
  return `<span class="stars" role="img" aria-label="${n} out of 5 stars">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
}

/** Live mode's form action: https, or a path on their own site; else "". */
function formAction(data) {
  const a = str(data?.live?.form_action).trim();
  return safeHttps(a) || (a.length <= URL_MAX && SAME_SITE_PATH.test(a) ? a : "");
}

/** Whether the page has a quote form: always in demo mode (disabled), in live mode only with a form action. */
export function hasQuote(data, mode) {
  return mode === "demo" || Boolean(formAction(data));
}

/** The quote form. Demo mode: the "Preview only" note above it and every field inside a disabled fieldset. Live
 * mode: enabled, posting to data.live.form_action; "" when there's none. */
export function quoteHtml(data, mode) {
  const demo = mode === "demo";
  const action = demo ? "" : formAction(data);
  if (!demo && !action) return "";
  const req = demo ? "" : " required";
  const fields = `<label>Your name<input name="name" autocomplete="name"${req}></label>
<label>Your phone number<input name="phone" type="tel" autocomplete="tel"${req}></label>
<label>Your message<textarea name="message" rows="4"></textarea></label>
<button type="submit">Send</button>`;
  return demo
    ? `<p class="note">${h(FORM_NOTE)}</p>\n<form class="quote"><fieldset disabled>\n${fields}\n</fieldset></form>`
    : `<form class="quote" method="post" action="${h(action)}"><fieldset>\n${fields}\n</fieldset></form>`;
}

/**
 * The guarantee strip (demo mode only; each template places it): addressed to the owner, in the Aetos look, with the
 * guarantee lines exactly as data.guarantee gives them (offer.js's GUARANTEE), the offer line for data.offer
 * (weekend deal or not; no prices, those are on the order page) and the "Order this site" button.
 */
export function guaranteeStrip(data) {
  const g = data?.guarantee ?? {};
  const days = data?.offer?.free_days;
  const offer = !(Number.isInteger(days) && days > 0) ? ""
    : data.offer.weekend === true ? `Weekend deal: first ${days} days of the monthly plan free. No contract.`
    : `First ${days} days of the monthly plan free. No contract.`;
  const slug = demoSlug(data);
  return [
    '<section class="ae-strip"><div class="wrap">',
    `<p class="ae-for">For ${h(data?.business?.name)}, from Aetos Websites</p>`,
    `<h2>${h(g.headline)}</h2>`,
    `<p>${h(g.section)}</p>`,
    offer ? `<p class="ae-offer">${h(offer)}</p>` : "",
    slug ? orderLink(slug) : "",
    "</div></section>",
  ].filter(Boolean).join("\n");
}

/** The function that draws `page` in live mode for DemoData without client-site pages (a demo lead's data). A client
 * site's pages (data.live.pages, from sites/sitedata.js) are all drawn by the template's page(). */
function pageOf(tpl, page) {
  if (page === "home") return tpl.home;
  if (typeof page === "string" && page !== "page" && PAGE_NAME.test(page) && typeof tpl[page] === "function") return tpl[page];
  throw new Error(`The ${tpl.TEMPLATE.label} look has no ${JSON.stringify(String(page).slice(0, 40))} page.`);
}

// ---------------------------------------------------------------- client sites (stage 10, live mode only)
//
// A client site's DemoData (sites/sitedata.js) carries data.live.pages: every page of its SiteContent with its JSON-LD
// and canonical URL. renderSite picks the page by path, the template's page(data, mode) lays it out with the pieces
// below, and the shell adds the head (title, meta description, canonical, JSON-LD), the preview bar, the NAP footer,
// the call bar and the chat tag. Nothing here runs for demos, so demo pages stay byte for byte the same.

// The client-site parts (nav, call button, FAQ, map, contact form). Added to the page's CSS only for client sites.
const SITE_CSS = `.home{display:flex;align-items:center;min-width:0;text-decoration:none}
.top-call{display:inline-block;padding:10px 16px;border-radius:10px;background:var(--main);color:#fff;text-decoration:none}
a.top-call{text-decoration-line:none}
.nav{border-top:1px solid #e3e5e8;background:#fff}
.top .nav .wrap{display:block;min-height:0;padding-top:0;padding-bottom:0}
.nav ul{display:flex;flex-wrap:wrap;gap:0 4px;margin:0;padding:0;list-style:none}
.nav a{display:block;padding:12px 10px;font-weight:600;text-decoration:none}
.nav a[aria-current]{box-shadow:inset 0 -3px 0 var(--main)}
.prose{max-width:720px}
.prose p,.prose ul{margin:0 0 14px}
.prose a,.faq a{text-decoration-color:var(--main);text-decoration-thickness:2px;text-underline-offset:3px}
.cards a{display:block;text-decoration:none}
.chips a{text-decoration:none}
.faq{max-width:720px}
.faq h3{margin:20px 0 6px;font-size:19px;line-height:1.3}
.faq p{margin:0}
.map{display:block;width:100%;height:320px;margin-top:20px;border:0;border-radius:12px;background:#e3e5e8}
.reach{max-width:720px;margin:0;padding:0;list-style:none}
.reach li{margin:0 0 8px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.foot a{color:#fff}`;

// The shell's look without the demo's Aetos parts (preview bar, guarantee strip): a client's page carries none of
// them; Nik's preview adds the bar's rules back (PREVIEW_CSS).
const AE_RULE = /\.ae-[^{}]*\{[^{}]*\}/g;
const SITE_SHELL_CSS = SHELL_CSS.split("\n").filter((l) => !l.startsWith(".ae-")).map((l) => l.replace(AE_RULE, "")).join("\n");
const PREVIEW_CSS = `.ae-bar{position:sticky;top:0;z-index:20;padding:8px 16px;background:#1a1c20;color:#fff;font-size:13px;line-height:1.4}
.ae-bar p{margin:0}
.ae-bar a{color:#c9a13b}`;

const SITE_FILE = /^\/s\/f\/[0-9a-f]{32}$/;
// The form's message limit: contact.js's MESSAGE_MAX (section 9). Not imported: contact.js pulls in the outbox.
const MESSAGE_MAX = 2000;
const NOTE_LIVE = "Works once the site is live.";
const BACK = '<a href="/#/sites">Back to the Control Room</a>';

/** Whether DemoData is a client site's (sites/sitedata.js): live mode with its pages. */
const isSiteData = (data) => Array.isArray(data?.live?.pages) && Boolean(data.live.page) && typeof data.live.page === "object";

// A client-site image URL: https, or one of the site's copied files (/s/f/<32 hex>, served on every host).
const siteImage = (u) => (typeof u === "string" && SITE_FILE.test(u) ? u : safeHttps(u));

/** The client site with `page` (a path, or "home" for "/") as its current page; throws for a path it hasn't. */
function sitePage(data, page) {
  const path = page === undefined || page === null || page === "home" ? "/" : page;
  const found = data.live.pages.find((p) => p && p.path === path);
  if (!found) throw new Error(`This site has no page ${JSON.stringify(String(path).slice(0, 80))}.`);
  return { ...data, live: { ...data.live, page: found, ld: list(found.ld), canonical_url: str(found.canonical_url) } };
}

/** The site's photos in content order (pages[].photo indexes them); a photo it can't print is null. */
export function sitePhotos(data) {
  return list(data?.live?.photos).map((p) => (p && siteImage(p.url) ? { url: siteImage(p.url), alt: str(p.alt) } : null));
}

/** The current page's top photo: its own `photo`, else the first photo on the home page; null for none. */
export function siteHeroPhoto(data) {
  const photos = sitePhotos(data);
  const p = data.live.page;
  if (Number.isSafeInteger(p.photo) && photos[p.photo]) return photos[p.photo];
  return p.key === "home" ? photos.find(Boolean) ?? null : null;
}

/** One photo with its alt text and real size: lazy, unless it's the page's top photo (fetchpriority high). */
export function sitePhotoHtml(data, photo, { top = false, cls = "" } = {}) {
  const src = siteImage(photo?.url);
  if (!src) return "";
  const s = data?.live?.photo_sizes?.[src];
  const [w, hgt] = s && Number.isSafeInteger(s.w) && Number.isSafeInteger(s.h) && s.w > 0 && s.h > 0 ? [s.w, s.h] : [800, 600];
  const load = top ? ' fetchpriority="high"' : ' loading="lazy"';
  const alt = str(photo.alt) || `Work by ${str(data.business.name)}`;
  return `<img${cls ? ` class="${h(cls)}"` : ""} src="${h(src)}" alt="${h(alt)}" width="${w}" height="${hgt}"${load} decoding="async" onerror="${PHOTO_FAILED}">`;
}

/** Their logo at 52 px high in its own proportions (lazy: only the top photo isn't), linking home; the name as the
 * wordmark it falls back to. */
function siteLogoHtml(data) {
  const name = h(data.business.name);
  const logo = siteImage(data.brand?.logo);
  const href = h(str(data.live.logo_href) || "/");
  if (!logo) return `<a class="home" href="${href}"><span class="wordmark">${name}</span></a>`;
  const s = data.live.photo_sizes?.[logo];
  const w = s && s.w > 0 && s.h > 0 ? Math.max(1, Math.min(200, Math.round((52 * s.w) / s.h))) : 160;
  return `<a class="home" href="${href}"><img class="logo" src="${h(logo)}" alt="${name} logo" width="${w}" height="52" loading="lazy" decoding="async" onerror="${LOGO_FAILED}"><span class="wordmark" hidden>${name}</span></a>`;
}

// The nav item that is (or holds) the current page.
function currentNav(page) {
  if (page.key === "service") return "/services";
  if (page.key === "area") return "/areas";
  return page.path;
}

/** The site header: logo (home link), the phone as a call button, and the nav (Home … Contact). */
export function siteHeader(data, tel) {
  const phone = data.business.phone;
  const ph = tel ? `<a class="top-ph top-call" href="${h(tel)}">Call ${h(phone)}</a>` : phone ? `<span class="top-ph">${h(phone)}</span>` : "";
  const here = currentNav(data.live.page);
  const items = list(data.live.nav).filter((n) => n && str(n.href).startsWith("/")).map((n) => {
    const cur = n.path === here ? ' aria-current="page"' : "";
    return `<li><a href="${h(n.href)}"${cur}>${h(n.label)}</a></li>`;
  });
  return `<header class="top"><div class="wrap">${siteLogoHtml(data)}${ph}</div><nav class="nav" aria-label="Main"><div class="wrap"><ul>${items.join("")}</ul></div></nav></header>`;
}

/** The current page's sections: [{h2, html}], each body as escaped paragraphs, lists and links (sites/body.js). */
export function siteSections(data) {
  return list(data.live.page.sections).map((s) => ({ h2: str(s?.h2), html: bodyHtml(str(s?.body), data.live.base) }))
    .filter((s) => s.h2 || s.html);
}

/** The page's FAQ as plain questions and answers; "" without one. */
export function siteFaqHtml(data) {
  const faq = list(data.live.page.faq).filter((f) => f && str(f.q) && str(f.a));
  if (!faq.length) return "";
  return `<h2>Questions people ask</h2>\n<div class="faq">${faq.map((f) => `<h3>${h(f.q)}</h3>\n<p>${h(f.a)}</p>`).join("\n")}</div>`;
}

/** Links to the site's service or area pages: [{name, href}]. */
export const siteLinks = (data, kind) => list(data.live[kind]).filter((l) => l && str(l.name) && str(l.href).startsWith("/"));

/** Their reviews from the content (at most `max`), as stage 4 shows them; "" without any. */
export function siteReviewsHtml(data, max = 12, { heading = true } = {}) {
  const items = list(data.reviews).filter((r) => r && typeof r.rating === "number" && str(r.text)).slice(0, max);
  if (!items.length) return "";
  const cards = items.map((r) => `<figure class="rev">${starsHtml(r.rating)}<blockquote>“${h(r.text)}”</blockquote><figcaption>${h(r.author || "Google reviewer")}</figcaption></figure>`);
  return `${heading ? "<h2>What customers say</h2>\n" : ""}<p class="sub">Reviews from Google</p>\n<div class="revs">${cards.join("")}</div>`;
}

/** "Leave us a Google review" as a button, when there's a review link; else "". */
export function siteReviewLink(data) {
  const url = safeHttps(data.live.footer?.review_url);
  return url ? `<p><a class="btn" href="${h(url)}">Leave us a Google review</a></p>` : "";
}

/** The embedded Google map (home and contact): the full address when shown, else the town; "" with neither. */
export function siteMapHtml(data) {
  const q = cleanText(str(data.live.map_query), 300);
  if (!q) return "";
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
  return `<iframe class="map" title="Map of ${h(q)}" src="${h(src)}" loading="lazy"></iframe>`;
}

/** How to reach them (the contact page): phone, email, the address or town, opening hours. */
export function siteReachHtml(data, tel) {
  const nap = data.live.footer?.nap ?? {};
  const email = str(nap.email).trim();
  const rows = [
    tel ? `<li>Phone: <a href="${h(tel)}">${h(nap.phone)}</a></li>` : nap.phone ? `<li>Phone: ${h(nap.phone)}</li>` : "",
    EMAIL.test(email) ? `<li>Email: <a href="mailto:${h(email)}">${h(email)}</a></li>` : "",
    str(nap.address) ? `<li>${h(nap.address)}</li>` : "",
    str(nap.hours) ? `<li>Opening hours: ${h(nap.hours)}</li>` : "",
  ].filter(Boolean);
  return rows.length ? `<ul class="reach">${rows.join("")}</ul>` : "";
}

/**
 * The contact form (section 9): name (required), phone, email, "What do you need?", the hidden honeypot `website`,
 * `t` (milliseconds since the page loaded, set by the 3-line script on submit) and `page`. Posts to
 * data.live.form_action. In Nik's preview (no form action, a preview bar) the note "Works once the site is live."
 * stands in for it; "" when there's neither.
 */
export function siteContactHtml(data) {
  const action = formAction(data);
  if (!action) return str(data.live.preview_bar) ? `<p class="note">${h(NOTE_LIVE)}</p>` : "";
  return `<form class="quote" id="cf" method="post" action="${h(action)}"><fieldset>
<label>Your name<input name="name" autocomplete="name" required></label>
<label>Your phone number<input name="phone" type="tel" autocomplete="tel"></label>
<label>Your email<input name="email" type="email" autocomplete="email"></label>
<label>What do you need?<textarea name="message" rows="5" maxlength="${MESSAGE_MAX}"></textarea></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<input type="hidden" name="t" value="">
<input type="hidden" name="page" value="${h(data.live.page.path)}">
<button type="submit">Send</button>
</fieldset></form>
<script>(function(){var s=Date.now(),f=document.getElementById("cf");
f.addEventListener("submit",function(){f.elements.t.value=String(Date.now()-s);});})();</script>`;
}

// The client site's <footer>: name, phone, town or full address, opening hours, legal line, the review and privacy
// links, "Website by Aetos Websites".
function siteFooter(data, tel, year) {
  const f = data.live.footer ?? {};
  const nap = f.nap ?? {};
  const name = h(data.business.name);
  const phone = tel ? `<a href="${h(tel)}">${h(nap.phone)}</a>` : h(nap.phone);
  const review = safeHttps(f.review_url);
  const privacy = str(f.privacy_href).startsWith("/") ? f.privacy_href : "/privacy";
  const links = [review ? `<a href="${h(review)}">Leave us a Google review</a>` : "", `<a href="${h(privacy)}">Privacy</a>`].filter(Boolean).join(" · ");
  return [
    '<footer class="foot"><div class="wrap">',
    `<p><b>${name}</b>${nap.phone ? ` · ${phone}` : ""}${str(nap.address) ? ` · ${h(nap.address)}` : ""}</p>`,
    str(nap.hours) ? `<p>Opening hours: ${h(nap.hours)}</p>` : "",
    str(f.legal_line) ? `<p>${h(f.legal_line)}</p>` : "",
    `<p>${links}</p>`,
    `<p>© ${year} ${name} · Website by Aetos Websites</p>`,
    "</div></footer>",
  ].filter(Boolean).join("");
}

// A client site's whole page (renderSite in live mode with client-site data).
function renderSitePage(data, tpl, mode, date) {
  const { css, body } = tpl.page(data, mode);
  const live = data.live;
  const p = live.page;
  const tel = callHref(data);
  const canonical = safeHttps(live.canonical_url);
  const ld = list(live.ld);
  const base = /^(?:\/[A-Za-z0-9._~-]+)*$/.test(str(live.base)) ? str(live.base) : "";
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${h(p.title || data.business.name)}</title>`,
    str(p.meta) ? `<meta name="description" content="${h(p.meta)}">` : "",
    live.noindex === true ? '<meta name="robots" content="noindex">' : "",
    canonical ? `<link rel="canonical" href="${h(canonical)}">` : "",
    `<style>:root{--main:${colourOf(data)}}\n${SITE_SHELL_CSS}\n${css}\n${SITE_CSS}${str(live.preview_bar) ? `\n${PREVIEW_CSS}` : ""}</style>`,
    ld.length ? `<script type="application/ld+json">${ldJson(ld)}</script>` : "",
  ].filter(Boolean).join("\n");
  const bar = str(live.preview_bar) ? `<div class="ae-bar"><p>${h(live.preview_bar)} · ${BACK}</p></div>` : "";
  const call = tel ? `<a class="callbar" href="${h(tel)}">Call ${h(data.business.name)}</a>` : "";
  const chat = live.chat === true && !bar ? `<script src="${h(base)}/s/chat.js" defer></script>` : "";
  return `<!doctype html>
<html lang="en-GB">
<head>
${head}
</head>
<body data-template="${h(tpl.TEMPLATE.id)}"${tel ? ' class="has-call"' : ""}>
${[bar, body, siteFooter(data, tel, date.getUTCFullYear()), call, chat].filter(Boolean).join("\n")}
</body>
</html>
`;
}

/**
 * One whole page for DemoData. Demo mode (default) always renders the home page with the preview bar, the guarantee
 * strip, the disabled form, noindex/no-referrer, "Preview by Aetos Websites" and, when views are counted, the beacon.
 * Live mode (stage 10) has none of those: the form posts to data.live.form_action (no form without one) and the page
 * links its canonical URL. `now` only sets the footer's © year.
 *
 * A client site's data (sites/sitedata.js's siteData, with data.live.pages) in live mode is a whole multi-page site:
 * `page` is a path ("/services/roof-repairs"; "home" or none is "/"), and the page gets its own title, meta
 * description, canonical URL and JSON-LD, the nav, the NAP footer and, when on, the chat tag (section 7).
 */
export function renderSite(data, { mode = "demo", page = "home", now = new Date() } = {}) {
  if (mode !== "demo" && mode !== "live") {
    throw new Error(`renderSite's mode must be "demo" or "live" (got ${JSON.stringify(String(mode).slice(0, 20))}).`);
  }
  const isObj = (v) => Boolean(v) && typeof v === "object";
  if (!isObj(data) || !isObj(data.business) || !isObj(data.copy)) {
    throw new TypeError("renderSite needs a lead's DemoData: build it with buildDemoData (demo/data.js).");
  }
  const demo = mode === "demo";
  const tpl = templateFor(data.template);
  if (!demo && isSiteData(data)) {
    const day = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    return renderSitePage(sitePage(data, page), tpl, mode, day);
  }
  const draw = demo ? tpl.home : pageOf(tpl, page);
  const slug = demo ? demoSlug(data) : "";
  const { css, body } = draw(data, mode);

  const name = h(data.business.name);
  const town = h(data.business.town);
  const tel = callHref(data);
  const canonical = demo ? "" : safeHttps(data.live?.canonical_url);
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${name}${town ? ` · ${town}` : ""}</title>`,
    demo ? '<meta name="robots" content="noindex,nofollow">\n<meta name="referrer" content="no-referrer">' : "",
    canonical ? `<link rel="canonical" href="${h(canonical)}">` : "",
    `<style>:root{--main:${colourOf(data)}}\n${SHELL_CSS}\n${css}</style>`,
  ].filter(Boolean).join("\n");

  const bar = demo
    ? `<div class="ae-bar"><p>Preview made for <b>${name}</b> by Aetos Websites · Visits to this page are counted</p>${slug ? orderLink(slug) : ""}</div>`
    : "";
  const aetos = demo ? `<p>Preview by Aetos Websites · <a href="${h(PRIVACY_URL)}">How we use your information</a></p>` : "";
  const foot = `<footer class="foot"><div class="wrap"><p>© ${date.getUTCFullYear()} ${name}${town ? ` · ${town}` : ""}</p>${aetos}</div></footer>`;
  const call = tel ? `<a class="callbar" href="${h(tel)}">Call ${name}</a>` : "";
  const script = slug && data.demo.count_views !== false ? `<script>${beacon(slug)}</script>` : "";

  return `<!doctype html>
<html lang="en-GB">
<head>
${head}
</head>
<body data-template="${h(tpl.TEMPLATE.id)}"${tel ? ' class="has-call"' : ""}>
${[bar, body, foot, call, script].filter(Boolean).join("\n")}
</body>
</html>
`;
}

/** A page in the Aetos look for when there's no demo to show. */
function notice(title, inner) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${h(title)}</title>
<style>${NOTICE_CSS}</style>
</head>
<body>
<main>
${inner}
<p class="by">Aetos Websites</p>
</main>
</body>
</html>
`;
}

/** The expired demo's page (send it with status 410): who it was for, how to get it back, and "or email <address>"
 * when their thread has a mailbox. */
export function renderExpired(info = {}) {
  const { name = "", contact_email = "" } = info ?? {};
  const who = shortName(cleanText(name));
  const email = String(contact_email ?? "").trim();
  const mail = EMAIL.test(email) ? `\n<p>or email <a href="mailto:${h(email)}">${h(email)}</a></p>` : "";
  return notice("Preview ended", `<h1>This preview has ended</h1>
<p>${h(`The website we made for ${who || "you"} is no longer on show. Reply to our email and we'll switch it back on.`)}</p>${mail}`);
}

/** An unknown demo link's page (send it with status 404). It never says whose. */
export function renderNotFound() {
  return notice("Page not found", `<h1>${h("This page doesn't exist.")}</h1>`);
}
