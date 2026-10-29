// Tick step `sites` (09-build.md Task 26, sections 7, 12 and 14): DNS checks (at most 5 hosts a run, each at most
// every 15 minutes until live, then once a day), going live and the go-live email (once), the ns_wait step, the
// due and stuck todos, chat-lead emails once the chat has been quiet for 10 minutes, and pruning rate_hits.
// Run: node --test control-room/tests/sites-tick.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { HOST_CHECK_FAILED } from "../functions/_lib/sites/dns.js";
import { checkSite, sitesStep } from "../functions/_lib/sites/tick.js";
import { STEPS } from "../functions/_lib/tick.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date("2026-10-28T10:00:00Z"); // Wed 10:00 UK (GMT)
const ago = (ms, from = NOW) => new Date(from.getTime() - ms);
const later = (ms, from = NOW) => new Date(from.getTime() + ms);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const HOST = "www.smithroofing.co.uk";
const PAGES = "goldbarwebsites.pages.dev";
const CONTENT = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const FORM = {
  business: {
    name: "Smith Roofing", phone: "01793 123456", email: "info@smithroofing.co.uk", address: "12 High St, Swindon",
    show_address: "no", legal_line: "John Smith trading as Smith Roofing", leads_email: "leads@smithroofing.co.uk",
  },
  services: [{ name: "Roof repairs", on: true, own: false }],
  areas: ["Swindon", "Wroughton"],
};

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const siteOf = async (DB, id = "c1") => {
  const row = await one(DB, "SELECT * FROM client_sites WHERE client_id = ?", id);
  return { ...row, host_check: row.host_check ? JSON.parse(row.host_check) : null, domain: JSON.parse(row.domain) };
};
const todo = (DB, dedupe) => one(DB, "SELECT * FROM todos WHERE dedupe = ? OR dedupe LIKE ? || '@%'", dedupe, dedupe);
const openTodo = (DB, dedupe) => one(DB, "SELECT * FROM todos WHERE dedupe = ? AND status = 'open'", dedupe);
const addTodoRow = (DB, dedupe, title = dedupe) =>
  insert(DB, "todos", { id: dedupe, kind: "build", client_id: "c1", title, dedupe, status: "open", created_at: iso(ago(HOUR)) });

/**
 * One client (Smith Roofing, Full Package) with a site, an onboarding row, a checkout email and a confident first
 * name. `site` and `onboarding` override the rows; mailbox false = no mailbox at all.
 */
async function setup({ site = {}, onboarding = {}, mailbox = true, pagesHost = PAGES } = {}) {
  const DB = fakeD1();
  const at = "2026-10-20T09:00:00Z";
  await addClient(DB, "c1", "Smith Roofing", { site: { host: HOST, ...site }, onboarding });
  await insert(DB, "client_links", { client_id: "c1", stripe_customer: "cus_1", email: "john@smithroofing.co.uk" });
  await insert(DB, "prospects", {
    place_id: "p-c1", stage: "won", stage_at: at, email: "info@smithroofing.co.uk", greet_name: "John", created_at: at, updated_at: at,
  });
  if (pagesHost) await insert(DB, "settings", { key: "sites:pages_host", value: pagesHost });
  if (mailbox) {
    await insert(DB, "mailboxes", {
      id: "mb-sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-01-01",
      status: "active", created_at: at,
    });
  }
  return DB;
}

async function addClient(DB, id, name, { site = {}, onboarding = {} } = {}) {
  const at = "2026-10-20T09:00:00Z";
  await insert(DB, "clients", {
    id, name, place_id: `p-${id}`, package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-20", created_at: at,
  });
  await insert(DB, "onboarding", {
    client_id: id, token: `${id}-`.padEnd(32, "t"), status: "review", form: JSON.stringify(FORM),
    submitted_at: "2026-10-24T22:30:00Z", due_live_at: "2026-10-31T22:30:00Z", created_at: at, ...onboarding,
  });
  await insert(DB, "client_sites", {
    client_id: id, slug: `${id}-site-abc123`, place_id: `p-${id}`, content: JSON.stringify(CONTENT), status: "live",
    domain: "{}", review_url: "https://search.google.com/local/writereview?placeid=p1", approved_at: at,
    content_at: at, created_at: at, updated_at: at, ...site,
  });
}

// A fake DNS-over-HTTPS: zones = {name: {CNAME: [...], A: [...], NS: [...]}}; a name in `fail` throws. calls = the
// names asked, in order.
function doh(zones = {}, { fail = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://cloudflare-dns.com/dns-query");
    const name = u.searchParams.get("name");
    const type = u.searchParams.get("type");
    calls.push({ name, type });
    if (fail.includes(name)) throw new Error("network down");
    const code = { A: 1, NS: 2, CNAME: 5 };
    const answers = (zones[name]?.[type] ?? []).map((data) => ({ name, type: code[type], data }));
    return new Response(JSON.stringify({ Status: zones[name] ? 0 : 3, Answer: answers }), {
      headers: { "content-type": "application/dns-json" },
    });
  };
  return { fetchImpl, calls, hosts: () => [...new Set(calls.map((c) => c.name))] };
}
const OURS = { [HOST]: { CNAME: [`${PAGES}.`] } };
const OLD = { [HOST]: { A: ["1.2.3.4"] } };

const run = (DB, now, dns, budget) => sitesStep({ DB, env: { DB }, now, budget }, { fetchImpl: dns.fetchImpl });

// --- Task 26, Step 1 ----------------------------------------------------------------------------------------------

test("going live: CNAME to the Pages host + seen_at → live, go-live email once, build todos closed except gbp", async () => {
  const DB = await setup({ site: { seen_at: iso(ago(5 * MIN)) } });
  for (const what of ["approve", "due", "stuck", "photos", "gphotos", "domain:pages", "domain:ns_wait", "gbp"]) {
    await addTodoRow(DB, `build:c1:${what}`);
  }
  await addTodoRow(DB, "build:c10:approve"); // another client's (c10 starts with c1): untouched
  const dns = doh(OURS);
  const summary = await run(DB, NOW, dns);
  assert.match(summary, /^checked 1, live 1, due 0, stuck 0, leads 0/);

  const site = await siteOf(DB);
  assert.equal(site.live_at, iso(NOW));
  assert.equal(site.host_check.ok, true);
  assert.equal(site.host_check.detail, "www.smithroofing.co.uk points at us ✓");
  assert.equal(site.host_check.at, iso(NOW));
  assert.equal(site.host_check.fails, 0);
  const ob = await one(DB, "SELECT * FROM onboarding WHERE client_id = 'c1'");
  assert.equal(ob.live_at, iso(NOW));
  assert.equal(ob.status, "live");
  assert.equal(ob.site_url, "https://www.smithroofing.co.uk/");

  const msgs = await all(DB, "SELECT * FROM messages");
  assert.equal(msgs.length, 1);
  const [m] = msgs;
  assert.equal(m.kind, "system");
  assert.equal(m.author, "system");
  assert.equal(m.client_id, "c1");
  assert.equal(m.to_addr, "john@smithroofing.co.uk"); // client_links.email first
  assert.equal(m.from_addr, "hello@aetoswebsites.com");
  assert.equal(m.subject, "Your website is live: www.smithroofing.co.uk");
  assert.match(m.body, /^Hi John,\n\nYour new website is live: https:\/\/www\.smithroofing\.co\.uk\n\n/);
  assert.match(m.body, /Website enquiries go to leads@smithroofing\.co\.uk\./);
  assert.doesNotMatch(m.body, /chat assistant/); // the chatbot isn't connected
  assert.match(m.body, /https:\/\/www\.smithroofing\.co\.uk\/s\/review-card/); // Full Package with a review URL
  assert.match(m.body, /\n\nNik\nAetos Websites$/);

  for (const what of ["approve", "due", "stuck", "photos", "gphotos", "domain:pages", "domain:ns_wait"]) {
    assert.equal((await todo(DB, `build:c1:${what}`)).status, "done", what);
  }
  assert.equal((await todo(DB, "build:c1:gbp")).status, "open");
  assert.equal((await todo(DB, "build:c10:approve")).status, "open");

  // The next runs queue nothing more: not 20 minutes later (not due a check), not a day later (checked again).
  assert.match(await run(DB, later(20 * MIN), dns), /^checked 0, live 0/);
  assert.match(await run(DB, later(25 * HOUR), dns), /^checked 1, live 0/);
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 1);
  assert.equal((await siteOf(DB)).live_at, iso(NOW));
});

test("DNS ready but nobody has opened the site → not live, host_check.ok true, no email", async () => {
  const DB = await setup();
  await run(DB, NOW, doh(OURS));
  const site = await siteOf(DB);
  assert.equal(site.live_at, null);
  assert.equal(site.host_check.ok, true);
  assert.equal(site.host_check.detail, "www.smithroofing.co.uk points at us ✓");
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "review");
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 0);
});

test("an A record at their old host → plain-English detail, not live", async () => {
  const DB = await setup({ site: { seen_at: iso(ago(HOUR)) } });
  await run(DB, NOW, doh(OLD));
  const site = await siteOf(DB);
  assert.equal(site.host_check.detail, "Not yet: www.smithroofing.co.uk still points at 1.2.3.4 (their old host)");
  assert.equal(site.host_check.ok, false);
  assert.equal(site.host_check.fails, 1);
  assert.equal(site.live_at, null);
});

test("Cloudflare A records count as ours; a host that doesn't exist says so", async () => {
  const DB = await setup({ site: { seen_at: iso(ago(HOUR)) } });
  await run(DB, NOW, doh({ [HOST]: { A: ["104.21.3.4", "172.67.1.1"] } }));
  assert.equal((await siteOf(DB)).live_at, iso(NOW));

  const DB2 = await setup();
  await run(DB2, NOW, doh({}));
  assert.equal((await siteOf(DB2)).host_check.detail, "Not yet: www.smithroofing.co.uk doesn't exist in DNS");
});

test("a host checked 10 minutes ago is skipped; 16 minutes ago it's checked again", async () => {
  const check = (at) => JSON.stringify({ at: iso(at), ok: false, detail: "Not yet: x", fails: 1 });
  const DB = await setup({ site: { host_check: check(ago(10 * MIN)) } });
  const dns = doh(OLD);
  assert.match(await run(DB, NOW, dns), /^checked 0,/);
  assert.equal(dns.calls.length, 0);
  assert.equal((await siteOf(DB)).host_check.at, iso(ago(10 * MIN)));

  const DB2 = await setup({ site: { host_check: check(ago(16 * MIN)) } });
  const dns2 = doh(OLD);
  assert.match(await run(DB2, NOW, dns2), /^checked 1,/);
  assert.deepEqual(dns2.hosts(), [HOST]);
  assert.equal((await siteOf(DB2)).host_check.fails, 2);
});

test("7 hosts → only 5 fetched, never-checked and oldest checks first; the rest next run", async () => {
  const DB = await setup({ site: { host_check: JSON.stringify({ at: iso(ago(20 * MIN)), ok: false, detail: "x", fails: 1 }) } });
  for (let i = 2; i <= 7; i++) {
    const at = i <= 3 ? null : JSON.stringify({ at: iso(ago((60 - i) * MIN)), ok: false, detail: "x", fails: 1 });
    await addClient(DB, `c${i}`, `Client ${i}`, { site: { host: `www.site${i}.co.uk`, host_check: at } });
  }
  const dns = doh({});
  assert.match(await run(DB, NOW, dns), /^checked 5,/);
  // c2, c3 never checked; then c4 (56 min ago), c5 (55), c6 (54); c7 (53) and c1 (20) wait.
  assert.deepEqual(dns.hosts(), ["www.site2.co.uk", "www.site3.co.uk", "www.site4.co.uk", "www.site5.co.uk", "www.site6.co.uk"]);
  const dns2 = doh({});
  assert.match(await run(DB, later(MIN), dns2), /^checked 2,/);
  assert.deepEqual(dns2.hosts(), ["www.site7.co.uk", HOST]);
});

test("sites taken offline, and sites with no host, are never checked", async () => {
  const DB = await setup({ site: { status: "off" } });
  await addClient(DB, "c2", "No Host Yet", { site: { host: null, status: "live" } });
  const dns = doh(OURS);
  assert.match(await run(DB, NOW, dns), /^checked 0,/);
  assert.equal(dns.calls.length, 0);
});

test("NS answers only *.ns.cloudflare.com → domain.steps.ns_wait done and its todo closed", async () => {
  const domain = { mode: "nameservers", domain: "smithroofing.co.uk", steps: { zone: "2026-10-25T10:00:00Z" } };
  const DB = await setup({ site: { status: "review", domain: JSON.stringify(domain) } });
  await addTodoRow(DB, "build:c1:domain:ns_wait");
  await addTodoRow(DB, "build:c1:domain:pages");
  await run(DB, NOW, doh({ "smithroofing.co.uk": { NS: ["ada.ns.cloudflare.com.", "bob.ns.cloudflare.com."] } }));
  const site = await siteOf(DB);
  assert.equal(site.domain.steps.ns_wait, iso(NOW));
  assert.equal(site.domain.steps.zone, "2026-10-25T10:00:00Z");
  assert.equal(site.domain.mode, "nameservers");
  assert.equal((await todo(DB, "build:c1:domain:ns_wait")).status, "done");
  assert.equal((await todo(DB, "build:c1:domain:pages")).status, "open");

  // Their old nameservers → nothing ticked.
  const DB2 = await setup({ site: { domain: JSON.stringify(domain) } });
  await run(DB2, NOW, doh({ "smithroofing.co.uk": { NS: ["ns1.123-reg.co.uk.", "ada.ns.cloudflare.com."] } }));
  assert.equal((await siteOf(DB2)).domain.steps.ns_wait, undefined);

  // Already ticked → no NS lookup at all.
  const DB3 = await setup({ site: { domain: JSON.stringify({ ...domain, steps: { ns_wait: "2026-10-27T10:00:00Z" } }) } });
  const dns3 = doh(OURS);
  await run(DB3, NOW, dns3);
  assert.equal(dns3.calls.some((c) => c.type === "NS"), false);
});

test("due in 47.5 h and not live → build:c1:due names what's missing; the title follows it", async () => {
  const T = new Date("2026-10-29T23:00:00Z"); // due Sat 31 Oct 22:30 UTC: 47.5 h left
  const DB = await setup();
  const summary = await run(DB, T, doh(OLD));
  assert.match(summary, /due 1/);
  const t = await openTodo(DB, "build:c1:due");
  assert.equal(t.title, "Smith Roofing's site is due live Sat and isn't live yet: the domain isn't connected");
  assert.equal(t.kind, "build");
  assert.equal(t.client_id, "c1");
  assert.equal(t.link, "/#/site/c1");
  assert.equal(t.due_at, "2026-10-31T22:30:00Z");

  // DNS fixed but nobody has opened it: the same todo now says so; a run with nothing new changes nothing.
  await run(DB, later(20 * MIN, T), doh(OURS));
  assert.equal((await openTodo(DB, "build:c1:due")).title, "Smith Roofing's site is due live Sat and isn't live yet: open the site once");
  assert.match(await run(DB, later(40 * MIN, T), doh(OURS)), /due 0/);
  assert.equal((await all(DB, "SELECT id FROM todos WHERE dedupe LIKE 'build:c1:due%'")).length, 1);
});

test("the due todo's reason: not built, needs approval; none with 49 h left, none once live", async () => {
  const T = new Date("2026-10-29T23:00:00Z");
  const DB = await setup({ site: { status: "draft", content: null, content_at: null, host: null } });
  await run(DB, T, doh({}));
  assert.equal((await openTodo(DB, "build:c1:due")).title, "Smith Roofing's site is due live Sat and isn't live yet: Claude hasn't built it");

  const DB2 = await setup({ site: { status: "review" } });
  await run(DB2, T, doh(OURS));
  assert.equal((await openTodo(DB2, "build:c1:due")).title, "Smith Roofing's site is due live Sat and isn't live yet: it needs your approval");

  const DB3 = await setup();
  await run(DB3, new Date("2026-10-29T21:30:00Z"), doh(OLD)); // 49 h left
  assert.equal(await todo(DB3, "build:c1:due"), null);

  const DB4 = await setup({ site: { live_at: "2026-10-29T12:00:00Z" } });
  await run(DB4, T, doh(OURS));
  assert.equal(await todo(DB4, "build:c1:due"), null);

  const DB5 = await setup({ site: { status: "off" } });
  await run(DB5, T, doh(OURS));
  assert.equal(await todo(DB5, "build:c1:due"), null);
});

test("fired 3 h 1 min ago with no content → build:c1:stuck; not at 2 h 59, not for a failed fire or posted content", async () => {
  const fire = (DB, at, { error = null, reason = "build: client c1" } = {}) =>
    insert(DB, "routine_fires", { id: `f-${at.getTime()}-${reason}`, routine: "build", reason, http_status: error ? 500 : 200, error, at: iso(at) });
  const draft = { status: "draft", content: null, content_at: null, host: null };

  const DB = await setup({ site: draft });
  await fire(DB, ago(3 * HOUR + MIN));
  assert.match(await run(DB, NOW, doh({})), /stuck 1/);
  const t = await openTodo(DB, "build:c1:stuck");
  assert.equal(t.title, "Claude hasn't built Smith Roofing's site yet: press Build again on the Site page");
  assert.equal(t.kind, "build");
  assert.equal(t.link, "/#/site/c1");
  assert.match(await run(DB, later(5 * MIN), doh({})), /stuck 0/); // filed once

  const DB2 = await setup({ site: draft });
  await fire(DB2, ago(2 * HOUR + 59 * MIN));
  await run(DB2, NOW, doh({}));
  assert.equal(await todo(DB2, "build:c1:stuck"), null);

  const DB3 = await setup({ site: draft });
  await fire(DB3, ago(4 * HOUR), { error: "HTTP 401" });
  await run(DB3, NOW, doh({}));
  assert.equal(await todo(DB3, "build:c1:stuck"), null);

  const DB4 = await setup({ site: { status: "review", content_at: iso(ago(HOUR)) } });
  await fire(DB4, ago(4 * HOUR));
  await run(DB4, NOW, doh({}));
  assert.equal(await todo(DB4, "build:c1:stuck"), null);

  // Changes Nik asked for on a live site, not posted 3 h later: the todo says what's missing.
  const DB5 = await setup({ site: { live_at: "2026-10-26T10:00:00Z", content_at: "2026-10-26T09:00:00Z" } });
  await fire(DB5, ago(3 * HOUR + MIN), { reason: "changes: client c1" });
  await run(DB5, NOW, doh(OURS));
  assert.equal((await openTodo(DB5, "build:c1:stuck")).title,
    "Claude hasn't made the changes to Smith Roofing's site yet: press Ask Claude for changes again on the Site page");
});

test("a chat lead quiet for 11 minutes → enquiry email with the transcript, notified_at set; 5 minutes → not yet", async () => {
  const DB = await setup({ site: { live_at: "2026-10-26T10:00:00Z", host_check: JSON.stringify({ at: iso(ago(HOUR)), ok: true, detail: "ok", fails: 0 }) } });
  const transcript = "Visitor: My roof is leaking\nAssistant: Sorry to hear that. What's your name and number?\nVisitor: I'm Dave, 07700 900123";
  await insert(DB, "site_leads", {
    id: "l1", client_id: "c1", source: "chat", name: "Dave", phone: "07700 900123", message: transcript, session: "s".repeat(16),
    created_at: iso(ago(20 * MIN)), updated_at: iso(ago(11 * MIN)),
  });
  await insert(DB, "site_leads", {
    id: "l2", client_id: "c1", source: "chat", name: "Sue", phone: "07700 900456", message: "Visitor: 07700 900456", session: "t".repeat(16),
    created_at: iso(ago(6 * MIN)), updated_at: iso(ago(5 * MIN)),
  });
  assert.match(await run(DB, NOW, doh(OURS)), /leads 1/);
  const msgs = await all(DB, "SELECT * FROM messages");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, "enquiry:l1");
  assert.equal(msgs[0].to_addr, "leads@smithroofing.co.uk");
  assert.equal(msgs[0].subject, "New enquiry from your website: Dave");
  assert.ok(msgs[0].body.includes(transcript));
  const l1 = await one(DB, "SELECT * FROM site_leads WHERE id = 'l1'");
  assert.equal(l1.notified_at, iso(NOW));
  assert.equal(l1.message_id, "enquiry:l1");
  assert.equal((await one(DB, "SELECT notified_at FROM site_leads WHERE id = 'l2'")).notified_at, null);

  // Sue's chat goes quiet: emailed on a later run; Dave isn't emailed again.
  assert.match(await run(DB, later(6 * MIN), doh(OURS)), /leads 1/);
  assert.deepEqual((await all(DB, "SELECT id FROM messages ORDER BY id")).map((m) => m.id), ["enquiry:l1", "enquiry:l2"]);
  assert.match(await run(DB, later(12 * MIN), doh(OURS)), /leads 0/);
});

test("a form lead is left to the contact form (only chat leads wait for the tick)", async () => {
  const DB = await setup({ site: { live_at: "2026-10-26T10:00:00Z" } });
  await insert(DB, "site_leads", {
    id: "f1", client_id: "c1", source: "form", name: "Al", phone: "07700 900789", message: "Gutter",
    created_at: iso(ago(HOUR)), updated_at: iso(ago(HOUR)),
  });
  assert.match(await run(DB, NOW, doh(OURS)), /leads 0/);
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 0);
});

test("a live site failing twice in a row → host_check.fails 2; a pass resets it; a failed lookup isn't a fail", async () => {
  const DB = await setup({ site: { live_at: "2026-10-20T10:00:00Z", seen_at: "2026-10-20T09:50:00Z" } });
  await run(DB, NOW, doh(OLD));
  assert.equal((await siteOf(DB)).host_check.fails, 1);
  await run(DB, later(HOUR), doh(OLD)); // a live site is checked once a day
  assert.equal((await siteOf(DB)).host_check.fails, 1);
  await run(DB, later(24 * HOUR), doh(OLD));
  const site = await siteOf(DB);
  assert.equal(site.host_check.fails, 2);
  assert.equal(site.host_check.ok, false);

  await run(DB, later(48 * HOUR), doh({}, { fail: [HOST] }));
  const failed = await siteOf(DB);
  assert.equal(failed.host_check.detail, HOST_CHECK_FAILED);
  assert.equal(failed.host_check.fails, 2);

  await run(DB, later(72 * HOUR), doh(OURS));
  assert.equal((await siteOf(DB)).host_check.fails, 0);
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 0); // already live: no second go-live email
});

test("pruneHits is called: rate_hits windows older than 48 h go", async () => {
  const DB = await setup();
  await insert(DB, "rate_hits", { key: "chat:c1:aaaa", win: "2026-10-25T09", count: 3 });
  await insert(DB, "rate_hits", { key: "chat:c1:aaaa", win: "2026-10-28T09", count: 1 });
  await run(DB, NOW, doh(OURS));
  assert.deepEqual((await all(DB, "SELECT win FROM rate_hits")).map((r) => r.win), ["2026-10-28T09"]);
});

test("no mailbox at all: going live files setup:client-mail:c1:go-live with the email as its draft; a chat lead files nothing", async () => {
  const DB = await setup({ mailbox: false, site: { seen_at: iso(ago(5 * MIN)) } });
  await insert(DB, "site_leads", {
    id: "l1", client_id: "c1", source: "chat", name: "Dave", phone: "07700 900123", message: "Visitor: 07700 900123",
    session: "s".repeat(16), created_at: iso(ago(30 * MIN)), updated_at: iso(ago(20 * MIN)),
  });
  assert.match(await run(DB, NOW, doh(OURS)), /live 1/);
  assert.equal((await siteOf(DB)).live_at, iso(NOW));
  const t = await openTodo(DB, "setup:client-mail:c1:go-live");
  assert.equal(t.kind, "setup");
  assert.equal(t.title, "Send Smith Roofing this email yourself (no mailbox yet)");
  assert.equal(t.link, "/#/site/c1");
  assert.equal(t.client_id, "c1");
  assert.match(t.draft, /^Hi John,\n\nYour new website is live: https:\/\/www\.smithroofing\.co\.uk/);
  assert.match(t.detail, /^To: john@smithroofing\.co\.uk\nSubject: Your website is live: www\.smithroofing\.co\.uk\n\n/);
  assert.equal(await todo(DB, "setup:welcome:c1"), null);
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 0);
  const todos = await all(DB, "SELECT dedupe FROM todos");
  assert.deepEqual(todos.map((r) => r.dedupe), ["setup:client-mail:c1:go-live"]);
  assert.equal((await one(DB, "SELECT notified_at FROM site_leads WHERE id = 'l1'")).notified_at, null);
});

// --- Beyond the plan's list ---------------------------------------------------------------------------------------

test("the go-live email: form email when there's no checkout email, 'Hi,' with no confident name, no review card when switched off", async () => {
  const DB = await setup({
    site: { seen_at: iso(ago(5 * MIN)), features: JSON.stringify({ review_booster: false }) },
  });
  await DB.prepare("DELETE FROM client_links").run();
  await DB.prepare("UPDATE prospects SET greet_name = NULL").run();
  await run(DB, NOW, doh(OURS));
  const [m] = await all(DB, "SELECT * FROM messages");
  assert.equal(m.to_addr, "info@smithroofing.co.uk");
  assert.match(m.body, /^Hi,\n\n/);
  assert.doesNotMatch(m.body, /review-card/);
});

test("the go-live email names the chat assistant when the chat is on for the site", async () => {
  const DB = await setup({ site: { seen_at: iso(ago(5 * MIN)) } });
  for (const [key, value] of [["secret:cf_ai:account_id", "acc123"], ["secret:cf_ai:token", "tok123456"], ["offer:chatbot_live", "1"]]) {
    await insert(DB, "settings", { key, value });
  }
  await run(DB, NOW, doh(OURS));
  const [m] = await all(DB, "SELECT body FROM messages");
  assert.match(m.body, /The chat assistant on your site answers questions day and night/);
  assert.doesNotMatch(m.body, /acc123|tok123456/);
});

test("with no sites:pages_host setting, a CNAME to goldbarwebsites.pages.dev still counts", async () => {
  const DB = await setup({ pagesHost: null });
  await run(DB, NOW, doh(OURS));
  assert.equal((await siteOf(DB)).host_check.ok, true);
});

test("a short budget: never spends more than it has, keeping 2 for the tick's own closing queries", async () => {
  const base = await setup({ site: { seen_at: iso(ago(5 * MIN)) } });
  for (let i = 2; i <= 4; i++) {
    await addClient(base, `c${i}`, `Client ${i}`, { site: { host: `www.site${i}.co.uk`, seen_at: iso(ago(5 * MIN)) } });
  }
  const zones = { ...OURS };
  for (let i = 2; i <= 4; i++) zones[`www.site${i}.co.uk`] = { CNAME: [PAGES] };
  const counter = countingDB(base);
  const budget = { left: () => 14 - counter.used() };
  await sitesStep({ DB: counter.DB, env: {}, now: NOW, budget }, { fetchImpl: doh(zones).fetchImpl });
  assert.ok(counter.used() <= 12, `used ${counter.used()}`);
  assert.ok((await all(base, "SELECT client_id FROM client_sites WHERE live_at IS NOT NULL")).length >= 1);
  // A later run with a full budget finishes the rest, one email each.
  await sitesStep({ DB: base, env: {}, now: later(20 * MIN) }, { fetchImpl: doh(zones).fetchImpl });
  assert.equal((await all(base, "SELECT client_id FROM client_sites WHERE live_at IS NOT NULL")).length, 4);
  assert.equal((await all(base, "SELECT id FROM messages")).length, 4);
});

test("a step that queued the go-live email but stopped before marking live doesn't email twice", async () => {
  const DB = await setup({ site: { seen_at: iso(ago(5 * MIN)) } });
  await insert(DB, "messages", {
    id: "go-live:c1", client_id: "c1", direction: "out", kind: "system", author: "system", to_addr: "john@smithroofing.co.uk",
    subject: "Your website is live: www.smithroofing.co.uk", body: "x", status: "queued", created_at: iso(ago(MIN)),
  });
  assert.match(await run(DB, NOW, doh(OURS)), /live 1/);
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 1);
  assert.equal((await siteOf(DB)).live_at, iso(NOW));
});

test("checkSite (the Site page's Check now): checks one site at once, whatever its last check", async () => {
  const DB = await setup({ site: { seen_at: iso(ago(5 * MIN)), host_check: JSON.stringify({ at: iso(ago(MIN)), ok: false, detail: "x", fails: 3 }) } });
  const result = await checkSite(DB, "c1", { fetchImpl: doh(OURS).fetchImpl, now: NOW });
  assert.deepEqual(result, { ok: true, detail: "www.smithroofing.co.uk points at us ✓", live: true });
  assert.equal((await siteOf(DB)).live_at, iso(NOW));
  assert.equal(await checkSite(DB, "nope", { fetchImpl: doh(OURS).fetchImpl, now: NOW }), null);
  const DB2 = await setup({ site: { host: null } });
  assert.deepEqual(await checkSite(DB2, "c1", { fetchImpl: doh(OURS).fetchImpl, now: NOW }), {
    ok: false, detail: "Type the client's web address on the Site page first.", live: false,
  });
});

test("opened just after a passing check → live on the next run from that check, with no DNS lookup", async () => {
  const ok = JSON.stringify({ at: iso(ago(2 * MIN)), ok: true, detail: "www.smithroofing.co.uk points at us ✓", fails: 0 });
  const DB = await setup({ site: { seen_at: iso(ago(MIN)), host_check: ok } });
  const dns = doh(OURS);
  assert.match(await run(DB, NOW, dns), /^checked 0, live 1,/);
  assert.equal(dns.calls.length, 0);
  assert.equal((await siteOf(DB)).live_at, iso(NOW));
  assert.equal((await all(DB, "SELECT id FROM messages")).length, 1);

  // A recent failing check isn't enough, and neither is a passing one nobody has opened.
  const bad = JSON.stringify({ at: iso(ago(2 * MIN)), ok: false, detail: "Not yet: x", fails: 1 });
  const DB2 = await setup({ site: { seen_at: iso(ago(MIN)), host_check: bad } });
  assert.match(await run(DB2, NOW, doh(OURS)), /^checked 0, live 0,/);
  const DB3 = await setup({ site: { host_check: ok } });
  assert.match(await run(DB3, NOW, doh(OURS)), /^checked 0, live 0,/);
  assert.equal((await siteOf(DB3)).live_at, null);
});

test("ns_wait: with no mode stored yet, the form's answers (has a domain, can log in) count as nameservers", async () => {
  const DB = await setup({ site: { status: "review" } });
  const form = { ...FORM, domain: { has: "yes", name: "smithroofing.co.uk", can_login: "yes", email_on_it: "no" } };
  await DB.prepare("UPDATE onboarding SET form = ? WHERE client_id = 'c1'").bind(JSON.stringify(form)).run();
  await run(DB, NOW, doh({ "smithroofing.co.uk": { NS: ["ada.ns.cloudflare.com.", "bob.ns.cloudflare.com."] } }));
  assert.equal((await siteOf(DB)).domain.steps.ns_wait, iso(NOW));

  // Can't log in (cname mode): no NS lookup.
  const DB2 = await setup({ site: { status: "review" } });
  await DB2.prepare("UPDATE onboarding SET form = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ ...form, domain: { ...form.domain, can_login: "no" } })).run();
  const dns2 = doh(OURS);
  await run(DB2, NOW, dns2);
  assert.equal(dns2.calls.some((c) => c.type === "NS"), false);
});

test("chat leads: the site's own email when the form has none; a lead over 30 days old isn't emailed", async () => {
  const DB = await setup({ site: { live_at: "2026-10-26T10:00:00Z" } });
  const form = { ...FORM, business: { ...FORM.business, leads_email: "", email: "" } };
  await DB.prepare("UPDATE onboarding SET form = ? WHERE client_id = 'c1'").bind(JSON.stringify(form)).run();
  await insert(DB, "site_leads", {
    id: "old", client_id: "c1", source: "chat", name: "Old", phone: "07700 900111", message: "Visitor: 07700 900111",
    session: "o".repeat(16), created_at: iso(ago(31 * 24 * HOUR)), updated_at: iso(ago(31 * 24 * HOUR)),
  });
  await insert(DB, "site_leads", {
    id: "l1", client_id: "c1", source: "chat", name: "Dave", phone: "07700 900123", message: "Visitor: 07700 900123",
    session: "s".repeat(16), created_at: iso(ago(30 * MIN)), updated_at: iso(ago(20 * MIN)),
  });
  assert.match(await run(DB, NOW, doh(OURS)), /leads 1/);
  const msgs = await all(DB, "SELECT * FROM messages");
  assert.deepEqual(msgs.map((m) => [m.id, m.to_addr]), [["enquiry:l1", "info@smithroofing.co.uk"]]);
  assert.equal((await one(DB, "SELECT notified_at FROM site_leads WHERE id = 'old'")).notified_at, null);
});

test("a stuck todo Nik closed himself doesn't block the next fire's; one closed for this fire isn't filed again", async () => {
  const fire = (DB, at) =>
    insert(DB, "routine_fires", { id: `f-${at.getTime()}`, routine: "build", reason: "build: client c1", http_status: 200, error: null, at: iso(at) });
  const closed = (DB, created, status = "done") =>
    insert(DB, "todos", {
      id: `old-${status}`, kind: "build", client_id: "c1", title: "old", dedupe: "build:c1:stuck", status,
      created_at: iso(created), done_at: iso(later(MIN, created)),
    });
  const draft = { status: "draft", content: null, content_at: null, host: null };

  // Ticked done (dedupe kept) for an earlier fire; Build pressed again 3 h 1 min ago and still nothing → a new todo.
  const DB = await setup({ site: draft });
  await closed(DB, ago(10 * HOUR));
  await fire(DB, ago(3 * HOUR + MIN));
  assert.match(await run(DB, NOW, doh({})), /stuck 1/);
  const open = await openTodo(DB, "build:c1:stuck");
  assert.equal(open.title, "Claude hasn't built Smith Roofing's site yet: press Build again on the Site page");
  assert.equal((await one(DB, "SELECT status FROM todos WHERE id = 'old-done'")).status, "done");
  assert.match(await run(DB, later(5 * MIN), doh({})), /stuck 0/);

  // Dismissed after this fire → left dismissed, not filed again.
  const DB2 = await setup({ site: draft });
  await fire(DB2, ago(4 * HOUR));
  await closed(DB2, ago(HOUR), "dismissed");
  assert.match(await run(DB2, NOW, doh({})), /stuck 0/);
  assert.equal(await openTodo(DB2, "build:c1:stuck"), null);
});

test("approved sites waiting to go live are checked before sites still being built", async () => {
  const DB = await setup({ site: { host_check: JSON.stringify({ at: iso(ago(20 * MIN)), ok: false, detail: "x", fails: 1 }) } });
  for (let i = 2; i <= 6; i++) await addClient(DB, `c${i}`, `Client ${i}`, { site: { host: `www.site${i}.co.uk`, status: "review" } });
  const dns = doh({});
  assert.match(await run(DB, NOW, dns), /^checked 5,/);
  assert.equal(dns.hosts()[0], HOST);
  assert.equal(dns.hosts().length, 5);
});

test("chat leads with nowhere to send them don't hold up other clients' leads", async () => {
  const DB = await setup({ site: { live_at: "2026-10-26T10:00:00Z" } });
  const blank = { ...FORM, business: { ...FORM.business, leads_email: "", email: "" } };
  await addClient(DB, "c2", "No Email Ltd", {
    site: { host: "www.noemail.co.uk", live_at: "2026-10-26T10:00:00Z", content: JSON.stringify({ ...CONTENT, business: { ...CONTENT.business, email: "" } }) },
    onboarding: { form: JSON.stringify(blank) },
  });
  for (let i = 1; i <= 4; i++) {
    await insert(DB, "site_leads", {
      id: `n${i}`, client_id: "c2", source: "chat", name: "X", phone: "07700 900000", message: "Visitor: 07700 900000",
      session: `n${i}`.padEnd(16, "n"), created_at: iso(ago(2 * HOUR)), updated_at: iso(ago(HOUR + i * MIN)),
    });
  }
  await insert(DB, "site_leads", {
    id: "l1", client_id: "c1", source: "chat", name: "Dave", phone: "07700 900123", message: "Visitor: 07700 900123",
    session: "s".repeat(16), created_at: iso(ago(30 * MIN)), updated_at: iso(ago(20 * MIN)),
  });
  assert.match(await run(DB, NOW, doh(OURS)), /leads 1/);
  assert.deepEqual((await all(DB, "SELECT id FROM messages")).map((m) => m.id), ["enquiry:l1"]);
});

test("STEPS: sites runs every 5 minutes, after calls and before purge", () => {
  const names = STEPS.map((s) => s.name);
  assert.equal(names.indexOf("sites"), names.indexOf("calls") + 1);
  assert.ok(names.indexOf("sites") < names.indexOf("purge"));
  const step = STEPS.find((s) => s.name === "sites");
  assert.equal(step.everyMinutes, 5);
  assert.equal(step.run, sitesStep);
});
