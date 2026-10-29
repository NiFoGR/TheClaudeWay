// Health lights for client sites and their chat (stage 10, 09-build.md Task 28, section 14): siteLights is pure;
// siteLightsFromDb reads the facts in 1 D1 query; importing the module registers both lights with stage 0's
// registerLight, so healthFromDb (Setup's lights, /api/health and the health step) shows them.
// Run: node --test control-room/tests/sites-health.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { healthFromDb } from "../functions/_lib/health.js";
import { siteLights, siteLightsFromDb } from "../functions/_lib/sites/health.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = new Date("2026-10-28T12:00:00Z");
const at = (ms) => new Date(NOW.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const KEYS = ["detail", "fix", "level", "name"];

const DUE_FIX =
  "Open Smith Roofing's Site page and do what its 'due' todo says; send the temporary link if the domain is the hold-up.";
const DNS_FIX = "Open the Site page and press Check now; follow the domain steps again.";
const STUCK_FIX = "Press Build again on the Site page; if it fails, check the build Routine on Setup → Claude.";

// A Smith Roofing site that's live, on time and fine; o overrides any field.
const site = (o = {}) => ({
  client_id: "c1",
  name: "Smith Roofing",
  status: "live",
  host: "www.smithroofing.co.uk",
  host_check: { at: at(-HOUR), ok: true, detail: "Points at us", fails: 0 },
  live_at: at(-24 * HOUR),
  due_live_at: at(24 * HOUR),
  has_content: true,
  content_at: at(-48 * HOUR),
  build_fired_at: at(-50 * HOUR),
  chat_on: true,
  ...o,
});
const lightsOf = (facts) => {
  const lights = siteLights({ chatToday: { messages: 0, ai_errors: 0 }, ...facts }, NOW);
  assert.equal(lights.length, 2);
  for (const l of lights) assert.deepEqual(Object.keys(l).sort(), KEYS, JSON.stringify(l));
  assert.deepEqual(lights.map((l) => l.name), ["sites", "chat"]);
  return { sites: lights[0], chat: lights[1] };
};

// ---------------------------------------------------------------- the spec's tests (Step 1)

test("sites: a site past due without live_at is red, naming the client and the days late", () => {
  const { sites } = lightsOf({ sites: [site({ status: "review", live_at: null, due_live_at: at(-50 * HOUR) })] });
  assert.equal(sites.level, "red");
  assert.equal(sites.detail, "Smith Roofing's site is 2 days late.");
  assert.equal(sites.fix, DUE_FIX);
  // 10 hours late is still a whole day late, never "0 days late".
  const one = lightsOf({ sites: [site({ status: "review", live_at: null, due_live_at: at(-10 * HOUR) })] }).sites;
  assert.equal(one.level, "red");
  assert.equal(one.detail, "Smith Roofing's site is 1 day late.");
});

test("sites: a live site whose DNS check failed twice in a row is red", () => {
  const { sites } = lightsOf({ sites: [site({ host_check: { at: at(-HOUR), ok: false, detail: "x", fails: 2 } })] });
  assert.equal(sites.level, "red");
  assert.equal(sites.detail, "www.smithroofing.co.uk no longer points at us. Check the domain's DNS.");
  assert.equal(sites.fix, DNS_FIX);
  // One failure is a blip, not red; host_check as stored JSON text reads the same.
  assert.equal(lightsOf({ sites: [site({ host_check: { ok: false, fails: 1 } })] }).sites.level, "green");
  assert.equal(lightsOf({ sites: [site({ host_check: JSON.stringify({ ok: false, fails: 3 }) })] }).sites.level, "red");
});

test("sites: due live within 48 hours and not live is amber", () => {
  const { sites } = lightsOf({ sites: [site({ status: "review", live_at: null, due_live_at: at(40 * HOUR) })] });
  assert.equal(sites.level, "amber");
  assert.match(sites.detail, /^Smith Roofing's site is due live /);
  assert.match(sites.detail, /isn't live yet/);
  assert.equal(sites.fix, DUE_FIX);
  // 49 h left is not amber yet.
  const later = site({ status: "review", live_at: null, due_live_at: at(49 * HOUR) });
  assert.equal(lightsOf({ sites: [later] }).sites.level, "green");
});

test("sites: a build fire 3 h 1 min ago with no content is amber (Claude hasn't built it); 2 h 59 min isn't", () => {
  const stuck = site({ status: "draft", live_at: null, due_live_at: at(120 * HOUR), has_content: false, content_at: null,
    build_fired_at: at(-(3 * HOUR + MIN)), host: null, host_check: null });
  const { sites } = lightsOf({ sites: [stuck] });
  assert.equal(sites.level, "amber");
  assert.equal(sites.detail, "Claude hasn't built Smith Roofing's site");
  assert.equal(sites.fix, STUCK_FIX);
  const waiting = { ...stuck, build_fired_at: at(-(3 * HOUR - MIN)) };
  assert.equal(lightsOf({ sites: [waiting] }).sites.level, "green");
  // Content posted after the fire: built.
  const built = { ...stuck, has_content: true, content_at: at(-HOUR), status: "review" };
  assert.equal(lightsOf({ sites: [built] }).sites.level, "green");
});

test("sites: 40 live www domains is amber at 80 of ~100 client domains (www + apex); 39 is green", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => site({ client_id: `c${i}`, name: `Firm ${i}`, host: `www.firm${i}.co.uk` }));
  const { sites } = lightsOf({ sites: many(40), liveDomains: many(40).map((s) => s.host) });
  assert.equal(sites.level, "amber");
  assert.equal(sites.detail, "You're at 80 of ~100 client domains on this Pages project: time to plan the next one.");
  assert.equal(lightsOf({ sites: many(39), liveDomains: many(39).map((s) => s.host) }).sites.level, "green");
  // Without liveDomains it counts the live sites' hosts itself.
  assert.equal(lightsOf({ sites: many(40) }).sites.detail, sites.detail);
});

test("sites: no client sites is grey; chat: no chat-on site is grey", () => {
  const { sites, chat } = lightsOf({ sites: [] });
  assert.equal(sites.level, "grey");
  assert.equal(chat.level, "grey");
  assert.equal(lightsOf({ sites: [site({ chat_on: false })] }).chat.level, "grey");
});

test("chat: ai_errors 11 today is amber, with a fix naming Setup → \"Client sites\" → Test; 10 is green", () => {
  const { chat } = lightsOf({ sites: [site()], chatToday: { messages: 50, ai_errors: 11 } });
  assert.equal(chat.level, "amber");
  assert.ok(chat.fix.includes('Setup → "Client sites" → Test'), chat.fix);
  assert.match(chat.detail, /11/);
  assert.equal(lightsOf({ sites: [site()], chatToday: { messages: 50, ai_errors: 10 } }).chat.level, "green");
});

test("chat: the all-sites cap (1,000 messages today) hit is amber", () => {
  const { chat } = lightsOf({ sites: [site()], chatToday: { messages: 1000, ai_errors: 0 } });
  assert.equal(chat.level, "amber");
  assert.match(chat.detail, /1,000/);
  assert.ok(chat.fix.length > 0);
  assert.equal(lightsOf({ sites: [site()], chatToday: { messages: 999, ai_errors: 0 } }).chat.level, "green");
});

test("otherwise both lights are green", () => {
  const { sites, chat } = lightsOf({ sites: [site(), site({ client_id: "c2", name: "Jones Plumbing", host: "www.jones.co.uk" })] });
  assert.equal(sites.level, "green");
  assert.equal(chat.level, "green");
  assert.equal(sites.fix, "");
  assert.equal(chat.fix, "");
});

// ---------------------------------------------------------------- more cases

test("sites: red beats amber; the most-late site is named and the rest are counted", () => {
  const { sites } = lightsOf({
    sites: [
      site({ client_id: "c2", name: "Jones Plumbing", status: "review", live_at: null, due_live_at: at(20 * HOUR) }),
      site({ client_id: "c3", name: "Ace Locks", status: "review", live_at: null, due_live_at: at(-26 * HOUR) }),
      site({ status: "review", live_at: null, due_live_at: at(-75 * HOUR) }),
    ],
  });
  assert.equal(sites.level, "red");
  assert.ok(sites.detail.startsWith("Smith Roofing's site is 3 days late."), sites.detail);
  assert.match(sites.detail, /2 more/);
  assert.equal(sites.fix, DUE_FIX);
});

test("sites: an off site counts as a client site but is never late, stuck or failing", () => {
  const off = site({ status: "off", live_at: null, due_live_at: at(-50 * HOUR), has_content: false, content_at: null,
    build_fired_at: at(-5 * HOUR), host_check: { fails: 4 } });
  const { sites, chat } = lightsOf({ sites: [off] });
  assert.equal(sites.level, "green");
  assert.equal(chat.level, "grey", "an off site serves no chat");
});

test("sites: a changes fire with no newer content after 3 h is amber; a site with no due date isn't late", () => {
  const s = site({ build_fired_at: at(-4 * HOUR), content_at: at(-30 * HOUR) });
  const { sites } = lightsOf({ sites: [s] });
  assert.equal(sites.level, "amber");
  assert.match(sites.detail, /Smith Roofing/);
  assert.equal(lightsOf({ sites: [site({ status: "draft", live_at: null, due_live_at: null })] }).sites.level, "green");
});

test("siteLights: missing or junk input never throws", () => {
  const lights = siteLights({}, NOW);
  assert.deepEqual(lights.map((l) => [l.name, l.level]), [["sites", "grey"], ["chat", "grey"]]);
  const junk = siteLights({ sites: [null, { name: "X", host_check: "{broken" }], chatToday: null }, NOW.toISOString());
  assert.equal(junk[0].level, "green");
});

// ---------------------------------------------------------------- from D1, and registered with healthFromDb

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

// c1 Smith Roofing (full): past due, not live. c2 Jones Plumbing (full): fired 3 h 1 min ago, no content.
async function seed(DB) {
  const T0 = "2026-10-20T10:00:00Z";
  for (const [id, name] of [["c1", "Smith Roofing"], ["c2", "Jones Plumbing"]]) {
    await insert(DB, "clients", { id, name, package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
      paid_on: "2026-10-20", created_at: T0 });
  }
  await insert(DB, "onboarding", { client_id: "c1", token: "t".repeat(32), status: "review", form: "{}",
    submitted_at: T0, due_live_at: at(-50 * HOUR), created_at: T0 });
  await insert(DB, "onboarding", { client_id: "c2", token: "u".repeat(32), status: "building", form: "{}",
    submitted_at: at(-4 * HOUR), due_live_at: at(164 * HOUR), created_at: T0 });
  await insert(DB, "client_sites", { client_id: "c1", slug: "smith-roofing-abc234", status: "review", content: "{}",
    content_at: at(-60 * HOUR), created_at: T0, updated_at: T0 });
  await insert(DB, "client_sites", { client_id: "c2", slug: "jones-plumbing-abc234", status: "draft", created_at: T0,
    updated_at: T0 });
  await insert(DB, "routine_fires", { id: "f1", routine: "build", reason: "build: client c2", http_status: 200,
    at: at(-(3 * HOUR + MIN)) });
  // A failed fire for c1 and another Routine's fire mentioning c2 don't count.
  await insert(DB, "routine_fires", { id: "f2", routine: "build", reason: "changes: client c1", http_status: 500,
    error: "Claude answered 500", at: at(-5 * HOUR) });
  await insert(DB, "routine_fires", { id: "f3", routine: "reply", reason: "build: client c1", http_status: 200,
    at: at(-5 * HOUR) });
}

test("siteLightsFromDb: one D1 query; past-due red; chat facts from today's chat_usage and the switches", async () => {
  const DB = fakeD1();
  assert.deepEqual((await siteLightsFromDb(DB, NOW)).map((l) => [l.name, l.level]), [["sites", "grey"], ["chat", "grey"]]);
  await seed(DB);
  const counted = countingDB(DB);
  const [sites, chat] = await siteLightsFromDb(counted.DB, NOW);
  assert.equal(counted.used(), 1);
  assert.equal(sites.level, "red");
  assert.ok(sites.detail.startsWith("Smith Roofing's site is 2 days late."), sites.detail);
  assert.match(sites.detail, /1 more/);
  assert.equal(chat.level, "grey", "the chatbot isn't connected");

  // Connected and switched on: chat is on (full package, not cancelled); 11 errors today (UK day) → amber.
  await insert(DB, "settings", { key: "secret:cf_ai:account_id", value: "acc" });
  await insert(DB, "settings", { key: "secret:cf_ai:token", value: "tok" });
  await insert(DB, "settings", { key: "offer:chatbot_live", value: "1" });
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-28", messages: 30, ai_errors: 6 });
  await insert(DB, "chat_usage", { client_id: "c2", day: "2026-10-28", messages: 5, ai_errors: 5 });
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-27", messages: 2000, ai_errors: 90 });
  const [, chat2] = await siteLightsFromDb(DB, NOW);
  assert.equal(chat2.level, "amber");
  assert.match(chat2.detail, /11/);

  // c1 goes live on time: c2's stuck build is what's left (amber).
  await DB.prepare("UPDATE client_sites SET status = 'live', live_at = ?, host = 'www.smithroofing.co.uk' WHERE client_id = 'c1'")
    .bind(at(-60 * HOUR)).run();
  const [sites3] = await siteLightsFromDb(DB, NOW);
  assert.equal(sites3.level, "amber");
  assert.equal(sites3.detail, "Claude hasn't built Jones Plumbing's site");
});

test("after importing the module, healthFromDb's lights contain one sites and one chat light", async () => {
  const DB = fakeD1();
  await seed(DB);
  const { lights } = await healthFromDb(DB, {}, NOW);
  assert.equal(lights.filter((l) => l.name === "sites").length, 1);
  assert.equal(lights.filter((l) => l.name === "chat").length, 1);
  assert.equal(lights.find((l) => l.name === "sites").level, "red");
  assert.equal(lights.some((l) => /_failed$/.test(l.name)), false, JSON.stringify(lights));
  assert.ok(lights.findIndex((l) => l.name === "sites") >= 10, "after stage 0's 10");
  const names = lights.map((l) => l.name);
  for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);
});

test("healthFromDb: the sites and chat lights share one query; rows read stay bounded as the logs grow", async () => {
  const DB = fakeD1();
  await seed(DB);
  let facts = 0;
  const watched = {
    prepare: (sql) => {
      if (sql.includes("FROM client_sites cs")) facts++;
      return DB.prepare(sql);
    },
    batch: (stmts) => DB.batch(stmts),
  };
  await healthFromDb(watched, {}, NOW);
  assert.equal(facts, 1, "one facts query for both lights");
  await healthFromDb(watched, {}, new Date(NOW.getTime() + MIN));
  assert.equal(facts, 2, "a later health run reads again");

  // The all-sites cap from today's chat_usage rows, summed over every site.
  await insert(DB, "settings", { key: "secret:cf_ai:account_id", value: "acc" });
  await insert(DB, "settings", { key: "secret:cf_ai:token", value: "tok" });
  await insert(DB, "settings", { key: "offer:chatbot_live", value: "1" });
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-28", messages: 700, ai_errors: 0 });
  await insert(DB, "chat_usage", { client_id: "c2", day: "2026-10-28", messages: 300, ai_errors: 0 });
  const [, chat] = await siteLightsFromDb(DB, NOW);
  assert.equal(chat.level, "amber");
  assert.match(chat.detail, /1,000 messages/);

  // routine_fires has no index: only its newest 1,000 rows are read, so a build fire 1,000 fires back no longer counts.
  const stmts = Array.from({ length: 1000 }, (_, i) =>
    DB.prepare("INSERT INTO routine_fires (id, routine, reason, http_status, at) VALUES (?, 'reply', 'reply waiting', 200, ?)")
      .bind(`r${i}`, at(-HOUR)));
  await DB.batch(stmts);
  await DB.prepare("UPDATE client_sites SET status = 'live', live_at = ?, host = 'www.smithroofing.co.uk' WHERE client_id = 'c1'")
    .bind(at(-60 * HOUR)).run();
  const [sites] = await siteLightsFromDb(DB, NOW);
  assert.equal(sites.level, "green", sites.detail);
});

test("GET /api/health shows the sites and chat lights (in a fresh process, from the route alone)", () => {
  const url = (p) => JSON.stringify(new URL(p, import.meta.url).href);
  const code = `
    import { onRequestGet } from ${url("../functions/api/health.js")};
    import { fakeD1 } from ${url("./helpers/fakeD1.mjs")};
    const DB = fakeD1();
    const body = await (await onRequestGet({ env: { DB } })).json();
    console.log(JSON.stringify(body.lights.filter((l) => l.name === "sites" || l.name === "chat")));`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
  const lights = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(lights.map((l) => [l.name, l.level]), [["sites", "grey"], ["chat", "grey"]]);
});
