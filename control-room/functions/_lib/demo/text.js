// Safe text helpers for the demo template engine (pure, no D1, nothing Workers can't run).
// Everything from the lead, research and reviews is untrusted: h() before it goes into HTML, safeHttps() before a URL
// goes into an attribute. Tested in control-room/tests/demo-text.test.mjs.

// Control characters (except tab, LF, CR) and the bidi embedding/override/isolate characters, which can make text
// read differently on screen from what it is ("Smith" + U+202E + " gnifooR" shows as "SmithRoofing").
// Written as \u escapes on purpose: literal bidi characters in source code hide what it really says.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const HAS_CONTROL = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

const TRAILING = new Set(" ,;:.!?-\u2013\u2014\u2026");
const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());

/** HTML-escape anything (null/undefined → ""), after removing control and bidi characters. */
export function h(v) {
  return String(v ?? "").replace(INVISIBLE, "").replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

/** One line of plain text: invisible characters removed, whitespace collapsed, trimmed, and when longer than `max`
 * cut at a word and ended with "…" (the result, "…" included, is at most `max` characters). */
export function cleanText(v, max) {
  const s = String(v ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!(max > 0) || s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (s[cut.length] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never split an emoji in half
  let end = cut.length; // drop trailing spaces/punctuation (a loop, not a regex: no backtracking on long runs)
  while (end > 0 && TRAILING.has(cut[end - 1])) end--;
  return `${cut.slice(0, end)}…`; // "…" already there isn't doubled: it's in TRAILING
}

/** The URL when it's a plain https:// URL (no spaces, quotes, angle brackets, brackets or backslashes, at most 2048
 * characters), else "". http:// is refused too: it would be blocked on our https page. */
export function safeHttps(u) {
  const s = typeof u === "string" ? u.trim() : "";
  if (s.length > 2048 || HAS_CONTROL.test(s)) return "";
  return /^https:\/\/[^\s"'<>()\\]+$/.test(s) ? s : "";
}

/** "tel:" target for a phone number: a leading + kept, then the digits; "" unless it has 10–13 digits. */
export function telHref(phone) {
  const s = String(phone ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return "";
  return (s.startsWith("+") ? "+" : "") + digits;
}

/** Business name as people say it: no " Ltd"/" Limited"/" LLP"/" PLC", nothing after " - " or " | ", ALL CAPS
 * title-cased. */
export function shortName(name) {
  let n = String(name || "").split(/\s+[-|–]\s+/)[0].trim().replace(/[,.]?\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = titleCase(n);
  return n;
}

/** Review author as first name + initial ("Sarah Jane Kent" → "Sarah K."); "Google reviewer" when there's no name. */
export function shortAuthor(author) {
  const words = cleanText(author, 200).split(" ").filter(Boolean);
  if (!words.length) return "Google reviewer";
  const first = cleanText(words[0], 30);
  if (words.length === 1) return first;
  const initial = words[words.length - 1].match(/[\p{L}\p{N}]/u);
  return initial ? `${first} ${initial[0].toUpperCase()}.` : first;
}

/** URL-safe, unguessable: "smith-roofing-7k2p9q". */
export function slugFor(name, rand = Math.random) {
  const base = shortName(name).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "your-business";
  const tail = Array.from({ length: 6 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(rand() * 31)]).join("");
  return `${base}-${tail}`;
}
