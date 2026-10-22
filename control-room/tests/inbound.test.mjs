// Inbound mail parsing (pure). Run: node --test control-room/tests/inbound.test.mjs
// The fixtures in tests/fixtures/mail/ are laid out the way Gmail, Outlook, iPhone, Yahoo, Postfix (Namecheap's
// mail servers) and Gmail's bounce generator really send mail, with CRLF line endings.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { OPT_OUT_PHRASES, bounceInfo, classifyInbound, extractText, parseHeaders } from "../functions/_lib/mail/inbound.js";

const DIR = new URL("./fixtures/mail/", import.meta.url);
const load = (name) => readFileSync(new URL(name, DIR), "utf8");

// The headers the relay stores: the top-level header block through a Headers object (keys lower-cased, a repeated
// header joined with ", "), as JSON.
function relayHeaders(raw) {
  const block = raw.split(/\r?\n\r?\n/)[0];
  const h = new Headers();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return JSON.stringify(Object.fromEntries(h));
}

function mail(name) {
  const raw = load(name);
  const headers = parseHeaders(relayHeaders(raw));
  const text = extractText(raw);
  return { raw, headers, text, cls: classifyInbound({ headers, text, raw }) };
}

// A small plain-text message for the edge cases.
function plainMail(body, extra = "", from = "Bob Harris <bob@x.com>") {
  return `From: ${from}\r\nTo: Nik <nik@aetoswebsites.com>\r\nSubject: Re: Your new website, Bob\r\n` +
    `Message-ID: <edge@mail.gmail.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n${extra}` +
    `\r\n${body.replace(/\r?\n/g, "\r\n")}\r\n`;
}
function classifyRaw(raw) {
  const headers = parseHeaders(relayHeaders(raw));
  return classifyInbound({ headers, text: extractText(raw), raw });
}
const classifyBody = (body, extra, from) => classifyRaw(plainMail(body, extra, from));

const IPHONE_TEXT = "Sounds good mate, I’ll have a proper look tonight when I’m back from the job.\n\nCheers \u{1F44D}\n\nSent from my iPhone";

// --- Task 14, Step 1 -----------------------------------------------------------------------------------------------

test("gmail-reply: only the reply's own lines (the wrapped On … wrote: and the > lines are cut), human", () => {
  const m = mail("gmail-reply.eml");
  assert.equal(m.text, "Hi Nik,\n\nHad a look at the site, it's not bad at all. My lad reckons the photos need changing " +
    "but otherwise I like it. What would it cost to keep it going each month?\n\nCheers,\nBob");
  assert.doesNotMatch(m.text, /wrote:/);
  assert.doesNotMatch(m.text, /^>/m);
  assert.equal(m.cls, "human"); // the quoted footer's "no thanks" is gone with the quote
  assert.equal(m.headers.inReplyTo, "<orig@aetoswebsites.com>");
  assert.deepEqual(m.headers, {
    from: { name: "Bob Harris", address: "bobharrisroofing@gmail.com" },
    to: "nik@aetoswebsites.com",
    subject: "Re: Your new website, Bob",
    messageId: "<CAJx7Lk2bPq0vN=Ze4tX1+R8mGHu3sYw-Fd5kLzQ9aE2oWcVb7g@mail.gmail.com>",
    inReplyTo: "<orig@aetoswebsites.com>",
    references: ["<orig@aetoswebsites.com>"],
    contentType: 'multipart/alternative; boundary="0000000000004f3e2b0624c1a7d9"',
    autoSubmitted: null,
    xAutoreply: null,
    xAutorespond: null,
    precedence: null,
    listId: null,
    listUnsubscribe: null,
    listPost: null,
  });
});

test("outlook-qp: Windows-1252 quoted-printable decodes £ and ’; the ____ + From: block is cut; human", () => {
  const m = mail("outlook-qp.eml");
  assert.match(m.text, /£249/);
  assert.match(m.text, /I’m interested/); // 0x92 is ’ in Windows-1252 (not a C1 control as in strict Latin-1)
  assert.doesNotMatch(m.text, /From:/);
  assert.doesNotMatch(m.text, /____/);
  assert.equal(m.text, "Hi Nik,\n\nThanks for sending this over. I’m interested but £249 a month is a lot for us at " +
    "the moment. Is there any way of doing it cheaper, or just the website on its own?\n\nKind regards\n\nSteve Turner\n" +
    "Turner Roofing Ltd\n07700 900321");
  assert.equal(m.cls, "human");
  // Exchange folds the Message-ID onto its own line.
  assert.equal(m.headers.messageId, "<LO4P265MB58733F1A2B9C4D5E6F7A8B9CD1E2A@LO4P265MB5873.GBRP265.PROD.OUTLOOK.COM>");
  assert.equal(m.headers.subject, "RE: Your new website, Steve");
});

test("iphone-b64: base64 UTF-8 decodes (Cheers 👍) and the text comes from text/plain, not the html", () => {
  const m = mail("iphone-b64.eml");
  assert.match(m.text, /Cheers 👍/);
  assert.equal(m.text, IPHONE_TEXT);
  assert.doesNotMatch(m.text, /[<>\ufeff]/);
  assert.equal(m.cls, "human");
  // Replace the html part's content: the result can't change, because it never came from there.
  const swapped = m.raw.replace(/(Content-Type: text\/html;[\s\S]*?\r\n\r\n)[A-Za-z0-9+/=\r\n]+(\r\n--Apple-Mail)/,
    (_, head, tail) => head + Buffer.from("<div>Words only in the HTML part</div>").toString("base64") + tail);
  assert.notEqual(swapped, m.raw);
  assert.equal(extractText(swapped), IPHONE_TEXT);
  // And with the plain part gone, the html part (base64, <blockquote>, U+FEFF) gives the same words.
  const htmlOnly = m.raw.replace(/--Apple-Mail[^\r\n]*\r\nContent-Type: text\/plain;[\s\S]*?(?=--Apple-Mail)/, "");
  assert.notEqual(htmlOnly, m.raw);
  assert.equal(extractText(htmlOnly), IPHONE_TEXT);
});

test("html-only: no tags left, entities decoded, <style> dropped, the Outlook reply header cut", () => {
  const m = mail("html-only.eml");
  assert.doesNotMatch(m.text, /</);
  assert.doesNotMatch(m.text, /&[a-z#0-9]+;/i);
  assert.doesNotMatch(m.text, /margin|font-family/);
  assert.equal(m.text, "Hi Nik,\n\nThanks & yes, we'd like to go ahead. Is the £1,950 a one-off, and is the " +
    "“first 60 days free” on top of that?\n\nBest wishes,\nMaria Rossi\nCafé Plumbing Ltd");
  assert.equal(m.cls, "human");
  assert.deepEqual(m.headers.from, { name: "Café Plumbing Ltd", address: "info@cafeplumbing.co.uk" }); // ISO-8859-1 Q-word
});

test("with-attachment: the PDF is skipped and the text is just the reply", () => {
  const m = mail("with-attachment.eml");
  assert.equal(m.text, "See attached");
  assert.equal(m.cls, "human");
});

test("ooo (Auto-Submitted: auto-replied) and ooo-subject (\"Automatic reply: away\", no auto headers) are auto", () => {
  const ooo = mail("ooo.eml");
  assert.equal(ooo.headers.autoSubmitted, "auto-replied");
  assert.equal(ooo.headers.subject, "Re: Your new website, Mark"); // the header alone makes it auto
  assert.equal(ooo.cls, "auto");
  const bySubject = mail("ooo-subject.eml");
  assert.equal(bySubject.headers.autoSubmitted, null);
  assert.equal(bySubject.headers.xAutoreply, null);
  assert.equal(bySubject.headers.xAutorespond, null);
  assert.equal(bySubject.headers.precedence, null);
  assert.equal(bySubject.headers.subject, "Automatic reply: away");
  assert.equal(bySubject.cls, "auto");
});

test("dsn-gmail: bounce, with the recipient and the original Message-ID from inside the report", () => {
  const m = mail("dsn-gmail.eml");
  assert.equal(m.cls, "bounce"); // even though Gmail's DSN also carries Auto-Submitted
  assert.deepEqual(bounceInfo(m.raw), { recipient: "nobody@x.com", messageId: "<orig@aetoswebsites.com>", delayed: false });
  assert.match(m.text, /Address not found/);
});

test("dsn-delay (Action: delayed, Status: 4.4.7) is auto, not a bounce", () => {
  const m = mail("dsn-delay.eml");
  assert.equal(m.cls, "auto");
  assert.deepEqual(bounceInfo(m.raw), {
    recipient: "sales@slowserver-scaffolding.co.uk",
    messageId: "<9e2c4a1b-3d5f-4e7a-8b6c-0f1e2d3c4b5a@aetoswebsites.com>",
    delayed: true,
  });
});

test("no-thanks: \"No thanks.\" above the iPhone signature and the quote is an opt_out", () => {
  const m = mail("no-thanks.eml");
  assert.equal(m.text, "No thanks.\n\nSent from my iPhone");
  assert.equal(m.cls, "opt_out");
  assert.equal(classifyInbound({ headers: m.headers, raw: m.raw }), "opt_out"); // text worked out from raw
});

test("long-mentions-unsubscribe: 60 words with \"unsubscribe\" on line 2 is human", () => {
  const m = mail("long-mentions-unsubscribe.eml");
  assert.equal(m.text.split(/\s+/).filter(Boolean).length, 60);
  assert.match(m.text.split("\n").filter((l) => l.trim())[1], /unsubscribe/);
  assert.equal(m.cls, "human");
});

test("a MAILER-DAEMON@namecheap.com sender with no report part is a bounce", () => {
  const raw = [
    "Return-Path: <>",
    "From: Mail Delivery System <MAILER-DAEMON@namecheap.com>",
    "To: nik@aetoswebsites.com",
    "Subject: Mail delivery failed: returning message to sender",
    "Message-Id: <E1t2Bq9-000A1b-3c@namecheap.com>",
    "X-Failed-Recipients: Gone@Example.co.uk",
    "Auto-Submitted: auto-replied",
    "Date: Mon, 19 Oct 2026 03:01:09 -0400",
    "",
    "This message was created automatically by mail delivery software.",
    "",
    "A message that you sent could not be delivered to one or more of its",
    "recipients. This is a permanent error. The following address(es) failed:",
    "",
    "  gone@example.co.uk",
    "    host mx.example.co.uk [203.0.113.9]",
    "    SMTP error from remote mail server after RCPT TO:<gone@example.co.uk>:",
    "    550 5.1.1 <gone@example.co.uk>: Recipient address rejected: User unknown",
    "",
    "------ This is a copy of the message, including all the headers. ------",
    "",
    "From: Nik <nik@aetoswebsites.com>",
    "To: gone@example.co.uk",
    "Subject: Your new website, Pat",
    "Message-ID: <5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d@aetoswebsites.com>",
    "",
    "Hi Pat,",
    "",
  ].join("\r\n");
  assert.equal(classifyRaw(raw), "bounce");
  assert.deepEqual(bounceInfo(raw), {
    recipient: "gone@example.co.uk",
    messageId: "<5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d@aetoswebsites.com>",
    delayed: false,
  });
});

test("Auto-Submitted: no on its own is human", () => {
  assert.equal(classifyBody("Sounds good, ring me Tuesday after 4.", "Auto-Submitted: no\r\n"), "human");
  assert.equal(classifyBody("Sounds good, ring me Tuesday after 4.", "Auto-Submitted: No\r\n"), "human");
});

// --- More real-world mail -------------------------------------------------------------------------------------------

test("dsn-namecheap (Postfix 'Undelivered Mail Returned to Sender'): bounce, folded fields, text/rfc822-headers", () => {
  const m = mail("dsn-namecheap.eml");
  assert.deepEqual(m.headers.from, { name: "Mail Delivery System", address: "mailer-daemon@mta-09.privateemail.com" });
  assert.equal(m.cls, "bounce");
  assert.deepEqual(bounceInfo(m.raw), {
    recipient: "info@oldsite-plumbing.co.uk",
    messageId: "<3f9c2b7e-4a1d-4e8b-9c6f-2d5e8a1b7c40@aetoswebsites.com>",
    delayed: false,
  });
});

test("namecheap-forwarded: the sender's own From/To/Message-ID survive the forward; Yahoo's one-line quote is cut", () => {
  const m = mail("namecheap-forwarded.eml");
  assert.deepEqual(m.headers.from, { name: "Dave Wilkins", address: "dave.wilkins@yahoo.co.uk" });
  assert.equal(m.headers.to, "nik@aetoswebsites.com"); // not the receive-only replies@ address
  assert.equal(m.headers.messageId, "<1283746529.4567821.1792404721234@mail.yahoo.com>");
  assert.equal(m.headers.inReplyTo, "<e9b4c2d7-3f1a-4b8e-9c5d-2a7f0e1b6c43@aetoswebsites.com>");
  assert.equal(m.text, "Go on then, what do I need to do next? Can you put my Checkatrade link on it as well\n\n" +
    "Sent from Yahoo Mail on Android");
  assert.equal(m.cls, "human");
});

test("every fixture is real-looking mail: CRLF line endings only, and no fixture leaks a parse error", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".eml"));
  assert.ok(files.length >= 13, files.join(", "));
  for (const f of files) {
    const raw = load(f);
    assert.doesNotMatch(raw, /(^|[^\r])\n/, `${f} has a bare LF`);
    assert.ok(raw.endsWith("\r\n"), f);
    const m = mail(f);
    assert.ok(["bounce", "auto", "opt_out", "human"].includes(m.cls), f);
    assert.ok(m.headers.messageId, f);
  }
});

test("the same mail with bare LF line endings gives the same result", () => {
  for (const f of ["gmail-reply.eml", "outlook-qp.eml", "iphone-b64.eml", "dsn-gmail.eml"]) {
    const raw = load(f);
    const lf = raw.replace(/\r\n/g, "\n");
    assert.equal(extractText(lf), extractText(raw), f);
    assert.deepEqual(bounceInfo(lf), bounceInfo(raw), f);
  }
});

test("Windows-1252 still decodes where TextDecoder only knows UTF-8", () => {
  const Real = globalThis.TextDecoder;
  globalThis.TextDecoder = class extends Real {
    constructor(label = "utf-8", options) {
      if (!/^utf-?8$/i.test(String(label).trim())) throw new RangeError(`The "${label}" encoding is not supported`);
      super(label, options);
    }
  };
  try {
    const text = extractText(load("outlook-qp.eml"));
    assert.match(text, /£249/);
    assert.match(text, /I’m/);
    assert.equal(parseHeaders(relayHeaders(load("html-only.eml"))).from.name, "Café Plumbing Ltd");
  } finally {
    globalThis.TextDecoder = Real;
  }
});

// --- Headers --------------------------------------------------------------------------------------------------------

test("parseHeaders: addresses lower-cased, quoted names with commas, bare <addr>, (comment) names", () => {
  const h = parseHeaders(JSON.stringify({
    from: '"Smith, Bob" <Bob.Smith@X.COM>',
    to: '"Harris, Bob" <BOB@x.com>, carol@y.com',
    subject: "Re: hi",
  }));
  assert.deepEqual(h.from, { name: "Smith, Bob", address: "bob.smith@x.com" });
  assert.equal(h.to, "bob@x.com");
  assert.deepEqual(parseHeaders({ from: "<Ann@B.co.uk>", to: "undisclosed-recipients:;" }).from, { name: "", address: "ann@b.co.uk" });
  assert.equal(parseHeaders({ from: "a@b.com", to: "undisclosed-recipients:;" }).to, "");
  assert.deepEqual(parseHeaders({ from: "MAILER-DAEMON (Mail Delivery System)" }).from,
    { name: "Mail Delivery System", address: "mailer-daemon" });
  assert.deepEqual(parseHeaders({ from: '"Nik \\"N\\" Smith" <n@a.com>' }).from, { name: 'Nik "N" Smith', address: "n@a.com" });
});

test("parseHeaders: RFC 2047 words (B and Q, a character split across two words), folded values", () => {
  const bytes = Buffer.from("Café Nik", "utf8");
  const w1 = bytes.subarray(0, 4).toString("base64"); // "Caf" + the first byte of é
  const w2 = bytes.subarray(4).toString("base64");
  assert.equal(parseHeaders({ from: `=?UTF-8?B?${w1}?= =?UTF-8?B?${w2}?= <n@a.com>` }).from.name, "Café Nik");
  assert.equal(parseHeaders({ subject: "=?utf-8?Q?Re:_Your_new_website=2C_Caf=C3=A9?=" }).subject, "Re: Your new website, Café");
  assert.equal(parseHeaders({ subject: "=?utf-8?q?Hello_?= =?utf-8?q?world?=" }).subject, "Hello world");
  assert.equal(parseHeaders({ subject: "Re: =?UTF-8?B?8J+RjQ==?= thanks" }).subject, "Re: 👍 thanks");
  assert.equal(parseHeaders({ subject: "Re: Your\r\n new website" }).subject, "Re: Your new website");
});

test("parseHeaders: Message-ID, In-Reply-To and References as <…> ids", () => {
  const chain = Array.from({ length: 30 }, (_, i) => `<id${i}@x.com>`);
  const h = parseHeaders({
    "message-id": "<a@b.com>",
    "in-reply-to": "Your message of Mon, 19 Oct 2026 <orig@aetoswebsites.com>",
    references: chain.slice(0, 15).join(" ") + "\r\n " + chain.slice(15).join(""),
  });
  assert.equal(h.messageId, "<a@b.com>");
  assert.equal(h.inReplyTo, "<orig@aetoswebsites.com>");
  assert.deepEqual(h.references, chain);
  assert.equal(parseHeaders({ "message-id": "no-brackets@b.com" }).messageId, "<no-brackets@b.com>");
});

test("parseHeaders: missing headers, original-case keys, and bad JSON", () => {
  assert.deepEqual(parseHeaders("{}"), {
    from: { name: "", address: "" }, to: "", subject: "", messageId: null, inReplyTo: null, references: [],
    contentType: "", autoSubmitted: null, xAutoreply: null, xAutorespond: null, precedence: null,
    listId: null, listUnsubscribe: null, listPost: null,
  });
  assert.equal(parseHeaders({ "Message-ID": "<k@b.com>", "X-Autoreply": "yes" }).messageId, "<k@b.com>");
  assert.equal(parseHeaders({ "X-Autoreply": "yes" }).xAutoreply, "yes");
  assert.throws(() => parseHeaders("\u0000"), /headers/);
  assert.throws(() => parseHeaders("[1,2]"), /headers/);
});

// --- Classification -------------------------------------------------------------------------------------------------

test("auto: any Auto-Submitted but no, X-Autoreply, X-Autorespond, Precedence bulk/auto_reply/junk, OOO subjects", () => {
  const body = "Thanks for your message, I'll be in touch.";
  assert.equal(classifyBody(body, "Auto-Submitted: auto-generated\r\n"), "auto");
  assert.equal(classifyBody(body, "X-Autoreply: yes\r\n"), "auto");
  assert.equal(classifyBody(body, "X-Autorespond: Thanks for your message\r\n"), "auto");
  for (const p of ["bulk", "auto_reply", "junk", "Bulk"]) assert.equal(classifyBody(body, `Precedence: ${p}\r\n`), "auto", p);
  // Precedence: list is list mail: auto unless it's a reply (see the list-mail test below).
  assert.equal(classifyBody(body, "Precedence: list\r\n"), "auto");
  assert.equal(classifyBody(body, "Precedence: list\r\nIn-Reply-To: <orig@aetoswebsites.com>\r\n"), "human");
  const withSubject = (s) => classifyInbound({ headers: { from: "a@b.com", subject: s }, text: body, raw: "" });
  assert.equal(withSubject("Out of Office: back Monday"), "auto");
  assert.equal(withSubject("OUT OF OFFICE"), "auto");
  assert.equal(withSubject("automatic reply: Your new website"), "auto");
  assert.equal(withSubject("Re: Automatic reply: away"), "human");
});

test("opt_out: each phrase in the first 3 non-empty lines of a body of at most 40 words", () => {
  assert.deepEqual(OPT_OUT_PHRASES, ["no thanks", "unsubscribe", "remove me", "stop emailing", "take me off"]);
  for (const body of ["no thanks", "No, thanks!", "Unsubscribe", "Please REMOVE ME from your list.", "Stop emailing me!!",
    "Hi,\n\nCan you take me off your list please\n\nCheers", "Not for us.\nThanks\nno-thanks"]) {
    assert.equal(classifyBody(body), "opt_out", body);
  }
  assert.equal(classifyBody("Hi Nik\nThanks for this\nI'll have a think\nno thanks for now though"), "human"); // line 4
  assert.equal(classifyBody("Thanks, no rush. Ring me Friday."), "human");
  assert.equal(classifyBody("no thanksgiving plans this year so we can talk"), "human");
  // Whole words only: a keen reply must never be read as an opt-out (it would lose the lead for good).
  assert.equal(classifyBody("Cheers Bruno thanks, looks great. When can we start?"), "human");
  assert.equal(classifyBody("Looks good, can you remove mention of gas work"), "human");
  const words = (n) => ["no thanks"].concat(Array.from({ length: n - 2 }, () => "mate")).join(" ");
  assert.equal(classifyBody(words(40)), "opt_out");
  assert.equal(classifyBody(words(41)), "human");
});

test("classifyInbound takes the relay's headers JSON or the lower-cased object as well as parsed headers", () => {
  const raw = load("no-thanks.eml");
  assert.equal(classifyInbound({ headers: relayHeaders(raw), raw }), "opt_out");
  assert.equal(classifyInbound({ headers: JSON.parse(relayHeaders(raw)), raw }), "opt_out");
});

// --- Bounces --------------------------------------------------------------------------------------------------------

test("bounces: postmaster@ is a bounce; delay warnings and success reports are auto", () => {
  assert.equal(classifyBody("Your message could not be delivered.", "", "postmaster@mail.example.co.uk"), "bounce");
  // Exim's plain-text delay warning has no report part and no Status line, only its subject says so.
  assert.equal(classifyRaw(plainMail("Message 1t2Bq7-0009xK-1f has not been delivered to all of its recipients after\n" +
    "more than 24 hours on the queue.", "", "Mail Delivery System <Mailer-Daemon@server88.web-hosting.com>")
    .replace("Subject: Re: Your new website, Bob", "Subject: Warning: message 1t2Bq7-0009xK-1f delayed 24 hours")), "auto");
  // A plain-text notice that says Action: delayed / Status: 4.x.x.
  assert.equal(classifyBody("Action: delayed\nStatus: 4.4.1", "", "MAILER-DAEMON@x.com"), "auto");
  assert.equal(classifyBody("Final-Recipient: rfc822; a@b.com\nStatus: 4.2.2", "", "MAILER-DAEMON@x.com"), "auto");
  // A delivery report that says it was delivered is not a failure.
  const ok = load("dsn-namecheap.eml").replace("Action: failed", "Action: delivered").replace("Status: 5.1.1", "Status: 2.0.0");
  assert.equal(classifyRaw(ok), "auto");
});

test("bounceInfo: nulls for ordinary mail, first failed recipient of several, Original-Recipient fallback", () => {
  assert.deepEqual(bounceInfo(load("gmail-reply.eml")), { recipient: null, messageId: null, delayed: false });
  assert.deepEqual(bounceInfo(""), { recipient: null, messageId: null, delayed: false });
  const two = load("dsn-namecheap.eml").replace("Final-Recipient: rfc822; info@oldsite-plumbing.co.uk",
    "Final-Recipient: rfc822; later@slow.co.uk\r\nAction: delayed\r\nStatus: 4.4.1\r\n\r\n" +
    "Final-Recipient: rfc822; INFO@oldsite-plumbing.co.uk");
  assert.deepEqual(bounceInfo(two), {
    recipient: "info@oldsite-plumbing.co.uk",
    messageId: "<3f9c2b7e-4a1d-4e8b-9c6f-2d5e8a1b7c40@aetoswebsites.com>",
    delayed: false,
  });
  const orig = load("dsn-namecheap.eml").replace("Final-Recipient: rfc822; info@oldsite-plumbing.co.uk\r\n", "");
  assert.equal(bounceInfo(orig).recipient, "info@oldsite-plumbing.co.uk");
});

// --- Body text ------------------------------------------------------------------------------------------------------

test("quote cuts: -----Original Message-----, From: + Date:, and an On … wrote: broken inside the address", () => {
  const t = (body) => extractText(plainMail(body));
  assert.equal(t("Yes please.\n\n-----Original Message-----\nFrom: Nik <nik@aetoswebsites.com>\nSent: 19 October 2026 08:01\n\nHi Bob"),
    "Yes please.");
  assert.equal(t("Sounds good\n\nFrom: Nik <nik@aetoswebsites.com>\nDate: Monday, 19 October 2026 at 08:01\nTo: Bob\n\nHi Bob"),
    "Sounds good");
  assert.equal(t("Yes\n\nOn Mon, 19 Oct 2026 at 08:01, Nik <\nnik@aetoswebsites.com> wrote:\n\n> Hi Bob"), "Yes");
  assert.equal(t("Great.\nOn Monday I'm free all day.\nBob"), "Great.\nOn Monday I'm free all day.\nBob");
  assert.equal(t("From: the van\nThanks"), "From: the van\nThanks");
});

test("quote cuts: a trailing > block goes but answers between quotes stay; a bottom-posted reply keeps its words", () => {
  const t = (body) => extractText(plainMail(body));
  assert.equal(t("Answers below.\n\n> Do you have photos?\nYes, loads.\n\n> Nik\n> Aetos Websites\n>\n"),
    "Answers below.\n\n> Do you have photos?\nYes, loads.");
  assert.equal(t("On Mon, 19 Oct 2026 at 08:01, Nik <nik@aetoswebsites.com> wrote:\n> Hi Bob,\n> Have a look.\n\nYes I'm interested"),
    "Yes I'm interested");
  assert.equal(t("> Hi Bob,\n> Have a look."), "");
});

test("multipart is followed 3 levels deep, not 4; a text/plain attachment is skipped", () => {
  const nest = (levels) => {
    let body = "Content-Type: text/plain; charset=utf-8\r\n\r\nDeep words\r\n";
    for (let i = levels; i >= 1; i--) {
      body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--\r\n`;
    }
    return "From: a@b.com\r\nSubject: x\r\nMIME-Version: 1.0\r\n" + body;
  };
  assert.equal(extractText(nest(3)), "Deep words");
  assert.equal(extractText(nest(4)), "");
  const withNotes = "From: a@b.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n" +
    "--x\r\nContent-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\n" +
    "attached notes\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe real reply\r\n--x--\r\n";
  assert.equal(extractText(withNotes), "The real reply");
});

test("body text: capped at 20,000 characters; unknown charset falls back to UTF-8; garbage gives empty text", () => {
  assert.equal(extractText(plainMail("word ".repeat(6000))).length, 20000);
  const odd = "From: a@b.com\r\nContent-Type: text/plain; charset=x-made-up\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
    "Caf=C3=A9 =\r\nPlumbing\r\n";
  assert.equal(extractText(odd), "Café Plumbing");
  assert.equal(extractText("\u0000"), "");
  assert.equal(extractText(""), "");
  assert.equal(extractText(undefined), "");
  const noType = "From: a@b.com\r\nSubject: hi\r\n\r\nJust text, no MIME headers.\r\n";
  assert.equal(extractText(noType), "Just text, no MIME headers.");
});

test("hostile or huge bodies stay quick and still give the first 20,000 characters", () => {
  const started = performance.now();
  const digits = extractText(plainMail("On " + "1 2 3 4 5 6 7 8 9 ".repeat(3000)));
  assert.equal(digits.length, 20000);
  assert.ok(digits.startsWith("On 1 2 3"));
  const lines = extractText(plainMail("Hi\n" + "______\n".repeat(8000) + "Bye")); // no From: after them: nothing cut
  assert.equal(lines.length, 20000);
  assert.ok(lines.startsWith("Hi\n______\n______\n"));
  const qp = "From: a@b.com\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
    "<div style=3D\"color:red\">Caf=C3=A9 &amp; plumbing &pound;249 <b>bold</b></div>=\r\n".repeat(3500);
  const text = extractText(qp.slice(0, 262144)); // the relay's 256 KB cap
  assert.equal(text.length, 20000);
  assert.ok(text.startsWith("Café & plumbing £249 bold\n\nCafé & plumbing £249 bold"));
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});

// --- Review regressions ---------------------------------------------------------------------------------------------

// A mail the tick can't finish (Cloudflare kills it on CPU) is never marked processed, so it would be retried first on
// every tick and block the queue for good. Each of these took seconds with the old regex-based stripping.
test("hostile html and attribution-like lines are parsed in linear time", () => {
  const html = (body) => "From: a@b.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + body;
  const plain = (body) => "From: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + body;
  const cases = {
    "<<<<": html("<".repeat(100000)),
    "<a<a<a": html("<a".repeat(50000)),
    "<br<br": html("<br".repeat(33000)),
    "<p <p": html("<p ".repeat(33000)),
    "unclosed <style>s": html("<style>".repeat(14000)),
    "unclosed <head x": html("<head x".repeat(14000)),
    "On 1 1 1 … lines": plain(("On " + "1 ".repeat(124) + "\n").repeat(200)),
    "many tiny parts": "From: a@b.com\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n" +
      "--b\r\nContent-Type: image/png\r\n\r\nx\r\n".repeat(7000),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const started = performance.now();
    const text = extractText(raw.slice(0, 262144));
    bounceInfo(raw.slice(0, 262144));
    const ms = performance.now() - started;
    assert.ok(typeof text === "string" && text.length <= 20000, name);
    assert.ok(ms < 250, `${name} took ${Math.round(ms)} ms`);
  }
  const started = performance.now();
  assert.equal(parseHeaders({ subject: "=?utf-8?q?a?= ".repeat(10000), to: "a@b.com, ".repeat(20000) }).to, "a@b.com");
  assert.ok(performance.now() - started < 250);
});

test("html: a stray < is text, an unclosed <style> doesn't swallow the reply, </header> doesn't close <head>", () => {
  const html = (body) => extractText("From: a@b.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + body);
  assert.equal(html("<p>Price &lt; £2k? 3 < 4</p>"), "Price < £2k? 3 < 4");
  assert.equal(html("<style>p{color:red}</style ><p>Hi &amp; bye</p><script>x()</script>"), "Hi & bye");
  assert.equal(html("<style>p{}<div>Yes please</div>"), "p{}\nYes please");
  assert.equal(html("<head><title>t</title><header>Top</header><p>Words</p>"), "Top\n\nWords");
  assert.equal(html("<!-- note --><div>One</div><!-- never closed <div>Two</div>"), "One");
  assert.equal(html("<o:p>Fine</o:p><param>, <pre>ok</pre>"), "Fine,\nok");
  // "İ" lower-cases to two characters: tag positions must not drift after it.
  assert.equal(html("<div>İİİİ Yılmaz</div><STYLE>p{color:red}</STYLE><div>Hi there</div><div>Bye</div>"),
    "İİİİ Yılmaz\n\nHi there\n\nBye");
});

test("html entities: only real names decode; &#128;–&#159; are Windows-1252", () => {
  const html = (body) => extractText("From: a@b.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + body);
  assert.equal(html("Hi &constructor; &toString; &__proto__; there"), "Hi &constructor; &toString; &__proto__; there");
  assert.equal(html("I&#146;m in &#8211; &pound;249 &#x1F44D; &#0;"), "I’m in – £249 👍 �");
});

test("addresses: an encoded name with a comma, a quoted name holding <…>, a trailing comment", () => {
  assert.deepEqual(parseHeaders({ from: "=?utf-8?Q?Smith,_Bob?= <Bob@X.com>" }).from, { name: "Smith, Bob", address: "bob@x.com" });
  assert.deepEqual(parseHeaders({ from: '"Bob <the boss>" <bob@x.com>' }).from, { name: "Bob <the boss>", address: "bob@x.com" });
  assert.deepEqual(parseHeaders({ from: "Bob <bob@x.com> (via <site>)" }).from, { name: "Bob", address: "bob@x.com" });
  assert.equal(parseHeaders({ to: "=?utf-8?Q?Turner,_Steve?= <steve@t.co.uk>, b@c.com" }).to, "steve@t.co.uk");
});

test("decoded headers never carry a line break or control character", () => {
  const h = parseHeaders({ subject: "=?utf-8?q?Hi=0D=0ABcc:_x@y.com?=", from: "=?utf-8?q?Bob=0AHarris?= <b@x.com>" });
  assert.equal(h.subject, "Hi Bcc: x@y.com");
  assert.equal(h.from.name, "Bob Harris");
  assert.doesNotMatch(h.subject + h.from.name, /[\u0000-\u001f\u007f]/);
});

test("quoted-printable with no charset: UTF-8 when it is UTF-8, else Windows-1252", () => {
  const qp = (body) => extractText(`From: a@b.com\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${body}`);
  assert.equal(qp("I=92m in, =A3249"), "I’m in, £249");
  assert.equal(qp("Caf=C3=A9 =E2=82=AC5"), "Café €5");
  assert.equal(qp("Caf=C3=A9 =E2=82"), "Café"); // a character cut off by the 256 KB cap is still UTF-8, not mojibake
});

test("an Outlook reply with nothing written gives no text, never our own email passed off as theirs", () => {
  const t = (body) => extractText(plainMail(body));
  const ours = "Hi Bob, have a look.\n\nNik\nAetos Websites\n\nIf you'd rather not hear from me, just reply \"no thanks\".";
  assert.equal(t(`\n________________________________\nFrom: Nik <nik@aetoswebsites.com>\nSent: 19 October 2026 08:01\nTo: Bob\n\n${ours}`), "");
  assert.equal(t(`\n-----Original Message-----\nFrom: Nik <nik@aetoswebsites.com>\n\n${ours}`), "");
  assert.equal(t(`From: Nik <nik@aetoswebsites.com>\nDate: 19 October 2026\n\n${ours}`), "");
  // The "> " style keeps a bottom-posted answer.
  assert.equal(t("On Mon, 19 Oct 2026 at 08:01, Nik <nik@aetoswebsites.com> wrote:\n> Hi Bob\n\nYes please"), "Yes please");
});

test("bounceInfo: a Message-ID folded onto its own line in a plain-text bounce", () => {
  const raw = "From: MAILER-DAEMON@mx.example.com\r\nSubject: Undeliverable: Your new website\r\n\r\n" +
    "Delivery has failed to these recipients:\r\n\r\nbob@x.com\r\n\r\nOriginal message headers:\r\n\r\n" +
    "From: Nik <nik@aetoswebsites.com>\r\nMessage-ID:\r\n <d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6@aetoswebsites.com>\r\n";
  assert.equal(bounceInfo(raw).messageId, "<d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6@aetoswebsites.com>");
  assert.equal(classifyRaw(raw), "bounce");
});

// --- Second review --------------------------------------------------------------------------------------------------

const OURS = "Hi Bob, have a look.\n\nNik\nAetos Websites\n\nIf you'd rather not hear from me, just reply \"no thanks\".";

test("bottom-posted reply above an Outlook header: only their words, never our email (or its \"no thanks\")", () => {
  const t = (body) => extractText(plainMail(body));
  const attribution = "On Mon, 19 Oct 2026 at 08:01, Nik <nik@aetoswebsites.com> wrote:\n> Hi Bob\n\n";
  assert.equal(t(`${attribution}Yes\n\n-----Original Message-----\nFrom: Nik <nik@aetoswebsites.com>\n\n${OURS}`), "Yes");
  assert.equal(t(`${attribution}________________________________\nFrom: Nik <nik@aetoswebsites.com>\nSent: 19 October 2026\n\n${OURS}`), "");
  assert.equal(t(`${attribution}No\n\nFrom: Nik <nik@aetoswebsites.com>\nDate: 19 October 2026\n\n${OURS}`), "No");
  // A short version of the same mail must not read as an opt-out because of our own footer.
  const short = plainMail(`${attribution}________________________________\nFrom: Nik <nik@aetoswebsites.com>\nSent: 19 Oct\n\n` +
    "If you'd rather not hear from me, just reply \"no thanks\".");
  assert.equal(classifyRaw(short), "human");
});

test("a sentence starting \"On … wrote:\" is the sender's own words; real attributions are still cut", () => {
  const t = (body) => extractText(plainMail(body));
  const own = "Hi Nik,\nOn the 19th you wrote: the first 60 days are free. Is that right?\nThanks\nBob";
  assert.equal(t(own), own);
  assert.equal(t("Hi Nik,\nOn 2 jobs this week so busy\nbut my lad wrote: he likes it\nBob"),
    "Hi Nik,\nOn 2 jobs this week so busy\nbut my lad wrote: he likes it\nBob");
  // Line end, 2+ spaces after (Yahoo's one-liner) or an address before: all attributions.
  assert.equal(t("Yes\n\nOn 19/10/2026 08:01, Nik wrote:\n> Hi Bob"), "Yes");
  assert.equal(t("Yes\n\n  On Mon, 19 Oct 2026 at 8:01, Nik wrote:   Hi Bob,\nI made you a website"), "Yes");
  assert.equal(t("Yes\n\nOn Mon, 19 Oct 2026 at 8:01, Nik<nik@aetoswebsites.com> wrote: Hi Bob,\nI made you a website"), "Yes");
});

test("bounces: the report's recipient line decides over a \"Delayed Mail\" subject; Action: failed beats a 4.x.x status", () => {
  const ndr = load("dsn-namecheap.eml");
  const delayedSubject = ndr.replace("Subject: Undelivered Mail Returned to Sender", "Subject: Delayed Mail (still being retried)");
  assert.equal(classifyRaw(delayedSubject), "bounce");
  assert.equal(bounceInfo(delayedSubject).delayed, false);
  // Postfix gives up after days of temporary failures with "Action: failed" and the last 4.x.x status. That is the
  // final failure (Part A: Action: failed is always a bounce), so the address stops being mailed.
  const expired = ndr.replace("Status: 5.1.1", "Status: 4.4.1");
  assert.equal(classifyRaw(expired), "bounce");
  assert.equal(bounceInfo(expired).delayed, false);
  // A 4.x.x status with no Action, or with Action: delayed, is still only a delay.
  assert.equal(classifyRaw(ndr.replace("Status: 5.1.1", "Status: 4.4.1").replace("Action: failed", "Action: delayed")), "auto");
  const noAction = ndr.replace("Status: 5.1.1", "Status: 4.4.1").replace("Action: failed\r\n", "");
  assert.equal(classifyRaw(noAction), "auto");
  assert.equal(bounceInfo(noAction).delayed, true);
  // The same rule with no recipient line (a plain-text notice): Action: failed with a 4.x.x status is a bounce.
  assert.equal(classifyBody("Action: failed\nStatus: 4.4.7", "", "MAILER-DAEMON@x.com"), "bounce");
});

test("an RFC 2231 split file name (filename*0=, name*0=) is an attachment, not the body", () => {
  const raw = "From: a@b.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n" +
    "--x\r\nContent-Type: text/plain; name*0=\"quote-for-\"; name*1=\"roof.txt\"\r\n" +
    "Content-Disposition: inline; filename*0*=utf-8''quote-for-; filename*1=\"roof.txt\"\r\n\r\nattached notes\r\n" +
    "--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe real reply\r\n--x--\r\n";
  assert.equal(extractText(raw), "The real reply");
});

test("\"Auto-Submitted: no\" with a parameter is still a person", () => {
  assert.equal(classifyBody("Sounds good, ring me Tuesday.", "Auto-Submitted: no; reason=manual\r\n"), "human");
  assert.equal(classifyBody("Sounds good, ring me Tuesday.", "Auto-Submitted: auto-replied; owner=x@y.com\r\n"), "auto");
});

test("Message-IDs are printable ASCII only (they are sent back in our replies' References)", () => {
  const h = parseHeaders({
    "message-id": "<a\u0000b@x.com> <ok@x.com>",
    "in-reply-to": "<café@x.com>",
    references: "<orig@aetoswebsites.com> <bad\u0007@x> <é@x> <later@x.com>",
  });
  assert.equal(h.messageId, "<ok@x.com>");
  assert.equal(h.inReplyTo, null);
  assert.deepEqual(h.references, ["<orig@aetoswebsites.com>", "<later@x.com>"]);
  assert.equal(parseHeaders({ "message-id": "café@x.com" }).messageId, null);
});

test("html: a <blockquote> is a quote, so an html-only reply keeps only the sender's words", () => {
  const html = (body) => extractText("From: a@b.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + body);
  const quoted = "<blockquote>Hi Bob,<br>I made you a new website.<br>Nik<br>If you'd rather not hear from me, just reply " +
    "&quot;no thanks&quot;.</blockquote>";
  assert.equal(html(`<div>Yes please, go ahead</div>${quoted}`), "Yes please, go ahead");
  assert.equal(html(quoted), ""); // nothing written: never our words passed off as theirs
  // An html-only "No thanks" above the quote is an opt-out (with the quote counted it would be over 40 words).
  const long = `<blockquote>${"Have a look at your new website, it's built from your own photos and reviews. ".repeat(4)}</blockquote>`;
  const noThanks = "From: Gary <gary@x.com>\r\nSubject: Re: hi\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<div>No thanks.</div>" + long;
  assert.equal(extractText(noThanks), "No thanks.");
  assert.equal(classifyRaw(noThanks), "opt_out");
  // Answers between quotes stay; nested quotes are quotes; a stray </blockquote> or <blockquote/> changes nothing.
  assert.equal(html("<blockquote>Do you have photos?</blockquote><div>Yes, loads.</div><blockquote>Nik<blockquote>Old</blockquote></blockquote>"),
    "> Do you have photos?\n\nYes, loads.");
  assert.equal(html("</blockquote><div>Hi</div><blockquote/><div>Bye</div>"), "Hi\n\nBye");
  // The marker characters can't be smuggled in, raw or as entities.
  assert.equal(html("<div>A\ue000B&#xE001;C&#57344;</div><div>D</div>"), "AB\ufffdC\ufffd\n\nD");
});

test("each real reply's html part on its own gives the same words as its text/plain part", () => {
  const words = (s) => s.replace(/\n+/g, "\n");
  for (const f of ["gmail-reply.eml", "outlook-qp.eml", "iphone-b64.eml", "no-thanks.eml", "with-attachment.eml",
    "long-mentions-unsubscribe.eml", "namecheap-forwarded.eml"]) {
    const raw = load(f);
    const noPlain = raw.replace(/(\r\n--[^\r\n]+\r\n)Content-Type: text\/plain;[\s\S]*?(?=\r\n--)/,
      "$1Content-Type: application/octet-stream\r\n\r\n");
    assert.notEqual(noPlain, raw, f);
    assert.equal(words(extractText(noPlain)), words(extractText(raw)), f);
  }
});

// --- Third review ---------------------------------------------------------------------------------------------------

// A run of spaces that ends in a letter, not a line break, inside a quoted-printable part. The old padding regex
// (/[ \t]+$/gm) tried the run from every space, n² work: 60,000 spaces took 8.5 s, so one such email killed two
// whole ticks. 99,000 spaces + "x" still fits in the 100,000 characters a part is decoded from (the worst case).
const SPACE_RUN = " ".repeat(99000) + "x";

test("quoted-printable: a 99,000-space run ending in a letter is decoded in linear time", () => {
  const raw = "From: a@b.com\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
    `Hi\r\n${SPACE_RUN}\r\n`;
  const started = performance.now();
  const text = extractText(raw);
  const ms = performance.now() - started;
  assert.ok(text.startsWith("Hi"), JSON.stringify(text.slice(0, 20)));
  assert.ok(ms < 50, `took ${Math.round(ms)} ms`);
});

test("quoted-printable: the same run in a delivery report's status part is read in linear time", () => {
  const raw = "From: MAILER-DAEMON@mx.example.com\r\nSubject: Undelivered Mail Returned to Sender\r\n" +
    "Message-ID: <qp-report@mx.example.com>\r\nMIME-Version: 1.0\r\n" +
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n' +
    "--b\r\nContent-Type: message/delivery-status\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
    `Final-Recipient: rfc822; bob@x.com\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n${SPACE_RUN}\r\n--b--\r\n`;
  const started = performance.now();
  const info = bounceInfo(raw);
  const ms = performance.now() - started;
  assert.deepEqual(info, { recipient: "bob@x.com", messageId: null, delayed: false });
  assert.ok(ms < 50, `took ${Math.round(ms)} ms`);
  assert.equal(classifyRaw(raw), "bounce");
});

test("quoted-printable: line-end padding still goes, \"=\" then padding is a soft break, spaces before \"=\" stay", () => {
  const qp = (body) => extractText("From: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n" +
    `Content-Transfer-Encoding: quoted-printable\r\n\r\n${body}`);
  assert.equal(qp("a  \r\nb\t \r\n  c"), "a\nb\n  c");
  assert.equal(qp("soft= \t\r\nbreak"), "softbreak");
  assert.equal(qp("keep   =\r\nme"), "keep   me");
  assert.equal(qp("tab\t=\r\n\tend=20  \r\nnext"), "tab\t\tend\nnext");
});

test("dsn-expired (Postfix gives up: Action: failed, Status: 4.4.7) is a bounce; the delay warning before it is auto", () => {
  const m = mail("dsn-expired.eml");
  assert.equal(m.headers.subject, "Undelivered Mail Returned to Sender");
  assert.equal(m.cls, "bounce");
  assert.deepEqual(bounceInfo(m.raw), {
    recipient: "sales@slowserver-scaffolding.co.uk",
    messageId: "<9e2c4a1b-3d5f-4e7a-8b6c-0f1e2d3c4b5a@aetoswebsites.com>",
    delayed: false,
  });
  assert.equal(mail("dsn-delay.eml").cls, "auto");
});

// Namecheap forwards everything in Nik's inbox (D-1 option A), newsletters included. List mail that isn't a reply is
// auto; a reply (In-Reply-To or References) stays a person's mail even when their mail host adds List-Unsubscribe.
test("list mail: List-Id, List-Unsubscribe, List-Post or Precedence: list is auto unless it's a reply", () => {
  const body = "This week: five ways to get more reviews.";
  assert.equal(classifyBody(body, "List-Unsubscribe: <https://news.example.com/u/123>\r\n"), "auto");
  assert.equal(classifyBody(body, "List-Id: Trade News <news.example.com>\r\n"), "auto");
  assert.equal(classifyBody(body, "List-Post: <mailto:list@example.com>\r\n"), "auto");
  assert.equal(classifyBody(body, "Precedence: List\r\n"), "auto");
  const reply = "Yes please, send me the link again.";
  assert.equal(classifyBody(reply, "In-Reply-To: <orig@aetoswebsites.com>\r\nList-Unsubscribe: <mailto:u@crm.example.com>\r\n"),
    "human");
  assert.equal(classifyBody(reply, "References: <orig@aetoswebsites.com>\r\nList-Id: <crm.example.com>\r\n"), "human");
  // A short newsletter with "Unsubscribe" in its first lines is auto, never an opt-out.
  assert.equal(classifyBody("Our October offers\nUnsubscribe", "List-Unsubscribe: <https://news.example.com/u/1>\r\n"), "auto");
  // A reply that says "unsubscribe" is still an opt-out.
  assert.equal(classifyBody("Unsubscribe", "In-Reply-To: <orig@aetoswebsites.com>\r\nList-Unsubscribe: <mailto:u@x.com>\r\n"),
    "opt_out");
  // And ordinary mail is unchanged.
  assert.equal(classifyBody(body), "human");
  const h = parseHeaders({ "list-id": "Trade News <news.example.com>", "list-unsubscribe": "<mailto:u@x.com>", "list-post": "NO" });
  assert.deepEqual([h.listId, h.listUnsubscribe, h.listPost], ["Trade News <news.example.com>", "<mailto:u@x.com>", "NO"]);
});

test("inbound.js runs on Workers: no Node-only APIs", () => {
  const src = readFileSync(new URL("../functions/_lib/mail/inbound.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bBuffer\b|\bprocess\.|\brequire\(|from\s+["']node:|import\(/);
  assert.doesNotMatch(src, /^import /m); // pure: nothing imported at all
});
