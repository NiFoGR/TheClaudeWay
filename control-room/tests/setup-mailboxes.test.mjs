// Setup API for mailboxes: add (POST /api/setup/mailboxes), edit / pause / resume (PATCH /api/setup/mailboxes/:id),
// and Test login / Send test email (POST /api/setup/mailboxes/:id/test). A fake `mailer` stands in for worker-mailer
// through env.__mailer, so nothing here opens a socket. Run: node --test control-room/tests/setup-mailboxes.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkStartedOn, onRequestPost as addMailbox } from "../functions/api/setup/mailboxes.js";
import { onRequestPatch as patchMailbox } from "../functions/api/setup/mailboxes/[id].js";
import { onRequestPost as testMailbox } from "../functions/api/setup/mailboxes/[id]/test.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { processInbound } from "../functions/_lib/mail/inbound-db.js";
import { dispatchDue } from "../functions/_lib/mail/outbox.js";
import { addUkDays, ukDate } from "../functions/_lib/ukTime.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const NIK = { address: "Nik@AetosWebsites.com", display_name: "Nik", role: "cold", started_on: "2026-10-19", password: "pw" };

const ADDRESS = "That doesn't look like an email address.";
const DUPLICATE = "That mailbox is already added.";
const STARTED_ON = "Pick the date you bought it (YYYY-MM-DD), today or earlier.";
const NAME = "Your name can't be empty or contain line breaks.";
const ROLE = "Role must be cold or system.";
const NO_PASSWORD = "Save the mailbox password first.";

const NAMECHEAP_OPTS = {host:"mail.privateemail.com", port:465, secure:true, authType:"login",
  credentials:{username:"nik@aetoswebsites.com", password:"pw"}, socketTimeoutMs:10000, responseTimeoutMs:10000};

// A stand-in for worker-mailer: connect(opts) → {send, close}. Records every call in order.
function fakeMailer({ connectError, sendError } = {}) {
  const calls = { connect: [], send: [], close: 0, order: [] };
  return {
    calls,
    connect(opts) {
      calls.connect.push(opts);
      calls.order.push("connect");
      if (connectError) return Promise.reject(connectError);
      return Promise.resolve({
        send(email) {
          calls.send.push(email);
          calls.order.push("send");
          return sendError ? Promise.reject(sendError) : Promise.resolve();
        },
        async close() {
          calls.close++;
          calls.order.push("close");
        },
      });
    },
  };
}

const request = (url, method, body) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function call(handler, ctx) {
  const res = await handler(ctx);
  const text = await res.text();
  return { status: res.status, text, data: JSON.parse(text) };
}

const add = (env, body) => call(addMailbox, { request: request("https://control.x/api/setup/mailboxes", "POST", body), env });
const patch = (env, id, body) =>
  call(patchMailbox, { request: request(`https://control.x/api/setup/mailboxes/${id}`, "PATCH", body), env, params: { id } });
const tryMailbox = (env, id, body) =>
  call(testMailbox, { request: request(`https://control.x/api/setup/mailboxes/${id}/test`, "POST", body), env, params: { id } });

const setting = (DB, key) => DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
const mailboxRow = (DB, id) => DB.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(id).first();
const count = (DB, table) => DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
const messages = async (DB) => (await DB.prepare("SELECT * FROM messages ORDER BY created_at").all()).results;

async function withMailbox(extra = {}, body = NIK) {
  const env = { DB: fakeD1(), ...extra };
  const r = await add(env, body);
  assert.equal(r.status, 201, r.text);
  return { env, DB: env.DB, id: r.data.mailbox.id, added: r };
}

// ---------------------------------------------------------------- adding a mailbox (Step 1)

test("adding a mailbox stores the address lower-cased and the password as a secret, never in the response", async () => {
  const env = { DB: fakeD1() };
  const r = await add(env, NIK);
  assert.equal(r.status, 201);
  const { mailbox } = r.data;
  assert.match(mailbox.id, UUID);
  assert.equal(mailbox.address, "nik@aetoswebsites.com");
  assert.equal((await mailboxRow(env.DB, mailbox.id)).address, "nik@aetoswebsites.com");
  assert.equal(await setting(env.DB, `secret:mailbox:${mailbox.id}`), "pw");
  assert.ok(!r.text.includes('"pw"'), "the response never contains the password");
  assert.equal(mailbox.has_password, true);
  assert.ok(!("password" in mailbox));
});

test("an added mailbox has the row's fields, the Namecheap defaults and starts active", async () => {
  const { DB, id, added } = await withMailbox();
  const { mailbox } = added.data;
  assert.deepEqual(Object.keys(mailbox).sort(), ["address", "cap_override", "created_at", "display_name", "has_password", "id",
    "paused_reason", "role", "smtp_host", "smtp_port", "started_on", "status"]);
  assert.equal(mailbox.display_name, "Nik");
  assert.equal(mailbox.role, "cold");
  assert.equal(mailbox.started_on, "2026-10-19");
  assert.equal(mailbox.smtp_host, "mail.privateemail.com");
  assert.equal(mailbox.smtp_port, 465);
  assert.equal(mailbox.cap_override, null);
  assert.equal(mailbox.status, "active");
  assert.equal(mailbox.paused_reason, null);
  assert.match(mailbox.created_at, ISO);
  assert.equal(await count(DB, "mailboxes"), 1);
  assert.equal(id, mailbox.id);
});

test("a mailbox added without a password has has_password false and no secret", async () => {
  const { DB, id, added } = await withMailbox({}, { ...NIK, password: undefined });
  assert.equal(added.data.mailbox.has_password, false);
  assert.equal(await setting(DB, `secret:mailbox:${id}`), null);
  const blank = await add({ DB }, { ...NIK, address: "two@aetoswebsites.com", password: "" }); // a blank field isn't a password
  assert.equal(blank.data.mailbox.has_password, false);
  assert.equal(await setting(DB, `secret:mailbox:${blank.data.mailbox.id}`), null);
});

test("names are trimmed, and a role or address with stray spaces or capitals is tidied", async () => {
  const { added } = await withMailbox({}, { ...NIK, address: "  Nik@AetosWebsites.com ", display_name: "  Nik  ", role: " Cold " });
  assert.equal(added.data.mailbox.address, "nik@aetoswebsites.com");
  assert.equal(added.data.mailbox.display_name, "Nik");
  assert.equal(added.data.mailbox.role, "cold");
});

test("validation messages are exact, and a refused mailbox stores nothing", async () => {
  const DB = fakeD1();
  const tomorrow = addUkDays(ukDate(new Date()), 1);
  const cases = [
    [{ address: "nik" }, ADDRESS],
    [{ address: "" }, ADDRESS],
    [{ address: undefined }, ADDRESS],
    [{ address: 42 }, ADDRESS],
    [{ address: "nik@" }, ADDRESS],
    [{ address: "nik@aetos" }, ADDRESS],
    [{ address: "a b@x.com" }, ADDRESS],
    [{ address: "Café@x.com" }, ADDRESS],
    [{ address: "nik@x.com\r\nBcc: y@z.com" }, ADDRESS],
    [{ started_on: "19/10/2026" }, STARTED_ON],
    [{ started_on: "2026-02-30" }, STARTED_ON],
    [{ started_on: tomorrow }, STARTED_ON],
    [{ started_on: "" }, STARTED_ON],
    [{ started_on: undefined }, STARTED_ON],
    [{ display_name: "" }, NAME],
    [{ display_name: "   " }, NAME],
    [{ display_name: undefined }, NAME],
    [{ display_name: "Nik\r\nBcc: x@y.com" }, NAME],
    [{ display_name: "Nik\n" }, NAME],
    [{ role: "warm" }, ROLE],
    [{ role: "" }, ROLE],
    [{ role: undefined }, ROLE],
  ];
  for (const [change, message] of cases) {
    const r = await add({ DB }, { ...NIK, ...change });
    assert.equal(r.status, 400, JSON.stringify(change));
    assert.deepEqual(r.data, { error: message }, JSON.stringify(change));
  }
  assert.equal(await count(DB, "mailboxes"), 0);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'secret:%'").first("n"), 0);
});

test("the same mailbox twice is refused with 409, whatever its capitals", async () => {
  const { DB } = await withMailbox();
  const again = await add({ DB }, { ...NIK, address: " NIK@aetoswebsites.com", password: "other" });
  assert.equal(again.status, 409);
  assert.deepEqual(again.data, { error: DUPLICATE });
  assert.equal(await count(DB, "mailboxes"), 1);
  assert.ok(!again.text.includes("other"));
});

test("today is a valid start date, and odd input is refused in plain English", async () => {
  const DB = fakeD1();
  const today = await add({ DB }, { ...NIK, started_on: ukDate(new Date()) });
  assert.equal(today.status, 201);
  const notJson = await add({ DB }, "{not json");
  assert.equal(notJson.status, 400);
  assert.ok(notJson.data.error);
  const badPassword = await add({ DB }, { ...NIK, address: "b@aetoswebsites.com", password: 1234 });
  assert.equal(badPassword.status, 400);
  assert.match(badPassword.data.error, /password must be text/);
  assert.ok(!badPassword.text.includes("1234"));
  const longName = await add({ DB }, { ...NIK, address: "c@aetoswebsites.com", display_name: "N".repeat(101) });
  assert.equal(longName.status, 400);
  assert.match(longName.data.error, /too long/);
  assert.equal(await count(DB, "mailboxes"), 1);
});

// ---------------------------------------------------------------- Send test email (Step 1)

test("Send test email goes through the mailbox, records a sent system message, the proof and the address", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer });
  const r = await tryMailbox(env, id, { action: "send", to: "nik.test@gmail.com" });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(typeof r.data.ms, "number");
  assert.ok(!("error" in r.data));

  assert.deepEqual(mailer.calls.connect, [NAMECHEAP_OPTS]);
  assert.equal(mailer.calls.send.length, 1);
  const email = mailer.calls.send[0];
  assert.equal(email.subject, "Aetos test email");
  assert.ok(email.text.startsWith("This is a test from your Control Room, sent through nik@aetoswebsites.com at "), email.text);
  assert.deepEqual(email.from, { name: "Nik", email: "nik@aetoswebsites.com" });
  assert.deepEqual(email.to, { email: "nik.test@gmail.com" });
  assert.equal(email.headers.From, "Nik <nik@aetoswebsites.com>");
  assert.equal(email.headers.To, "nik.test@gmail.com");
  assert.equal(email.headers.Subject, "Aetos test email");
  assert.match(email.headers["Message-ID"], /^<[0-9a-f-]{36}@aetoswebsites\.com>$/);
  assert.ok(!("In-Reply-To" in email.headers));
  assert.deepEqual(mailer.calls.order, ["connect", "send", "close"]);

  const proof = JSON.parse(await setting(DB, "smtp:proof"));
  assert.equal(proof.ok, true);
  assert.deepEqual(Object.keys(proof).sort(), ["at", "error", "mailbox_id", "ms", "ok"]);
  assert.equal(proof.mailbox_id, id);
  assert.equal(proof.ms, r.data.ms);
  assert.equal(proof.error, null);
  assert.match(proof.at, ISO);

  const rows = await messages(DB);
  assert.equal(rows.length, 1);
  const [m] = rows;
  assert.equal(m.status, "sent");
  assert.equal(m.kind, "system");
  assert.equal(m.author, "system");
  assert.equal(m.direction, "out");
  assert.equal(m.mailbox_id, id);
  assert.equal(m.place_id, null);
  assert.equal(m.to_addr, "nik.test@gmail.com");
  assert.equal(m.from_addr, "nik@aetoswebsites.com");
  assert.equal(m.subject, "Aetos test email");
  assert.equal(m.body, email.text);
  assert.equal(m.message_id, email.headers["Message-ID"]); // so a reply to it links back
  assert.equal(m.error, null);
  assert.match(m.sent_at, ISO);
  assert.match(m.created_at, ISO);

  assert.equal(await setting(DB, "setup:test_to"), "nik.test@gmail.com");
});

test("a failed test send is recorded as failed, with the plain-English reason, and never shows the password", async () => {
  const mailer = fakeMailer({ connectError: new Error("535 5.7.8 Authentication failed") });
  const { DB, id, env } = await withMailbox({ __mailer: mailer });
  const r = await tryMailbox(env, id, { action: "send", to: "nik.test@gmail.com" });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /Namecheap said the password is wrong for nik@aetoswebsites\.com/);
  assert.ok(!r.text.includes('"pw"'));
  const [m] = await messages(DB);
  assert.equal(m.status, "failed");
  assert.equal(m.error, r.data.error);
  assert.equal(m.sent_at, null);
  const proof = JSON.parse(await setting(DB, "smtp:proof"));
  assert.equal(proof.ok, false);
  assert.equal(proof.error, r.data.error);
  assert.equal(proof.mailbox_id, id);
  assert.equal(mailer.calls.send.length, 0);
});

test("the test email remembers the last address used, and each press sends a new Message-ID", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer });
  await tryMailbox(env, id, { action: "send", to: "first@gmail.com" });
  await tryMailbox(env, id, { action: "send", to: " second@gmail.com " });
  assert.equal(await setting(DB, "setup:test_to"), "second@gmail.com");
  assert.equal(mailer.calls.send[1].to.email, "second@gmail.com");
  const ids = (await messages(DB)).map((m) => m.message_id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("a system mailbox and a paused mailbox can still be tested (the test bypasses the outbox and its cap)", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer }, { ...NIK, role: "system", started_on: ukDate(new Date()) });
  await DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = 'x' WHERE id = ?").bind(id).run();
  const r = await tryMailbox(env, id, { action: "send", to: "nik.test@gmail.com" });
  assert.equal(r.data.ok, true); // started today: the warm-up cap is 0, but the test isn't capped
  assert.equal((await messages(DB))[0].status, "sent");
});

// ---------------------------------------------------------------- Test login (Step 1)

test("Test login with no password says to save it first, and never connects", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer }, { ...NIK, password: undefined });
  const r = await tryMailbox(env, id, { action: "login" });
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.data.ok, error: r.data.error }, { ok: false, error: NO_PASSWORD });
  assert.equal(r.data.ms, 0);
  assert.equal(mailer.calls.connect.length, 0);

  // Send test email without a password: the same answer, and nothing is recorded (nothing was tried)
  const s = await tryMailbox(env, id, { action: "send", to: "nik.test@gmail.com" });
  assert.deepEqual({ ok: s.data.ok, error: s.data.error }, { ok: false, error: NO_PASSWORD });
  assert.equal(mailer.calls.connect.length, 0);
  assert.equal(await count(DB, "messages"), 0);
  assert.equal(await setting(DB, "smtp:proof"), null);
});

test("Test login connects and closes, never sends, and records nothing", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer });
  const r = await tryMailbox(env, id, { action: "login" });
  assert.equal(r.data.ok, true);
  assert.equal(typeof r.data.ms, "number");
  assert.deepEqual(mailer.calls.connect, [NAMECHEAP_OPTS]);
  assert.deepEqual(mailer.calls.order, ["connect", "close"]);
  assert.equal(await count(DB, "messages"), 0);
  assert.equal(await setting(DB, "smtp:proof"), null);
});

test("Test login explains a wrong password and a timeout in plain English", async () => {
  const wrong = await withMailbox({ __mailer: fakeMailer({ connectError: new Error("535 5.7.8 Authentication failed") }) });
  const r = await tryMailbox(wrong.env, wrong.id, { action: "login" });
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /Namecheap said the password is wrong for nik@aetoswebsites\.com/);
  assert.ok(!r.text.includes('"pw"'));

  const slow = await withMailbox({ __mailer: fakeMailer({ connectError: new Error("Timeout while waiting for smtp server response") }) });
  const t = await tryMailbox(slow.env, slow.id, { action: "login" });
  assert.match(t.data.error, /Couldn't connect to mail\.privateemail\.com on port 465 within 10 seconds/);
});

test("the test route refuses an unknown mailbox, an unknown action and a bad To address", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer });
  const missing = await tryMailbox(env, "nope", { action: "login" });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.ok, false);
  assert.match(missing.data.error, /mailbox/);

  const action = await tryMailbox(env, id, { action: "launch" });
  assert.equal(action.status, 400);
  assert.deepEqual({ ok: action.data.ok, error: action.data.error }, { ok: false, error: "Action must be login or send." });

  for (const to of ["nope", "", undefined, "a@b.com\r\nBcc: c@d.com", "x@y.com, z@w.com"]) {
    const r = await tryMailbox(env, id, { action: "send", to });
    assert.equal(r.status, 400, String(to));
    assert.deepEqual({ ok: r.data.ok, error: r.data.error }, { ok: false, error: ADDRESS });
  }
  const notJson = await tryMailbox(env, id, "{");
  assert.equal(notJson.status, 400);
  assert.equal(notJson.data.ok, false);

  assert.equal(mailer.calls.connect.length, 0);
  assert.equal(await count(DB, "messages"), 0);
  assert.equal(await setting(DB, "setup:test_to"), null);
});

// ---------------------------------------------------------------- PATCH: pause, resume, edit (Step 1)

test("PATCH status active on a paused mailbox clears paused_reason and sets resumed_at", async () => {
  const { DB, id, env } = await withMailbox();
  await DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = ? WHERE id = ?")
    .bind("2 emails bounced in 7 days (last: x@y.com). Check your addresses are real, then press Resume.", id).run();
  const before = Date.now();
  const r = await patch(env, id, { status: "active" });
  assert.equal(r.status, 200);
  assert.equal(r.data.mailbox.status, "active");
  assert.equal(r.data.mailbox.paused_reason, null);
  const row = await mailboxRow(DB, id);
  assert.equal(row.status, "active");
  assert.equal(row.paused_reason, null);
  const resumedAt = await setting(DB, `mailbox:${id}:resumed_at`);
  assert.match(resumedAt, ISO);
  assert.ok(Math.abs(Date.parse(resumedAt) - before) < 5000);
  assert.ok(!r.text.includes('"pw"'));
  assert.equal(r.data.mailbox.has_password, true);
});

test("PATCH active on a mailbox that's already active isn't a resume (resumed_at is left alone)", async () => {
  const { DB, id, env } = await withMailbox();
  await DB.prepare("INSERT INTO settings (key, value) VALUES (?, '2026-01-01T00:00:00Z')").bind(`mailbox:${id}:resumed_at`).run();
  const r = await patch(env, id, { status: "active" });
  assert.equal(r.status, 200);
  assert.equal(await setting(DB, `mailbox:${id}:resumed_at`), "2026-01-01T00:00:00Z");
});

test("PATCH paused pauses with a plain reason, and keeps the reason of a mailbox that's already paused", async () => {
  const { DB, id, env } = await withMailbox();
  const r = await patch(env, id, { status: "paused" });
  assert.equal(r.data.mailbox.status, "paused");
  assert.equal(r.data.mailbox.paused_reason, "you paused it on Setup.");
  await DB.prepare("UPDATE mailboxes SET paused_reason = 'bounces' WHERE id = ?").bind(id).run();
  const again = await patch(env, id, { status: "paused" });
  assert.equal(again.status, 200);
  assert.equal(again.data.mailbox.paused_reason, "bounces");
  assert.equal(await setting(DB, `mailbox:${id}:resumed_at`), null);
});

test("PATCH edits the name, role, start date and daily cap with the same checks", async () => {
  const { DB, id, env } = await withMailbox();
  const r = await patch(env, id, { display_name: " Nik S ", role: "system", started_on: "2026-10-01", cap_override: 20 });
  assert.equal(r.status, 200);
  assert.equal(r.data.mailbox.display_name, "Nik S");
  assert.equal(r.data.mailbox.role, "system");
  assert.equal(r.data.mailbox.started_on, "2026-10-01");
  assert.equal(r.data.mailbox.cap_override, 20);
  assert.equal((await patch(env, id, { cap_override: "5" })).data.mailbox.cap_override, 5);
  assert.equal((await patch(env, id, { cap_override: null })).data.mailbox.cap_override, null);
  await patch(env, id, { cap_override: 3 });
  assert.equal((await patch(env, id, { cap_override: "" })).data.mailbox.cap_override, null);

  const tomorrow = addUkDays(ukDate(new Date()), 1);
  const CAP = "The daily cap must be a whole number from 0 to 200, or leave it empty to follow the warm-up.";
  const cases = [
    [{ display_name: "a\nb" }, NAME],
    [{ display_name: "" }, NAME],
    [{ role: "warm" }, ROLE],
    [{ started_on: tomorrow }, STARTED_ON],
    [{ started_on: "2026-13-01" }, STARTED_ON],
    [{ cap_override: -1 }, CAP],
    [{ cap_override: 2.5 }, CAP],
    [{ cap_override: "x" }, CAP],
    [{ cap_override: 201 }, CAP],
    [{ status: "stopped" }, "Status must be active or paused."],
    [{ address: "other@aetoswebsites.com" }, "A mailbox's address can't be changed. Add the new address as a new mailbox, then pause this one."],
    [{ display_name: "Fine", role: "warm" }, ROLE], // one bad field refuses the whole change
  ];
  for (const [change, message] of cases) {
    const bad = await patch(env, id, change);
    assert.equal(bad.status, 400, JSON.stringify(change));
    assert.deepEqual(bad.data, { error: message }, JSON.stringify(change));
  }
  const row = await mailboxRow(DB, id);
  assert.equal(row.display_name, "Nik S");
  assert.equal(row.role, "system");
  assert.equal(row.started_on, "2026-10-01");
  assert.equal(row.cap_override, null);
  assert.equal(row.status, "active");

  // the unchanged address (any capitals) is fine, so the Edit form can send the whole row back
  const same = await patch(env, id, { address: "NIK@aetoswebsites.com", display_name: "Nik" });
  assert.equal(same.status, 200);
  assert.equal(same.data.mailbox.address, "nik@aetoswebsites.com");
});

test("PATCH saves a new password without showing it; a blank password keeps the old one", async () => {
  const { DB, id, env } = await withMailbox({}, { ...NIK, password: undefined });
  const r = await patch(env, id, { password: "new-secret-pw" });
  assert.equal(r.status, 200);
  assert.equal(r.data.mailbox.has_password, true);
  assert.ok(!r.text.includes("new-secret-pw"));
  assert.equal(await setting(DB, `secret:mailbox:${id}`), "new-secret-pw");
  const blank = await patch(env, id, { display_name: "Nik", password: "" });
  assert.equal(blank.status, 200);
  assert.equal(await setting(DB, `secret:mailbox:${id}`), "new-secret-pw");
  const notText = await patch(env, id, { password: 99 });
  assert.equal(notText.status, 400);
  assert.match(notText.data.error, /password must be text/);
});

test("PATCH refuses an unknown mailbox and an empty change", async () => {
  const { id, env } = await withMailbox();
  const missing = await patch(env, "nope", { status: "active" });
  assert.equal(missing.status, 404);
  assert.match(missing.data.error, /mailbox/);
  const empty = await patch(env, id, {});
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.data, { error: "Nothing to change." });
  const notJson = await patch(env, id, "nope");
  assert.equal(notJson.status, 400);
});

// ---------------------------------------------------------------- review: rules the Step 1 list doesn't cover

const BOUNCED = "2 emails bounced in 7 days (last: x@y.com). Check your addresses are real, then press Resume.";

// The same DB, but `race` runs once, straight after the request first reads the mailbox row: another request (the
// inbound step pausing it for bounces) landing between this request's read and its write.
function racingDB(DB, race) {
  let fired = false;
  return {
    ...DB,
    prepare(sql) {
      const stmt = DB.prepare(sql);
      if (fired || !/^SELECT id, address\b/.test(sql)) return stmt;
      return {
        ...stmt,
        bind(...values) {
          const bound = stmt.bind(...values);
          return {
            ...bound,
            async first(...args) {
              const row = await bound.first(...args);
              if (!fired) {
                fired = true;
                await race();
              }
              return row;
            },
          };
        },
      };
    },
  };
}

const bouncePause = (DB, id) => () =>
  DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = ? WHERE id = ? AND status = 'active'").bind(BOUNCED, id).run();

test("an Edit that sends status active back doesn't undo a bounce pause that lands meanwhile", async () => {
  const { DB, id } = await withMailbox();
  const r = await patch({ DB: racingDB(DB, bouncePause(DB, id)) }, id, { display_name: "Nik S", status: "active" });
  assert.equal(r.status, 200, r.text);
  const row = await mailboxRow(DB, id);
  assert.equal(row.display_name, "Nik S");
  assert.equal(row.status, "paused");
  assert.equal(row.paused_reason, BOUNCED);
  assert.equal(await setting(DB, `mailbox:${id}:resumed_at`), null);
});

test("pressing Pause as bounces pause it keeps the bounce reason", async () => {
  const { DB, id } = await withMailbox();
  const r = await patch({ DB: racingDB(DB, bouncePause(DB, id)) }, id, { status: "paused" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.mailbox.status, "paused");
  assert.equal(r.data.mailbox.paused_reason, BOUNCED);
});

test("a mailbox stored with capitals by anything else still counts as already added", async () => {
  const DB = fakeD1();
  await DB.prepare("INSERT INTO mailboxes (id, address, display_name, role, started_on, created_at) VALUES ('old', ?, 'Nik', 'cold', '2026-10-01', '2026-10-01T00:00:00Z')")
    .bind("Nik@AetosWebsites.com").run();
  const r = await add({ DB }, NIK);
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { error: DUPLICATE });
  assert.equal(await count(DB, "mailboxes"), 1);
  assert.equal(await setting(DB, "secret:mailbox:old"), null);
});

test("a name of 100 characters is fine and 101 is refused with a true message", async () => {
  const DB = fakeD1();
  assert.equal((await add({ DB }, { ...NIK, display_name: "N".repeat(100) })).status, 201);
  const long = await add({ DB }, { ...NIK, address: "b@aetoswebsites.com", display_name: "N".repeat(101) });
  assert.deepEqual(long.data, { error: "Your name is too long: keep it to 100 characters or fewer." });
});

test("the start date is checked against the UK date it is today", () => {
  assert.deepEqual(checkStartedOn("2026-10-22", "2026-10-21"), { error: STARTED_ON });
  assert.deepEqual(checkStartedOn("2026-10-21", "2026-10-21"), { value: "2026-10-21" });
  assert.deepEqual(checkStartedOn(" 2026-10-20 ", "2026-10-21"), { value: "2026-10-20" });
  assert.deepEqual(checkStartedOn("2026-10-20T00:00:00Z", "2026-10-21"), { error: STARTED_ON });
});

test("while the test email is going its row is 'sending', so a send Cloudflare cuts off is still on record", async () => {
  const env = { DB: fakeD1() };
  let during = null;
  env.__mailer = {
    async connect() {
      return {
        async send() {
          during = (await messages(env.DB)).map((m) => m.status);
        },
        async close() {},
      };
    },
  };
  const { data: { mailbox } } = await add(env, NIK);
  const r = await tryMailbox(env, mailbox.id, { action: "send", to: "nik.test@gmail.com" });
  assert.equal(r.data.ok, true);
  assert.deepEqual(during, ["sending"]);
  assert.equal((await messages(env.DB))[0].status, "sent");
});

test("a test send killed after the SMTP step (Error 1102) is marked failed by the outbox's sweep 10 min later, never resent", async () => {
  const mailer = fakeMailer();
  const { DB, id } = await withMailbox();
  // The request dies before it can record the result, as when Cloudflare stops it for CPU time.
  const dying = {
    ...DB,
    prepare(sql) {
      if (/^UPDATE messages SET status = \?, sent_at/.test(sql)) throw new Error("Error 1102: Worker exceeded resource limits");
      return DB.prepare(sql);
    },
  };
  await assert.rejects(tryMailbox({ DB: dying, __mailer: mailer }, id, { action: "send", to: "nik.test@gmail.com" }), /1102/);
  assert.equal((await messages(DB))[0].status, "sending");
  const later = new Date(Date.now() + 11 * 60 * 1000);
  const sends = [];
  await dispatchDue(DB, {}, later, { send: async (...a) => { sends.push(a); return { ok: true, ms: 1 }; } });
  const [m] = await messages(DB);
  assert.equal(m.status, "failed");
  assert.match(m.error, /^The send was interrupted\. It may or may not have gone: check the Sent folder/);
  assert.equal(sends.length, 0);
  assert.equal(mailer.calls.send.length, 1);
});

test("a server that echoes the password never gets it into the answer, the messages row or smtp:proof", async () => {
  const secret = "S3cret-Namecheap-pw";
  for (const action of ["send", "login"]) {
    const mailer = fakeMailer({ connectError: new Error(`454 4.7.0 Temporary failure for user nik ${secret}`) });
    const { DB, id, env } = await withMailbox({ __mailer: mailer }, { ...NIK, password: secret });
    const r = await tryMailbox(env, id, { action, to: "nik.test@gmail.com" });
    assert.equal(r.data.ok, false, action);
    assert.ok(!r.text.includes(secret), r.text);
    const stored = JSON.stringify({ rows: await messages(DB), proof: await setting(DB, "smtp:proof") });
    assert.ok(!stored.includes(secret), stored);
    const { results } = await DB.prepare("SELECT key FROM settings WHERE value LIKE ?").bind(`%${secret}%`).all();
    assert.deepEqual(results.map((s) => s.key), [`secret:mailbox:${id}`]);
  }
});

test("the test routes stay well inside the 50 D1 queries an invocation may make", async () => {
  const mailer = fakeMailer();
  const { DB, id } = await withMailbox();
  const send = countingDB(DB);
  assert.equal((await tryMailbox({ DB: send.DB, __mailer: mailer }, id, { action: "send", to: "nik.test@gmail.com" })).data.ok, true);
  assert.ok(send.used() <= 7, `send used ${send.used()} queries`);
  const login = countingDB(DB);
  assert.equal((await tryMailbox({ DB: login.DB, __mailer: mailer }, id, { action: "login" })).data.ok, true);
  assert.ok(login.used() <= 3, `login used ${login.used()} queries`);
  const edit = countingDB(DB);
  assert.equal((await patch({ DB: edit.DB }, id, { status: "paused", display_name: "Nik", password: "pw2" })).status, 200);
  assert.ok(edit.used() <= 7, `PATCH used ${edit.used()} queries`);
});

test("an address stored with capitals by anything else can still be sent back unchanged by the Edit form", async () => {
  const DB = fakeD1();
  await DB.prepare("INSERT INTO mailboxes (id, address, display_name, role, started_on, created_at) VALUES ('old', ?, 'Nik', 'cold', '2026-10-01', '2026-10-01T00:00:00Z')")
    .bind("Nik@AetosWebsites.com").run();
  const r = await patch({ DB }, "old", { address: "nik@aetoswebsites.com", display_name: "Nik S" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.mailbox.display_name, "Nik S");
  const other = await patch({ DB }, "old", { address: "someone@aetoswebsites.com" });
  assert.equal(other.status, 400);
});

// ---------------------------------------------------------------- review: what these routes write, read by the inbound step

const MAIL_DIR = new URL("./fixtures/mail/", import.meta.url);
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// A Task 14 fixture as the relay stores it (the lower-cased top-level headers as JSON, and the raw MIME), with the
// top-level headers in `set` replaced.
function relayed(name, set = {}) {
  const original = readFileSync(new URL(name, MAIL_DIR), "utf8");
  const end = original.indexOf("\r\n\r\n");
  let head = `${original.slice(0, end)}\r\n`;
  for (const [header, value] of Object.entries(set)) {
    const re = new RegExp(`^${header}:[^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*\\r\\n`, "im");
    assert.match(head, re, `${name} has a ${header} header`);
    head = head.replace(re, () => `${header}: ${value}\r\n`);
  }
  const raw = head.slice(0, -2) + original.slice(end);
  const h = new Headers();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { raw, headers: JSON.stringify(Object.fromEntries(h)) };
}

let rawSeq = 0;
// The relay saves the email at `receivedMs`, then the tick's inbound step runs at that moment.
async function deliver(DB, mail, receivedMs) {
  await DB.prepare("INSERT INTO inbound_raw (id, received_at, envelope_from, envelope_to, headers, raw) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(`raw${++rawSeq}`, isoAt(receivedMs), "someone@example.com", "replies@aetos-mail.co.uk", mail.headers, mail.raw)
    .run();
  return processInbound(DB, new Date(receivedMs));
}

test("a reply to the test email reaches Nik as an email from an unknown sender, linked to the test mailbox (Perfect when 8)", async () => {
  const mailer = fakeMailer();
  const { DB, id, env } = await withMailbox({ __mailer: mailer });
  assert.equal((await tryMailbox(env, id, { action: "send", to: "nik.test@gmail.com" })).data.ok, true);
  const [sent] = await messages(DB);
  const reply = relayed("gmail-reply.eml", {
    From: "Nik <nik.test@gmail.com>",
    "In-Reply-To": sent.message_id,
    References: sent.message_id,
  });
  assert.deepEqual(await deliver(DB, reply, Date.now()), { unknown_sender: 1 });
  const m = await DB.prepare("SELECT * FROM messages WHERE direction = 'in'").first();
  assert.equal(m.class, "human");
  assert.equal(m.needs_reply, 0);
  assert.equal(m.place_id, null);
  assert.equal(m.mailbox_id, id);
  const todo = await DB.prepare("SELECT title FROM todos WHERE kind = 'escalation' AND status = 'open'").first();
  assert.equal(todo.title, "Email from unknown sender: nik.test@gmail.com");
});

test("Resume restarts the bounce count: the 2 bounces before it don't count, so one more doesn't pause it again", async () => {
  const { DB, id, env } = await withMailbox();
  // An email from this mailbox that bounces (the DSN fixture reports <orig@aetoswebsites.com> to nobody@x.com).
  await DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, kind, author, to_addr, from_addr, subject, body, message_id, status, sent_at, created_at)
     VALUES ('out1', ?, 'out', 'system', 'system', 'nobody@x.com', 'nik@aetoswebsites.com', 'Aetos test email', 'x', '<orig@aetoswebsites.com>', 'sent', ?, ?)`,
  ).bind(id, isoAt(Date.now() - 3 * 3600000), isoAt(Date.now() - 3 * 3600000)).run();
  const dsn = (n) => relayed("dsn-gmail.eml", { "Message-ID": `<dsn-${n}@mx.google.com>` });

  assert.deepEqual(await deliver(DB, dsn(1), Date.now() - 2 * 3600000), { bounce: 1 });
  assert.deepEqual(await deliver(DB, dsn(2), Date.now() - 3600000), { bounce: 1 });
  const paused = await mailboxRow(DB, id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.paused_reason, "2 emails bounced in 7 days (last: nobody@x.com). Check your addresses are real, then press Resume.");

  const r = await patch(env, id, { status: "active" });
  assert.equal(r.status, 200, r.text);
  const resumedAt = Date.parse(await setting(DB, `mailbox:${id}:resumed_at`));
  assert.ok(!Number.isNaN(resumedAt));

  // Without the Resume time, this third bounce would make 3 in 7 days and pause it straight away.
  assert.deepEqual(await deliver(DB, dsn(3), resumedAt + 60000), { bounce: 1 });
  const after = await mailboxRow(DB, id);
  assert.equal(after.status, "active");
  assert.equal(after.paused_reason, null);

  // A second bounce after the Resume pauses it again, as it should.
  assert.deepEqual(await deliver(DB, dsn(4), resumedAt + 120000), { bounce: 1 });
  assert.equal((await mailboxRow(DB, id)).status, "paused");
});
