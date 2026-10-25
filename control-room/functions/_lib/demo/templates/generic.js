// The "Everything else" look (05-demo.md Part A §3, Task 6): the demo template for every trade that isn't a landscaper.
// home(data, mode) lays out the sections between the shell's preview bar and footer (render.js owns those, the
// guarantee strip and the shared pieces imported below). Section order is Part A §3's list: hero, services, recent
// work, areas, reviews, guarantee strip (demo mode only), about, contact. Empty sections are left out, never padded:
// only their data is shown, and the template's own words make no claims (no numbers, no "free quote", no "best").
// Any change to what this renders must bump TEMPLATE.version, so Nik approves the new look before emails link to it.
import { SERVICES_PLACEHOLDER, callHref, guaranteeStrip, hasQuote, logoHtml, photoHtml, photoList, quoteHtml, ratingHtml, starsHtml } from "../render.js";
import { h } from "../text.js";

export const TEMPLATE = Object.freeze({ id: "generic", version: 1, label: "Everything else" });

const MAX_SERVICES = 8;
const MAX_AREAS = 12;
const MAX_REVIEWS = 3;

// The photo-free hero's line icon (a map pin: a local business, whatever the trade).
const ICON = '<svg class="hero-icon" viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M32 58S12 38.5 12 25a20 20 0 0 1 40 0C52 38.5 32 58 32 58z"/><circle cx="32" cy="25" r="7"/></svg>';

// Mobile first; one desktop block. --main only behind white text and for thin accent lines.
// The desktop hero's columns are minmax(0, …): a 1fr column grows to fit its longest word (an intro with a web
// address), which would push the page sideways. A photo that fails to load removes itself; when none in Recent work
// loads (a host that blocks hot-linking), the section hides instead of showing "Recent work" over nothing.
const CSS = `.top{background:#fff;border-bottom:1px solid #e3e5e8}
.top .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;min-height:72px;padding-top:10px;padding-bottom:10px}
.logo{width:auto;height:52px;max-width:200px;object-fit:contain}
.wordmark{min-width:0;font-size:20px;font-weight:800;line-height:1.25}
.top-ph{font-weight:700;text-decoration:none;white-space:nowrap}
a.top-ph{text-decoration-line:underline;text-decoration-color:var(--main);text-decoration-thickness:2px;text-underline-offset:4px}
.hero{padding:36px 0 40px;background:#f5f6f7;border-bottom:4px solid var(--main)}
.hero-grid{display:flex;flex-direction:column}
.hero h1{margin:0 0 12px;font-size:32px;line-height:1.15}
.intro{margin:0 0 16px;font-size:18px}
.rate{display:inline-block;margin:0 0 20px;padding:6px 14px;border:1px solid #d5d8dc;border-radius:99px;background:#fff;font-size:15px;font-weight:600}
.btns{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-block;padding:12px 20px;border:2px solid var(--main);border-radius:10px;background:var(--main);color:#fff;font-weight:700;text-decoration:none}
.btn-alt{background:#fff;color:#1d2125}
.hero-img{width:100%;height:auto;margin-top:24px;aspect-ratio:4/3;border-radius:12px;background:#e3e5e8;object-fit:cover}
.hero-icon{order:-1;width:56px;height:56px;margin:0 0 16px}
.hero-plain{border-bottom:0;background:var(--main) repeating-linear-gradient(135deg,rgba(0,0,0,.14) 0 2px,transparent 2px 18px);color:#fff}
.hero-plain .rate{border-color:rgba(255,255,255,.55);background:rgba(0,0,0,.28)}
.hero-plain .btn{border-color:#fff;background:#fff;color:#1d2125}
.hero-plain .btn-alt{background:transparent;color:#fff}
.sec{padding:44px 0}
.alt{background:#f5f6f7}
.sec h2{margin:0 0 20px;font-size:26px;line-height:1.2}
#quote{scroll-margin-top:72px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:12px;margin:0;padding:0;list-style:none}
.card{padding:16px 18px;border:1px solid #e3e5e8;border-left:4px solid var(--main);border-radius:10px;background:#fff;font-weight:600}
.card-ph{border:2px dashed #8a9099;font-weight:400}
.card-ph b{display:block}
.card-ph small{color:#5c6066;font-size:14px}
.work{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.work img{width:100%;height:auto;aspect-ratio:4/3;border-radius:10px;background:#e3e5e8;object-fit:cover}
#work:has(.work:empty){display:none}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.chips li{max-width:100%;padding:6px 14px;border:1px solid var(--main);border-radius:99px;background:#fff}
.sub{margin:-12px 0 20px;color:#5c6066}
.revs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
.rev{margin:0;padding:20px;border:1px solid #e3e5e8;border-radius:12px;background:#fff}
.stars{color:#8a5a00;letter-spacing:2px}
.rev blockquote{margin:8px 0 12px}
.rev figcaption{color:#5c6066;font-weight:600}
.text{max-width:720px;margin:0}
@media (min-width: 900px){.hero{padding:72px 0}.hero h1{font-size:46px}.hero-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:48px;align-items:center}.hero-img{margin-top:0}.hero-icon{order:0;width:180px;height:180px;margin:0 auto}.sec{padding:64px 0}.sec h2{font-size:32px}.work{grid-template-columns:repeat(3,1fr);gap:14px}}`;

const texts = (v, n) => (Array.isArray(v) ? v : []).filter((s) => typeof s === "string" && s).slice(0, n);

function header(data, tel) {
  const phone = data.business.phone;
  const ph = tel ? `<a class="top-ph" href="${h(tel)}">${h(phone)}</a>` : phone ? `<span class="top-ph">${h(phone)}</span>` : "";
  return `<header class="top"><div class="wrap">${logoHtml(data)}${ph}</div></header>`;
}

// Headline, intro, rating badge, the two buttons; their first photo beside (desktop) or below (mobile) the text, or
// the photo-free panel in their colour with the line icon.
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
  const art = photos.length ? photoHtml(photos[0], data, { top: true, cls: "hero-img" }) : ICON;
  return `<section class="hero${photos.length ? "" : " hero-plain"}"><div class="wrap hero-grid">\n${text}\n${art}\n</div></section>`;
}

// One card per service of theirs; none → the dashed placeholder card (demo mode only, never a trade's default list).
function services(data, mode) {
  const items = texts(data.business.services, MAX_SERVICES);
  if (items.length) return `<h2>What we do</h2>\n<ul class="cards">${items.map((s) => `<li class="card">${h(s)}</li>`).join("")}</ul>`;
  if (mode !== "demo") return "";
  return `<h2>What we do</h2>\n<ul class="cards"><li class="card card-ph"><b>${h(SERVICES_PLACEHOLDER.title)}</b><small>${h(SERVICES_PLACEHOLDER.label)}</small></li></ul>`;
}

// Photos 2–6, only when there are 2 or more.
function work(data, photos) {
  if (photos.length < 2) return "";
  return `<h2>Recent work</h2>\n<div class="work">${photos.slice(1).map((u) => photoHtml(u, data)).join("")}</div>`;
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
    ["services", services(data, mode)],
    ["work", work(data, photos)],
    ["areas", areas(data)],
    ["reviews", reviews(data)],
    ["strip", mode === "demo" ? guaranteeStrip(data) : ""],
    ["about", about(data)],
    ["quote", quote ? `<h2>Ask for a quote</h2>\n${quoteHtml(data, mode)}` : ""],
  ].filter(([, html]) => html);
  let tone = 0; // white and light grey take turns, whichever sections are shown
  const sections = blocks.map(([id, html]) => (id === "strip" ? html
    : `<section class="sec${tone++ % 2 ? " alt" : ""}" id="${id}"><div class="wrap">\n${html}\n</div></section>`));
  return { css: CSS, body: [header(data, tel), "<main>", hero(data, photos, tel, quote), ...sections, "</main>"].join("\n") };
}
