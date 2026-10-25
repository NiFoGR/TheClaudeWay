// Text rules for the emails Nik and the system send to prospects (pure: no database, nothing Workers can't run; the
// only import is the cold footer from the pure compose.js). The follow-up checks (followups.js) and the first-email
// checks below use these, and stage 7 imports businessName (it has no copy of its own) and may reuse findLinks and
// greetingFor for Claude's replies. Tested in control-room/tests/followups.test.mjs (wordCount, findLinks,
// businessName) and control-room/tests/rules.test.mjs (the first email).
//
// Email text is plain text, written or pasted by Nik (from Gmail or Word: smart quotes, a signature with "www.", a
// bare "greenleaf.co.uk", an email address), so findLinks looks for every way a link can be written, and nothing in
// ordinary writing ("e.g.", "ok.", "£1,950.00", "St.Albans") counts as one.
//
// First email (Part A §A3): Nik writes the subject and body; the system adds the greeting (greetingFor: "Hi Mark,"
// only for a confident first name, else "Hi,"), fills in {demo_link} and adds the cold footer (renderFirstEmail).
// firstEmailIssues is the text half of the checks before Send, with A3's exact messages; the database half
// (demo_not_ready, no_mailbox, warming_up, no_room, not_in_list, suppressed, shared_address, already_emailed,
// queued_already, no_prospect) is first-email.js's. stripFooter takes the footer off again (the style examples).
import { OPT_OUT_LINE, coldFooter } from "./compose.js";

/** How many words `text` has: whitespace-separated, so a placeholder such as {demo_link} or {business} is one. */
export function wordCount(text) {
  const s = String(text ?? "").trim();
  return s ? s.split(/\s+/).length : 0;
}

// The patterns in this file read ASCII only. Written with Unicode letter classes (\p{L}\p{N}, about 20 of them in the
// link pattern), they took 10-40 ms of CPU to compile the first time they ran in an isolate, over Workers' 10 ms a
// request on their own. So each check first gives every non-ASCII character an ASCII stand-in that its pattern treats
// exactly as it would treat the character, one code unit for one code unit so positions match (findLinks cuts the
// links out of the original text): a letter in any script → "a", any other number (not 0-9) → NUMBER, a combining
// mark → MARK, a space (no-break, em…) → " ", the apostrophe ’ → "'", anything else (other quotes, £, dashes,
// emoji) → "~", which is in no class below.
const NUMBER = "\uE000"; // never in the stand-in text otherwise: an original private-use character becomes "~"
const MARK = "\uE001";
const NOT_ASCII = /[^\x00-\x7F]/gu;
const STAND_IN = /(\p{L})|(\p{N})|(\p{M})|(\s)/u;
function standIn(ch) {
  if (ch === "\u2019") return "'";
  const kind = STAND_IN.exec(ch);
  return (!kind ? "~" : kind[1] ? "a" : kind[2] ? NUMBER : kind[3] ? MARK : " ").repeat(ch.length); // astral: 2 units
}
const ascii = (text) => text.replace(NOT_ASCII, standIn);
const LETTER_OR_DIGIT = `A-Za-z0-9${NUMBER}`; // \p{L}\p{N} in the stand-in text
// A host name's label (letters and digits in any script, hyphens inside), and the endings that make a bare
// "name.ending" a web address. Only the last label is listed: "greenleaf.co.uk" and "greenleaf.org.uk" end in "uk".
const LABEL = String.raw`[${LETTER_OR_DIGIT}](?:[${LETTER_OR_DIGIT}-]*[${LETTER_OR_DIGIT}])?`;
const ENDINGS = ["uk", "com", "net", "org", "io", "biz", "info", "co", "me", "eu", "ie", "london", "wales", "scot",
  "cymru", "online", "site", "website", "shop", "store", "tech", "app", "dev"];
const PATH = String.raw`(?::\d+)?(?:[/?#][^\s<>"]*)?`;
// In this order, so at one place in the text the longest reading wins: "https://x.com/a" is one link, not a host and
// a path, and "www.me@x.org" is one address. Each kind only starts where a word does (the lookbehinds): a later start
// inside the same run of letters could only find part of what the first one finds, and trying from every letter of
// a long run would take time that grows with the square of its length (20,000 characters: 1.7 s, over Workers' CPU).
const AN = LETTER_OR_DIGIT;
const LINK = new RegExp([
  String.raw`https?://[^\s<>"]+`, // a full URL, to the next space
  String.raw`(?<![${AN}._%+-])[${AN}._%+-]+@${LABEL}(?:\.${LABEL})*\.[A-Za-z]{2,}`, // an email address
  String.raw`(?<![${AN}])www\.${LABEL}(?:\.${LABEL})*${PATH}`, // a www. host (not "awww.")
  // a bare domain (greenleaf.co.uk), not starting inside a host name, after "x." or "x-" ("...x.com", "-x.com" count)
  String.raw`(?<![${AN}]|[${AN}]-)(?<![${AN}-]\.)(?:${LABEL}\.)+(?:${ENDINGS.join("|")})(?![${AN}])${PATH}`,
].join("|"), "gi");

// What a sentence puts after a link, which isn't part of it: "www.x.com," "(see https://a.io/b)." "“x.com”".
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "\u2018", "\u2019", "\u201C", "\u201D", "\u00BB",
  "\u2026", "*", ")", "]", "}", ">"]);
const count = (text, ch) => text.split(ch).length - 1;

function trimLink(link) {
  // A closing bracket with its opening one inside the link is part of it ("…/wiki/Roof_(building)"). Opening ones are
  // never trimmed, so they're counted once; closing ones are counted down as they go.
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

/**
 * Every link in `text`, in the order they come, as written: http(s) URLs, www. hosts, bare domains such as
 * greenleaf.co.uk (endings .uk, .com, .net, .org, .io, .biz, .info and a few more) and email addresses, without the
 * punctuation that follows them. Each occurrence is listed, so the same address twice comes back twice. Placeholders
 * are left alone, so take them out first ({demo_link} is not a link until it's filled in).
 */
export function findLinks(text) {
  const s = String(text ?? "");
  const links = [];
  for (const match of ascii(s).matchAll(LINK)) {
    const link = trimLink(s.slice(match.index, match.index + match[0].length));
    if (link) links.push(link);
  }
  return links;
}

// Port of cleanBusiness (_lib/outreach.js, from the old system): same rules, same results.
const TITLE_SMALL = new Set(["and", "of", "the", "in", "on", "at", "for", "to", "&"]);

function titleCase(s) {
  return String(s || "").toLowerCase().split(/(\s+|-)/).map((w, i) =>
    (i > 0 && TITLE_SMALL.has(w)) || /^\s+$|^-$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/**
 * The business's name as people say it: "SMITH ROOFING LTD - Roofer in Leeds" → "Smith Roofing". Nothing after
 * " - ", " – " or " | ", no ", Ltd" / " Limited" / " LLP" / " PLC" at the end, and an ALL CAPS name title-cased
 * ("and", "of", "the"… kept small). A name in mixed case ("McDonald Roofing") is left as it is.
 */
export function businessName(name) {
  let n = String(name || "").split(/\s+[-|–]\s+/)[0].trim();
  n = n.replace(/[,.]?\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = titleCase(n);
  return n;
}

// ---- The first email (Part A §A3) ----

const FIRST_EMAIL_MAX_WORDS = 150; // the body must stay under this ({demo_link} 1 word; greeting and footer not counted)

// research.js's rule for owner.first (/^(?=.*\p{L})[\p{L}\p{M}'’-]{1,30}$/u, not exported), on the stand-in text:
// 1 to 30 letters (and marks), ' ’ and - allowed, at least one letter. A name research would refuse (two words, a
// digit, a line break, a hidden character) gets "Hi,".
const FIRST_NAME = new RegExp(`^(?=.*[A-Za-z])[A-Za-z${MARK}'-]+$`);
const isFirstName = (first) => [...first].length <= 30 && FIRST_NAME.test(ascii(first));

// "mark", "MARK" and "mARK" (Caps Lock) → "Mark", "mary-jane" → "Mary-Jane"; a name in mixed case that starts with a
// capital ("DeShawn", "McKenzie") is kept as written. Only the first letter and one after a hyphen are capitals
// ("d’arcy" → "D’arcy"), and the first letter is one even after an apostrophe ("'mark" → "'Mark").
function titleName(first) {
  const lower = first.toLowerCase();
  const keep = first !== lower && first !== first.toUpperCase() && /^\P{L}*\p{Lu}/u.test(first);
  const name = keep ? first : lower.replace(/(^|-)(\p{L})/gu, (all, before, letter) => before + letter.toUpperCase());
  return name.replace(/^(\P{L}*)(\p{L})/u, (all, before, letter) => before + letter.toUpperCase());
}

/**
 * The greeting line of every email to this lead: {line: "Hi Mark,", name: "Mark"} when `owner` (research.owner,
 * {first, confident}) has `confident` exactly true and a first name research would accept (title-cased), else
 * {line: "Hi,", name: null}. `name` is what prospects.greet_name stores (NULL for "Hi,"); follow-ups use the same.
 */
export function greetingFor(owner) {
  const first = owner !== null && typeof owner === "object" && owner.confident === true && typeof owner.first === "string"
    ? owner.first.normalize("NFC").trim() : "";
  if (!isFirstName(first)) return { line: "Hi,", name: null };
  const name = titleName(first);
  return { line: `Hi ${name},`, name };
}

// Pasted text: Windows line ends, Word's Shift+Enter (vertical tab), form feeds and Unicode line separators are line
// breaks; other control characters are dropped (tabs stay). Invisible characters are dropped too: bidi marks and
// overrides, the soft hyphen (Word's optional hyphen), zero-width spaces, the word joiner and the BOM. They would make
// the text read differently from what it says, and hide a greeting or a link from the checks ("\u200BHi Mark,",
// "www\u200B.x.com"); zero-width joiners stay (emoji use them). The checks and the email read the same text. Written as
// \u escapes: literal ones hide in code.
const LINE_ENDS = /\r\n?|[\u000B\u000C\u0085\u2028\u2029]/g;
const CONTROLS = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g;
const INVISIBLE = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const kind = (value) => (Array.isArray(value) ? "a list" : value === null ? "null" : typeof value);

function emailText(value, what) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new TypeError(`${what} as text, got ${kind(value)}`);
  return value.replace(INVISIBLE, "").replace(LINE_ENDS, "\n").replace(CONTROLS, "");
}

const oneLine = (value) => (typeof value === "string"
  ? value.replace(INVISIBLE, "").replace(LINE_ENDS, " ").replace(CONTROLS, " ").replace(/\s+/g, " ").trim() : "");

// The demo's address when it's a whole http(s) link, else "" (no demo yet: only {demo_link} itself counts then).
const demoAddress = (demoUrl) => {
  const url = typeof demoUrl === "string" ? demoUrl.trim() : "";
  return /^https?:\/\/\S+$/i.test(url) ? url : "";
};

const PLACEHOLDERS = /\{([^{}\n]*)\}/g; // anything in braces, so "{Business}" and "{ demo_link }" are caught too
// GREETING and SEO read the stand-in text (ascii()), where [\p{L}\p{N}] is [LETTER_OR_DIGIT] and ’ is '.
const GREETING = new RegExp(String.raw`^(?:hi|hiya|hello|hey|dear|morning|good\s+(?:morning|afternoon|evening))` +
  `(?![${LETTER_OR_DIGIT}'-])`, "i");
const RE_FWD = /^(?:re|fwd?)\s*:/i;
const SEO = new RegExp(`(?<![${LETTER_OR_DIGIT}_])seo(?![${LETTER_OR_DIGIT}_])`, "i");

/**
 * The text checks before Send, in Part A §A3's order, as [{code, message}] with A3's exact messages; [] when all
 * pass. `subject` and `body` are what Nik typed (null or undefined = blank); `demoUrl` is the lead's demo address
 * (null when there's no demo yet: then only {demo_link} counts as the demo link); `greetingLine` is the greeting the
 * email will get (greetingFor's line), quoted by the `greeting` message ("Hi," when not given).
 * - subject_missing, subject_re ("Re:", "Fwd:", "Fw:" in any case);
 * - body_missing (and then no other check on the body);
 * - greeting: the body's first line (after any blank lines) starts with Hi, Hiya, Hello, Hey, Dear, Morning or
 *   Good morning/afternoon/evening as a word;
 * - demo_missing, demo_twice: {demo_link} and the demo address pasted as it is count together. Each is filled in
 *   first and looked for with findLinks, so one glued to other text ("{demo_link}thanks", "www.{demo_link}"), which
 *   would be a dead link, isn't the demo link but another link;
 * - other_link: every other link findLinks finds in the body (URLs, www. hosts, bare domains, email addresses), and
 *   every link in the subject (the email's one link is the demo link, in the body), each named once, in the order
 *   they come, the subject's first;
 * - seo: "SEO" as a word in the subject or the body (not inside the demo address);
 * - too_long: 150 words or more in the body;
 * - placeholder: each {word} other than {demo_link} in the body, and any {word} in the subject (nothing is filled in
 *   there), named once each.
 */
export function firstEmailIssues(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError(`firstEmailIssues needs {subject, body, demoUrl}, got ${kind(input)}`);
  }
  const { subject, body, demoUrl, greetingLine } = input;
  const subj = emailText(subject, "firstEmailIssues needs the subject").trim();
  const text = emailText(body, "firstEmailIssues needs the email's text (body)").trim();
  const url = demoAddress(demoUrl);
  const issues = [];
  const add = (code, message) => issues.push({ code, message });

  if (!subj) add("subject_missing", "Add a subject.");
  else if (RE_FWD.test(subj)) add("subject_re", 'The subject can\'t start with "Re:" or "Fwd:".');
  if (!text) add("body_missing", "Write the email first.");

  let plain = ""; // the body without the demo link, for the SEO check
  let others = findLinks(subj.replace(PLACEHOLDERS, " ")); // a web address in the subject is never the demo link
  if (text) {
    if (GREETING.test(ascii(text.split("\n", 1)[0]))) {
      add("greeting", `Leave out the greeting: "${oneLine(greetingLine) || greetingFor(null).line}" is added for you.`);
    }
    // {demo_link} filled in (counted here when there's no address to fill in), every other placeholder taken out.
    let bare = 0;
    const probe = text.replace(PLACEHOLDERS, (all, name) => {
      if (name !== "demo_link") return " ";
      if (url) return url;
      bare += 1;
      return " ";
    });
    const links = findLinks(probe);
    const demos = bare + (url ? links.filter((link) => link === url).length : 0);
    if (demos === 0) add("demo_missing", "Add the demo link: press Insert demo link.");
    else if (demos > 1) add("demo_twice", "The demo link is in there more than once. Keep it once.");
    others = others.concat(links.filter((link) => !url || link !== url));
    plain = url ? probe.split(url).join(" ") : probe;
  }
  if (others.length) add("other_link", `Only the demo link is allowed. Remove: ${[...new Set(others)].join(", ")}`);

  if (SEO.test(ascii(subj)) || SEO.test(ascii(plain))) add("seo", 'Don\'t say "SEO". Say "front page of Google" instead.');

  if (text) {
    const words = wordCount(text);
    if (words >= FIRST_EMAIL_MAX_WORDS) add("too_long", `Too long: ${words} words. Keep it under ${FIRST_EMAIL_MAX_WORDS}.`);
  }

  const named = new Set();
  for (const [where, value] of [["subject", subj], ["body", text]]) {
    for (const [all, name] of value.matchAll(PLACEHOLDERS)) {
      if ((where === "body" && name === "demo_link") || named.has(all)) continue;
      named.add(all);
      add("placeholder", name === "demo_link" ? "{demo_link} only works in the email, not in the subject."
        : `${all} isn't filled in for you. Only {demo_link} is.`);
    }
  }
  return issues;
}

/**
 * The first email's text exactly as the prospect gets it (and as the preview shows it): `greetingLine` ("Hi Mark," /
 * "Hi,", put on one line), a blank line, Nik's `body` trimmed with every {demo_link} replaced by `demoUrl`, a blank
 * line, then coldFooter(`nikName`) (the business:sender_name setting, never the mailbox's display name). Line ends
 * come out as \n. A blank body gives the greeting and the footer only (the preview of an empty draft). Throws in
 * plain English when the greeting line is blank, or the body has {demo_link} and `demoUrl` isn't a whole http(s)
 * link, so a prospect never gets "{demo_link}", "undefined" or a dead link. Nothing else is filled in: any other
 * {word} stays, and firstEmailIssues stops such an email being sent.
 */
export function renderFirstEmail({ greetingLine, body, demoUrl, nikName } = {}) {
  const greeting = oneLine(greetingLine);
  if (!greeting) {
    throw new Error(`renderFirstEmail needs the greeting line, like "Hi Mark," or "Hi,", got ${kind(greetingLine)}`);
  }
  const text = emailText(body, "renderFirstEmail needs the email's text (body)").trim().replace(/\{demo_link\}/g, () => {
    const url = demoAddress(demoUrl);
    if (!url) throw new Error(`A first email with {demo_link} needs the demo's address (demoUrl) as a whole https:// link, got ${kind(demoUrl)}`);
    return url;
  });
  return [greeting, text, coldFooter(nikName)].filter(Boolean).join("\n\n");
}

// The footer as any sender name (or none) wrote it: an optional name line, "Aetos Websites", a blank line, the
// opt-out line, at the very end. For text sent before Nik changed his name on Setup.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY_FOOTER = new RegExp(String.raw`(?:^|\n)(?:[^\n]+\n)?Aetos Websites\n\n${escapeRegExp(OPT_OUT_LINE)}$`);

/**
 * `text` (an email as sent: renderFirstEmail's or a follow-up's) without the cold footer at its end and the blank
 * lines before it; the greeting stays. coldFooter(`nikName`) comes off as a whole (from the start of a line), and so
 * does a footer written under another sender name or none. Text that doesn't end with a footer comes back as it is,
 * end trimmed. Line ends come out as \n; null or undefined is "".
 */
export function stripFooter(text, nikName) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trimEnd();
  const footer = coldFooter(nikName);
  if (s === footer) return "";
  if (s.endsWith(`\n${footer}`)) return s.slice(0, s.length - footer.length).trimEnd();
  const match = ANY_FOOTER.exec(s);
  return match ? s.slice(0, match.index).trimEnd() : s;
}
