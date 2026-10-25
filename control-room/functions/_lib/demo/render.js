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
import { CHARCOAL } from "./colour.js";
import { cleanText, h, safeHttps, shortName, telHref } from "./text.js";
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

/** The function that draws `page` in live mode (stage 10 adds pages beyond home to the templates). */
function pageOf(tpl, page) {
  if (page === "home") return tpl.home;
  if (typeof page === "string" && PAGE_NAME.test(page) && typeof tpl[page] === "function") return tpl[page];
  throw new Error(`The ${tpl.TEMPLATE.label} look has no ${JSON.stringify(String(page).slice(0, 40))} page.`);
}

/**
 * One whole page for DemoData. Demo mode (default) always renders the home page with the preview bar, the guarantee
 * strip, the disabled form, noindex/no-referrer, "Preview by Aetos Websites" and, when views are counted, the beacon.
 * Live mode (stage 10) has none of those: the form posts to data.live.form_action (no form without one) and the page
 * links its canonical URL. `now` only sets the footer's © year.
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
