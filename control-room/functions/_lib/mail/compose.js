// Plain-text email composer (pure). Builds the RFC 5322 headers (From, To, Subject, Date, Message-ID, and
// In-Reply-To / References when replying) and the text body. The SMTP library adds the MIME headers and writes these
// values to the wire as they are, so they are checked here:
// - a CR or LF anywhere in one is refused outright (header values come from scraped and inbound data);
// - a non-ASCII (or control) display name or subject is RFC 2047 B-encoded;
// - addresses must be plain ASCII (worker-mailer doesn't speak SMTPUTF8);
// - no header line is longer than RFC 5322's 998 characters.

export const OPT_OUT_LINE = 'If you\'d rather not hear from me, just reply "no thanks".';

const LINE_BREAK = /[\r\n]/;
const NEEDS_ENCODING = /[^\x20-\x7e]|=\?/; // non-ASCII or control, or text a mail app would read as an encoded word
const PLAIN = /^[\x20-\x7e]*$/; // printable ASCII
const SPECIALS = /[()<>@,;:\\".[\]]/;
const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/; // printable ASCII, no spaces or angle brackets inside
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`); // e.g. aetoswebsites.com: no empty labels, no edge hyphens
const MAX_REFERENCES = 10;
const MAX_LINE = 998; // RFC 5322: a header line is at most 998 characters
const WORD_BYTES = 45; // 45 bytes → 60 base64 characters → a 72-character encoded word (the limit is 75)

function clean(value) {
  const s = value == null ? "" : String(value);
  if (LINE_BREAK.test(s)) throw new Error("Header values can't contain line breaks");
  return s.trim();
}

function base64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// RFC 2047 B-encoding, split into words of at most 75 characters, never inside a character.
function encodeWords(text) {
  const enc = new TextEncoder();
  const words = [];
  let chunk = [];
  for (const ch of text) {
    const bytes = enc.encode(ch);
    if (chunk.length + bytes.length > WORD_BYTES) {
      words.push(chunk);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64(w)}?=`).join(" ");
}

const encodeText = (text) => (NEEDS_ENCODING.test(text) ? encodeWords(text) : text);

function displayName(name) {
  if (NEEDS_ENCODING.test(name)) return encodeWords(name);
  if (SPECIALS.test(name)) return `"${name.replace(/[\\"]/g, "\\$&")}"`;
  return name;
}

function mailbox(from) {
  const n = clean(from?.name);
  const a = clean(from?.address);
  if (!a) throw new Error("composeEmail: from.address is required");
  if (!PLAIN.test(a)) {
    throw new Error("The mailbox address has accented letters or hidden characters. Check it on Setup → Mailboxes.");
  }
  return n ? `${displayName(n)} <${a}>` : a;
}

// One or more Message-IDs (a string such as a stored References header, or an array) as "<id>" strings. Ids written
// without angle brackets get them; text with angle brackets gives only its complete "<...>" tokens, so a broken id
// such as "<a b@x>" is dropped rather than split into made-up ids.
function ids(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    const s = clean(item);
    if (!s) continue;
    if (/[<>]/.test(s)) out.push(...(s.match(/<[^<>\s]+>/g) ?? []));
    else out.push(...s.split(/\s+/).map((id) => `<${id}>`));
  }
  return out;
}

// An id from someone else's mail is used only if it's a proper Message-ID that fits on an In-Reply-To line.
const usableId = (id) => MSG_ID.test(id) && "In-Reply-To: ".length + id.length <= MAX_LINE;

const HEADER_LABELS = { From: "sender name", To: "To address", Subject: "subject" };

/** A new Message-ID, "<uuid@domain>". Takes a domain or a mailbox address. */
export function makeMessageId(domain) {
  const d = clean(domain).split("@").pop().toLowerCase();
  if (!d || !DOMAIN.test(d)) throw new Error("makeMessageId needs a domain, e.g. aetoswebsites.com");
  return `<${crypto.randomUUID()}@${d}>`;
}

/**
 * A plain-text email: {headers, text}. `references` is the chain to send (a string such as the row's stored `refs`,
 * or an array), kept in its own order: a follow-up's `in_reply_to` is the first email while its `refs` also list the
 * follow-ups sent since. The parent (`inReplyTo`) is added at the end only when the chain doesn't have it, and only
 * the last 10 ids are kept (fewer if they don't fit on one header line). Ids from other people's mail that aren't
 * proper Message-IDs are left out, never sent.
 */
export function composeEmail({ from, to, subject, body, messageId, inReplyTo, references, date = new Date() }) {
  const headers = {};
  headers.From = mailbox(from);
  headers.To = clean(to);
  if (!headers.To) throw new Error("composeEmail: to is required");
  if (!PLAIN.test(headers.To)) {
    throw new Error("Can't send to this address: it has accented letters or hidden characters that email servers don't accept. Check it and use a plain address.");
  }
  headers.Subject = encodeText(clean(subject));
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("composeEmail: date must be a valid Date");
  headers.Date = date.toUTCString();
  if (!clean(messageId)) throw new Error("composeEmail: messageId is required");
  const [id] = ids(messageId);
  if (!id || !MSG_ID.test(id)) throw new Error("composeEmail: messageId isn't a valid Message-ID");
  headers["Message-ID"] = id;

  const [parent] = ids(inReplyTo).filter(usableId);
  const chain = [...new Set(ids(references ?? []).filter(usableId))];
  if (parent && !chain.includes(parent)) chain.push(parent);
  if (parent) headers["In-Reply-To"] = parent;
  let refs = chain.slice(-MAX_REFERENCES);
  while (refs.length > 1 && "References: ".length + refs.join(" ").length > MAX_LINE) refs = refs.slice(1);
  if (refs.length) headers.References = refs.join(" ");

  for (const [name, value] of Object.entries(headers)) {
    if (name.length + 2 + value.length > MAX_LINE) {
      const label = HEADER_LABELS[name] ?? `${name} header`;
      throw new Error(`The ${label} is too long for an email (a header line can be at most ${MAX_LINE} characters). Shorten it and try again.`);
    }
  }

  if (body == null) throw new Error("composeEmail: body is required");
  const text = String(body).replace(/\r\n?/g, "\n");
  return { headers, text };
}

/** The footer every cold email ends with: Nik's name, the business, and the opt-out line. */
export function coldFooter(nikName) {
  const name = String(nikName ?? "").trim();
  return [name, "Aetos Websites"].filter(Boolean).join("\n") + `\n\n${OPT_OUT_LINE}`;
}
