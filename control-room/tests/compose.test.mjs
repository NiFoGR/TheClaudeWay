// Plain-text email composer. Run: node --test control-room/tests/compose.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { OPT_OUT_LINE, coldFooter, composeEmail, makeMessageId } from "../functions/_lib/mail/compose.js";

const base = {
  from: {name: "Nik", address: "nik@aetoswebsites.com"}, to: "bob@x.com", subject: "Your site",
  body: "Hi,\nline", messageId: "<a@aetoswebsites.com>",
};

// Decode one header value made of RFC 2047 B-words (or plain ASCII) back to text.
const decode = (v) => v.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=(\s+(?==\?))?/g,
  (_, b64) => Buffer.from(b64, "base64").toString("utf8"));

test("the spec's cases (Task 10, Step 1)", () => {
  assert.match(makeMessageId("aetoswebsites.com"), /^<[0-9a-f-]{36}@aetoswebsites\.com>$/);
  const m = composeEmail({from:{name:"Nik",address:"nik@aetoswebsites.com"}, to:"bob@x.com", subject:"Your site",
    body:"Hi,\r\nline", messageId:"<a@aetoswebsites.com>", inReplyTo:"<r@x.com>"});
  assert.equal(m.headers.From, "Nik <nik@aetoswebsites.com>");
  assert.equal(m.headers["In-Reply-To"], "<r@x.com>"); assert.equal(m.headers.References, "<r@x.com>");
  assert.equal(m.text, "Hi,\nline");
  assert.equal(composeEmail({...base, from:{name:"Café Nik",address:"n@a.com"}}).headers.From, "=?UTF-8?B?Q2Fmw6kgTmlr?= <n@a.com>");
  assert.throws(() => composeEmail({...base, subject:"Hi\r\nBcc: x@y.com"}), /Header values can't contain line breaks/);
  assert.equal(composeEmail({...base, references: Array.from({length:15},(_,i)=>`<${i}@x>`)}).headers.References.split(" ").length, 10);
  assert.equal(coldFooter("Nik"), 'Nik\nAetos Websites\n\nIf you\'d rather not hear from me, just reply "no thanks".');
  assert.equal(composeEmail({...base, from:{name:'Nik "N" Smith', address:"n@a.com"}}).headers.From, '"Nik \\"N\\" Smith" <n@a.com>');
});

// Extra edges (Review Focus 2).

test("OPT_OUT_LINE is exact and the cold footer ends with it", () => {
  assert.equal(OPT_OUT_LINE, 'If you\'d rather not hear from me, just reply "no thanks".');
  assert.ok(coldFooter("Nik").endsWith(OPT_OUT_LINE));
  assert.equal(coldFooter("  Nik  "), coldFooter("Nik"));
  assert.equal(coldFooter(""), `Aetos Websites\n\n${OPT_OUT_LINE}`); // never a blank first line
});

test("headers are exactly the RFC 5322 set, in order, with no threading headers on a new email", () => {
  const date = new Date("2026-10-21T09:05:00Z");
  const m = composeEmail({...base, date});
  assert.deepEqual(Object.keys(m.headers), ["From", "To", "Subject", "Date", "Message-ID"]);
  assert.deepEqual(m.headers, {
    From: "Nik <nik@aetoswebsites.com>", To: "bob@x.com", Subject: "Your site",
    Date: "Wed, 21 Oct 2026 09:05:00 GMT", "Message-ID": "<a@aetoswebsites.com>",
  });
  assert.equal(m.headers.Date, date.toUTCString());
  const r = composeEmail({...base, inReplyTo: "<r@x.com>"});
  assert.deepEqual(Object.keys(r.headers), ["From", "To", "Subject", "Date", "Message-ID", "In-Reply-To", "References"]);
});

test("Date defaults to now", () => {
  const before = Date.now();
  const d = Date.parse(composeEmail(base).headers.Date);
  assert.ok(d >= Math.floor(before / 1000) * 1000 && d <= Date.now(), "Date is the current time");
});

test("References keep the chain, add the parent once, and keep the last 10", () => {
  // The row's own refs (a stored string) already end with the parent: used exactly as they are.
  assert.equal(composeEmail({...base, inReplyTo: "<r@y>", references: "<q@y> <r@y>"}).headers.References, "<q@y> <r@y>");
  // The parent is added at the end when the chain doesn't have it.
  assert.equal(composeEmail({...base, inReplyTo: "<r@y>", references: ["<q@y>"]}).headers.References, "<q@y> <r@y>");
  // References without In-Reply-To are kept, with no In-Reply-To invented.
  const noParent = composeEmail({...base, references: "<q@y>"});
  assert.equal(noParent.headers.References, "<q@y>"); assert.equal("In-Reply-To" in noParent.headers, false);
  // The newest 10 survive, so the parent is always the last one.
  const long = Array.from({length: 15}, (_, i) => `<${i}@x>`);
  const refs = composeEmail({...base, inReplyTo: "<p@x>", references: long}).headers.References.split(" ");
  assert.equal(refs.length, 10); assert.equal(refs[0], "<6@x>"); assert.equal(refs.at(-1), "<p@x>");
  // Folded or unspaced chains from real headers are split into ids; duplicates are dropped.
  assert.equal(composeEmail({...base, references: "<a@x><b@x>\t<a@x>"}).headers.References, "<a@x> <b@x>");
  // A broken bracketed id is dropped, never split into made-up ids.
  assert.equal(composeEmail({...base, references: "<q@y> <a b@x>"}).headers.References, "<q@y>");
  assert.equal("References" in composeEmail({...base, references: "<a b@x>"}).headers, false);
  // Empty values mean no header at all.
  const none = composeEmail({...base, inReplyTo: "", references: []});
  assert.equal("In-Reply-To" in none.headers, false); assert.equal("References" in none.headers, false);
});

test("the row's own References chain is sent in its own order (stage 6 follow-ups)", () => {
  // Follow-up 3: in_reply_to is the first email, refs = the first email + the follow-ups sent since (overview §8: the
  // row's message_id / in_reply_to / refs are used as they are). The parent is already in the chain, so nothing moves.
  const refs = "<root@aetoswebsites.com> <f1@aetoswebsites.com> <f2@aetoswebsites.com>";
  const m = composeEmail({...base, messageId: "<f3@aetoswebsites.com>", inReplyTo: "<root@aetoswebsites.com>", references: refs});
  assert.equal(m.headers["In-Reply-To"], "<root@aetoswebsites.com>");
  assert.equal(m.headers.References, refs);
  // Stage 7's reply: their References + their Message-ID, with In-Reply-To = their Message-ID.
  const r = composeEmail({...base, inReplyTo: "<a@them.com>", references: "<root@aetoswebsites.com> <a@them.com>"});
  assert.equal(r.headers.References, "<root@aetoswebsites.com> <a@them.com>");
});

test("ids without angle brackets get them", () => {
  const m = composeEmail({...base, messageId: "a@aetoswebsites.com", inReplyTo: " r@x.com "});
  assert.equal(m.headers["Message-ID"], "<a@aetoswebsites.com>");
  assert.equal(m.headers["In-Reply-To"], "<r@x.com>"); assert.equal(m.headers.References, "<r@x.com>");
});

test("a non-ASCII subject is B-encoded in words of at most 75 characters, never splitting a character", () => {
  const s = composeEmail({...base, subject: "Café Plumbing Ltd"}).headers.Subject;
  assert.equal(s, `=?UTF-8?B?${Buffer.from("Café Plumbing Ltd").toString("base64")}?=`);
  assert.equal(decode(s), "Café Plumbing Ltd");
  const long = "Ŝomé “quoted” wörds — " + "ü".repeat(40) + " and an emoji 🛠️ at the end";
  const enc = composeEmail({...base, subject: long}).headers.Subject;
  const words = enc.split(" ");
  assert.ok(words.length > 1);
  for (const w of words) {
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(w.length <= 75, w);
    assert.doesNotThrow(() => new TextDecoder("utf-8", {fatal: true}).decode(Buffer.from(w.slice(10, -2), "base64")));
  }
  assert.equal(decode(enc), long);
});

test("plain ASCII is left alone; text that looks like an encoded word is encoded", () => {
  assert.equal(composeEmail({...base, subject: "Smith & Sons: your new site"}).headers.Subject, "Smith & Sons: your new site");
  const spoof = composeEmail({...base, subject: "=?UTF-8?B?SGk=?="}).headers.Subject;
  assert.notEqual(spoof, "=?UTF-8?B?SGk=?="); assert.equal(decode(spoof), "=?UTF-8?B?SGk=?=");
  const name = composeEmail({...base, from: {name: "=?UTF-8?B?SGk=?=", address: "n@a.com"}}).headers.From;
  assert.equal(decode(name.replace(/ <n@a\.com>$/, "")), "=?UTF-8?B?SGk=?=");
});

test("display names: specials are quoted, a missing name gives the bare address", () => {
  assert.equal(composeEmail({...base, from: {name: "Nik J. Smith", address: "n@a.com"}}).headers.From, '"Nik J. Smith" <n@a.com>');
  assert.equal(composeEmail({...base, from: {name: "Smith, Jones", address: "n@a.com"}}).headers.From, '"Smith, Jones" <n@a.com>');
  assert.equal(composeEmail({...base, from: {name: "back\\slash", address: "n@a.com"}}).headers.From, '"back\\\\slash" <n@a.com>');
  assert.equal(composeEmail({...base, from: {name: "", address: "n@a.com"}}).headers.From, "n@a.com");
  assert.equal(composeEmail({...base, from: {address: "n@a.com"}}).headers.From, "n@a.com");
  assert.equal(composeEmail({...base, from: {name: "  Nik  ", address: " n@a.com "}}).headers.From, "Nik <n@a.com>");
});

test("a line break in any header value is refused (scraped names, subjects, ids)", () => {
  const LB = /Header values can't contain line breaks/;
  assert.throws(() => composeEmail({...base, subject: "Hi\nBcc: x@y.com"}), LB);
  assert.throws(() => composeEmail({...base, subject: "Hi\rBcc: x@y.com"}), LB);
  assert.throws(() => composeEmail({...base, from: {name: "Café\r\nBcc: x@y.com", address: "n@a.com"}}), LB);
  assert.throws(() => composeEmail({...base, from: {name: "Nik", address: "n@a.com\r\nBcc: x@y.com"}}), LB);
  assert.throws(() => composeEmail({...base, to: "bob@x.com\nBcc: x@y.com"}), LB);
  assert.throws(() => composeEmail({...base, messageId: "<a@x>\r\nBcc: x@y.com"}), LB);
  assert.throws(() => composeEmail({...base, inReplyTo: "<r@x>\nBcc: x@y.com"}), LB);
  assert.throws(() => composeEmail({...base, references: ["<q@x>", "<r@x>\nBcc: x@y.com"]}), LB);
  assert.throws(() => makeMessageId("aetoswebsites.com\r\nBcc: x@y.com"), LB);
  // The body may have line breaks: they're normalised to \n.
  assert.equal(composeEmail({...base, body: "a\r\nb\rc\nd"}).text, "a\nb\nc\nd");
});

test("missing essentials are refused with a plain message", () => {
  assert.throws(() => composeEmail({...base, messageId: undefined}), /composeEmail: messageId is required/);
  assert.throws(() => composeEmail({...base, to: ""}), /composeEmail: to is required/);
  assert.throws(() => composeEmail({...base, from: {name: "Nik"}}), /composeEmail: from\.address is required/);
  assert.throws(() => composeEmail({...base, body: undefined}), /composeEmail: body is required/);
  assert.throws(() => composeEmail({...base, date: new Date("nope")}), /composeEmail: date must be a valid Date/);
  assert.equal(composeEmail({...base, subject: undefined}).headers.Subject, "");
});

test("makeMessageId is unique, lower-cases the domain and accepts a mailbox address", () => {
  const a = makeMessageId("aetoswebsites.com"), b = makeMessageId("aetoswebsites.com");
  assert.notEqual(a, b);
  assert.match(makeMessageId("AetosWebsites.com"), /@aetoswebsites\.com>$/);
  assert.match(makeMessageId("nik@aetoswebsites.com"), /^<[0-9a-f-]{36}@aetoswebsites\.com>$/);
  assert.throws(() => makeMessageId(""), /makeMessageId needs a domain/);
  assert.throws(() => makeMessageId(undefined), /makeMessageId needs a domain/);
  // A domain that would break the Message-ID into two tokens, or put a space in it, is refused.
  assert.throws(() => makeMessageId("x.com> <y"), /makeMessageId needs a domain/);
  assert.throws(() => makeMessageId("aetos websites.com"), /makeMessageId needs a domain/);
  // Not a domain at all: empty labels or edge hyphens.
  for (const d of [".", "-", "a..b", "x.com.", "-x.com", "nik@"]) assert.throws(() => makeMessageId(d), /makeMessageId needs a domain/, d);
});

// Every header line the SMTP library writes is "Name: value"; RFC 5322 caps a line at 998 characters.
const longestLine = (headers) => Math.max(...Object.entries(headers).map(([k, v]) => k.length + 2 + v.length));

test("hostile or broken ids from inbound mail never make a header line over 998 characters", () => {
  // A 1,200-character Message-ID on the email being replied to: left out, so the reply still goes.
  const huge = `<${"x".repeat(1200)}@evil.com>`;
  const r = composeEmail({...base, inReplyTo: huge, references: [huge]});
  assert.equal("In-Reply-To" in r.headers, false); assert.equal("References" in r.headers, false);
  // Ten fat ids plus the parent: the oldest are dropped until the line fits, and the parent stays last.
  const fat = Array.from({length: 10}, (_, i) => `<${"y".repeat(150)}${i}@x.com>`);
  const f = composeEmail({...base, inReplyTo: "<p@x>", references: fat});
  const refs = f.headers.References.split(" ");
  assert.ok(refs.length < 10 && refs.length > 1, String(refs.length));
  assert.equal(refs.at(-1), "<p@x>"); assert.equal(refs.at(-2), fat.at(-1));
  assert.ok("References: ".length + f.headers.References.length <= 998);
  assert.ok(longestLine(f.headers) <= 998);
  // Ids that aren't proper Message-IDs (non-ASCII, control characters) are left out of threading.
  const odd = composeEmail({...base, inReplyTo: "<é@x>", references: "<a@x> <\u0001@x> <ü@x> <b@x>"});
  assert.equal("In-Reply-To" in odd.headers, false); assert.equal(odd.headers.References, "<a@x> <b@x>");
});

test("a subject or name too long for one header line is refused with a plain message", () => {
  const TOO_LONG = /too long for an email \(a header line can be at most 998 characters\)/;
  assert.throws(() => composeEmail({...base, subject: "é".repeat(600)}), /The subject is too long for an email/);
  assert.throws(() => composeEmail({...base, subject: "a".repeat(990)}), TOO_LONG);
  assert.throws(() => composeEmail({...base, from: {name: "N".repeat(1000), address: "n@a.com"}}), /The sender name is too long/);
  // A long but reasonable non-ASCII subject is fine, and every line fits.
  const ok = composeEmail({...base, subject: "Café Plumbing & Heating Ltd — ".repeat(8)});
  assert.ok(longestLine(ok.headers) <= 998);
});

test("addresses must be plain ASCII (the SMTP library can't send anything else)", () => {
  const TO = /Can't send to this address: it has accented letters or hidden characters/;
  assert.throws(() => composeEmail({...base, to: "josé@x.com"}), TO);
  assert.throws(() => composeEmail({...base, to: "bob@x.com\u0000"}), TO);
  assert.throws(() => composeEmail({...base, to: "bob@x.com\u2028Bcc: y@z.com"}), TO);
  assert.throws(() => composeEmail({...base, from: {name: "Nik", address: "nïk@a.com"}}), /The mailbox address has accented letters/);
  // The Message-ID we pass in must be a proper one.
  assert.throws(() => composeEmail({...base, messageId: "<é@aetoswebsites.com>"}), /composeEmail: messageId isn't a valid Message-ID/);
  assert.throws(() => composeEmail({...base, messageId: "<a@aetoswebsites.com"}), /composeEmail: messageId isn't a valid Message-ID/);
  // A missing sender is a plain error, not a TypeError.
  assert.throws(() => composeEmail({...base, from: null}), /composeEmail: from\.address is required/);
  assert.throws(() => composeEmail({...base, from: undefined}), /composeEmail: from\.address is required/);
});
