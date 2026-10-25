// Quality checks for a rendered demo page (pure, regex only, no DOM). checkDemoHtml(html, data, {mode, now}) returns
// plain-English problems; [] means the page may be shown. The Demo page lists them under each preview and
// GET /api/demo/check runs them on real leads, so each message is exact. Only noindex, the preview bar and the disabled
// form depend on mode ("demo" by default); stage 10 can reuse the rest on a live site.
// "What a person sees" for the numbers and claims checks is the visible text plus the words shown from attributes
// (placeholder, title, alt, an input's value), so a "Get a free quote" button or a made-up placeholder phone number
// can't slip through. The disabled-form check also fails on a field or button left outside the disabled fieldset.
// Tested in control-room/tests/demo-check.test.mjs.
import { GUARANTEE, PACKAGES } from "../offer.js";

/** Claims the template's own wording must never make: shown only when their own data says it. */
export const BANNED_CLAIMS = ["free quote", "fully insured", "years of experience", "24/7", "family run", "award", "no.1", "best"];

const MAX_BYTES = 100000;
// The characters h() removes (as in demo/text.js). Written as \u escapes: literal bidi characters in source code hide
// what it really says.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", middot: "·",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", pound: "£",
  euro: "€", times: "×", deg: "°", star: "☆", starf: "★",
};
// Numbers as a person reads them: "1,250", "4.8", "37". Thousands separators only between groups of three.
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
// A tag's unquoted part never runs past another "<" (h() escapes every "<" in text and attributes), which also keeps
// these regexes linear on hostile input like "<a<a<a…".
const TAG = /<([a-z][a-z0-9-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
// Form controls and fieldsets, opening and closing, in page order (for the disabled-form check).
const FORM_TAG = /<(\/?)(fieldset|input|textarea|select|button)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi;
// Input types whose value attribute isn't shown as words on the page.
const VALUE_NOT_SHOWN = new Set(["hidden", "checkbox", "radio", "file", "image", "color", "range"]);
// toFixed() takes at most 100 places; nobody formats a rating or count with more than a few.
const MAX_PLACES = 20;

/** Entities decoded the way a browser shows them (numeric ones and the common named ones; unknown ones left alone). */
function decode(s) {
  return s.replace(/&(?:#(\d{1,8})|#x([0-9a-f]{1,7})|([a-z][a-z0-9]{1,31}));?/gi, (m, dec, hex, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name] : m;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
  });
}

/** The page without comments, and without what's inside <script> and <style> (their opening tags kept). */
function markupOf(html) {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/(<(script|style)\b[^<>]*>)[\s\S]*?(?:<\/\2\s*>|$)/gi, "$1 ");
}

/** A tag's attributes: Map(lower-case name → decoded value, "" when it has none); the first one of a name wins. */
function attrsOf(rest) {
  const attrs = new Map();
  for (const [, k, dq, sq, bare] of rest.matchAll(ATTR)) {
    const key = k.toLowerCase();
    if (!attrs.has(key)) attrs.set(key, decode(dq ?? sq ?? bare ?? ""));
  }
  return attrs;
}

/** Every opening tag: { name (lower-case), attrs }. */
function tagsOf(markup) {
  const out = [];
  for (const [, name, rest] of markup.matchAll(TAG)) out.push({ name: name.toLowerCase(), attrs: attrsOf(rest) });
  return out;
}

/** Words a person sees that live in attributes: placeholders, tooltips, alt text, the words on input buttons. */
function shownAttrText(tags) {
  const out = [];
  for (const t of tags) {
    for (const k of ["placeholder", "title", "alt"]) if (t.attrs.get(k)) out.push(t.attrs.get(k));
    const type = (t.attrs.get("type") || "").trim().toLowerCase();
    if (t.name === "input" && t.attrs.get("value") && !VALUE_NOT_SHOWN.has(type)) out.push(t.attrs.get("value"));
  }
  return out.join(" \n ").replace(/\s+/g, " ").trim();
}

/** Demo mode: there's a fieldset, every fieldset is disabled, and no input, textarea, select or button sits outside
 * them unless it's disabled itself (a send button below the fieldset would still be live). */
function formDisabled(markup) {
  let fieldsets = 0;
  let depth = 0;
  for (const [, close, rawName, rest] of markup.matchAll(FORM_TAG)) {
    const name = rawName.toLowerCase();
    if (close) {
      if (name === "fieldset") depth = Math.max(0, depth - 1);
      continue;
    }
    const disabled = attrsOf(rest).has("disabled");
    if (name === "fieldset") {
      if (!disabled) return false;
      fieldsets++;
      depth++;
    } else if (!depth && !disabled) return false;
  }
  return fieldsets > 0;
}

/** What a person reads: no <style>, <script>, comments or tags, entities decoded, whitespace collapsed. */
function visibleText(markup) {
  const noScripts = markup.replace(/<(script|style)\b[^<>]*>/gi, " ");
  // Quote-aware first (a ">" inside a quoted attribute doesn't end the tag), then whatever is left of a broken tag.
  const noTags = noScripts.replace(/<[a-z!?\/](?:[^<>"']|"[^"]*"|'[^']*')*>/gi, " ").replace(/<[a-z!?\/][^<>]*>/gi, " ");
  return decode(noTags).replace(/\s+/g, " ").trim();
}

/** Every string inside `data` (values only, never key names), each once. */
function stringsOf(data) {
  const out = new Set();
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === "string") out.add(v);
    else if (v && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
    }
  };
  walk(data);
  return [...out];
}

/** Every number inside `data` (numbers, and numbers written inside its strings). */
function numbersOf(data, strings) {
  const out = [];
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (v && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
    }
  };
  walk(data);
  for (const s of strings) for (const [t] of s.matchAll(NUMBER)) out.push(Number(t.replace(/,/g, "")));
  return out;
}

function jsonOf(data) {
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    return "";
  }
}

const runsOf = (s) => s.match(/\d+/g) ?? [];

/** "family run" also matches "Family-run", "no.1" also "No. 1"; whole words only, any case, plural/-ed/-ing too. */
function claimPattern(claim) {
  const body = [...claim].map((c) => {
    if (c === " ") return "[\\s\\-\\u2010-\\u2015]+"; // space, hyphen or a Unicode dash
    if (c === ".") return "\\.?\\s*";
    if (c === "/") return "\\s*\\/\\s*";
    return c.replace(/[\\^$*+?()[\]{}|]/g, "\\$&");
  }).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, "iu");
}
const CLAIM_PATTERNS = BANNED_CLAIMS.map((claim) => [claim, claimPattern(claim)]);

function loadsOutside(tags, html) {
  // src, or href / xlink:href on an SVG <script>.
  if (tags.some((t) => t.name === "script" && ["src", "href", "xlink:href"].some((k) => t.attrs.has(k)))) return true;
  const outsideLink = (t) => {
    const rel = (t.attrs.get("rel") || "").toLowerCase().split(/\s+/);
    const as = (t.attrs.get("as") || "").toLowerCase();
    return rel.includes("stylesheet") || rel.includes("modulepreload") || rel.includes("import")
      || (rel.includes("preload") && ["script", "style", "font"].includes(as));
  };
  if (tags.some((t) => t.name === "link" && outsideLink(t))) return true;
  const noComments = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  const css = [...noComments.matchAll(/<style\b[^<>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)].map((m) => m[1])
    .concat(tags.map((t) => t.attrs.get("style") || ""));
  return css.some((c) => /@import\b/i.test(c) || /@font-face\s*\{[^{}@]*url\(\s*["']?\s*(?!data:)/i.test(c));
}

/**
 * Plain-English problems with a rendered page, in a fixed order; [] = pass. `data` is the DemoData it was rendered
 * from: every number shown must come from it, the guarantee (3, 90), the offer line (60/90) or this year, and no
 * banned claim may appear unless their data says it.
 */
export function checkDemoHtml(html, data, { mode = "demo", now = new Date() } = {}) {
  const page = typeof html === "string" ? html : String(html ?? "");
  const demo = mode !== "live";
  const problems = [];
  const add = (p) => { if (!problems.includes(p)) problems.push(p); };

  const markup = markupOf(page);
  const tags = tagsOf(markup);
  const text = visibleText(markup);
  const attrText = shownAttrText(tags);
  const strings = stringsOf(data);
  // As h() shows them on the page: control and bidi characters removed.
  const shown = strings.map((s) => s.replace(INVISIBLE, ""));
  const metas = tags.filter((t) => t.name === "meta");
  const meta = (name) => metas.filter((t) => (t.attrs.get("name") || "").toLowerCase() === name).map((t) => t.attrs.get("content") || "");

  const bytes = new TextEncoder().encode(page).length;
  if (bytes >= MAX_BYTES) add(`Page is ${Math.ceil(bytes / 1000)} KB (limit 100 KB)`);

  if (loadsOutside(tags, page)) add("Loads an outside script or stylesheet");

  if (demo && !meta("robots").some((c) => /(^|[\s,])noindex([\s,]|$)/i.test(c))) add("Missing noindex");

  const imgs = tags.filter((t) => t.name === "img");
  if (imgs.some((t) => !(t.attrs.get("alt") || "").trim())) add("Image without alt text");
  if (imgs.slice(2).some((t) => (t.attrs.get("loading") || "").trim().toLowerCase() !== "lazy")) add("Image below the top isn't lazy-loaded");

  const date = now instanceof Date ? now : new Date(now);
  const year = Number.isFinite(date.getTime()) ? String(date.getUTCFullYear()) : "";
  const numbers = numbersOf(data, shown);
  // Digit runs as written: their strings as h() shows them, their number fields (also in the JSON, which can fail on
  // odd input), never a number re-read from a string ("07969" doesn't make "7969" theirs).
  const runs = new Set([jsonOf(data), ...shown, ...numbersOf(data, []).map(String), GUARANTEE.headline,
    GUARANTEE.section, String(PACKAGES.full.freeDays), String(PACKAGES.weekend.freeDays), year].flatMap(runsOf));
  const allowed = (t) => {
    const plain = t.replace(/,/g, "");
    if (runsOf(t).every((r) => runs.has(r)) || runsOf(plain).every((r) => runs.has(r))) return true;
    const dot = plain.indexOf(".");
    const places = plain.length - dot - 1;
    return dot > 0 && places <= MAX_PLACES && numbers.some((n) => n.toFixed(places) === plain); // "5.0" for 5, "4.8" for 4.83
  };
  for (const src of [text, attrText]) for (const [t] of src.matchAll(NUMBER)) if (!allowed(t)) add(`Number "${t}" isn't in their data`);

  // Their words only: an image file name or a link ("…/best-patio.jpg") isn't them saying it.
  const theirs = shown.filter((s) => !/^\s*(?:https?:|\/)/i.test(s)).join("\n");
  for (const [claim, re] of CLAIM_PATTERNS) {
    if ((re.test(text) || re.test(attrText)) && !re.test(theirs)) add(`Says "${claim}" but their data doesn't`);
  }

  if (demo) {
    const bar = tags.some((t) => (t.attrs.get("class") || "").split(/\s+/).includes("ae-bar"));
    if (!bar || !text.includes("Preview made for")) add("Preview bar missing");
    if (!formDisabled(markup)) add("Quote form isn't disabled");
  }

  // The message shows the string without its control and bidi characters: the Control Room's esc() keeps those, and a
  // right-to-left override would turn the rest of the problem list around.
  strings.forEach((s, i) => {
    if (!/[<>"]/.test(s)) return;
    if (page.includes(s) || page.includes(shown[i])) add(`Unescaped text: ${[...shown[i]].slice(0, 30).join("")}`);
  });

  if (!meta("viewport").some((c) => /(^|[\s,;])width\s*=\s*device-width\b/i.test(c))) add("Missing mobile viewport");

  return problems;
}
