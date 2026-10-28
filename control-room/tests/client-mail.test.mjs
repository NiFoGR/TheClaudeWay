// Client emails: the welcome and payment-failed copy (pure), and sendClientMail picking the mailbox (system first,
// else the cold one with most room left, else a setup todo carrying the email as its draft).
// Run: node --test control-room/tests/client-mail.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  WELCOME_TODO, paymentFailedEmail, sendClientMail, senderName, systemMailbox, welcomeEmail,
} from "../functions/_lib/client-mail.js";
import { termsFor } from "../functions/_lib/offer.js";
import { setSetting } from "../functions/_lib/settings.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-19T10:00:00Z"); // Mon 11:00 UK (BST)
const ONBOARD = "https://x.test/onboard/T";

const MAILBOX = {
  address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-01-01",
  cap_override: null, status: "active", paused_reason: null, created_at: "2026-01-01T09:00:00Z",
};

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const addMailbox = (DB, row) => insert(DB, "mailboxes", { ...MAILBOX, ...row });
const all = async (DB, sql) => (await DB.prepare(sql).all()).results;

const welcome = (signName) => welcomeEmail({
  business: "Smith Roofing", greetName: "Mark", terms: termsFor("full", false), amountPaid: 195000,
  onboardUrl: ONBOARD, firstChargeOn: "2026-12-18", signName,
});

const send = (DB, extra = {}) => sendClientMail(DB, {
  client_id: "c1", place_id: "p1", to: "mark@smithroofing.co.uk", business: "Smith Roofing", compose: welcome,
  now: NOW, ...extra,
});

test("welcome full", () => {
  const { subject, body } = welcome("Nik P");
  assert.equal(subject, "Smith Roofing: your onboarding form");
  assert.ok(body.startsWith("Hi Mark,\n\nThanks for ordering. Your payment of £1,950 has gone through."), body);
  assert.ok(body.includes("https://x.test/onboard/T"));
  assert.ok(body.includes(
    "Your first 60 days of the monthly plan are free. The first £249 is taken on Friday 18 December 2026",
  ));
  assert.ok(body.endsWith("Nik P\nAetos Websites"), body);
  // Part A's text, line for line.
  assert.equal(body, [
    "Hi Mark,",
    "",
    "Thanks for ordering. Your payment of £1,950 has gone through.",
    "",
    "Next step: fill in this short form. It asks for your logo, photos, services and the areas you cover.",
    "",
    "https://x.test/onboard/T",
    "",
    "Your 7 days start when the form is complete, and your website will be live within 7 days of that. GUARANTEED.",
    "",
    "Your first 60 days of the monthly plan are free. The first £249 is taken on Friday 18 December 2026 from the card you used, then monthly. You can stop any time by replying to this email.",
    "",
    "Any questions, just reply.",
    "",
    "Nik P",
    "Aetos Websites",
  ].join("\n"));
});

test("welcome weekend: 90 free days, £1,750 paid", () => {
  const { body } = welcomeEmail({
    business: "Smith Roofing", greetName: "Mark", terms: termsFor("full", true), amountPaid: 175000,
    onboardUrl: ONBOARD, firstChargeOn: "2027-01-16", signName: "Nik",
  });
  assert.ok(body.includes("Your payment of £1,750 has gone through."));
  assert.ok(body.includes("Your first 90 days of the monthly plan are free. The first £249 is taken on Saturday 16 January 2027"));
});

test("welcome website, no name", () => {
  const { subject, body } = welcomeEmail({
    business: "Smith Roofing", greetName: null, terms: termsFor("website", false), amountPaid: 175000,
    onboardUrl: ONBOARD, firstChargeOn: null, signName: "Nik",
  });
  assert.equal(subject, "Smith Roofing: your onboarding form");
  assert.ok(body.startsWith("Hi,\n\n"), body);
  assert.ok(!body.includes("monthly plan"));
  assert.ok(body.includes("Your payment of £1,750 has gone through."));
  assert.ok(body.includes(ONBOARD));
  assert.ok(body.endsWith("Any questions, just reply.\n\nNik\nAetos Websites"), body);
});

test("welcome: a blank greet name says Hi, and a name never breaks a line", () => {
  const { subject, body } = welcomeEmail({
    business: "Smith\r\nRoofing", greetName: "  ", terms: termsFor("website", false), amountPaid: 175000,
    onboardUrl: ONBOARD, signName: "Nik",
  });
  assert.equal(subject, "Smith Roofing: your onboarding form");
  assert.ok(body.startsWith("Hi,\n\n"));
});

test("welcome: refuses an onboarding link that isn't a web address", () => {
  assert.throws(() => welcomeEmail({
    business: "Smith Roofing", greetName: "Mark", terms: termsFor("website", false), amountPaid: 175000,
    onboardUrl: "javascript:alert(1)", signName: "Nik",
  }), /onboarding link/);
});

test("failed email", () => {
  const { subject, body } = paymentFailedEmail({
    business: "Smith Roofing", greetName: "Mark", amountDue: 24900, payUrl: "https://invoice.stripe.com/i/acct_1/test_X",
    signName: "Nik P",
  });
  assert.equal(subject, "Your Aetos Websites payment didn't go through");
  assert.ok(body.includes("Your monthly payment of £249 for Smith Roofing didn't go through."));
  assert.ok(body.split("\n").includes("https://invoice.stripe.com/i/acct_1/test_X"), "pay URL on its own line");
  assert.equal(body, [
    "Hi Mark,",
    "",
    "Your monthly payment of £249 for Smith Roofing didn't go through. This usually means a card has expired or been replaced.",
    "",
    "You can pay or change your card here:",
    "https://invoice.stripe.com/i/acct_1/test_X",
    "",
    "Stripe will try the card again over the next few days. If you'd rather stop the monthly plan, just reply and I'll sort it. You keep your website either way.",
    "",
    "Thanks,",
    "Nik P",
    "Aetos Websites",
  ].join("\n"));
});

test("failed email: no name says Hi,", () => {
  const { body } = paymentFailedEmail({
    business: "Smith Roofing", greetName: null, amountDue: 24900, payUrl: "https://invoice.stripe.com/i/x", signName: "Nik",
  });
  assert.ok(body.startsWith("Hi,\n\nYour monthly payment of £249 for Smith Roofing"));
});

test("uses the system mailbox", async () => {
  const DB = fakeD1();
  await addMailbox(DB, { id: "sys", address: "hello@aetoswebsites.com", display_name: "Aetos Team", role: "system" });
  await addMailbox(DB, { id: "cold1", address: "nik@aetoswebsites.com" });
  await setSetting(DB, "business:sender_name", "Nik P");

  const got = await send(DB);
  assert.equal(got.fallback, false);
  const rows = await all(DB, "SELECT * FROM messages");
  assert.equal(rows.length, 1);
  const [m] = rows;
  assert.equal(got.queued, m.id);
  assert.equal(m.kind, "system");
  assert.equal(m.author, "system");
  assert.equal(m.direction, "out");
  assert.equal(m.status, "queued");
  assert.equal(m.mailbox_id, "sys");
  assert.equal(m.client_id, "c1");
  assert.equal(m.place_id, "p1");
  assert.equal(m.to_addr, "mark@smithroofing.co.uk");
  assert.equal(m.from_addr, "hello@aetoswebsites.com");
  assert.equal(m.subject, "Smith Roofing: your onboarding form");
  assert.equal(m.due_at, "2026-10-19T10:00:00Z");
  assert.ok(m.body.endsWith("Nik P\nAetos Websites"), m.body);
  assert.ok(!m.body.includes("Aetos Team"));
  assert.deepEqual(await all(DB, "SELECT * FROM todos"), []);
});

test("sign-off fallback", async () => {
  const DB = fakeD1();
  assert.equal(await senderName(DB), "Nik");
  await setSetting(DB, "business:sender_name", "   ");
  assert.equal(await senderName(DB), "Nik");
  await setSetting(DB, "business:sender_name", "Nikiforos");
  assert.equal(await senderName(DB), "Nikiforos");
});

test("falls back to cold", async () => {
  const DB = fakeD1();
  await addMailbox(DB, { id: "cold1" });
  const got = await send(DB);
  assert.equal(got.fallback, true);
  const [m] = await all(DB, "SELECT * FROM messages");
  assert.equal(m.mailbox_id, "cold1");
  assert.equal(got.queued, m.id);
  assert.ok(m.body.endsWith("Nik\nAetos Websites"));
  const todos = await all(DB, "SELECT * FROM todos");
  assert.equal(todos.length, 1);
  assert.equal(todos[0].dedupe, "setup:system_mailbox");
  assert.equal(todos[0].kind, "setup");
  assert.equal(todos[0].title, "Add a system mailbox for client emails (welcome emails are going from a cold mailbox)");
  assert.equal(todos[0].link, "/#/setup");
  // A second client email from the cold mailbox adds no second todo.
  await send(DB, { client_id: "c2" });
  assert.equal((await all(DB, "SELECT * FROM todos")).length, 1);
});

test("falls back to the cold mailbox with most room left, even when none has room", async () => {
  const DB = fakeD1();
  await addMailbox(DB, { id: "cold1", address: "a@aetoswebsites.com", cap_override: 10 });
  await addMailbox(DB, { id: "cold2", address: "b@aetoswebsites.com", cap_override: 10 });
  for (let i = 0; i < 3; i++) {
    await insert(DB, "messages", {
      id: `s${i}`, mailbox_id: "cold1", direction: "out", kind: "first", author: "nik", to_addr: "x@y.com",
      body: "x", status: "sent", sent_at: "2026-10-19T09:00:00Z", created_at: "2026-10-19T09:00:00Z",
    });
  }
  assert.equal((await systemMailbox(DB, NOW)).mailbox.id, "cold2");
  assert.equal((await systemMailbox(DB, NOW)).fallback, true);

  // Warming up (cap 0 for both): client mail doesn't count against cold caps, so it still goes, ties by id.
  const warm = fakeD1();
  await addMailbox(warm, { id: "cold2", address: "b@aetoswebsites.com", started_on: "2026-10-15" });
  await addMailbox(warm, { id: "cold1", address: "a@aetoswebsites.com", started_on: "2026-10-15" });
  assert.equal((await systemMailbox(warm, NOW)).mailbox.id, "cold1");
});

test("no mailbox", async () => {
  const DB = fakeD1();
  assert.equal(await systemMailbox(DB, NOW), null);
  const got = await send(DB);
  assert.deepEqual(got, { queued: null, fallback: false });
  assert.deepEqual(await all(DB, "SELECT * FROM messages"), []);
  const todos = await all(DB, "SELECT * FROM todos");
  assert.equal(todos.length, 1);
  const [t] = todos;
  assert.equal(t.dedupe, "setup:welcome:c1");
  assert.equal(t.kind, "setup");
  assert.equal(t.title, "Send Smith Roofing their onboarding link yourself (no mailbox yet)");
  assert.equal(t.link, "/#/money");
  assert.equal(t.client_id, "c1");
  assert.equal(t.place_id, "p1");
  assert.ok(t.draft.includes("https://x.test/onboard/T"));
  assert.ok(t.draft.endsWith("Nik\nAetos Websites"));
  // the Todo board shows a setup todo's detail (not its draft): the whole email is there, link included
  assert.equal(t.detail, `To: mark@smithroofing.co.uk\nSubject: Smith Roofing: your onboarding form\n\n${t.draft}`);
  assert.ok(t.detail.includes("https://x.test/onboard/T"));
  assert.equal(WELCOME_TODO.title, "Send {name} their onboarding link yourself (no mailbox yet)");
});

test("an id given is the message's id", async () => {
  const DB = fakeD1();
  await addMailbox(DB, { id: "sys", address: "hello@aetoswebsites.com", role: "system" });
  const got = await send(DB, { id: "welcome:c1" });
  assert.equal(got.queued, "welcome:c1");
  assert.deepEqual((await all(DB, "SELECT id FROM messages")).map((m) => m.id), ["welcome:c1"]);
  // the same id again is D1's primary-key error (the caller treats it as "already queued")
  await assert.rejects(() => send(DB, { id: "welcome:c1" }), /UNIQUE constraint failed: messages\.id/);
});

test("no mailbox, other email", async () => {
  const DB = fakeD1();
  const goLive = () => ({ subject: "Your website is live", body: "Hi Mark,\n\nIt's live.\n\nNik\nAetos Websites" });
  const todo = (kind) => ({ dedupe: `setup:client-mail:c1:${kind}`, title: "Send {name} this email yourself (no mailbox yet)" });
  const got = await send(DB, { compose: goLive, noMailboxTodo: todo("go-live") });
  assert.equal(got.queued, null);
  let todos = await all(DB, "SELECT * FROM todos ORDER BY dedupe");
  assert.equal(todos.length, 1);
  assert.equal(todos[0].dedupe, "setup:client-mail:c1:go-live");
  assert.equal(todos[0].title, "Send Smith Roofing this email yourself (no mailbox yet)");
  assert.equal(todos[0].draft, goLive().body);
  assert.equal(todos[0].link, "/#/money");
  assert.equal((await all(DB, "SELECT * FROM todos WHERE dedupe = 'setup:welcome:c1'")).length, 0);

  await send(DB, { compose: goLive, noMailboxTodo: { ...todo("domain-cname"), link: "/#/site/c1" } });
  todos = await all(DB, "SELECT * FROM todos ORDER BY dedupe");
  assert.deepEqual(todos.map((t) => t.dedupe), ["setup:client-mail:c1:domain-cname", "setup:client-mail:c1:go-live"]);
  assert.equal(todos[0].link, "/#/site/c1");
  assert.deepEqual(await all(DB, "SELECT * FROM messages"), []);
});

test("no mailbox, no todo", async () => {
  const DB = fakeD1();
  const got = await send(DB, { noMailboxTodo: null });
  assert.deepEqual(got, { queued: null, fallback: false });
  assert.deepEqual(await all(DB, "SELECT * FROM messages"), []);
  assert.deepEqual(await all(DB, "SELECT * FROM todos"), []);
});

test("paused mailboxes ignored", async () => {
  const DB = fakeD1();
  await addMailbox(DB, { id: "sys", address: "hello@aetoswebsites.com", role: "system", status: "paused", paused_reason: "bounces" });
  assert.equal(await systemMailbox(DB, NOW), null);
  const got = await send(DB);
  assert.deepEqual(got, { queued: null, fallback: false });
  assert.deepEqual(await all(DB, "SELECT * FROM messages"), []);
  const todos = await all(DB, "SELECT * FROM todos");
  assert.deepEqual(todos.map((t) => t.dedupe), ["setup:welcome:c1"]);

  // A paused system mailbox next to an active cold one: the cold one sends, with the setup todo.
  await addMailbox(DB, { id: "cold1" });
  const again = await send(DB, { client_id: "c2" });
  assert.equal(again.fallback, true);
  assert.equal((await all(DB, "SELECT mailbox_id FROM messages"))[0].mailbox_id, "cold1");
});

test("no mailbox: a $ in the business name is printed as written", async () => {
  const DB = fakeD1();
  await send(DB, { business: "Cash $$ Cars $& $' Ltd" });
  const [t] = await all(DB, "SELECT title FROM todos");
  assert.equal(t.title, "Send Cash $$ Cars $& $' Ltd their onboarding link yourself (no mailbox yet)");
});

test("the system mailbox closes the setup:system_mailbox todo the cold fallback filed", async () => {
  const DB = fakeD1();
  await addMailbox(DB, { id: "cold1" });
  await send(DB);
  assert.equal((await all(DB, "SELECT * FROM todos WHERE status = 'open'")).length, 1);
  await addMailbox(DB, { id: "sys", address: "hello@aetoswebsites.com", role: "system" });
  const got = await send(DB, { client_id: "c2" });
  assert.equal(got.fallback, false);
  assert.deepEqual(await all(DB, "SELECT * FROM todos WHERE status = 'open'"), []);
  // Back on a cold mailbox later (system one paused): the todo is filed again.
  await DB.prepare("UPDATE mailboxes SET status = 'paused' WHERE id = 'sys'").run();
  await send(DB, { client_id: "c3" });
  const open = await all(DB, "SELECT dedupe FROM todos WHERE status = 'open'");
  assert.deepEqual(open.map((t) => t.dedupe), ["setup:system_mailbox"]);
});

test("a bad noMailboxTodo or a missing client id throws before anything is written", async () => {
  const DB = fakeD1();
  await assert.rejects(send(DB, { noMailboxTodo: { title: "Send {name} this email yourself (no mailbox yet)" } }), /noMailboxTodo/);
  await assert.rejects(send(DB, { noMailboxTodo: { dedupe: "", title: "x" } }), /noMailboxTodo/);
  await assert.rejects(send(DB, { client_id: null }), /client_id/);
  await assert.rejects(send(DB, { to: "  " }), /email address/);
  await assert.rejects(send(DB, { compose: null }), /compose/);
  assert.deepEqual(await all(DB, "SELECT * FROM todos"), []);
  assert.deepEqual(await all(DB, "SELECT * FROM messages"), []);
  // null client_id is fine when the caller's own todo doesn't need it, and when there's no todo at all.
  assert.deepEqual(await send(DB, { client_id: null, noMailboxTodo: null }), { queued: null, fallback: false });
});
