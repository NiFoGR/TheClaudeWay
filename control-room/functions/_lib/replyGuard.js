// Reply guard (pure): the server's checks on every reply Claude writes (stage 7, Part A "Checks on every reply"). A
// reply that fails is refused with HTTP 422 and these reasons, in the order of Part A's table, each once; Claude fixes
// it (2 tries at most) or escalates. Nik's own replies are never checked: they're his words. The call-day check
// ("Your reply doesn't mention Tuesday…") needs the slot, so it's the reply route's, not this module's.
//
// ctx: {offer: offerFacts(send_at) from offer.js, hosts: REPLY_HOSTS, slug: the lead's latest demo slug or null,
// signName: the business:sender_name setting}. The guard is pure and never throws on what Claude sends.
//
// Claude's text is untrusted (an inbound email can try to steer it), so every check is written against the ways a
// rule could be got round: a link without https://, "aetoswebsites.com@bit.ly", fullwidth letters, zero-width
// characters inside "SEO", "1950 quid", "£1.95k". A host passes only when it is exactly one of ctx.hosts.
import { formatPounds } from "./offer.js";

export const REPLY_HOSTS = ["aetoswebsites.com", "www.aetoswebsites.com"];

const MAX_WORDS = 180;

// Letters of other scripts that can make up a host name (IDN), kept as plain ranges: Unicode property classes take
// tens of ms to compile in a fresh Worker isolate (see _lib/mail/rules.js).
const NA = "À-ʯͰ-῿Ⰰ-ⷿ぀-퟿豈-﷿ﹰ-ﻼ";
const X = `A-Za-z0-9${NA}`;
const LABEL = `[${X}](?:[${X}-]*[${X}])?`;

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
// Each kind starts only where a word does (the lookbehinds), so a long run of letters is tried once, not from every
// letter (which would take time growing with the square of its length).
const EMAIL_RE = new RegExp(`(?<![${X}._%+-])[${X}._%+-]+@${LABEL}(?:\\.${LABEL})*\\.[A-Za-z${NA}]{2,}`, "g");
const BARE_RE = new RegExp(
  `(?<![${X}]|[${X}-]\\.|[${X}]-)((?:${LABEL}\\.)+([A-Za-z${NA}]{2,63}))(?![${X}-])((?::\\d+)?(?:[/?#\\\\][^\\s<>"]*)?)`,
  "g",
);
// Endings that make a bare "name.ending" a link even when written "Name.Com". Any other ending counts when it's all
// lower or all upper case ("bit.ly", "evil.click", "BIT.LY") or has a path; "St.Albans" or "Sure.It" doesn't.
const KNOWN_ENDINGS = new Set(["uk", "com", "net", "org", "io", "biz", "info", "co", "me", "eu", "ie", "london",
  "wales", "scot", "cymru", "online", "site", "website", "shop", "store", "tech", "app", "dev", "xyz", "ly", "ai"]);

// What a sentence puts after a link, which isn't part of it.
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "‘", "’", "“", "”", "»",
  "…", "*", ")", "]", "}", ">"]);
const count = (text, ch) => text.split(ch).length - 1;
function trimLink(link) {
  const opened = { ")": count(link, "("), "]": count(link, "["), "}": count(link, "{") };
  const closed = { ")": count(link, ")"), "]": count(link, "]"), "}": count(link, "}") };
  let end = link.length;
  while (end > 0 && TRAILING.has(link[end - 1])) {
    const ch = link[end - 1];
    if (ch in closed) {
      if (opened[ch] >= closed[ch]) break;
      closed[ch] -= 1;
    }
    end -= 1;
  }
  return link.slice(0, end);
}

const cleanHost = (h) => h.toLowerCase().replace(/\.+$/, "");
const blank = (text, start, length) => text.slice(0, start) + " ".repeat(length) + text.slice(start + length);

/** Every host and path linked in `s`, and every email address (never also counted as a host). */
function linksIn(s) {
  const links = []; // {host, path}
  const emails = [];
  let rest = s;
  for (const m of s.matchAll(URL_RE)) {
    const link = trimLink(m[0]);
    rest = blank(rest, m.index, m[0].length);
    const after = link.replace(/^https?:\/\//i, "");
    const cut = after.search(/[/?#\\]/);
    const authority = cut < 0 ? after : after.slice(0, cut);
    const host = cleanHost(authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, ""));
    links.push({ host: host || link, path: cut < 0 ? "" : after.slice(cut) });
  }
  for (const m of rest.matchAll(EMAIL_RE)) {
    emails.push(m[0]);
    rest = blank(rest, m.index, m[0].length);
  }
  for (const m of rest.matchAll(BARE_RE)) {
    const [, host, ending] = m;
    const path = trimLink(m[3] || "");
    const isLink = /^[/?#\\]|^:\d/.test(path) || KNOWN_ENDINGS.has(ending.toLowerCase())
      || ending === ending.toLowerCase() || ending === ending.toUpperCase();
    if (isLink) links.push({ host: cleanHost(host), path: path.replace(/^:\d+/, "") });
  }
  return { links, emails };
}

// An email address written out to dodge the check: "dave at smith dot co dot uk", "dave [at] smith [dot] com".
const spelt = (w) => `(?:\\s+${w}\\s+|\\s*[[(]\\s*${w}\\s*[\\])]\\s*)`;
const SPELT_EMAIL_RE = new RegExp(
  `(?<![a-z0-9._%+-])[a-z0-9._%+-]+${spelt("at")}[a-z0-9-]+(?:${spelt("dot")}[a-z]{2,})+(?![a-z0-9])`, "gi");

/**
 * The demo slug a path on our own host opens, or null. Resolved as a browser would ("/x/../d/other", "%2e%2e",
 * backslashes, "//d/other", "/D/other"), so a link can't reach another business's demo by a detour.
 */
function demoSlugIn(path) {
  let p = String(path).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  try {
    p = new URL(p, "https://x.invalid").pathname;
  } catch {
    // keep p as written
  }
  const m = /^\/d\/([^/?#]+)/i.exec(p.replace(/\/{2,}/g, "/"));
  return m ? m[1] : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const distinct = (list) => [...new Set(list)];

// "2k", "£1.95k", "1950 pounds", "1950 quid", "GBP 1950", "2 grand", "a few hundred pounds".
const NOT_IN_FULL = [
  /(?<![\d,.])\d(?:[\d,.]*\d)?\s?k(?![a-z0-9])/i,
  /(?<![\d,.])\d[\d,.]*\s*(?:pounds?|quid|gbp|grand)(?![a-z])/i,
  /(?<![a-z])(?:quid|gbp)(?![a-z])/i,
  /(?<![a-z])(?:hundred|thousand|grand)\s+(?:pounds?|quid)(?![a-z])/i,
  // A number priced by the month or year without £ ("249 a month", "1950 up front", "1500£") isn't in full either.
  /(?<![£\d,.])\d{2,}(?:,\d{3})*(?:\.\d\d)?\s*(?:a|per|\/|p)\s*(?:month|mth|mo|year|yr|annum)(?![a-z])/i,
  /(?<![£\d,.])\d{2,}(?:,\d{3})*(?:\.\d\d)?\s*(?:up[\s-]?front|one[\s-]?off)(?![a-z])/i,
  /(?<![\d,.])\d[\d,.]*\s?£(?!\s*\d)/,
];
// A monthly price in words ("then £249 a month", "per month", "monthly"), not "no monthly fee" / "nothing monthly".
const MONTHLY = /(?<!\b(?:no|nothing|without)\s+)(?:monthly|(?:a|per|each|every)\s+month(?![a-z])|\/\s?month)/i;
const AMOUNT_RE = /£\s*(\d[\d,]*)(\.\d+)?(\s?[km](?![a-z0-9]))?/gi;
// Letters from other alphabets that look like s, e and o ("ЅЕО" in Cyrillic), only for the SEO check.
const LOOKALIKE = { "Ѕ": "s", "ѕ": "s", "Е": "e", "е": "e", "Ё": "e", "ё": "e", "Ε": "e", "О": "o", "о": "o", "Ο": "o", "ο": "o", "Օ": "o", "օ": "o" };
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join("")}]`, "g");
const SEO = [
  /(?<![a-z0-9])s[\s._*/|-]{0,3}e[\s._*/|-]{0,3}[o0](?:'?s)?(?![a-z0-9])/i,
  /search[\s-]*engine[\s-]*optimi[sz]/i,
];
const PROMISE = /(?<![a-z])(?:guarant|promis)|(?<![\d.,])100\s*(?:%|per\s?cent)|money[\s-]*back/i;
const WEEKEND_WORDS = [
  /(?<![a-z0-9])(?:90|ninety)\s+(?:free\s+)?days?\s+(?:(?:are|is)\s+)?(?:for\s+)?free/i,
  /(?<![a-z0-9])(?:90|ninety)\s+free\s+days/i,
  /free\s+for\s+(?:the\s+)?(?:first\s+)?(?:90|ninety)\s+days/i,
  /first\s+(?:90|ninety)\s+days/i,
  // the same 90 days in months
  /(?<![a-z0-9])(?:3|three)\s+(?:free\s+)?months?\s+(?:(?:are|is)\s+)?(?:for\s+)?free/i,
  /(?<![a-z0-9])(?:3|three)\s+free\s+months/i,
  /free\s+for\s+(?:the\s+)?(?:first\s+)?(?:3|three)\s+months/i,
];
const PLACEHOLDER_RE = /\[[^[\]\n]{1,60}\]|\{\{?[^{}\n]{1,60}\}?\}/g;
const HTML = [/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i, /<!--/, /&(?:[a-z]{2,8}|#\d{1,6}|#x[0-9a-f]{1,6});/i];
const SIGN_OFF_WORDS = /^(?:(?:many|kind|best|warm|warmest)\s+)?(?:thanks|thank you|thankyou|cheers|regards|wishes|best|ta|speak soon|talk soon|all the best|yours)\s+/;

const plainWords = (s) => s.toLowerCase().replace(new RegExp(`[^a-z0-9${NA}]+`, "g"), " ").trim();

function signsOff(lastLine, signName) {
  const line = plainWords(lastLine);
  if (!line || line.split(" ").length > 6) return false;
  const name = plainWords(String(signName ?? ""));
  const names = new Set(["aetos websites", "aetos", "the aetos websites team", "the aetos team"]);
  if (name) {
    names.add(name);
    names.add(name.split(" ")[0]);
    names.add(`${name} aetos websites`);
    names.add(`${name.split(" ")[0]} aetos websites`);
    names.add(`${name} at aetos websites`);
    names.add(`${name} from aetos websites`);
  }
  return names.has(line) || names.has(line.replace(SIGN_OFF_WORDS, ""));
}

/**
 * Checks a reply Claude wrote: {ok, reasons}, reasons in Part A's table order, each at most once, with its exact text.
 */
export function replyGuard(body, ctx = {}) {
  // Fullwidth letters and dots become plain ones (NFKC; "。" is a dot in host names too), zero-width characters and
  // soft hyphens go, and a curly apostrophe is a straight one, so nothing hides from the checks below.
  const s = String(body ?? "").normalize("NFKC").replace(/[­​-‏⁠-⁤﻿]/g, "")
    .replace(/[。｡]/g, ".").replace(/[‘’]/g, "'").replace(/₤/g, "£");
  if (!s.trim()) return { ok: false, reasons: ["Write a reply, or escalate."] };
  const offer = ctx.offer || {};
  const hosts = new Set((ctx.hosts || []).map((h) => String(h).toLowerCase()));
  const reasons = [];

  const words = s.trim().split(/\s+/).length;
  if (words > MAX_WORDS) reasons.push(`Too long: ${words} words (${MAX_WORDS} max).`);

  const { links, emails } = linksIn(s);
  const badHosts = distinct(links.filter((l) => !hosts.has(l.host)).map((l) => l.host));
  if (badHosts.length) {
    reasons.push(`Links can only go to their demo, their order page or aetoswebsites.com (found ${badHosts.join(", ")}).`);
  }
  const otherDemos = distinct(links.filter((l) => hosts.has(l.host)).map((l) => demoSlugIn(l.path))
    .filter((slug) => slug !== null && slug !== ctx.slug).map((slug) => `/d/${slug}`));
  if (otherDemos.length) reasons.push(`That link is another business's demo (${otherDemos.join(", ")}).`);
  for (const m of s.matchAll(SPELT_EMAIL_RE)) emails.push(m[0].replace(/\s+/g, " "));
  if (emails.length) reasons.push(`No email addresses in replies (found ${distinct(emails).join(", ")}).`);

  const amounts = [...(offer.amounts || [])].sort((a, b) => a - b);
  const allowed = new Set(amounts.map((a) => Math.round(a * 100)));
  const wrong = [];
  const found = new Set(); // every £ amount written in full, in pence
  let shortened = false;
  for (const m of s.matchAll(AMOUNT_RE)) {
    if (m[3]) { // "£1.95k", "£2m": reported only as "write prices in full"
      shortened = true;
      continue;
    }
    const pence = Math.round(Number(m[1].replace(/,/g, "") + (m[2] || "")) * 100);
    found.add(pence);
    if (allowed.has(pence)) continue;
    wrong.push(Number.isSafeInteger(pence) ? formatPounds(pence) : `£${m[1].slice(0, 20)}`);
  }
  const prices = amounts.map((a) => formatPounds(Math.round(a * 100))).join(", ");
  const bad = distinct(wrong);
  if (bad.length === 1) reasons.push(`${bad[0]} isn't one of our prices (${prices}).`);
  else if (bad.length > 1) reasons.push(`${bad.slice(0, -1).join(", ")} and ${bad.at(-1)} aren't our prices (${prices}).`);
  if (shortened || NOT_IN_FULL.some((re) => re.test(s))) reasons.push("Write prices in full with £, e.g. £1,950.");
  // On a weekday the Full Package (the one with the monthly price) isn't £1,750: that's Website Only's price, or the
  // weekend deal's. £1,750 next to a monthly price without £1,950 is the weekend price going out on a weekday; a reply
  // that names both packages passes.
  const pence = (pounds) => Math.round(Number(pounds) * 100) || 0;
  const websiteOnly = pence(offer.website_only?.build);
  const fullBuild = pence(offer.full?.build);
  if (offer.weekend !== true && websiteOnly && fullBuild && websiteOnly !== fullBuild && found.has(websiteOnly)
    && !found.has(fullBuild) && (found.has(pence(offer.full?.monthly)) || MONTHLY.test(s))) {
    reasons.push(`${formatPounds(websiteOnly)} is the Website Only price; the Full Package is ${formatPounds(fullBuild)} to build.`);
  }

  const plainLetters = s.replace(LOOKALIKE_RE, (c) => LOOKALIKE[c]);
  if (SEO.some((re) => re.test(plainLetters))) {
    reasons.push("Don't say \"SEO\": say \"top 3 on Google\" or \"the front page of Google\".");
  }

  let unpromised = s;
  for (const g of offer.guarantees || []) {
    const sentence = escapeRe(String(g).replace(/[‘’]/g, "'").trim()).replace(/\s+/g, "\\s+");
    if (sentence) unpromised = unpromised.replace(new RegExp(sentence, "gi"), " ");
  }
  if (PROMISE.test(unpromised)) reasons.push("Promises must use the exact guarantee wording from the offer.");

  if (offer.weekend !== true && WEEKEND_WORDS.some((re) => re.test(s))) {
    reasons.push("The weekend deal isn't on when this goes out: use the weekday offer.");
  }

  const placeholders = distinct([...s.matchAll(PLACEHOLDER_RE)].map((m) => m[0]));
  if (placeholders.length === 1) reasons.push(`Fill in or remove the placeholder ${placeholders[0]}.`);
  else if (placeholders.length > 1) reasons.push(`Fill in or remove the placeholders ${placeholders.join(", ")}.`);

  if (HTML.some((re) => re.test(s))) reasons.push("Plain text only: remove the HTML.");

  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && signsOff(lines.at(-1), ctx.signName)) {
    reasons.push("Don't sign off: \"Nik\" and \"Aetos Websites\" are added under your reply.");
  }

  return { ok: reasons.length === 0, reasons };
}
