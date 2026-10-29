// Client site enquiries (09-build.md Task 16): notifyLead emails the business from the system mailbox (no todo when
// there's no mailbox), and handleContact runs section 9's checks: honeypot, too-fast posts, 5 an hour per visitor,
// plain-English errors with the form refilled, CR/LF stripped before anything is stored or emailed.
// Run: node --test control-room/tests/sites-contact.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleContact } from "../functions/_lib/sites/contact.js";
import { getSite } from "../functions/_lib/sites/db.js";
import { notifyLead } from "../functions/_lib/sites/notify.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-19T10:00:00Z"); // Mon 11:00 UK (BST)
const IP = "203.0.113.45";
const URL_CONTACT = "https://www.smithroofing.co.uk/s/contact";
const CONTENT = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const FORM = {
  business: {
    name: "Smith Roofing", phone: "01793 123456", email: "info@smithroofing.co.uk", address: "12 High St, Swindon",
    show_address: "no", legal_line: "John Smith trading as Smith Roofing", leads_email: "leads@smithroofing.co.uk",
  },
  services: [{ name: "Roof repairs", on: true, own: false }],
  areas: ["Swindon", "Wroughton", "Old Town"],
};

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const all = async (DB, sql) => (await DB.prepare(sql).all()).results;

async function setup({ mailbox = true } = {}) {
  const DB = fakeD1();
  const at = "2026-10-10T09:00:00Z";
  await insert(DB, "clients", {
    id: "c1", name: "Smith Roofing", place_id: "p1", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-10", created_at: at,
  });
  await insert(DB, "onboarding", {
    client_id: "c1", token: "T".repeat(32), status: "live", form: JSON.stringify(FORM), submitted_at: at,
    due_live_at: "2026-10-17T09:00:00Z", live_at: "2026-10-15T09:00:00Z", created_at: at,
  });
  await insert(DB, "client_sites", {
    client_id: "c1", slug: "smith-roofing-abc123", place_id: "p1", host: "www.smithroofing.co.uk",
    content: JSON.stringify(CONTENT), status: "live", domain: "{}", live_at: "2026-10-15T09:00:00Z",
    created_at: at, updated_at: at,
  });
  if (mailbox) {
    await insert(DB, "mailboxes", {
      id: "mb-sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system",
      started_on: "2026-01-01", status: "active", created_at: at,
    });
  }
  return { DB, env: { DB }, site: await getSite(DB, "c1") };
}

function post(fields, ip = IP) {
  return new Request(URL_CONTACT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: new URLSearchParams(fields).toString(),
  });
}

const VALID = { name: "Dave", phone: "07700900123", message: "Leak" };

test("notifyLead with no mailbox: nothing queued, no todo, notified_at stays NULL", async () => {
  const { DB, site } = await setup({ mailbox: false });
  await insert(DB, "site_leads", {
    id: "l1", client_id: "c1", source: "chat", name: "Dave", phone: "07700900123", message: "Visitor: leak",
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  });
  const lead = (await all(DB, "SELECT * FROM site_leads WHERE id = 'l1'"))[0];
  const result = await notifyLead(DB, lead, site, NOW);
  assert.deepEqual(result, { queued: false });
  assert.equal((await all(DB, "SELECT * FROM messages")).length, 0);
  const todos = await all(DB, "SELECT dedupe FROM todos");
  assert.equal(todos.length, 0, JSON.stringify(todos));
  assert.ok(!todos.some((t) => /^setup:(welcome|client-mail):/.test(t.dedupe ?? "")));
  const after = (await all(DB, "SELECT notified_at, message_id FROM site_leads WHERE id = 'l1'"))[0];
  assert.equal(after.notified_at, null);
  assert.equal(after.message_id, null);
});

test("notifyLead: queues the enquiry email once, sets notified_at and message_id", async () => {
  const { DB, site } = await setup();
  await insert(DB, "site_leads", {
    id: "l2", client_id: "c1", source: "chat", name: "Dave", phone: "07700900123",
    message: "Visitor: my roof leaks\nAssistant: Thanks", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  });
  const lead = (await all(DB, "SELECT * FROM site_leads WHERE id = 'l2'"))[0];
  assert.deepEqual(await notifyLead(DB, lead, site, NOW), { queued: true });
  const msgs = await all(DB, "SELECT * FROM messages");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, "system");
  assert.equal(msgs[0].author, "system");
  assert.equal(msgs[0].client_id, "c1");
  assert.equal(msgs[0].mailbox_id, "mb-sys");
  assert.equal(msgs[0].to_addr, "leads@smithroofing.co.uk");
  assert.ok(msgs[0].body.includes("Visitor: my roof leaks"));
  const after = (await all(DB, "SELECT notified_at, message_id FROM site_leads WHERE id = 'l2'"))[0];
  assert.equal(after.notified_at, "2026-10-19T10:00:00Z");
  assert.equal(after.message_id, msgs[0].id);
  // A second call for the same lead (already notified, or a race) never queues a second email.
  assert.deepEqual(await notifyLead(DB, lead, site, NOW), { queued: false });
  assert.equal((await all(DB, "SELECT * FROM messages")).length, 1);
});

test("valid POST → 303 /contact?sent=1, one form lead, one system email to leads_email", async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post(VALID), env, site, NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/contact?sent=1");
  assert.equal(res.headers.get("set-cookie"), null);
  const leads = await all(DB, "SELECT * FROM site_leads");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, "form");
  assert.equal(leads[0].client_id, "c1");
  assert.equal(leads[0].name, "Dave");
  assert.equal(leads[0].phone, "07700900123");
  assert.equal(leads[0].message, "Leak");
  assert.equal(leads[0].session, null);
  const msgs = await all(DB, "SELECT * FROM messages");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, "system");
  assert.equal(msgs[0].to_addr, "leads@smithroofing.co.uk");
  assert.equal(msgs[0].subject, "New enquiry from your website: Dave");
  assert.equal(leads[0].notified_at, "2026-10-19T10:00:00Z");
  assert.equal(leads[0].message_id, msgs[0].id);
  // No raw IP is stored anywhere.
  const rate = await all(DB, "SELECT * FROM rate_hits");
  assert.equal(rate.length, 1);
  assert.match(rate[0].key, /^form:c1:[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(await all(DB, "SELECT * FROM site_leads")).includes(IP));
});

test("valid POST with waitUntil sends the enquiry email straight away (system mail only, one email)", async () => {
  const { DB, env, site } = await setup();
  const waits = [];
  const calls = [];
  const res = await handleContact(post(VALID), env, site, NOW, {
    waitUntil: (p) => waits.push(p),
    dispatch: async (...args) => { calls.push(args); return { sent: 1, failed: 0, held: 0 }; },
  });
  assert.equal(res.status, 303);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], DB);
  assert.equal(calls[0][1], env);
  assert.equal(calls[0][2], NOW);
  // It never takes the tick's lease or stamps tick:last (a public form must not keep the cron tick turned away).
  assert.equal((await all(DB, "SELECT * FROM settings WHERE key LIKE 'tick:%'")).length, 0);
  // A failed send never changes the answer.
  const bad = await handleContact(post(VALID), env, site, NOW, {
    waitUntil: (p) => waits.push(p),
    dispatch: async () => { throw new Error("SMTP down"); },
  });
  assert.equal(bad.status, 303);
  await Promise.all(waits);
});

test("the default send runs the outbox for system mail: held with no mailbox password, nothing thrown", async () => {
  const { DB, env, site } = await setup();
  const waits = [];
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    const res = await handleContact(post(VALID), env, site, NOW, { waitUntil: (p) => waits.push(p) });
    assert.equal(res.status, 303);
    assert.equal(waits.length, 1);
    await Promise.all(waits);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(errors, []);
  const msg = (await all(DB, "SELECT status FROM messages"))[0];
  assert.equal(msg.status, "queued"); // no password saved yet: held for the tick's send step
});

test("no mailbox at all: the enquiry is still stored, nothing queued, nothing sent, no todo", async () => {
  const { DB, env, site } = await setup({ mailbox: false });
  const waits = [];
  const res = await handleContact(post(VALID), env, site, NOW, { waitUntil: (p) => waits.push(p) });
  assert.equal(res.status, 303);
  assert.equal(waits.length, 0);
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 1);
  assert.equal((await all(DB, "SELECT * FROM messages")).length, 0);
  assert.equal((await all(DB, "SELECT * FROM todos")).length, 0);
});

test("an email that can't be queued still gives the thanks page (the enquiry is saved)", async () => {
  const { DB, env, site } = await setup();
  const broken = {
    prepare(sql) {
      if (/FROM mailboxes/.test(sql)) throw new Error("D1 is having a moment");
      return DB.prepare(sql);
    },
  };
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    const res = await handleContact(post(VALID), { DB: broken }, site, NOW);
    assert.equal(res.status, 303);
  } finally {
    console.error = orig;
  }
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 1);
  assert.equal(errors.length, 1);
});

test("on the temporary link (base /w/<slug>) the thanks redirect and the refilled form stay under it", async () => {
  const { env, site } = await setup();
  const base = "/w/smith-roofing-abc123";
  const ok = await handleContact(post(VALID), env, site, NOW, { base });
  assert.equal(ok.headers.get("location"), `${base}/contact?sent=1`);
  const bot = await handleContact(post({ ...VALID, website: "x" }), env, site, NOW, { base });
  assert.equal(bot.headers.get("location"), `${base}/contact?sent=1`);
  const bad = await (await handleContact(post({ name: "Dave" }), env, site, NOW, { base })).text();
  assert.ok(bad.includes(`action="${base}/s/contact"`));
  // A base that isn't a plain path is ignored.
  const odd = await handleContact(post(VALID), env, site, NOW, { base: "//evil.example" });
  assert.equal(odd.headers.get("location"), "/contact?sent=1");
});

test("honeypot website=x → 303 and no rows", async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post({ ...VALID, website: "x" }), env, site, NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/contact?sent=1");
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 0);
  assert.equal((await all(DB, "SELECT * FROM messages")).length, 0);
  assert.equal((await all(DB, "SELECT * FROM rate_hits")).length, 0); // checked before the rate limit
});

test("t=1200 (sent too fast) → 303 and no rows", async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post({ ...VALID, t: "1200" }), env, site, NOW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/contact?sent=1");
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 0);
  assert.equal((await all(DB, "SELECT * FROM messages")).length, 0);
  // A human-speed post (t ≥ 3000) goes through.
  const ok = await handleContact(post({ ...VALID, t: "4500" }), env, site, NOW);
  assert.equal(ok.status, 303);
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 1);
});

test("no phone and no email → 400, the error and the name refilled (escaped)", async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post({ name: "Dave <b>", message: "Leak & drip" }), env, site, NOW);
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  const html = await res.text();
  assert.ok(html.includes("Please add a phone number or an email so Smith Roofing can reply."), html);
  assert.ok(html.includes('value="Dave &lt;b&gt;"'), html);
  assert.ok(!html.includes("<b>"));
  assert.ok(html.includes("Leak &amp; drip"));
  assert.ok(html.includes('name="website"'));
  assert.ok(html.includes('action="/s/contact"'));
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 0);
  assert.equal((await all(DB, "SELECT * FROM messages")).length, 0);
});

test("other invalid posts: no name, bad email, message over 2,000 characters", async () => {
  const { env, site } = await setup();
  const noName = await (await handleContact(post({ phone: "07700900123" }), env, site, NOW)).text();
  assert.ok(noName.includes("Please add your name."));
  const badEmail = await handleContact(post({ name: "Dave", email: "dave@", phone: "07700900123" }), env, site, NOW);
  assert.equal(badEmail.status, 400);
  assert.ok((await badEmail.text()).includes("That email doesn&#39;t look right."));
  const long = await handleContact(post({ name: "Dave", phone: "07700900123", message: "x".repeat(2001) }), env, site, NOW);
  assert.equal(long.status, 400);
  assert.ok((await long.text()).includes("Please keep your message under 2,000 characters."));
});

test("an email alone is enough to reply", async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post({ name: "Dave", email: "dave@example.com", message: "Leak" }), env, site, NOW);
  assert.equal(res.status, 303);
  const lead = (await all(DB, "SELECT * FROM site_leads"))[0];
  assert.equal(lead.email, "dave@example.com");
  assert.equal(lead.phone, null);
});

test("6th POST in the hour from one IP → 429 with the phone number", async () => {
  const { DB, env, site } = await setup();
  for (let i = 0; i < 5; i++) {
    const res = await handleContact(post(VALID), env, site, NOW);
    assert.equal(res.status, 303, `post ${i + 1}`);
  }
  const res = await handleContact(post(VALID), env, site, NOW);
  assert.equal(res.status, 429);
  const html = await res.text();
  assert.ok(html.includes("Too many messages from this connection. Please call 01793 123456 instead."), html);
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 5);
  // Another connection is unaffected.
  const other = await handleContact(post(VALID, "198.51.100.7"), env, site, NOW);
  assert.equal(other.status, 303);
});

test('name "Dave\\r\\nBcc: x" is stored and emailed without CR/LF', async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post({ ...VALID, name: "Dave\r\nBcc: x" }), env, site, NOW);
  assert.equal(res.status, 303);
  const lead = (await all(DB, "SELECT * FROM site_leads"))[0];
  assert.ok(!/[\r\n]/.test(lead.name), JSON.stringify(lead.name));
  assert.ok(lead.name.startsWith("Dave"));
  const msg = (await all(DB, "SELECT * FROM messages"))[0];
  assert.ok(!/[\r\n]/.test(msg.subject), JSON.stringify(msg.subject));
  assert.ok(msg.subject.startsWith("New enquiry from your website: Dave"));
  const nameLine = msg.body.split("\n").find((l) => l.startsWith("Name: "));
  assert.equal(nameLine, `Name: ${lead.name}`);
  assert.ok(!msg.body.split("\n").some((l) => l.startsWith("Bcc:")));
});

test("control and bidi characters are taken out of every field", async () => {
  const { DB, env, site } = await setup();
  const res = await handleContact(post({
    name: "Da\u202Eve\u0000", phone: "07700\u0007900123", message: "Leak\u202E\r\nsecond line\u0001",
  }), env, site, NOW);
  assert.equal(res.status, 303);
  const lead = (await all(DB, "SELECT * FROM site_leads"))[0];
  assert.equal(lead.name, "Dave");
  assert.equal(lead.phone, "07700900123");
  assert.equal(lead.message, "Leak\nsecond line");
});

test("the page field is kept when it's a path; anything else is dropped", async () => {
  const { DB, env, site } = await setup();
  await handleContact(post({ ...VALID, page: "/services/roof-repairs" }), env, site, NOW);
  await handleContact(post({ ...VALID, page: "https://evil.example/x" }), env, site, NOW);
  const pages = (await all(DB, "SELECT page FROM site_leads ORDER BY created_at, rowid")).map((r) => r.page);
  assert.deepEqual(pages, ["/services/roof-repairs", null]);
  const msg = (await all(DB, "SELECT body FROM messages ORDER BY rowid"))[0];
  assert.ok(msg.body.startsWith("Dave sent this from /services/roof-repairs on Mon 19 Oct, 11:00:"), msg.body);
});

test("a site that isn't live takes no posts; GET is refused", async () => {
  const { DB, env, site } = await setup();
  const off = await handleContact(post(VALID), env, { ...site, status: "off" }, NOW);
  assert.equal(off.status, 404);
  const get = await handleContact(new Request(URL_CONTACT), env, site, NOW);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 0);
});

// A chunked body with no Content-Length (regression): it used to be read to the end by request.formData().
function chunkedPost(chunks, onCancel) {
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() { onCancel?.(); },
  });
  return {
    pulled: () => i,
    request: new Request(URL_CONTACT, {
      method: "POST", body: stream, duplex: "half",
      headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": IP },
    }),
  };
}

test("a chunked contact body with no Content-Length over 64 KB → 413, the stream cancelled, no rows", async () => {
  const { DB, env, site } = await setup();
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1024));
  const { request, pulled } = chunkedPost(Array.from({ length: 1000 }, () => chunk), () => { cancelled = true; });
  assert.equal(request.headers.get("content-length"), null);
  const res = await handleContact(request, env, site, NOW);
  assert.equal(res.status, 413);
  assert.ok((await res.text()).includes("Please keep your message under 2,000 characters."));
  assert.ok(pulled() <= 64 + 3, `stopped reading after the limit (read ${pulled()} chunks)`);
  assert.equal(cancelled, true);
  assert.equal((await all(DB, "SELECT * FROM site_leads")).length, 0);
});

test("a chunked contact body under the limit is still read as the form", async () => {
  const { DB, env, site } = await setup();
  const text = new URLSearchParams(VALID).toString();
  const enc = new TextEncoder();
  const { request } = chunkedPost([enc.encode(text.slice(0, 10)), enc.encode(text.slice(10))]);
  const res = await handleContact(request, env, site, NOW);
  assert.equal(res.status, 303);
  const leads = await all(DB, "SELECT * FROM site_leads");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, "07700900123");
});
