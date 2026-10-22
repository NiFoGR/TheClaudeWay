// Inbound mail (pure). Reads the headers the relay stored, pulls the sender's own words out of the raw MIME (the
// quoted thread cut off), and sorts each email into bounce / auto / opt_out / human. Inbound text is untrusted: it's
// returned as plain text, never HTML, and whatever renders it escapes it.

export const OPT_OUT_PHRASES = ["no thanks", "unsubscribe", "remove me", "stop emailing", "take me off"];

const BODY_CAP = 20000; // characters
// Work bounds, for the tick's CPU budget: only the first 20,000 characters survive, and the sender's words come
// before the quote, so a part is decoded from at most 100,000 characters and at most 50,000 characters of plain
// text are looked at, each in linear time. A 256 KB newsletter then costs a few milliseconds (up to ~15 in a fresh
// isolate), so the inbound step (inbound-db.js) also parses at most ~100 KB of raw MIME a tick: about one big email,
// or many small replies, never ten big ones.
const ENCODED_WORK = 100000;
const TEXT_WORK = 50000;
const MAX_DEPTH = 3; // levels of multipart followed
const MAX_PARTS = 100; // leaf parts read
const OPT_OUT_MAX_WORDS = 40;
const AUTO_PRECEDENCE = ["bulk", "auto_reply", "junk"];
const AUTO_SUBJECT = /^\s*(automatic reply|out of office)/i;
// Delay warnings that carry no Action/Status lines (Exim's plain-text ones) say so in the subject.
const DELAY_SUBJECT = /^\s*(delayed mail\b|delivery delayed\b|delivery status notification \(delay\)|warning: message \S+ delayed\b)/i;
const DAEMON = /^(mailer-daemon|postmaster)(@|$)/;
const REPORT_PART = /^message\/(global-)?delivery-status$/;
const ORIGINAL_PART = /^(message\/(rfc822|global|rfc822-headers|global-headers)|text\/rfc822-headers)$/;

// ---------------------------------------------------------------------------------------------------------------
// Bytes and charsets

// Windows-1252's 0x80–0x9F (the rest of the single-byte range is Latin-1). Mail labelled Latin-1 or US-ASCII is
// read as Windows-1252, as browsers do (WHATWG). This table is used rather than TextDecoder because runtimes differ:
// Node's TextDecoder reads "windows-1252" as strict Latin-1 (0x92 comes out as a control character, not "’"), and
// some don't know the label at all.
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const LATIN_LABELS = new Set(["windows-1252", "cp1252", "x-cp1252", "iso-8859-1", "iso8859-1", "iso_8859-1", "latin1",
  "l1", "iso-ir-100", "ibm819", "cp819", "csisolatin1", "iso88591", "us-ascii", "ascii", "latin-1", "windows1252"]);

function decodeCp1252(bytes) {
  const codes = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    codes[i] = b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : b;
  }
  let out = "";
  for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode.apply(null, codes.subarray(i, i + 8192));
  return out;
}

function decodeBytes(bytes, charset) {
  const label = String(charset || "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!label) {
    // No charset given: UTF-8 if the bytes are valid UTF-8, else Windows-1252 (old Outlook and webmail send 8-bit
    // Latin text unlabelled). `stream` lets a character cut off at the end (a body cut short) not count as invalid.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    } catch {
      return decodeCp1252(bytes);
    }
  }
  if (LATIN_LABELS.has(label)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes); // a charset this runtime doesn't know
  }
}

const hexDigit = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);

// "=XX" escapes to bytes; any other character as itself (UTF-8 bytes for a non-ASCII one, which 8-bit mail has).
function hexBytes(str) {
  const out = new Uint8Array(str.length * 3);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x3d) {
      const hi = hexDigit(str.charCodeAt(i + 1));
      const lo = hexDigit(str.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        out[n++] = hi * 16 + lo;
        i += 2;
        continue;
      }
    }
    if (c < 0x80) {
      out[n++] = c;
      continue;
    }
    let cp = c;
    const d = str.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
      cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
      i++;
    }
    if (cp < 0x800) {
      out[n++] = 0xc0 | (cp >> 6);
    } else if (cp < 0x10000) {
      out[n++] = 0xe0 | (cp >> 12);
      out[n++] = 0x80 | ((cp >> 6) & 63);
    } else {
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 63);
      out[n++] = 0x80 | ((cp >> 6) & 63);
    }
    out[n++] = 0x80 | (cp & 63);
  }
  return out.subarray(0, n);
}

// Quoted-printable body: trailing spaces on a line are padding, "=" at a line end is a soft break. The lookbehind
// lets a match start only at the first space or tab of a run, so each run is scanned once: plain /[ \t]+$/gm tries a
// run that ends in a letter from every one of its spaces (n² work; 60,000 spaces took 8.5 s, far over the tick's CPU).
const qpBytes = (str) => hexBytes(str.replace(/(?<![ \t])[ \t]+$/gm, "").replace(/=\n/g, ""));

function b64Bytes(str) {
  let s = String(str).replace(/[^A-Za-z0-9+/]/g, "");
  if (s.length % 4 === 1) s = s.slice(0, -1); // a dangling character (a body cut at the 256 KB cap) can't be decoded
  while (s.length % 4) s += "=";
  let bin;
  try {
    bin = atob(s);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// RFC 2047 encoded words. Adjacent words are joined (the space between them isn't text), and their bytes decoded
// together, so a character split across two words survives. Only a header's first 10,000 characters are read (a
// work bound: real subjects and names are far shorter). Control characters, line breaks included, become spaces, so
// a decoded "=0D=0A" can't put a line break into a subject that a later reply reuses.
const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
const HEADER_WORK = 10000;
function decodeWords(input) {
  const s = String(input ?? "").slice(0, HEADER_WORK);
  let out = "";
  let last = 0;
  let pending = null;
  const flush = () => {
    if (pending) out += decodeBytes(Uint8Array.from(pending.bytes), pending.charset || "utf-8");
    pending = null;
  };
  for (const m of s.matchAll(WORD)) {
    const gap = s.slice(last, m.index);
    const charset = m[1].split("*")[0].toLowerCase();
    const bytes = m[2].toUpperCase() === "B" ? b64Bytes(m[3]) : hexBytes(m[3].replace(/_/g, " "));
    if (pending && !gap.trim() && pending.charset === charset) {
      for (const b of bytes) pending.bytes.push(b);
    } else {
      flush();
      if (last === 0 || gap.trim()) out += gap; // only whitespace between two encoded words is dropped
      pending = { charset, bytes: Array.from(bytes) };
    }
    last = m.index + m[0].length;
  }
  flush();
  return (out + s.slice(last)).replace(/[\u0000-\u001f\u007f]+/g, " ");
}

// ---------------------------------------------------------------------------------------------------------------
// MIME

const lf = (s) => String(s).replace(/\r\n?/g, "\n");
const unfold = (value) => String(value).replace(/\r?\n(?=[ \t])/g, "").replace(/[\r\n]+/g, " ").trim();

// A header block as {lower-case name: value}, folded lines joined; the first of a repeated header wins.
function headerBlock(block) {
  const out = Object.create(null); // no inherited names: a header called "constructor" is just a header
  let name = null;
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line)) {
      if (name) out[name] += " " + line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) {
      name = null;
      continue;
    }
    const key = line.slice(0, i).trim().toLowerCase();
    if (key in out) {
      name = null;
      continue;
    }
    out[key] = line.slice(i + 1).trim();
    name = key;
  }
  return out;
}

// Headers and body split at the first blank line (an entity that starts with one has no headers).
function entity(text) {
  if (text.startsWith("\n")) return { headers: Object.create(null), body: text.slice(1) };
  const i = text.indexOf("\n\n");
  if (i < 0) return { headers: headerBlock(text), body: "" };
  return { headers: headerBlock(text.slice(0, i)), body: text.slice(i + 2) };
}

// "type/sub; a=1; b="x"" → {type, params}. Parameter names are lower-cased; values unquoted.
function mimeValue(value) {
  const v = String(value ?? "");
  const semi = v.indexOf(";");
  const type = (semi < 0 ? v : v.slice(0, semi)).trim().toLowerCase();
  const params = Object.create(null);
  const re = /;\s*([A-Za-z0-9_.*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]*)/g;
  for (const m of v.matchAll(re)) {
    const key = m[1].toLowerCase();
    if (!(key in params)) params[key] = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, "$1") : m[2];
  }
  return { type, params };
}

// The parts between "--boundary" lines (the preamble before the first and anything after "--boundary--" dropped),
// at most `max` of them; the body is read only as far as needed.
function multipartChildren(body, boundary, max) {
  const open = "--" + boundary;
  const close = open + "--";
  const parts = [];
  let start = -1; // where the current part's text begins
  for (let at = 0; at <= body.length;) {
    let end = body.indexOf("\n", at);
    if (end < 0) end = body.length;
    if (body.startsWith(open, at)) {
      const t = body.slice(at, end).trimEnd();
      if (t === open || t === close) {
        if (start >= 0) parts.push(body.slice(start, Math.max(start, at - 1)));
        if (t === close || parts.length >= max) return parts;
        start = end + 1;
      }
    }
    at = end + 1;
  }
  if (start >= 0) parts.push(body.slice(start));
  return parts;
}

// Every leaf part in order, following multipart up to MAX_DEPTH levels (message/rfc822 is a leaf, not opened). At
// most MAX_PARTS leaves are read (a work bound: the reply's text comes first, and a mail of thousands of tiny parts
// would otherwise cost tens of milliseconds).
function leaves(text, depth = 0, out = []) {
  if (out.length >= MAX_PARTS) return out;
  const { headers, body } = entity(text);
  const ct = mimeValue(headers["content-type"] || "text/plain");
  if (ct.type.startsWith("multipart/")) {
    if (depth < MAX_DEPTH && ct.params.boundary) {
      for (const child of multipartChildren(body, ct.params.boundary, MAX_PARTS - out.length)) {
        if (out.length >= MAX_PARTS) break;
        leaves(child, depth + 1, out);
      }
    }
    return out;
  }
  out.push({ type: ct.type || "text/plain", params: ct.params, headers, body });
  return out;
}

// A file name in any form: name=, name*=, and RFC 2231's split name*0=, name*1*= (long or non-ASCII names).
const FILE_NAME = /^(file)?name(\*|$)/;
function isAttachment(part) {
  const disp = mimeValue(part.headers["content-disposition"]);
  return disp.type === "attachment" || Object.keys(disp.params).some((k) => FILE_NAME.test(k)) ||
    Object.keys(part.params).some((k) => FILE_NAME.test(k));
}

function partText(part, max = Infinity) {
  const cte = String(part.headers["content-transfer-encoding"] || "").trim().toLowerCase();
  const body = part.body.length > max ? part.body.slice(0, max) : part.body;
  if (cte === "quoted-printable") return decodeBytes(qpBytes(body), part.params.charset);
  if (cte === "base64") return decodeBytes(b64Bytes(body), part.params.charset);
  return body; // 7bit / 8bit / binary: the relay already read it as text
}

// ---------------------------------------------------------------------------------------------------------------
// Text

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", pound: "£", euro: "€", copy: "©", reg: "®",
  trade: "™", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚",
  bdquo: "„", bull: "•", middot: "·", deg: "°", times: "×", divide: "÷", laquo: "«", raquo: "»", cent: "¢",
  yen: "¥", sect: "§", para: "¶", shy: "", zwnj: "", zwj: "", frac12: "½", frac14: "¼", frac34: "¾",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à", acirc: "â", auml: "ä", aring: "å",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", ccedil: "ç", ntilde: "ñ", szlig: "ß", Eacute: "É", Agrave: "À",
  Ouml: "Ö", Uuml: "Ü", Auml: "Ä",
};

// <blockquote> and </blockquote>, while html is turned into text: two private-use characters, each on a line of its
// own. Neither can come from the email itself (removed from the html first, and an entity for one decodes to U+FFFD).
const QUOTE_OPEN = String.fromCharCode(0xe000);
const QUOTE_CLOSE = String.fromCharCode(0xe001);
const MARKERS = /[\ue000\ue001]/g;

// A numeric reference; 128–159 mean Windows-1252 there (the HTML rule), so "&#146;" is "’".
function codePoint(n) {
  if (n >= 0x80 && n <= 0x9f) return String.fromCharCode(CP1252[n - 0x80]);
  if (n === 0xe000 || n === 0xe001) return String.fromCharCode(0xfffd); // never a blockquote marker (below)
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
}

const namedEntity = (name) => (Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : null);
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e) => {
  if (e[0] === "#") return codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return namedEntity(e) ?? namedEntity(e.toLowerCase()) ?? all; // own names only: "&constructor;" stays as it is
});

const DROP_TAGS = new Set(["head", "style", "script", "title", "xml"]); // dropped with everything inside them
const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "tr", "table", "tbody",
  "thead", "blockquote", "pre", "hr", "section", "article", "header", "footer", "center"]); // a line break
const TAG_NAME = /\/?([a-z][a-z0-9]*)/iy;
// Each dropped tag's closing tag ("</style>", "</STYLE >"). Matched case-insensitively on the html itself: a
// lower-cased copy can be longer ("İ" lower-cases to 2 characters), so its positions wouldn't line up.
const CLOSING = new Map([...DROP_TAGS].map((n) => [n, new RegExp(`</${n}(?=[\\s/>]|$)`, "gi")]));
const SPACES = /[ \t\r\n\f]+/g;

// The closing tag of `name` at or after `from`, as the index just past its ">"; -1 if there's none.
function closingTag(html, name, from) {
  const re = CLOSING.get(name);
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return -1;
  const end = html.indexOf(">", m.index);
  return end < 0 ? html.length : end + 1;
}

// "<" then a letter, "/", "!" or "?" starts a tag; any other "<" ("3 < 4") is text, as in a browser.
const startsTag = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 47 || c === 33 || c === 63;

// Lines inside a <blockquote> (html's form of quoting: Apple, Yahoo and Gmail put the quoted email in one) start
// "> ", as in a plain-text reply, so the same quote rules cut them.
function markQuotes(lines) {
  const out = [];
  let depth = 0;
  for (const line of lines) {
    if (line === QUOTE_OPEN) depth++;
    else if (line === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
    else out.push(depth && line ? `> ${line}` : line);
  }
  return out;
}

// Tags out, <br> and block tags as line breaks, blockquotes as "> " lines, entities decoded. One pass that looks at
// each "<" once (regexes like /<[^>]*>/ go quadratic on "<a<a<a…" or a pile of unclosed <style>s, and a hostile email
// must not be able to burn the tick's CPU). A tag with no ">" after it is text; a <style> etc. that is never closed is
// just a tag.
function htmlToText(source) {
  const html = source.includes(QUOTE_OPEN) || source.includes(QUOTE_CLOSE) ? source.replace(MARKERS, "") : source;
  let quotes = false; // any <blockquote> seen
  const out = [];
  const unclosed = new Set(); // DROP_TAGS with no closing tag anywhere further on
  let text = 0; // start of the text not yet copied to out
  let at = 0; // where to look for the next "<"
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt < 0) break;
    if (!startsTag(html.charCodeAt(lt + 1))) {
      at = lt + 1;
      continue;
    }
    if (html.startsWith("<!--", lt)) {
      out.push(html.slice(text, lt).replace(SPACES, " "));
      const end = html.indexOf("-->", lt + 4);
      text = at = end < 0 ? html.length : end + 3; // an unclosed comment runs to the end
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // the rest is text
    out.push(html.slice(text, lt).replace(SPACES, " "));
    text = at = gt + 1;
    TAG_NAME.lastIndex = lt + 1;
    const m = TAG_NAME.exec(html);
    if (!m) continue; // <!DOCTYPE>, <?xml?>: not a tag we act on
    const name = m[1].toLowerCase();
    if (m[0][0] !== "/" && DROP_TAGS.has(name) && !unclosed.has(name)) {
      const after = closingTag(html, name, at);
      if (after >= 0) {
        text = at = after;
        continue;
      }
      unclosed.add(name);
    }
    const selfClosing = html.charCodeAt(gt - 1) === 47; // "<blockquote/>" opens nothing
    if (name === "blockquote" && !selfClosing) {
      out.push(`\n${m[0][0] === "/" ? QUOTE_CLOSE : QUOTE_OPEN}\n`);
      quotes = true;
    } else if (name === "br" || BLOCK_TAGS.has(name)) out.push("\n");
  }
  out.push(html.slice(text).replace(SPACES, " "));
  const lines = decodeEntities(out.join("")).replace(/\u00a0/g, " ").split("\n").map((l) => l.trim());
  return (quotes ? markQuotes(lines) : lines).join("\n").replace(/\n{3,}/g, "\n\n");
}

const tidy = (s) => s.replace(/\ufeff/g, "").split("\n").map((l) => l.trimEnd()).join("\n").trim();

// "On <date>, <name> wrote:" (Gmail, Apple, Yahoo, Thunderbird): a line starting "On ", then a digit, then
// " wrote:" that ends the line, or has 2+ spaces after it (Yahoo's one-line "wrote:   Hi Dave,"), or comes after an
// email address. The digit keeps "On Monday you wrote: …" in, and the rest keeps a sentence such as "On the 19th you
// wrote: free for 60 days?" in (cutting there would lose the reply). Only a line's first 500 characters are looked
// at, and without a backtracking pattern (/On\s.*\d.*\swrote:/ costs n² per line).
const ON_START = /^\s*On\s/;
const WROTE = /\swrote:(?=\s|$)/g;
function isAttribution(line) {
  const s = line.length > 500 ? line.slice(0, 500) : line;
  if (!ON_START.test(s)) return false;
  let at = -1;
  for (const m of s.matchAll(WROTE)) at = m.index; // the last " wrote:", so any digit before it counts
  if (at <= 0) return false;
  const before = s.slice(0, at);
  const after = s.slice(at + " wrote:".length);
  return /\d/.test(before) && (!after.trim() || /^\s{2}/.test(after) || before.includes("@"));
}
// Gmail wraps a long attribution: "On Mon, 19 Oct 2026 at 08:01, Nik <nik@aetoswebsites.com>" then "wrote:".
const wrapsOver = (line, next) => next != null && ON_START.test(line) && !/\swrote:/.test(line.slice(0, 500)) &&
  isAttribution(line.slice(0, 500) + " " + next.slice(0, 500).trim());
const isQuoted = (l) => /^\s*>/.test(l);
const isBlank = (l) => !l.trim();
// The next non-blank line within 3, for "a line of underscores followed by From:".
function nextFilled(lines, i) {
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) if (!isBlank(lines[j])) return lines[j];
  return "";
}

// Part A's cut rules, applied in order; each cuts at its first match in what is left.
const CUTS = [
  (lines) => lines.findIndex((l, i) => isAttribution(l) || wrapsOver(l, lines[i + 1])),
  (lines) => lines.findIndex((l) => /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(l)),
  (lines) => lines.findIndex((l, i) => /^\s*_{5,}\s*$/.test(l) && /^\s*\*?From:/i.test(nextFilled(lines, i))),
  (lines) => lines.findIndex((l, i) => /^\s*\*?From:/i.test(l) && /^\s*\*?(Sent|Date):/i.test(lines[i + 1] ?? "")),
  (lines) => {
    let start = -1;
    for (let i = lines.length - 1; i >= 0 && (isBlank(lines[i]) || isQuoted(lines[i])); i--) if (isQuoted(lines[i])) start = i;
    return start;
  },
];

const OUTLOOK_CUTS = [CUTS[1], CUTS[2], CUTS[3]]; // -----Original Message-----, ____ + From:, From: + Sent:/Date:

function stripQuotes(text) {
  const all = text.split("\n");
  let lines = all;
  for (const cut of CUTS) {
    const at = cut(lines);
    if (at >= 0) lines = lines.slice(0, at);
  }
  const kept = tidy(lines.join("\n"));
  if (kept) return kept;
  // A reply written under a "> " quote (bottom-posted): keep the lines that aren't quoted or an attribution, above
  // the first Outlook-style header anywhere in the mail. Under one of those everything is our own email, unmarked, so
  // nothing from there on is theirs (an empty reply, or one that only carried an attachment, gives "", never our
  // words, "no thanks" footer and all, passed off as theirs).
  let end = all.length;
  for (const cut of OUTLOOK_CUTS) {
    const at = cut(all);
    if (at >= 0 && at < end) end = at;
  }
  const rest = all.slice(0, end);
  return tidy(rest.filter((l, i) => !isQuoted(l) && !isAttribution(l) && !wrapsOver(l, rest[i + 1]) &&
    !(i > 0 && wrapsOver(rest[i - 1], l))).join("\n"));
}

function cap(text) {
  if (text.length <= BODY_CAP) return text;
  const code = text.charCodeAt(BODY_CAP - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? BODY_CAP - 1 : BODY_CAP);
}

/** The sender's own words: the first text/plain part that isn't an attachment (else the html one, tags stripped),
 *  decoded, with the quoted thread cut off, capped at 20,000 characters. */
export function extractText(raw) {
  if (typeof raw !== "string" || !raw) return "";
  const parts = leaves(lf(raw)).filter((p) => !isAttachment(p));
  const plain = parts.find((p) => p.type === "text/plain");
  let text = plain ? tidy(lf(partText(plain, ENCODED_WORK)).slice(0, TEXT_WORK)) : "";
  if (!text) {
    const html = parts.find((p) => p.type === "text/html");
    if (html) text = tidy(htmlToText(lf(partText(html, ENCODED_WORK))).slice(0, TEXT_WORK));
  }
  return cap(stripQuotes(text));
}

// ---------------------------------------------------------------------------------------------------------------
// Headers

// Split an address list at commas outside quotes, <…> and (…); drop group names ("undisclosed-recipients:;").
// An encoded word is one token: "=?utf-8?Q?Smith,_Bob?=" isn't split at its comma (senders do write those).
const ONE_WORD = /=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=/y;

// The first `max` addresses of a list (the tick only ever needs the first).
function addressList(value, max = Infinity) {
  const out = [];
  const take = (piece) => {
    const s = piece.trim().replace(/^[^"<>@(]*:\s*/, "");
    const a = s ? oneAddress(s) : null;
    if (a?.address) out.push(a);
    return out.length >= max;
  };
  let cur = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === "=" && value[i + 1] === "?") {
      ONE_WORD.lastIndex = i;
      const w = ONE_WORD.exec(value);
      if (w) {
        cur += w[0];
        i += w[0].length - 1;
        continue;
      }
    }
    if (c === '"') quoted = true;
    else if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if ((c === "," || c === ";") && !angle && !paren) {
      if (take(cur)) return out;
      cur = "";
      continue;
    }
    cur += c;
  }
  take(cur);
  return out;
}

function angleOutsideQuotes(piece) {
  let quoted = false;
  for (let i = 0; i < piece.length; i++) {
    const c = piece[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (c === "<" && !quoted) return i;
  }
  return -1;
}

function oneAddress(piece) {
  let name;
  let address;
  const open = angleOutsideQuotes(piece); // a quoted name may hold "<" too: "Bob <the boss>" <bob@x.com>
  const close = open < 0 ? -1 : piece.indexOf(">", open);
  if (close > open) {
    address = piece.slice(open + 1, close);
    name = piece.slice(0, open).trim();
  } else {
    const comment = /\(([^()]*)\)/.exec(piece);
    name = comment ? comment[1] : "";
    address = piece.replace(/\([^()]*\)/g, "");
  }
  if (/^"(.*)"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  return {
    name: decodeWords(name).replace(/\s+/g, " ").trim(),
    address: address.replace(/^mailto:/i, "").replace(/\s+/g, "").toLowerCase(),
  };
}

// A Message-ID is printable ASCII with no spaces or angle brackets inside (as compose.js's MSG_ID): ids are stored
// and later sent back in In-Reply-To/References, so a control or non-ASCII character never gets through.
const ID_CHARS = "[\\x21-\\x3b\\x3d\\x3f-\\x7e]+";
const ID_IN_TEXT = new RegExp(`<${ID_CHARS}>`, "g");
const BARE_ID = new RegExp(`^${ID_CHARS}$`);

function oneId(value) {
  if (value == null) return null;
  const s = String(value);
  ID_IN_TEXT.lastIndex = 0;
  const m = ID_IN_TEXT.exec(s);
  if (m) return m[0];
  const v = s.trim();
  return BARE_ID.test(v) && v.includes("@") ? `<${v}>` : null;
}

function headerObject(headersJson) {
  let h = headersJson;
  if (typeof h === "string") {
    try {
      h = JSON.parse(h);
    } catch {
      throw new Error("parseHeaders: the stored headers aren't valid JSON");
    }
  }
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("parseHeaders: the headers must be a JSON object");
  const out = Object.create(null);
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (!(key in out) && v != null) out[key] = unfold(Array.isArray(v) ? v.join(", ") : v);
  }
  return out;
}

/** The headers the relay stored (JSON of lower-cased name → value, or that object) in the shape the tick uses.
 *  Addresses are lower-cased; `to` is the first recipient's address; ids keep their <…>. */
export function parseHeaders(headersJson) {
  const h = headerObject(headersJson);
  const get = (k) => (k in h ? h[k] : null);
  return {
    from: addressList(get("from") ?? "", 1)[0] ?? { name: "", address: "" },
    to: addressList(get("to") ?? "", 1)[0]?.address ?? "",
    subject: decodeWords(get("subject") ?? "").trim(),
    messageId: oneId(get("message-id")),
    inReplyTo: oneId(get("in-reply-to")),
    references: (get("references") ?? "").match(ID_IN_TEXT) ?? [],
    contentType: get("content-type") ?? "",
    autoSubmitted: get("auto-submitted"),
    xAutoreply: get("x-autoreply"),
    xAutorespond: get("x-autorespond"),
    precedence: get("precedence"),
    listId: get("list-id"),
    listUnsubscribe: get("list-unsubscribe"),
    listPost: get("list-post"),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bounces

// "Name: value" groups separated by blank lines (RFC 3464's per-message and per-recipient blocks); folded lines join.
function fieldBlocks(text) {
  const blocks = [];
  let cur = null;
  let key = null;
  for (const line of text.split("\n")) {
    if (isBlank(line)) {
      cur = null;
      key = null;
      continue;
    }
    if (/^[ \t]/.test(line) && cur && key) {
      cur[key] += " " + line.trim();
      continue;
    }
    const m = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!m) {
      key = null;
      continue;
    }
    if (!cur) blocks.push((cur = Object.create(null)));
    key = m[1].toLowerCase();
    if (key in cur) key = null;
    else cur[key] = m[2].trim();
  }
  return blocks;
}

const action = (b) => String(b.action || "").trim().toLowerCase();
const status = (b) => String(b.status || "").trim();
// An explicit "Action: failed" always beats the status code: Postfix gives up on a message with Action: failed and
// the last temporary (4.x.x) status, and that is the final failure, not a delay.
const isDelay = (b) => action(b) === "delayed" || (action(b) !== "failed" && /^4\.\d{1,3}\.\d{1,3}\b/.test(status(b)));
const isFailed = (b) => action(b) === "failed" || /^5\.\d{1,3}\.\d{1,3}\b/.test(status(b));
const isRecipient = (b) => b["final-recipient"] != null || b["original-recipient"] != null;

function recipientOf(block) {
  for (const field of ["final-recipient", "original-recipient"]) {
    const v = block[field];
    if (!v) continue;
    const address = oneAddress(v.includes(";") ? v.slice(v.indexOf(";") + 1).trim() : v.trim()).address;
    if (address) return address;
  }
  return null;
}

function report(raw, subject = null) {
  const text = lf(typeof raw === "string" ? raw : "");
  const top = entity(text);
  const parts = leaves(text);
  const statusPart = parts.find((p) => REPORT_PART.test(p.type));
  const head = top.body.slice(0, ENCODED_WORK); // a plain-text bounce says what failed near the top
  const blocks = fieldBlocks(statusPart ? lf(partText(statusPart, ENCODED_WORK)) : head);
  const recipients = blocks.filter(isRecipient);
  const chosen = recipients.find(isFailed) ?? recipients[0] ?? null;
  const recipient = (chosen && recipientOf(chosen)) || addressList(top.headers["x-failed-recipients"] ?? "", 1)[0]?.address ||
    null;
  const subj = subject ?? decodeWords(top.headers.subject ?? "");
  // A recipient line decides; the subject only speaks for a notice that has none (Exim's plain-text warnings).
  const delayed = chosen ? isDelay(chosen) : blocks.some(isDelay) || DELAY_SUBJECT.test(subj);
  const delivered = !!chosen && /^(delivered|relayed|expanded)$/.test(action(chosen));
  let messageId = null;
  const original = parts.find((p) => ORIGINAL_PART.test(p.type));
  if (original) messageId = oneId(entity(lf(partText(original, ENCODED_WORK))).headers["message-id"]);
  for (const b of blocks) messageId ??= oneId(b["x-original-message-id"] ?? b["original-message-id"]);
  messageId ??= oneId(/^message-id:[ \t]*(?:\n[ \t]+)?(<[^<>\s]+>)/im.exec(head)?.[1]); // Exchange folds it
  return { recipient, messageId, delayed, delivered };
}

/** What a delivery report says: the failed recipient (Final-Recipient, else X-Failed-Recipients), the Message-ID of
 *  our original inside it, and whether it's only a delay (Action: delayed, or Status: 4.x.x without Action: failed). */
export function bounceInfo(raw) {
  const { recipient, messageId, delayed } = report(raw);
  return { recipient, messageId, delayed };
}

// ---------------------------------------------------------------------------------------------------------------
// Classify

function isOptOut(text) {
  if (text.split(/\s+/).filter(Boolean).length > OPT_OUT_MAX_WORDS) return false;
  const lines = text.split("\n").filter((l) => !isBlank(l)).slice(0, 3);
  return lines.some((line) => {
    const words = ` ${line.toLowerCase().replace(/['’`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
    return OPT_OUT_PHRASES.some((p) => words.includes(` ${p} `));
  });
}

const isListMail = (h) => h.listId != null || h.listUnsubscribe != null || h.listPost != null ||
  String(h.precedence ?? "").trim().toLowerCase() === "list";
const isReply = (h) => !!h.inReplyTo || (Array.isArray(h.references) && h.references.length > 0);

/** bounce | auto | opt_out | human, first match wins (Part A). `headers` is parseHeaders' result, or what the relay
 *  stored (JSON or the object); `text` defaults to extractText(raw). */
export function classifyInbound({ headers, text, raw = "" } = {}) {
  const h = headers && typeof headers === "object" && headers.from && typeof headers.from === "object"
    ? headers : parseHeaders(headers ?? {});
  const ct = mimeValue(h.contentType);
  const isReport = ct.type === "multipart/report" && String(ct.params["report-type"] || "").toLowerCase() === "delivery-status";
  if (isReport || DAEMON.test(h.from?.address ?? "")) {
    const r = report(raw, h.subject);
    return r.delayed || r.delivered ? "auto" : "bounce";
  }
  // RFC 3834: "Auto-Submitted: no" may carry parameters ("no; x=y") and still mean a person wrote it.
  if (h.autoSubmitted != null && h.autoSubmitted.split(";")[0].trim().toLowerCase() !== "no") return "auto";
  if (h.xAutoreply != null || h.xAutorespond != null) return "auto";
  if (h.precedence != null && AUTO_PRECEDENCE.includes(h.precedence.trim().toLowerCase())) return "auto";
  if (AUTO_SUBJECT.test(h.subject ?? "")) return "auto";
  // An addition to Part A's auto rule (rule 2): D-1 option A forwards everything in Nik's inbox, newsletters
  // included, and each would otherwise become an "unknown sender" todo. List mail is auto only when it isn't a reply:
  // a newsletter never has In-Reply-To or References, and a real reply to Nik always does, so a prospect whose mail
  // host or CRM adds List-Unsubscribe to every email still counts as a person (a false "auto" loses the lead).
  if (isListMail(h) && !isReply(h)) return "auto";
  if (isOptOut(text ?? extractText(raw))) return "opt_out";
  return "human";
}
