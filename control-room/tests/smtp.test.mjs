// SMTP sender over the vendored worker-mailer. Most tests pass a fake `mailer` in place of worker-mailer; the last three
// run the real vendored library against a fake Namecheap (the real cloudflare:sockets is never loaded).
// Run: node --test control-room/tests/smtp.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import test from "node:test";
import { composeEmail } from "../functions/_lib/mail/compose.js";
import { INTERRUPTED_PREFIX, MAYBE_SENT, explainSmtpError, sendViaSmtp, testSmtpLogin } from "../functions/_lib/mail/smtp.js";

const VENDOR = new URL("../functions/_lib/mail/vendor/worker-mailer.js", import.meta.url);
const SMTP_SRC = new URL("../functions/_lib/mail/smtp.js", import.meta.url);

// The last tests run the real vendored worker-mailer (unchanged) against a fake Namecheap. Workers provides
// cloudflare:sockets; here a module hook maps it to a stand-in that hands the socket to the fake server the test set up
// (with none set up, connecting fails). Registered before anything loads the library, and only in this test process.
const REAL_LIBRARY = typeof nodeModule.registerHooks === "function";
if (REAL_LIBRARY) {
  const standIn = "export function connect(...args) { const server = globalThis.__fakeNamecheap; "
    + "if (!server) throw new Error('No fake SMTP server is set up'); return server(...args); }";
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== "cloudflare:sockets") return next(specifier, context);
      return {shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(standIn)}`};
    },
  });
  // worker-mailer base64-encodes the AUTH lines with Uint8Array.prototype.toBase64, which Workers' V8 has and Node 22
  // doesn't yet.
  if (typeof Uint8Array.prototype.toBase64 !== "function") {
    Object.defineProperty(Uint8Array.prototype, "toBase64", {configurable: true, writable: true,
      value() { return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64"); }});
  }
}

const mailbox = {
  id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold",
  smtp_host: "mail.privateemail.com", smtp_port: 465, started_on: "2026-01-01", status: "active",
};

const NAMECHEAP_OPTS = {host:"mail.privateemail.com", port:465, secure:true, authType:"login",
  credentials:{username:"nik@aetoswebsites.com", password:"pw"}, socketTimeoutMs:10000, responseTimeoutMs:10000};

const WRONG_PASSWORD = "Namecheap said the password is wrong for nik@aetoswebsites.com. Copy it again from Namecheap → "
  + "Private Email, paste it here, press Save, then Test login.";
const NO_CONNECT = "Couldn't connect to mail.privateemail.com on port 465 within 10 seconds. Wait a minute and try "
  + "again. If it keeps failing, Namecheap's mail server may be down.";

// A stand-in for worker-mailer: connect(opts) → {send, close}. Records every call in order.
function fakeMailer({connectError, connectThrowsSync, sendError, sendThrowsSync, closeError} = {}) {
  const calls = {connect: [], send: [], close: 0, order: []};
  return {
    calls,
    connect(opts) {
      calls.connect.push(opts);
      calls.order.push("connect");
      if (connectThrowsSync) throw connectThrowsSync;
      if (connectError) return Promise.reject(connectError);
      return Promise.resolve({
        send(email) {
          calls.send.push(email);
          calls.order.push("send");
          if (sendThrowsSync) throw sendThrowsSync; // worker-mailer's Email constructor throws synchronously
          return sendError ? Promise.reject(sendError) : Promise.resolve();
        },
        async close() {
          calls.close++;
          calls.order.push("close");
          if (closeError) throw closeError;
        },
      });
    },
  };
}

function message(extra = {}) {
  const from = {name: "Nik", address: "nik@aetoswebsites.com"};
  const {headers, text} = composeEmail({from, to: "bob@x.com", subject: "Your site", body: "Hi Bob,\nline",
    messageId: "<a@aetoswebsites.com>", inReplyTo: "<r@x.com>", date: new Date("2026-10-21T09:00:00Z")});
  return {from, to: "bob@x.com", subject: "Your site", text, headers, ...extra};
}

function assertFailed(r) {
  assert.equal(r.ok, false);
  assert.equal(typeof r.ms, "number");
  assert.equal(typeof r.error, "string");
  assert.ok(r.error.length > 0);
}

// ---- The spec's cases (Task 12, Step 1) ----

test("connects to Namecheap with the exact settings and sends the composed message", async () => {
  const mailer = fakeMailer();
  const msg = message();
  const r = await sendViaSmtp(mailbox, "pw", msg, {mailer});
  assert.deepEqual(mailer.calls.connect, [NAMECHEAP_OPTS]);
  assert.equal(mailer.calls.send.length, 1);
  const {dsnOverride, ...sent} = mailer.calls.send[0];
  assert.deepEqual(sent, {from:{name:"Nik",email:"nik@aetoswebsites.com"}, to:{email:"bob@x.com"},
    subject:"Your site", text:"Hi Bob,\nline", headers: msg.headers});
  // Bounces must come back (worker-mailer's default would be NOTIFY=NEVER on a server that offers DSN).
  assert.deepEqual(dsnOverride, {NOTIFY: {FAILURE: true}});
  assert.equal(mailer.calls.send[0].headers["Message-ID"], "<a@aetoswebsites.com>");
  assert.equal(mailer.calls.send[0].headers["In-Reply-To"], "<r@x.com>");
  assert.equal(mailer.calls.close, 1);
  assert.deepEqual(mailer.calls.order, ["connect", "send", "close"]);
  assert.equal(r.ok, true);
  assert.equal(typeof r.ms, "number");
  assert.ok(r.ms >= 0);
  assert.deepEqual(Object.keys(r).sort(), ["ms", "ok"]);
});

test("a 535 from Namecheap says the password is wrong", async () => {
  const mailer = fakeMailer({connectError: new Error("535 5.7.8 Authentication failed")});
  const r = await sendViaSmtp(mailbox, "pw", message(), {mailer});
  assertFailed(r);
  assert.match(r.error, /Namecheap said the password is wrong for nik@aetoswebsites.com/);
  assert.equal(r.error, WRONG_PASSWORD);
  assert.equal(mailer.calls.send.length, 0);
  assert.equal(mailer.calls.close, 0); // there is no connection to close
});

test("a timeout says it couldn't connect within 10 seconds", async () => {
  for (const e of [new Error("Socket timeout!"), new Error("Timeout while waiting for smtp server response")]) {
    const mailer = fakeMailer({connectError: e});
    const r = await sendViaSmtp(mailbox, "pw", message(), {mailer});
    assertFailed(r);
    assert.match(r.error, /Couldn't connect to mail.privateemail.com on port 465 within 10 seconds/, e.message);
    assert.equal(r.error, NO_CONNECT);
    assert.equal(mailer.calls.send.length, 0);
  }
});

test("testSmtpLogin connects then closes, and never sends", async () => {
  const mailer = fakeMailer();
  const r = await testSmtpLogin(mailbox, "pw", {mailer});
  assert.deepEqual(mailer.calls.order, ["connect", "close"]);
  assert.equal(mailer.calls.send.length, 0);
  assert.deepEqual(mailer.calls.connect, [NAMECHEAP_OPTS]);
  assert.equal(r.ok, true);
  assert.equal(typeof r.ms, "number");
  assert.equal(r.error, undefined);
});

test("the vendor file is worker-mailer 1.3.0 (MIT), unchanged, and uses cloudflare:sockets", () => {
  const src = readFileSync(VENDOR, "utf8");
  const lines = src.split("\n");
  assert.match(lines[0], /^\/\/ worker-mailer 1\.3\.0 .*MIT/);
  assert.equal(lines[0], "// worker-mailer 1.3.0 (https://www.npmjs.com/package/worker-mailer), MIT License, Copyright (c) zou-yu.");
  assert.equal(lines[1], "// Vendored unchanged from dist/index.mjs, sha256 64f8823c…9783. Do not edit.");
  assert.ok(src.includes("cloudflare:sockets"));
  // The full LICENSE text sits in a block comment, then dist/index.mjs follows byte for byte.
  assert.equal(lines[2], "/*");
  assert.ok(src.includes("Permission is hereby granted, free of charge, to any person obtaining a copy"));
  assert.ok(src.includes("The above copyright notice and this permission notice shall be included in all"));
  const end = src.indexOf("\n*/\n");
  assert.ok(end > 0, "the LICENSE comment is closed");
  const verbatim = src.slice(end + "\n*/\n".length);
  assert.equal(createHash("sha256").update(verbatim, "utf8").digest("hex"),
    "64f8823cacce89afe22834809903400f07982fa915eb37d301e962f232759783");
  assert.match(verbatim, /export\{[^}]*\bS as WorkerMailer\b/);
});

test("smtp.js loads the vendor file lazily, never with a static import", () => {
  const src = readFileSync(SMTP_SRC, "utf8");
  const staticImport = /^\s*import(?!\s*\()[^;]*?vendor/m; // import … from "./vendor/…", import{…}from"…", import "./vendor/…"
  const reExport = /^\s*export\b[^;]*?\bfrom\s*["'][^"']*vendor/m;
  // The patterns catch every static form (and not the lazy one), so the checks below mean something.
  for (const form of ['import { WorkerMailer } from "./vendor/worker-mailer.js";', 'import{WorkerMailer}from"./vendor/worker-mailer.js"',
    "import * as wm from './vendor/worker-mailer.js';", 'import "./vendor/worker-mailer.js";',
    'import {\n  WorkerMailer,\n} from "./vendor/worker-mailer.js";']) assert.match(form, staticImport, form);
  assert.match('export { WorkerMailer } from "./vendor/worker-mailer.js";', reExport);
  assert.doesNotMatch('  const m = await import("./vendor/worker-mailer.js");', staticImport);
  assert.doesNotMatch(src, staticImport);
  assert.doesNotMatch(src, reExport);
  assert.match(src, /await import\(\s*["']\.\/vendor\/worker-mailer\.js["']\s*\)/);
});

// ---- Extra edges ----

test("the caller's headers object is copied, not handed over (worker-mailer adds headers in place)", async () => {
  const mailer = fakeMailer();
  const msg = message();
  await sendViaSmtp(mailbox, "pw", msg, {mailer});
  assert.notEqual(mailer.calls.send[0].headers, msg.headers);
  mailer.calls.send[0].headers.Extra = "x";
  assert.equal(msg.headers.Extra, undefined);
});

test("host and port come from the mailbox row, with Namecheap's as the default", async () => {
  const bare = fakeMailer();
  await sendViaSmtp({address: "nik@aetoswebsites.com"}, "pw", message(), {mailer: bare});
  assert.deepEqual(bare.calls.connect, [NAMECHEAP_OPTS]);
  const asText = fakeMailer();
  await testSmtpLogin({...mailbox, smtp_port: "465", smtp_host: " mail.privateemail.com "}, "pw", {mailer: asText});
  assert.deepEqual(asText.calls.connect, [NAMECHEAP_OPTS]);
  const trimmed = fakeMailer();
  await testSmtpLogin({...mailbox, address: " nik@aetoswebsites.com "}, "pw", {mailer: trimmed});
  assert.equal(trimmed.calls.connect[0].credentials.username, "nik@aetoswebsites.com");
});

test("a display name is left out of `from` when there isn't one", async () => {
  const mailer = fakeMailer();
  await sendViaSmtp(mailbox, "pw", message({from: {address: "nik@aetoswebsites.com"}}), {mailer});
  assert.deepEqual(mailer.calls.send[0].from, {email: "nik@aetoswebsites.com"});
});

test("refuses before connecting: no password, line breaks, a bad address, an empty email, no message", async () => {
  const cases = [
    ["no password", mailbox, "", message(), /^Save the mailbox password first\.$/],
    ["null password", mailbox, null, message(), /^Save the mailbox password first\.$/],
    ["CRLF in a header", mailbox, "pw", message({headers: {...message().headers, Subject: "Hi\r\nBcc: x@y.com"}}),
      /Header values can't contain line breaks/],
    ["LF in the subject", mailbox, "pw", message({subject: "Hi\nBcc: x@y.com"}), /Header values can't contain line breaks/],
    ["CR in the sender name", mailbox, "pw", message({from: {name: "Nik\rBcc: x", address: "nik@aetoswebsites.com"}}),
      /Header values can't contain line breaks/],
    ["SMTP injection in To", mailbox, "pw", message({to: "bob@x.com>\r\nRCPT TO:<evil@y.com"}), /To address/],
    ["a name in To", mailbox, "pw", message({to: "Bob <bob@x.com>"}), /To address/],
    ["no To", mailbox, "pw", message({to: ""}), /To address/],
    ["bad From", mailbox, "pw", message({from: {name: "Nik", address: "nik@aetoswebsites.com>\r\nRSET"}}), /From address/],
    ["empty email", mailbox, "pw", message({text: ""}), /The email is empty/],
    ["no message", mailbox, "pw", null, /no message/i],
    ["no mailbox", null, "pw", message(), /mailbox/i],
  ];
  for (const [label, mb, pw, msg, re] of cases) {
    const mailer = fakeMailer();
    const r = await sendViaSmtp(mb, pw, msg, {mailer});
    assertFailed(r);
    assert.match(r.error, re, label);
    assert.equal(r.ms, 0, label);
    assert.equal(mailer.calls.connect.length, 0, label);
  }
  const mailer = fakeMailer();
  assert.deepEqual(await testSmtpLogin(mailbox, "", {mailer}), {ok: false, ms: 0, error: "Save the mailbox password first."});
  assert.equal(mailer.calls.connect.length, 0);
});

test("never throws: a broken mailer, a sync throw, a failed send, a failed close", async () => {
  const broken = await sendViaSmtp(mailbox, "pw", message(), {mailer: {}});
  assertFailed(broken);
  const syncConnect = await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({connectThrowsSync: new Error("boom")})});
  assertFailed(syncConnect);
  assert.match(syncConnect.error, /boom/);
  const loginBroken = await testSmtpLogin(mailbox, "pw", {mailer: {connect: () => { throw "not an Error"; }}});
  assertFailed(loginBroken);

  // A failed send still closes the connection, once.
  const failing = fakeMailer({sendError: new Error("Failed send email body: 554 5.7.1 Message rejected")});
  assertFailed(await sendViaSmtp(mailbox, "pw", message(), {mailer: failing}));
  assert.equal(failing.calls.close, 1);
  const syncSend = fakeMailer({sendThrowsSync: new Error("At least one of text or html must be provided")});
  const r = await sendViaSmtp(mailbox, "pw", message(), {mailer: syncSend});
  assertFailed(r);
  assert.match(r.error, /The email is empty/);
  assert.equal(syncSend.calls.close, 1);

  // The email was accepted before close failed, so it counts as sent.
  const badClose = fakeMailer({closeError: new Error("Socket closed")});
  assert.equal((await sendViaSmtp(mailbox, "pw", message(), {mailer: badClose})).ok, true);
  assert.equal(badClose.calls.close, 1);
  const badCloseLogin = fakeMailer({closeError: new Error("Socket closed")});
  assert.equal((await testSmtpLogin(mailbox, "pw", {mailer: badCloseLogin})).ok, true);
});

test("a send that breaks part-way may or may not have gone; a refusal wasn't sent", async () => {
  const dropped = [
    new Error("Timeout while waiting for smtp server response"),
    new Error("SMTP connection closed by server"),
    new Error("Network connection lost."),
  ];
  for (const e of dropped) {
    const r = await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({sendError: e})});
    assertFailed(r);
    assert.match(r.error, /It may or may not have gone: check the Sent folder in Namecheap webmail before sending again\./, e.message);
    assert.doesNotMatch(r.error, /Couldn't connect/, e.message);
  }
  const refusedTo = await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({sendError:
    new Error("Invalid RCPT TO: <bob@x.com> NOTIFY=FAILURE 550 5.1.1 <bob@x.com>: Recipient address rejected: User unknown")})});
  assert.match(refusedTo.error, /^Namecheap refused the address bob@x\.com/);
  assert.match(refusedTo.error, /550 5\.1\.1/);
  assert.match(refusedTo.error, /It wasn't sent\./);
  const refused = await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({sendError:
    new Error("Failed send email body: 554 5.7.1 Message rejected as spam")})});
  assert.match(refused.error, /^Namecheap refused this email \(it said: "554 5\.7\.1 Message rejected as spam"\)\. It wasn't sent\./);
  const later = await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({sendError:
    new Error("Invalid MAIL FROM: <nik@aetoswebsites.com> 451 4.7.1 Sending rate limit exceeded")})});
  assert.match(later.error, /couldn't take this email right now/);
  assert.match(later.error, /It wasn't sent\./);
  assert.doesNotMatch(later.error, /may or may not/);
});

test("explainSmtpError: plain English for each kind of failure (pure)", () => {
  assert.equal(explainSmtpError(new Error("535 5.7.8 Authentication failed"), mailbox), WRONG_PASSWORD);
  assert.equal(explainSmtpError(new Error("Failed to login authentication: 535 5.7.8 Error: authentication failed: authentication failure"), mailbox), WRONG_PASSWORD);
  assert.equal(explainSmtpError("535 5.7.8 Authentication failed", mailbox), WRONG_PASSWORD); // a bare string works too
  assert.equal(explainSmtpError(new Error("Socket timeout!"), mailbox), NO_CONNECT);
  assert.equal(explainSmtpError(new Error("Socket timeout!"), {address: "nik@aetoswebsites.com"}), NO_CONNECT); // defaults
  assert.equal(explainSmtpError(new Error("SMTP connection closed by server"), mailbox), NO_CONNECT);
  assert.equal(explainSmtpError(new Error("Socket timeout!"), {...mailbox, smtp_host: "smtp.example.com", smtp_port: 2465}),
    NO_CONNECT.replace("mail.privateemail.com on port 465", "smtp.example.com on port 2465"));
  // A temporary auth failure (4xx) is not a wrong password.
  const temp = explainSmtpError(new Error("Failed to login authentication: 454 4.7.0 Temporary authentication failure"), mailbox);
  assert.doesNotMatch(temp, /password is wrong/);
  assert.match(temp, /454 4\.7\.0 Temporary authentication failure/);
  assert.match(temp, /try again/i);
  // An unsupported login method isn't a wrong password either; the server's words are shown.
  const method = explainSmtpError(new Error("Invalid login: 504 5.5.4 Unrecognized authentication type"), mailbox);
  assert.doesNotMatch(method, /password is wrong/);
  assert.match(method, /504 5\.5\.4 Unrecognized authentication type/);
  // An unexpected error shows its own words.
  assert.match(explainSmtpError(new TypeError("l(...).toBase64 is not a function"), mailbox), /toBase64 is not a function/);
  // Odd input never throws.
  for (const e of [undefined, null, "", 42, {}, {message: 7}, Object.create(null)]) {
    assert.equal(typeof explainSmtpError(e, mailbox), "string");
    assert.equal(typeof explainSmtpError(e, undefined), "string");
  }
  assert.match(explainSmtpError(new Error("535 5.7.8 Authentication failed"), {}), /password is wrong for this mailbox/);
  // While sending, a dropped line is ambiguous.
  assert.match(explainSmtpError(new Error("Socket timeout!"), mailbox, "send"), /may or may not have gone/);
});

// Stage 6 never retries a failed follow-up whose error starts with INTERRUPTED_PREFIX (it may have gone), and retries
// every other failure up to 3 times. So every "may or may not have gone" text must start with it, and no definite
// failure may.
test("a send that may already have gone starts with INTERRUPTED_PREFIX; a definite failure never does", async () => {
  assert.equal(INTERRUPTED_PREFIX, "The send was interrupted");
  assert.equal(MAYBE_SENT, "It may or may not have gone: check the Sent folder in Namecheap webmail before sending again.");
  assert.equal(explainSmtpError(new Error("Socket timeout!"), mailbox, "send"),
    "The send was interrupted: mail.privateemail.com stopped answering while the email was being sent (nothing back " +
    `within 10 seconds). ${MAYBE_SENT}`);
  assert.equal(explainSmtpError(new Error("SMTP connection closed by server"), mailbox, "send"),
    "The send was interrupted: the connection to mail.privateemail.com broke while the email was being sent (SMTP " +
    `connection closed by server). ${MAYBE_SENT}`);
  for (const e of [new Error("Timeout while waiting for smtp server response"), new Error("Socket timeout!"),
    new Error("SMTP connection closed by server"), new Error("Network connection lost."), new Error("something odd")]) {
    const r = await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({sendError: e})});
    assert.ok(r.error.startsWith(`${INTERRUPTED_PREFIX}: `), r.error);
    assert.ok(r.error.endsWith(MAYBE_SENT), r.error);
  }

  const definite = [];
  for (const sendError of [
    new Error("Failed send email body: 554 5.7.1 Message rejected as spam"), // 5xx
    new Error("Invalid MAIL FROM: <nik@aetoswebsites.com> 451 4.7.1 Sending rate limit exceeded"), // 4xx temporary
    new Error("Invalid RCPT TO: <bob@x.com> NOTIFY=FAILURE 550 5.1.1 <bob@x.com>: Recipient address rejected"),
    new Error("At least one of text or html must be provided"), // empty email
    new Error("535 5.7.8 Authentication failed"),
  ]) definite.push((await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({sendError})})).error);
  definite.push((await sendViaSmtp(mailbox, "pw", message({text: ""}), {mailer: fakeMailer()})).error); // empty
  definite.push((await sendViaSmtp(mailbox, "", message(), {mailer: fakeMailer()})).error); // no password
  // Every failure while connecting or logging in: nothing was sent.
  for (const connectError of [new Error("Socket timeout!"), new Error("SMTP connection closed by server"),
    new Error("Network connection lost."), new Error("535 5.7.8 Authentication failed"),
    new Error("Failed to login authentication: 454 4.7.0 Temporary authentication failure"),
    new Error("Invalid login: 504 5.5.4 Unrecognized authentication type"), new Error("something odd")]) {
    definite.push((await sendViaSmtp(mailbox, "pw", message(), {mailer: fakeMailer({connectError})})).error);
    definite.push((await testSmtpLogin(mailbox, "pw", {mailer: fakeMailer({connectError})})).error);
    definite.push(explainSmtpError(connectError, mailbox, "connect"));
  }
  for (const error of definite) {
    assert.equal(typeof error, "string");
    assert.ok(!error.startsWith(INTERRUPTED_PREFIX), error);
    assert.doesNotMatch(error, /may or may not/, error);
  }
});

test("server words are tidied: control characters removed, long replies cut", () => {
  const long = explainSmtpError(new Error(`Failed send email body: 554 5.7.1 ${"x".repeat(1000)}\r\n`), mailbox, "send");
  assert.ok(long.length < 400, String(long.length));
  assert.doesNotMatch(long, /[\r\n\x00-\x1f]/);
});

test("the password never appears in an error, even if the server echoes it", async () => {
  const pw = "hunter2-secret";
  const b64 = Buffer.from(pw, "utf8").toString("base64");
  for (const where of ["connectError", "sendError"]) {
    const mailer = fakeMailer({[where]: new Error(`Something odd: ${pw} / ${b64}`)});
    const r = await sendViaSmtp(mailbox, pw, message(), {mailer});
    assertFailed(r);
    assert.ok(!r.error.includes(pw), r.error);
    assert.ok(!r.error.includes(b64), r.error);
  }
  const login = await testSmtpLogin(mailbox, pw, {mailer: fakeMailer({connectError: new Error(`bad ${pw}`)})});
  assertFailed(login);
  assert.ok(!login.error.includes(pw), login.error);
});

// ---- Review fixes ----

test("Test login gives Setup's exact answers for a wrong password and a timeout", async () => {
  const wrong = await testSmtpLogin(mailbox, "pw", {mailer: fakeMailer({connectError:
    new Error("Failed to login authentication: 535 5.7.8 Error: authentication failed: UGFzc3dvcmQ6")})});
  assert.deepEqual({ok: wrong.ok, error: wrong.error}, {ok: false, error: WRONG_PASSWORD});
  const slow = await testSmtpLogin(mailbox, "pw", {mailer: fakeMailer({connectError: new Error("Socket timeout!")})});
  assert.deepEqual({ok: slow.ok, error: slow.error}, {ok: false, error: NO_CONNECT});
});

test("ms covers connect, send and close", async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mailer = {connect: async () => { await wait(20); return {send: async () => wait(20), close: async () => wait(20)}; }};
  const r = await sendViaSmtp(mailbox, "pw", message(), {mailer});
  assert.equal(r.ok, true);
  assert.ok(r.ms >= 55, String(r.ms));
  const l = await testSmtpLogin(mailbox, "pw", {mailer});
  assert.ok(l.ms >= 35, String(l.ms));
});

test("a port number in a socket error isn't read as an SMTP reply code", () => {
  for (const e of ["proxy request failed, cannot connect to the specified address on port 465",
    "Connection refused on Port 465", "Failed to connect to SMTP server: "]) {
    assert.equal(explainSmtpError(new Error(e), mailbox), NO_CONNECT, e);
  }
  // A real reply code is still found.
  assert.match(explainSmtpError(new Error("Failed to connect to SMTP server: 554 No SMTP service here"), mailbox),
    /refused the login \(it said: "554 No SMTP service here"\)/);
});

test("an unexpected error reads as one sentence (no doubled punctuation)", () => {
  const e = explainSmtpError(new Error("No supported auth method found."), mailbox);
  assert.equal(e, "Couldn't log in to mail.privateemail.com: No supported auth method found. Try again in a minute; if the same error comes back, ask Claude to look at it.");
  assert.doesNotMatch(explainSmtpError(new Error("Weird:"), mailbox), /:\./);
});

test("headers: empty values are left out, odd shapes are refused, the checked text is what's sent", async () => {
  const mailer = fakeMailer();
  const base = message();
  await sendViaSmtp(mailbox, "pw", message({headers: {...base.headers, "X-Unset": undefined, "X-Empty": null}}), {mailer});
  assert.deepEqual(mailer.calls.send[0].headers, base.headers); // worker-mailer would have written "undefined"
  const asText = fakeMailer();
  await sendViaSmtp(mailbox, "pw", message({headers: {...base.headers, "X-Step": 3}}), {mailer: asText});
  assert.equal(asText.calls.send[0].headers["X-Step"], "3");
  for (const headers of ["From: x", ["a"], 7]) {
    const m = fakeMailer();
    const r = await sendViaSmtp(mailbox, "pw", message({headers}), {mailer: m});
    assertFailed(r);
    assert.match(r.error, /headers aren't in the right shape/);
    assert.equal(m.calls.connect.length, 0);
  }
  for (const name of ["Bcc:", "X Bad", "", "Sübject"]) {
    const m = fakeMailer();
    const r = await sendViaSmtp(mailbox, "pw", message({headers: {...base.headers, [name]: "v"}}), {mailer: m});
    assert.match(r.error, /header names isn't valid/, name);
    assert.equal(m.calls.connect.length, 0, name);
  }
});

test("never throws on odd values, and still hides the password", async () => {
  const pw = "hunter2-secret";
  const throwing = {toString() { throw new Error(`no ${pw}`); }};
  const getter = Object.defineProperty({address: "nik@aetoswebsites.com"}, "smtp_port", {get() { throw new Error("boom"); }});
  const cases = [
    () => sendViaSmtp({...mailbox, smtp_port: Symbol("p")}, pw, message(), {mailer: fakeMailer()}),
    () => sendViaSmtp(getter, pw, message(), {mailer: fakeMailer()}),
    () => sendViaSmtp(mailbox, pw, message({from: {name: "Nik", address: throwing}}), {mailer: fakeMailer()}),
    () => sendViaSmtp(mailbox, pw, message({from: {get name() { throw new Error(`leak ${pw}`); }, address: "nik@aetoswebsites.com"}}), {mailer: fakeMailer()}),
    () => sendViaSmtp(mailbox, Symbol("pw"), message(), {mailer: fakeMailer()}),
    () => testSmtpLogin(getter, pw, {mailer: fakeMailer()}),
    () => testSmtpLogin(mailbox, throwing, {mailer: fakeMailer()}),
    () => sendViaSmtp(mailbox, pw, message(), null),
    () => testSmtpLogin(mailbox, pw, null),
  ];
  for (const [i, run] of cases.entries()) {
    const r = await run();
    assert.equal(typeof r.ok, "boolean", `case ${i}`);
    assert.equal(typeof r.ms, "number", `case ${i}`);
    if (!r.ok) assert.ok(!r.error.includes(pw), `case ${i}: ${r.error}`);
  }
  const leak = await cases[3]();
  assertFailed(leak);
  assert.match(leak.error, /^The email wasn't sent: something unexpected went wrong/);
  assert.equal(typeof explainSmtpError(new Error("x"), {smtp_port: Symbol("p")}), "string");
  assert.equal(typeof explainSmtpError(new Error("x"), getter), "string");
});

// ---- The real worker-mailer against a fake Namecheap (see REAL_LIBRARY at the top) ----

const NEEDS_HOOKS = !REAL_LIBRARY && "needs node:module registerHooks (Node 22.15 or later)";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Answers SMTP the way Namecheap's server does, through the socket shape cloudflare:sockets' connect() returns, and
// records what the library writes. `body: null` never answers the final dot; `greet: false` never says hello;
// `opened: false` never opens the socket.
function fakeNamecheap({caps = ["AUTH PLAIN LOGIN", "DSN"], auth = "235 2.7.0 Authentication successful",
  rcpt = "250 2.1.5 Ok", body = "250 2.0.0 Ok: queued as 4ABC", greet = true, opened = true} = {}) {
  const seen = {connects: [], lines: [], data: null};
  globalThis.__fakeNamecheap = (address, options) => {
    seen.connects.push({address, options});
    let out;
    const readable = new ReadableStream({start(controller) { out = controller; }});
    const say = (reply) => out.enqueue(new TextEncoder().encode(`${reply}\r\n`));
    let buffer = "";
    let inData = false;
    let authStep = 0;
    const writable = new WritableStream({
      write(chunk) {
        buffer += new TextDecoder().decode(chunk);
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            seen.data = buffer.slice(0, end + 2);
            buffer = buffer.slice(end + 5);
            inData = false;
            if (body) say(body);
            continue;
          }
          const eol = buffer.indexOf("\r\n");
          if (eol < 0) return;
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          seen.lines.push(line);
          if (authStep === 1) { authStep = 2; say("334 UGFzc3dvcmQ6"); continue; }
          if (authStep === 2) { authStep = 0; say(auth); continue; }
          const verb = line.split(/[\s:]/)[0].toUpperCase();
          if (verb === "EHLO") say(["250-mail.privateemail.com", ...caps.map((c) => `250-${c}`), "250 8BITMIME"].join("\r\n"));
          else if (verb === "AUTH") { authStep = 1; say("334 VXNlcm5hbWU6"); }
          else if (verb === "MAIL") say("250 2.1.0 Ok");
          else if (verb === "RCPT") say(rcpt);
          else if (verb === "DATA") { inData = true; say("354 End data with <CR><LF>.<CR><LF>"); }
          else if (verb === "RSET") say("250 2.0.0 Ok");
          else if (verb === "QUIT") { say("221 2.0.0 Bye"); out.close(); }
          else say("502 5.5.2 Error: command not recognized");
        }
      },
    });
    if (greet) queueMicrotask(() => say("220 mail.privateemail.com ESMTP"));
    return {opened: opened ? Promise.resolve() : new Promise(() => {}), readable, writable, close: async () => {},
      startTls() { throw new Error("not used on port 465"); }};
  };
  return seen;
}

// Runs `run` with console output captured (worker-mailer logs at INFO), then removes the fake server.
async function quietly(run) {
  const logged = [];
  const saved = {};
  for (const level of ["debug", "info", "log", "warn", "error"]) {
    saved[level] = console[level];
    console[level] = (...args) => logged.push(args.map(String).join(" "));
  }
  try {
    return {result: await run(), logged};
  } finally {
    Object.assign(console, saved);
    delete globalThis.__fakeNamecheap;
  }
}

// worker-mailer's 10-second timers are mocked (so none is left running); this moves the clock on until `promise` settles.
async function settle(t, promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 20 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!done) t.mock.timers.tick(10000);
  }
  assert.ok(done, "it never finished");
  return promise;
}

test("real worker-mailer: the SMTP conversation, and the email exactly as Namecheap receives it", {skip: NEEDS_HOOKS}, async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const server = fakeNamecheap();
  const pw = "pw-Secret-1";
  const from = {name: "Café Nik", address: "nik@aetoswebsites.com"};
  const {headers, text} = composeEmail({from, to: "bob@x.com", subject: "Your site – a quick look",
    body: "Hi Bob,\n.a line starting with a dot\nNik", messageId: "<a@aetoswebsites.com>", inReplyTo: "<r@x.com>",
    references: "<q@x.com>", date: new Date("2026-10-21T09:00:00Z")});
  const {result, logged} = await quietly(() => sendViaSmtp(mailbox, pw, {from, to: "bob@x.com", subject: "Your site – a quick look", text, headers}));

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(server.connects, [{address: {hostname: "mail.privateemail.com", port: 465},
    options: {secureTransport: "on", allowHalfOpen: false}}]);
  assert.deepEqual(server.lines.map((l) => l.trimEnd()), ["EHLO [127.0.0.1]", "AUTH LOGIN", b64("nik@aetoswebsites.com"), b64(pw),
    "MAIL FROM: <nik@aetoswebsites.com>", "RCPT TO: <bob@x.com> NOTIFY=FAILURE", "DATA", "QUIT"]);

  // composeEmail's headers go out once each, exactly as composed; the library adds only the MIME ones.
  const head = server.data.slice(0, server.data.indexOf("\r\n\r\n")).split("\r\n");
  for (const [name, value] of Object.entries(headers)) {
    assert.deepEqual(head.filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)), [`${name}: ${value}`], name);
  }
  assert.ok(head.includes("From: =?UTF-8?B?Q2Fmw6kgTmlr?= <nik@aetoswebsites.com>"));
  assert.ok(head.includes("References: <q@x.com> <r@x.com>"));
  assert.deepEqual(head.map((l) => l.split(":")[0]).sort(),
    ["Content-Type", "Date", "From", "In-Reply-To", "MIME-Version", "Message-ID", "References", "Subject", "To"]);
  assert.match(server.data, /\r\nContent-Type: text\/plain; charset="UTF-8"\r\n/);
  assert.match(server.data, /\r\nHi Bob,\r\n\.\.a line starting with a dot\r\nNik\r\n/); // dot-stuffed on the wire

  // Nothing the library logs carries the password.
  assert.ok(logged.length > 0);
  for (const line of logged) assert.ok(!line.includes(pw) && !line.includes(b64(pw)), line);
});

test("real worker-mailer: wrong password, refused address, no DSN, and Test login", {skip: NEEDS_HOOKS}, async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const wrong = fakeNamecheap({auth: "535 5.7.8 Error: authentication failed: UGFzc3dvcmQ6"});
  const w = (await quietly(() => sendViaSmtp(mailbox, "pw", message()))).result;
  assert.deepEqual({ok: w.ok, error: w.error}, {ok: false, error: WRONG_PASSWORD});
  assert.ok(!wrong.lines.some((l) => l.startsWith("MAIL")));

  const refused = fakeNamecheap({rcpt: "550 5.1.1 <bob@x.com>: Recipient address rejected: User unknown in virtual mailbox table"});
  const r = (await quietly(() => sendViaSmtp(mailbox, "pw", message()))).result;
  assert.equal(r.ok, false);
  assert.match(r.error, /^Namecheap refused the address bob@x\.com \(it said: "550 5\.1\.1 <bob@x\.com>: Recipient address rejected/);
  assert.match(r.error, /It wasn't sent\./);
  assert.ok(!refused.lines.includes("DATA"));
  assert.equal(refused.lines.at(-1), "QUIT"); // closed even though the send failed

  const noDsn = fakeNamecheap({caps: ["AUTH PLAIN LOGIN"]});
  assert.equal((await quietly(() => sendViaSmtp(mailbox, "pw", message()))).result.ok, true);
  assert.ok(noDsn.lines.includes("RCPT TO: <bob@x.com>")); // nothing to ask for when the server has no DSN

  const login = fakeNamecheap();
  const l = (await quietly(() => testSmtpLogin(mailbox, "pw"))).result;
  assert.equal(l.ok, true, l.error);
  assert.deepEqual(login.lines, ["EHLO [127.0.0.1]", "AUTH LOGIN", b64("nik@aetoswebsites.com"), b64("pw"), "QUIT"]);
  const badLogin = fakeNamecheap({auth: "535 5.7.8 Error: authentication failed: authentication failure"});
  const bl = (await quietly(() => testSmtpLogin(mailbox, "pw"))).result;
  assert.deepEqual({ok: bl.ok, error: bl.error}, {ok: false, error: WRONG_PASSWORD});
  assert.equal(badLogin.lines.length, 4);
});

test("real worker-mailer: timeouts give Setup's text, and a silent server after the email is 'may or may not'", {skip: NEEDS_HOOKS}, async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  fakeNamecheap({opened: false});
  const closed = (await quietly(() => settle(t, testSmtpLogin(mailbox, "pw")))).result;
  assert.deepEqual({ok: closed.ok, error: closed.error}, {ok: false, error: NO_CONNECT});

  fakeNamecheap({greet: false});
  const silent = (await quietly(() => settle(t, sendViaSmtp(mailbox, "pw", message())))).result;
  assert.deepEqual({ok: silent.ok, error: silent.error}, {ok: false, error: NO_CONNECT});

  const after = fakeNamecheap({body: null});
  const lost = (await quietly(() => settle(t, sendViaSmtp(mailbox, "pw", message())))).result;
  assert.equal(lost.ok, false);
  assert.match(lost.error, /^The send was interrupted: mail\.privateemail\.com stopped answering while the email was being sent/);
  assert.match(lost.error, /It may or may not have gone: check the Sent folder in Namecheap webmail before sending again\.$/);
  assert.ok(after.data, "the email itself was written");
});
