// The client site store (stage 10, 09-build.md Task 7): one client_sites row per client, found by client id, host
// (or its www twin) and slug; content saved for review; the host claimed once across clients; the domain plan merged;
// seen/live stamped once; the Sites list with its 30-day enquiry count; per-site feature switches (stage 11 calls them).
// Run: node --test control-room/tests/sites-db.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureSite, getSite, listSites, markLive, markSeen, saveContent, setHost, setSiteFeature, setSiteStatus, siteByHost,
  siteBySlug, updateDomain,
} from "../functions/_lib/sites/db.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const T0 = "2026-10-24T22:30:00Z";
const AT = new Date("2026-10-28T10:00:00Z");
const LATER = new Date("2026-10-28T11:00:00Z");
const SLUG = /^smith-roofing-[a-z2-9]{6}$/;
const CONTENT = { version: 1, keyword: "roofer Swindon", pages: [{ key: "home", path: "/", title: "Roofer in Swindon" }] };

const one = (DB, sql, ...args) => DB.raw.prepare(sql).get(...args);

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

/** Clients c1 (Smith Roofing, full) and c2 (Jones Plumbing, website), each with a submitted onboarding row. */
async function seed() {
  const DB = fakeD1();
  const client = (id, name, pkg) => insert(DB, "clients", {
    id, name, place_id: `p-${id}`, package: pkg, build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-24", created_at: T0,
  });
  await client("c1", "Smith Roofing", "full");
  await client("c2", "Jones Plumbing", "website");
  for (const id of ["c1", "c2"]) {
    await insert(DB, "onboarding", {
      client_id: id, token: `${id}`.padEnd(32, "t"), status: "building", form: "{}", submitted_at: T0,
      due_live_at: "2026-10-31T22:30:00Z", created_at: T0,
    });
  }
  return DB;
}

const leadRow = (DB, id, client_id, created_at) => insert(DB, "site_leads", {
  id, client_id, source: "form", name: "Sam", message: "Roof leak", created_at, updated_at: created_at,
});

// ---------------------------------------------------------------- the spec's tests (Task 7, Step 1)

test("ensureSite makes one row per client and returns the same slug the second time", async () => {
  const DB = await seed();
  const a = await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  assert.match(a.slug, SLUG);
  assert.equal(a.status, "draft");
  assert.equal(a.place_id, "p-c1");
  assert.equal(a.content, null);
  assert.deepEqual(a.domain, {});
  assert.deepEqual(a.features, {});
  assert.equal(a.host_check, null);
  assert.equal(a.created_at, "2026-10-28T10:00:00Z");
  const b = await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, LATER);
  assert.equal(b.slug, a.slug);
  assert.equal(b.created_at, a.created_at);
  assert.equal(Number(one(DB, "SELECT COUNT(*) AS n FROM client_sites").n), 1);
});

test("siteByHost finds the row stored as www.<domain> from the bare domain, and the other way round", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  assert.deepEqual(await setHost(DB, "c1", "www.smithroofing.co.uk", AT), { ok: true });
  const bare = await siteByHost(DB, "smithroofing.co.uk");
  assert.equal(bare.client_id, "c1");
  assert.equal(bare.host, "www.smithroofing.co.uk");
  assert.equal((await siteByHost(DB, "www.smithroofing.co.uk")).client_id, "c1");
  assert.equal((await siteByHost(DB, "WWW.SmithRoofing.co.uk.:443")).client_id, "c1");
  assert.equal(await siteByHost(DB, "jones.co.uk"), null);
  assert.equal(await siteByHost(DB, ""), null);
});

test("setHost refuses a host another client's site already uses", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await ensureSite(DB, "c2", { name: "Jones Plumbing", place_id: "p-c2" }, AT);
  await setHost(DB, "c1", "www.smithroofing.co.uk", AT);
  assert.deepEqual(await setHost(DB, "c2", "www.smithroofing.co.uk", AT), {
    ok: false, error: "www.smithroofing.co.uk is already used by Smith Roofing's site.",
  });
  // Its www twin is the same site.
  assert.deepEqual(await setHost(DB, "c2", "smithroofing.co.uk", AT), {
    ok: false, error: "smithroofing.co.uk is already used by Smith Roofing's site.",
  });
  assert.equal((await getSite(DB, "c2")).host, null);
  // Setting its own host again is fine.
  assert.deepEqual(await setHost(DB, "c1", "www.smithroofing.co.uk", AT), { ok: true });
});

test("saveContent puts the site and the onboarding row in review", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await setSiteStatus(DB, "c1", "draft", AT, { notes: "Make the phone number bigger" });
  await DB.prepare("UPDATE client_sites SET last_errors = ? WHERE client_id = ?").bind('["home: bad"]', "c1").run();
  const r = await saveContent(DB, "c1", CONTENT, LATER);
  assert.deepEqual(r, { status: "review" });
  const site = await getSite(DB, "c1");
  assert.equal(site.status, "review");
  assert.deepEqual(site.content, CONTENT);
  assert.equal(site.content_at, "2026-10-28T11:00:00Z");
  assert.equal(site.change_notes, null);
  assert.equal(site.last_errors, null);
  assert.equal(one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'").status, "review");
  assert.equal(one(DB, "SELECT status FROM onboarding WHERE client_id = 'c2'").status, "building");
});

test("markLive is true only the first time and finishes the onboarding row", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await setHost(DB, "c1", "www.smithroofing.co.uk", AT);
  await saveContent(DB, "c1", CONTENT, AT);
  await setSiteStatus(DB, "c1", "live", AT, { approved: true });
  assert.equal(await markLive(DB, "c1", LATER), true);
  assert.equal(await markLive(DB, "c1", new Date("2026-10-28T12:00:00Z")), false);
  const ob = one(DB, "SELECT * FROM onboarding WHERE client_id = 'c1'");
  assert.equal(ob.live_at, "2026-10-28T11:00:00Z");
  assert.equal(ob.status, "live");
  assert.equal(ob.site_url, "https://www.smithroofing.co.uk/");
  const site = await getSite(DB, "c1");
  assert.equal(site.live_at, "2026-10-28T11:00:00Z");
  assert.equal(site.status, "live");
});

test("listSites counts enquiries from the last 30 days only", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await ensureSite(DB, "c2", { name: "Jones Plumbing", place_id: "p-c2" }, AT);
  await leadRow(DB, "l1", "c1", "2026-10-27T09:00:00Z");
  await leadRow(DB, "l2", "c1", "2026-10-01T09:00:00Z");
  await leadRow(DB, "l3", "c1", "2026-09-20T09:00:00Z"); // 38 days before AT
  await leadRow(DB, "l4", "c2", "2026-08-01T09:00:00Z");
  const rows = await listSites(DB, AT);
  const by = Object.fromEntries(rows.map((r) => [r.client_id, r]));
  assert.equal(by.c1.enquiries_30d, 2);
  assert.equal(by.c2.enquiries_30d, 0);
  assert.equal(by.c1.name, "Smith Roofing");
  assert.equal(by.c1.package, "full");
  assert.equal(by.c2.package, "website");
  assert.equal(by.c1.submitted_at, T0);
  assert.equal(by.c1.due_live_at, "2026-10-31T22:30:00Z");
});

test("setSiteFeature switches a feature off and back on (missing = on); unknown features throw", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await setSiteFeature(DB, "c1", "chatbot", false);
  assert.equal((await getSite(DB, "c1")).features.chatbot, false);
  await setSiteFeature(DB, "c1", "review_booster", false, AT);
  assert.deepEqual((await getSite(DB, "c1")).features, { chatbot: false, review_booster: false });
  await setSiteFeature(DB, "c1", "chatbot", true, AT);
  const features = (await getSite(DB, "c1")).features;
  assert.equal(Object.hasOwn(features, "chatbot"), false);
  assert.deepEqual(features, { review_booster: false });
  await assert.rejects(setSiteFeature(DB, "c1", "x", true, AT), { message: "Unknown site feature: x" });
  // A client without a site (stage 11 cancelling) is a quiet no-op.
  await setSiteFeature(DB, "nobody", "chatbot", false, AT);
});

// ---------------------------------------------------------------- the rest of the store

test("getSite parses content, domain and host_check, and carries the client's name, package and clock", async () => {
  const DB = await seed();
  assert.equal(await getSite(DB, "c1"), null);
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await DB.prepare("UPDATE client_sites SET host_check = ?, content = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ at: "2026-10-28T10:00:00Z", ok: true, detail: "x", fails: 0 }), "{not json")
    .run();
  const site = await getSite(DB, "c1");
  assert.deepEqual(site.host_check, { at: "2026-10-28T10:00:00Z", ok: true, detail: "x", fails: 0 });
  assert.equal(site.content, null); // a broken JSON column reads as no content, never a crash
  assert.equal(site.name, "Smith Roofing");
  assert.equal(site.package, "full");
  assert.equal(site.due_live_at, "2026-10-31T22:30:00Z");
  assert.equal(site.onboarding_status, "building");
});

test("siteBySlug finds the site; junk slugs find nothing", async () => {
  const DB = await seed();
  const s = await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  assert.equal((await siteBySlug(DB, s.slug)).client_id, "c1");
  assert.equal(await siteBySlug(DB, "nope-aaaaaa"), null);
  assert.equal(await siteBySlug(DB, ""), null);
  assert.equal(await siteBySlug(DB, undefined), null);
});

test("ensureSite retries once with a new slug when the random one is taken", async () => {
  const DB = await seed();
  await insert(DB, "client_sites", {
    client_id: "other", slug: "smith-roofing-aaaaaa", status: "draft", domain: "{}", created_at: T0, updated_at: T0,
  });
  let calls = 0;
  const rand = () => (calls++ < 6 ? 0 : 0.5); // first slug ends "aaaaaa" (taken), the second doesn't
  const s = await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1", rand }, AT);
  assert.match(s.slug, SLUG);
  assert.notEqual(s.slug, "smith-roofing-aaaaaa");
});

test("saveContent on a live site keeps it live (a change Nik asked for, or a care update)", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await setHost(DB, "c1", "www.smithroofing.co.uk", AT);
  await saveContent(DB, "c1", CONTENT, AT);
  await setSiteStatus(DB, "c1", "live", AT, { approved: true });
  await markLive(DB, "c1", AT);
  const r = await saveContent(DB, "c1", { ...CONTENT, keyword: "roofer Swindon area" }, LATER);
  assert.deepEqual(r, { status: "live" });
  assert.equal((await getSite(DB, "c1")).content.keyword, "roofer Swindon area");
  assert.equal(one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'").status, "live");
  assert.equal(await saveContent(DB, "nobody", CONTENT, LATER), null);
});

test("setSiteStatus checks the status word and stamps approved_at on approval", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  assert.equal(await setSiteStatus(DB, "c1", "review", AT), true);
  assert.equal((await getSite(DB, "c1")).approved_at, null);
  assert.equal(await setSiteStatus(DB, "c1", "live", LATER, { approved: true }), true);
  const site = await getSite(DB, "c1");
  assert.equal(site.status, "live");
  assert.equal(site.approved_at, "2026-10-28T11:00:00Z");
  assert.equal(site.updated_at, "2026-10-28T11:00:00Z");
  assert.equal(await setSiteStatus(DB, "nobody", "off", AT), false);
  await assert.rejects(setSiteStatus(DB, "c1", "gone", AT), { message: "Unknown site status: gone" });
});

test("setHost normalises the host, refuses junk, and a new host forgets the old DNS check and visit", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  assert.deepEqual(await setHost(DB, "c1", "WWW.SmithRoofing.co.uk.", AT), { ok: true });
  assert.equal((await getSite(DB, "c1")).host, "www.smithroofing.co.uk");
  await DB.prepare("UPDATE client_sites SET host_check = '{\"ok\":true}', seen_at = ? WHERE client_id = 'c1'").bind(T0).run();
  await setHost(DB, "c1", "www.smithroofing.co.uk", AT); // same host: kept
  assert.equal((await getSite(DB, "c1")).seen_at, T0);
  // The test client's host has no www: setHost keeps the host as given (only with { test: true }).
  assert.deepEqual(await setHost(DB, "c1", "site-test.aetoswebsites.com", LATER, { test: true }), { ok: true });
  const site = await getSite(DB, "c1");
  assert.equal(site.host, "site-test.aetoswebsites.com");
  assert.equal(site.seen_at, null);
  assert.equal(site.host_check, null);
  const BAD = "That doesn't look like a web address. Type it like smithroofing.co.uk.";
  assert.deepEqual(await setHost(DB, "c1", "smith", AT), { ok: false, error: BAD });
  assert.deepEqual(await setHost(DB, "c1", "a b.co.uk", AT), { ok: false, error: BAD });
  assert.deepEqual(await setHost(DB, "nobody", "www.x.co.uk", AT), { ok: false, error: "That client has no site yet." });
  // null clears it.
  assert.deepEqual(await setHost(DB, "c1", null, AT), { ok: true });
  assert.equal((await getSite(DB, "c1")).host, null);
});

test("setHost refuses aetoswebsites.com and every host under it (control., www.control.), bar the test client's", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  const OUR = "That's one of Aetos's own addresses, not the client's. Type their domain, like smithroofing.co.uk.";
  for (const h of ["www.control.aetoswebsites.com", "control.aetoswebsites.com", "CONTROL.AetosWebsites.com.",
    "aetoswebsites.com", "www.aetoswebsites.com", "x.y.aetoswebsites.com", "site-test.aetoswebsites.com",
    "www.site-test.aetoswebsites.com", "aetos.pages.dev"]) {
    assert.deepEqual(await setHost(DB, "c1", h, AT), { ok: false, error: OUR }, h);
  }
  // { test: true } opens the one test host only.
  assert.deepEqual(await setHost(DB, "c1", "control.aetoswebsites.com", AT, { test: true }), { ok: false, error: OUR });
  assert.deepEqual(await setHost(DB, "c1", "www.site-test.aetoswebsites.com", AT, { test: true }), { ok: false, error: OUR });
  assert.equal((await getSite(DB, "c1")).host, null);
  assert.deepEqual(await setHost(DB, "c1", "site-test.aetoswebsites.com", AT, { test: true }), { ok: true });
  assert.equal((await getSite(DB, "c1")).host, "site-test.aetoswebsites.com");
  // A look-alike domain that only ends in the same letters is a client's own.
  assert.deepEqual(await setHost(DB, "c1", "www.myaetoswebsites.com", AT), { ok: true });
});

test("updateDomain merges the patch into the domain plan; a null step un-ticks it", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  const d1 = await updateDomain(DB, "c1", { mode: "ns", domain: "smithroofing.co.uk", steps: { zone: T0 } }, AT);
  assert.deepEqual(d1, { mode: "ns", domain: "smithroofing.co.uk", steps: { zone: T0 } });
  const d2 = await updateDomain(DB, "c1", { nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], steps: { ns_email: AT.toISOString() } }, LATER);
  assert.deepEqual(d2.steps, { zone: T0, ns_email: AT.toISOString() });
  assert.deepEqual(d2.nameservers, ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
  const d3 = await updateDomain(DB, "c1", { steps: { zone: null } }, LATER);
  assert.deepEqual(d3.steps, { ns_email: AT.toISOString() });
  assert.deepEqual((await getSite(DB, "c1")).domain, d3);
  assert.equal(await updateDomain(DB, "nobody", { mode: "ns" }, AT), null);
  await assert.rejects(updateDomain(DB, "c1", ["x"], AT), { message: "The domain change must be an object." });
});

test("markSeen stamps the first visit only; markLive needs an approved site with a host", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  assert.equal(await markSeen(DB, "c1", AT), true);
  assert.equal(await markSeen(DB, "c1", LATER), false);
  assert.equal((await getSite(DB, "c1")).seen_at, "2026-10-28T10:00:00Z");
  // Not approved: no go-live.
  await setHost(DB, "c1", "www.smithroofing.co.uk", AT);
  assert.equal(await markLive(DB, "c1", AT), false);
  // Approved but no host: no go-live either.
  await setHost(DB, "c1", null, AT);
  await setSiteStatus(DB, "c1", "live", AT, { approved: true });
  assert.equal(await markLive(DB, "c1", AT), false);
  assert.equal(one(DB, "SELECT live_at FROM onboarding WHERE client_id = 'c1'").live_at, null);
});

test("listSites puts the soonest due first and never sends the content", async () => {
  const DB = await seed();
  await DB.prepare("UPDATE onboarding SET due_live_at = '2026-10-30T09:00:00Z' WHERE client_id = 'c2'").run();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await ensureSite(DB, "c2", { name: "Jones Plumbing", place_id: "p-c2" }, AT);
  await saveContent(DB, "c1", CONTENT, AT);
  const rows = await listSites(DB, AT);
  assert.deepEqual(rows.map((r) => r.client_id), ["c2", "c1"]);
  assert.equal(Object.hasOwn(rows[1], "content"), false);
  assert.equal(rows[1].has_content, true);
  assert.equal(rows[0].has_content, false);
  assert.equal(rows[1].status, "review");
});

test("saveContent on a site Nik took offline puts it back in review, so the Approve todo can be approved", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await saveContent(DB, "c1", CONTENT, AT);
  await setSiteStatus(DB, "c1", "off", AT);
  assert.deepEqual(await saveContent(DB, "c1", CONTENT, LATER), { status: "review" });
  assert.equal((await getSite(DB, "c1")).status, "review");
  assert.equal(one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'").status, "review");
});

test("setHost stores a bare host only, and never one of Aetos's own hosts", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  const BAD = "That doesn't look like a web address. Type it like smithroofing.co.uk.";
  for (const junk of ["https://www.smithroofing.co.uk/", "www.smithroofing.co.uk/about", "smithroofing.co.uk?x=1", "sam@smithroofing.co.uk"]) {
    assert.deepEqual(await setHost(DB, "c1", junk, AT), { ok: false, error: BAD }, junk);
  }
  const OURS = "That's one of Aetos's own addresses, not the client's. Type their domain, like smithroofing.co.uk.";
  for (const ours of ["aetoswebsites.com", "www.aetoswebsites.com", "goldbarwebsites.pages.dev", "www.goldbarwebsites.pages.dev"]) {
    assert.deepEqual(await setHost(DB, "c1", ours, AT), { ok: false, error: OURS }, ours);
  }
  assert.equal((await getSite(DB, "c1")).host, null);
  // An IDN is stored in punycode.
  assert.deepEqual(await setHost(DB, "c1", "www.bücher.de", AT), { ok: true });
  assert.equal((await getSite(DB, "c1")).host, "www.xn--bcher-kva.de");
  assert.equal((await siteByHost(DB, "bücher.de")).client_id, "c1");
});

test("two ensureSite calls at once make one row, and both get the same slug", async () => {
  const DB = await seed();
  const [a, b] = await Promise.all([
    ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT),
    ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT),
  ]);
  assert.equal(a.slug, b.slug);
  assert.match(a.slug, SLUG);
  assert.equal(Number(one(DB, "SELECT COUNT(*) AS n FROM client_sites").n), 1);
});

test("markLive called twice at once is true exactly once", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await setHost(DB, "c1", "www.smithroofing.co.uk", AT);
  await saveContent(DB, "c1", CONTENT, AT);
  await setSiteStatus(DB, "c1", "live", AT, { approved: true });
  const results = await Promise.all([markLive(DB, "c1", LATER), markLive(DB, "c1", LATER)]);
  assert.deepEqual(results.sort(), [false, true]);
  // The other client's onboarding row is untouched.
  const c2 = one(DB, "SELECT status, live_at, site_url FROM onboarding WHERE client_id = 'c2'");
  assert.deepEqual({ ...c2 }, { status: "building", live_at: null, site_url: null });
});

test("listSites's 30 days include a lead exactly 30 days old and not one a second older", async () => {
  const DB = await seed();
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, AT);
  await leadRow(DB, "l1", "c1", "2026-09-28T10:00:00Z"); // exactly 30 days before AT
  await leadRow(DB, "l2", "c1", "2026-09-28T09:59:59Z");
  const [row] = await listSites(DB, AT);
  assert.equal(row.enquiries_30d, 1);
});
