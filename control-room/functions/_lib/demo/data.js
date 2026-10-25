// DemoData (pure): one lead and its research turned into exactly what a demo template prints (05-demo.md Part A §3–§5).
// Only their real data goes in: their name, phone, town, Claude's copy about them, their own https photos and logo,
// their colour (if white text reads on it) and their real rated Google reviews. Nothing missing is padded: no default
// services, no stock photos, no invented numbers; the template hides what's empty. Text is cleaned and clipped here
// (cleanText); escaping happens when it's printed (h()). The offer and the guarantee come from offer.js only.
//
// Safe on Workers: no node: imports and nothing runs at load (shortlist-db.js imports this module lazily for
// templateIdFor). Tested in control-room/tests/demo-data.test.mjs with tests/fixtures/demo-fixtures.mjs.
import { GUARANTEE, offerFor } from "../offer.js";
import { parseJson } from "../util.js";
import { pickColour } from "./colour.js";
import { cleanText, safeHttps, shortAuthor, shortName, telHref } from "./text.js";

// Trades that get the landscaper look (Part A §7); every other trade gets the generic one. No g flag: test() with g
// remembers where it stopped and would answer differently next time.
const LANDSCAPER_TRADE = /landscap|garden|lawn|turf|paving|patio|fenc/i;
// A demo slug as slugFor makes it; it's printed into a link and the view beacon's script.
const SLUG = /^[a-z0-9-]{3,60}$/;
// A live site's form action on its own site ("/c/<slug>/s/contact"), when it isn't a full https:// URL: one leading
// "/" (never "//" or "/\", which browsers read as another site), no spaces, quotes, brackets, control or bidi characters.
const SAME_SITE_PATH = /^\/(?![/\\])[^\s"'<>()\\\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]*$/;
const URL_MAX = 2048;

// Part A §4 clipping (characters, cut at a word with "…") and the caps of the Global Constraints.
const CLIP = Object.freeze({ headline: 90, intro: 300, about: 700, service: 60, area: 40, review: 320 });
const MAX_SERVICES = 8;
const MAX_AREAS = 12;
const MAX_PHOTOS = 6;
const MAX_REVIEWS = 3;
const REVIEW_MIN_WORDS = 8;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A JSON column as D1 gives it (text) or already parsed (an object): the object, or null.
function objectOf(v) {
  const o = typeof v === "string" ? parseJson(v, null) : v;
  return isObj(o) ? o : null;
}

// Cleaned text of a value that is text; anything else (numbers, objects, null) is "".
const text = (v, max) => cleanText(typeof v === "string" ? v : "", max);

// A number from D1: a number, or plain decimal text ("4.8", "37"); NaN otherwise (never hex like "0x25", "1e3" or
// "Infinity", which Number() would also read).
const DECIMAL = /^\s*\d+(?:\.\d+)?\s*$/;
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && DECIMAL.test(v) ? Number(v) : NaN);

// Trade words that are abbreviations, written the way people write them ("hvac" is a trade the scraper searches).
const ACRONYMS = Object.freeze({ hvac: "HVAC", upvc: "uPVC", cctv: "CCTV", mot: "MOT", ev: "EV" });
// What the lead-manager's brand.top_reviews writes for a review without a name; shortAuthor would turn it into
// "Google R.", as if a person called Google had written it.
const NO_AUTHOR = /^google reviewer$/i;

/** The look a trade gets: "landscaper" for /landscap|garden|lawn|turf|paving|patio|fenc/i, else "generic". */
export function templateIdFor(trade) {
  return LANDSCAPER_TRADE.test(String(trade ?? "")) ? "landscaper" : "generic";
}

// The trade as a page shows it: title-cased ("Heating Engineer", abbreviations as "HVAC"), "Landscaper(s)" as
// "Landscaping".
function tradeLabel(trade) {
  const t = text(trade);
  if (/^landscapers?$/i.test(t)) return "Landscaping";
  return t.toLowerCase().replace(/[^\s-]+/g, (w) => (Object.hasOwn(ACRONYMS, w) ? ACRONYMS[w] : w[0].toUpperCase() + w.slice(1)));
}

// A review's author as the page shows it: "Sarah K.", "Google reviewer" when there's no name (also when the lead
// manager already wrote "Google reviewer").
function authorOf(author) {
  const a = text(author);
  return NO_AUTHOR.test(a) ? "Google reviewer" : shortAuthor(a);
}

// Text items of a list: cleaned, clipped to `max` characters each, empty and repeated (any case) ones dropped, at
// most `n`.
function textList(list, max, n) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (out.length === n) break;
    const s = text(item, max);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Their own photos: https only (http would be blocked on our https page), never the logo again, no repeats, max 6.
function photosOf(list, logo) {
  const out = [];
  for (const u of Array.isArray(list) ? list : []) {
    if (out.length === MAX_PHOTOS) break;
    const url = safeHttps(u);
    if (url && url !== logo && !out.includes(url)) out.push(url);
  }
  return out;
}

// A review's own Google rating, when it is a real one of 4 or 5 stars: never assumed, never text.
const goodRating = (r) => typeof r === "number" && Number.isFinite(r) && r >= 4 && r <= 5;

// Their real Google reviews: rated 4–5 with 8+ words, the 3 longest (ties keep Google's order), author as "Sarah K.",
// text clipped at 320 characters.
function reviewsOf(list) {
  const good = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!isObj(r) || !goodRating(r.rating)) continue;
    const full = text(r.text);
    if (!full || full.split(" ").length < REVIEW_MIN_WORDS) continue;
    good.push({ author: authorOf(r.author), rating: r.rating, full });
  }
  good.sort((a, b) => b.full.length - a.full.length); // stable: equal lengths keep their order
  return good.slice(0, MAX_REVIEWS).map((r) => ({ author: r.author, rating: r.rating, text: cleanText(r.full, CLIP.review) }));
}

// Google rating (1 decimal) and review count, only when both are above 0: the rating as shown must be a real Google
// one of 1 to 5 (0.04 would read "0 ★") and the count a whole number.
function ratingOf(lead) {
  const rating = Math.round(num(lead.rating) * 10) / 10;
  const count = num(lead.review_count);
  const shown = rating >= 1 && rating <= 5 && Number.isSafeInteger(count) && count > 0;
  return shown ? { rating, review_count: count } : { rating: null, review_count: null };
}

// Their headline, else "<Trade> in <Town>", else their name (never empty).
function headlineOf(copy, name, trade, town) {
  const own = text(copy.headline, CLIP.headline);
  if (own) return own;
  return cleanText(trade && town ? `${trade} in ${town}` : name || trade || town || "Welcome", CLIP.headline);
}

// The offer as the page uses it. One that can't be read is replaced whole by the real one for `now`, so the weekend
// flag and the free days always come from the same place.
function offerOf(offer, now) {
  const days = isObj(offer) && isObj(offer.full) ? offer.full.freeDays : undefined;
  const usable = isObj(offer) && typeof offer.weekend === "boolean" && Number.isInteger(days) && days > 0;
  const o = usable ? offer : offerFor(now);
  return { weekend: o.weekend, free_days: o.full.freeDays };
}

function demoOf(demo) {
  if (!demo) return null;
  const slug = typeof demo.slug === "string" ? demo.slug : "";
  if (!SLUG.test(slug)) {
    throw new Error(`This demo's slug isn't valid: it must be 3 to 60 lower-case letters, digits or hyphens (got ${JSON.stringify(slug.slice(0, 70))}).`);
  }
  return { slug, order_url: `/d/${slug}/order`, count_views: Boolean(demo.count_views ?? true) };
}

function liveOf(live) {
  if (!isObj(live)) return null;
  const action = typeof live.form_action === "string" ? live.form_action.trim() : "";
  const path = action.length <= URL_MAX && SAME_SITE_PATH.test(action) ? action : "";
  return { form_action: safeHttps(action) || path, canonical_url: safeHttps(live.canonical_url) };
}

/**
 * The DemoData contract (05-demo.md Task 4) for one lead. `lead` is a raw `leads` row (`audit` as JSON text or an
 * object); `research` a raw `research` row (`copy` as JSON text or an object) or null. `offer` is offerFor(now)'s
 * result (offerFor(now) itself when missing). `demo` = {slug, count_views?} in demo mode, null in live mode; `live` =
 * {form_action, canonical_url} for stage 10. Throws when there's no lead or the demo's slug isn't one slugFor makes.
 */
export function buildDemoData({ lead, research = null, demo = null, offer, now = new Date(), live = null } = {}) {
  if (!isObj(lead)) throw new TypeError("buildDemoData needs the lead: its row from the leads table.");
  const template = templateIdFor(lead.trade);
  const audit = objectOf(lead.audit) ?? {};
  const brand = objectOf(audit.brand) ?? {};
  const copy = (isObj(research) && objectOf(research.copy)) || {};

  const name = shortName(text(lead.name));
  const trade = tradeLabel(lead.trade);
  const town = text(lead.town) || text(lead.search_town);
  const phone = text(lead.phone);
  const logo = safeHttps(brand.logo);
  const { colour, source } = pickColour(brand.colour, template);
  const { rating, review_count } = ratingOf(lead);

  return {
    template,
    business: {
      name, trade, phone, phone_href: telHref(phone), town,
      areas: textList(copy.areas, CLIP.area, MAX_AREAS),
      services: textList(copy.services, CLIP.service, MAX_SERVICES),
    },
    brand: { logo, colour, colour_source: source, photos: photosOf(brand.photos, logo) },
    reviews: reviewsOf(audit.reviews),
    rating,
    review_count,
    copy: {
      headline: headlineOf(copy, name, trade, town),
      intro: text(copy.intro, CLIP.intro),
      about: text(copy.about, CLIP.about),
    },
    guarantee: GUARANTEE,
    offer: offerOf(offer, now),
    demo: demoOf(demo),
    live: liveOf(live),
  };
}
