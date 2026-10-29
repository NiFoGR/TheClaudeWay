// Setup → "Client sites" (stage 10, docs/rebuild/09-build.md sections 11-13, Task 27): the chatbot connection
// (Cloudflare account ID and token, write-only; the model name; Test), the Pages address (Test = DNS lookup), Nik's
// Google account for client profiles, and the two offer switches, which turn on only when sitesReadiness says so.
// Run: node --test control-room/tests/sites-setup.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getRoute, onRequestPost as postRoute } from "../functions/api/setup/sites.js";
import { sitesReadiness } from "../functions/_lib/sites/readiness.js";
import { ensureSite } from "../functions/_lib/sites/db.js";
import { getSecret, getSetting, setSecret, setSetting } from "../functions/_lib/settings.js";
import { addTodo } from "../functions/_lib/todo.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-28T10:00:00Z");
const BASE = "https://goldbarwebsites.pages.dev";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cfTokenValue_ABCDEFGHIJKLMNOPQRSTUV_123456";
const REVIEW = "https://search.google.com/local/writereview?placeid=ChIJtest";

const REASONS = {
  noTest: "Press Test on the chatbot connection first.",
  oldTest: "The last chatbot test is over a week old: press Test again.",
  noSite: "Put the test site live first (Create test client).",
};

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

/** A test client (is_test = 1), live when `live` is set, with a review link unless `review` is null. */
async function testSite(DB, { live = true, review = REVIEW, features = "{}" } = {}) {
  await insert(DB, "clients", {
    id: "cl_test_1", name: "Aetos Test Site", package: "full", build_fee_pence: 0, monthly_pence: 0, free_days: 0,
    paid_on: "2026-10-20", notes: "TEST", created_at: "2026-10-20T09:00:00Z",
  });
  await ensureSite(DB, "cl_test_1", { name: "Aetos Test Site", place_id: null, is_test: true }, new Date("2026-10-20T09:00:00Z"));
  await DB.prepare(
    `UPDATE client_sites SET host = 'site-test.aetoswebsites.com', status = ?, live_at = ?, review_url = ?, features = ?
     WHERE client_id = 'cl_test_1'`,
  ).bind(live ? "live" : "review", live ? "2026-10-27T09:00:00Z" : null, review, features).run();
}

const lastTest = (DB, at, ok = true) =>
  setSetting(DB, "chat:last_test", JSON.stringify({ at, ok, detail: ok ? "Chatbot connection works ✓ (answered in 0.8 s)" : "Cloudflare rejected the token." }));

const req = (path, { method = "POST", body } = {}) => new Request(`${BASE}${path}`, {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (DB, request, extra = {}) => ({ request, env: { DB }, now: NOW, ...extra });
const get = (DB) => getRoute(ctx(DB, req("/api/setup/sites", { method: "GET" })));
const post = (DB, query, body, extra) => postRoute(ctx(DB, req(`/api/setup/sites${query}`, { body: body ?? {} }), extra));
const todoOf = (DB, dedupe) => DB.prepare("SELECT * FROM todos WHERE dedupe = ? OR dedupe LIKE ? || '@%' ORDER BY created_at DESC LIMIT 1")
  .bind(dedupe, dedupe).first();

// A Workers AI stand-in: answers {result: {response}} and records the calls.
function fakeAi(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return status === 200
      ? new Response(JSON.stringify({ success: true, result: { response: "OK" } }), { status: 200 })
      : new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status });
  };
  return { calls, fetchImpl };
}

// A DoH stand-in: `a` = the A answer for every name, no CNAME.
function fakeDoh(a = ["172.66.44.1"], { status = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push({ name: u.searchParams.get("name"), type: u.searchParams.get("type") });
    const type = u.searchParams.get("type");
    const Answer = type === "A" ? a.map((data) => ({ type: 1, data })) : [];
    return new Response(JSON.stringify({ Status: status, Answer }), { headers: { "content-type": "application/dns-json" } });
  };
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------- GET

test("GET: secretStatus booleans only, never a secret value; the model, Pages address, Google account and switches", async () => {
  const DB = fakeD1();
  const empty = await (await get(DB)).json();
  assert.deepEqual(empty.secrets, { "cf_ai:account_id": false, "cf_ai:token": false });
  assert.equal(empty.model, "");
  assert.equal(empty.model_default, "@cf/google/gemma-3-12b-it");
  assert.equal(empty.pages_host, "");
  assert.equal(empty.pages_host_default, "goldbarwebsites.pages.dev");
  assert.equal(empty.gbp_email, "");
  assert.equal(empty.last_test, null);
  assert.deepEqual(empty.switches, { chatbot: false, review_booster: false });
  assert.equal(empty.readiness.chatbot.ready, false);
  assert.equal(empty.test_client, null);

  await setSecret(DB, "cf_ai:account_id", ACCOUNT);
  await setSecret(DB, "cf_ai:token", TOKEN);
  await setSetting(DB, "chat:model", "@cf/google/gemma-3-27b-it");
  await setSetting(DB, "offer:chatbot_live", "1");
  await lastTest(DB, "2026-10-27T09:00:00Z");
  await testSite(DB);
  const res = await get(DB);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(ACCOUNT), "the account id never leaves the server");
  assert.ok(!text.includes(TOKEN), "the token never leaves the server");
  const body = JSON.parse(text);
  assert.deepEqual(body.secrets, { "cf_ai:account_id": true, "cf_ai:token": true });
  assert.equal(body.model, "@cf/google/gemma-3-27b-it");
  assert.deepEqual(body.switches, { chatbot: true, review_booster: false });
  assert.equal(body.last_test.ok, true);
  assert.equal(body.test_client.client_id, "cl_test_1");
  assert.equal(body.test_client.live_at, "2026-10-27T09:00:00Z");
  assert.deepEqual(body.readiness, { chatbot: { ready: true }, review_booster: { ready: true } });
});

// ---------------------------------------------------------------- POST save

test("POST: saves the account id, token, model, Pages address and Google account; the answer has no secret", async () => {
  const DB = fakeD1();
  const res = await post(DB, "", {
    account_id: ` ${ACCOUNT} `, token: TOKEN, model: "@cf/google/gemma-3-27b-it",
    pages_host: "https://GoldBarWebsites.pages.dev/", gbp_email: "Nik.Aetos@Gmail.com",
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(ACCOUNT) && !text.includes(TOKEN));
  assert.deepEqual(JSON.parse(text).secrets, { "cf_ai:account_id": true, "cf_ai:token": true });
  assert.equal(await getSecret(DB, "cf_ai:account_id"), ACCOUNT);
  assert.equal(await getSecret(DB, "cf_ai:token"), TOKEN);
  assert.equal(await getSetting(DB, "chat:model"), "@cf/google/gemma-3-27b-it");
  assert.equal(await getSetting(DB, "sites:pages_host"), "goldbarwebsites.pages.dev");
  assert.equal(await getSetting(DB, "care:nik_google_email"), "nik.aetos@gmail.com");

  // Write-only: an empty secret field keeps what's saved; an empty model goes back to the default.
  await post(DB, "", { account_id: "", token: "", model: "" });
  assert.equal(await getSecret(DB, "cf_ai:token"), TOKEN);
  assert.equal(await getSetting(DB, "chat:model"), null);
});

test("POST: a bad email is 400 'That doesn't look like an email address.' and nothing is saved", async () => {
  const DB = fakeD1();
  for (const bad of ["nik", "nik@", "nik@gmail", "a b@gmail.com", "nik@gmail.com\r\nBcc: x@y.z"]) {
    const res = await post(DB, "", { token: TOKEN, gbp_email: bad });
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).error, "That doesn't look like an email address.");
  }
  assert.equal(await getSecret(DB, "cf_ai:token"), null, "all or nothing");
  assert.equal(await getSetting(DB, "care:nik_google_email"), null);
});

test("POST: bad account id, token, model or Pages address are plain-English 400s", async () => {
  const DB = fakeD1();
  const cases = [
    [{ account_id: "ACC/../../evil" }, "The Cloudflare account ID doesn't look right: copy it again from the Cloudflare dashboard."],
    [{ token: "short" }, "That doesn't look like a Cloudflare API token: make one with the 'Workers AI' template and paste it again."],
    [{ token: "has a space in it and is long enough" }, "That doesn't look like a Cloudflare API token: make one with the 'Workers AI' template and paste it again."],
    [{ model: "gemma" }, "That doesn't look like a Workers AI model name. Type it like @cf/google/gemma-3-12b-it."],
    [{ pages_host: "aetoswebsites.com" }, "That isn't a Pages address. Type it like goldbarwebsites.pages.dev."],
    [{ pages_host: "pages.dev" }, "That isn't a Pages address. Type it like goldbarwebsites.pages.dev."],
    [{ token: 42 }, "Each Client sites setting must be text."],
  ];
  for (const [body, error] of cases) {
    const res = await post(DB, "", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, error);
  }
  const junk = await postRoute(ctx(DB, new Request(`${BASE}/api/setup/sites`, { method: "POST", body: "{nope" })));
  assert.equal(junk.status, 400);
});

test("POST: saving care:nik_google_email closes setup:gbp-email", async () => {
  const DB = fakeD1();
  await addTodo(DB, { kind: "setup", dedupe: "setup:gbp-email", title: "Add the Google account clients invite as Manager", link: "/#/setup" });
  await post(DB, "", { model: "@cf/google/gemma-3-27b-it" });
  assert.equal((await todoOf(DB, "setup:gbp-email")).status, "open", "only the Google account closes it");
  await post(DB, "", { gbp_email: "nik@gmail.com" });
  assert.equal((await todoOf(DB, "setup:gbp-email")).status, "done");
});

test("POST: a new account id, token or model makes the last chat test stale", async () => {
  const DB = fakeD1();
  await lastTest(DB, "2026-10-27T09:00:00Z");
  await post(DB, "", { gbp_email: "nik@gmail.com" });
  assert.ok(await getSetting(DB, "chat:last_test"), "other fields keep it");
  await post(DB, "", { token: TOKEN });
  assert.equal(await getSetting(DB, "chat:last_test"), null);

  // The Setup form sends every field on each Save: the same model (or empty while it's the default) keeps the test.
  await lastTest(DB, "2026-10-27T09:00:00Z");
  const form = { account_id: "", token: "", model: "", pages_host: "", gbp_email: "nik@gmail.com" };
  await post(DB, "", form);
  await post(DB, "", { ...form, model: "@cf/google/gemma-3-12b-it" });
  assert.ok(await getSetting(DB, "chat:last_test"), "an unchanged model keeps the last test");
  await post(DB, "", { ...form, model: "@cf/google/gemma-3-12b-it" });
  assert.ok(await getSetting(DB, "chat:last_test"), "saving the default model again keeps it too");
  await post(DB, "", { ...form, model: "@cf/google/gemma-3-27b-it" });
  assert.equal(await getSetting(DB, "chat:last_test"), null, "a different model needs a fresh Test");
  await lastTest(DB, "2026-10-27T09:00:00Z");
  await post(DB, "", { ...form, model: "@cf/google/gemma-3-27b-it" });
  assert.ok(await getSetting(DB, "chat:last_test"), "the same non-default model keeps it");
});

// ---------------------------------------------------------------- Tests

test("POST ?test=chat: runs testModel and stores chat:last_test; a pass closes setup:chatbot", async () => {
  const DB = fakeD1();
  await setSecret(DB, "cf_ai:account_id", ACCOUNT);
  await setSecret(DB, "cf_ai:token", TOKEN);
  await addTodo(DB, { kind: "setup", dedupe: "setup:chatbot", title: "Connect the chatbot (Cloudflare Workers AI) on Setup", link: "/#/setup" });

  const rejected = fakeAi(401);
  const bad = await (await post(DB, "?test=chat", {}, { fetchImpl: rejected.fetchImpl })).json();
  assert.equal(bad.ok, false);
  assert.equal(bad.detail, "Cloudflare rejected the token. Make a new token with the 'Workers AI' template and paste it again.");
  assert.equal((await todoOf(DB, "setup:chatbot")).status, "open");

  const ai = fakeAi();
  const res = await post(DB, "?test=chat", {}, { fetchImpl: ai.fetchImpl });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.detail, /^Chatbot connection works ✓ \(answered in \d+\.\d s\)$/);
  assert.equal(ai.calls[0].body.messages.at(-1).content, "Reply with the word OK.");
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  const saved = JSON.parse(await getSetting(DB, "chat:last_test"));
  assert.equal(saved.ok, true);
  assert.equal(saved.at, "2026-10-28T10:00:00Z");
  assert.equal((await todoOf(DB, "setup:chatbot")).status, "done");
});

test("POST ?test=pages: a DNS lookup of the Pages address (saved, else the default)", async () => {
  const DB = fakeD1();
  const doh = fakeDoh();
  const ok = await (await post(DB, "?test=pages", {}, { fetchImpl: doh.fetchImpl })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "goldbarwebsites.pages.dev answers ✓: clients' www records will point here.");
  assert.ok(doh.calls.every((c) => c.name === "goldbarwebsites.pages.dev"));

  await setSetting(DB, "sites:pages_host", "aetos-sites.pages.dev");
  const missing = await (await post(DB, "?test=pages", {}, { fetchImpl: fakeDoh([], { status: 3 }).fetchImpl })).json();
  assert.equal(missing.ok, false);
  assert.equal(missing.detail,
    "aetos-sites.pages.dev doesn't lead to a Cloudflare Pages project. Copy the address from Cloudflare → Workers & Pages → your project (it ends .pages.dev).");

  const down = await (await post(DB, "?test=pages", {}, { fetchImpl: async () => { throw new TypeError("fetch failed"); } })).json();
  assert.deepEqual(down, { ok: false, detail: "Couldn't check DNS just now: will try again." });
});

// ---------------------------------------------------------------- readiness

test("sitesReadiness: no chat test → press Test; over 7 days → press Test again; no live test site → put it live", async () => {
  const DB = fakeD1();
  assert.deepEqual((await sitesReadiness(DB, NOW)).chatbot, { ready: false, reason: REASONS.noTest });

  await lastTest(DB, "2026-10-20T09:59:00Z"); // 7 days and 1 minute ago
  assert.deepEqual((await sitesReadiness(DB, NOW)).chatbot, { ready: false, reason: REASONS.oldTest });

  await lastTest(DB, "2026-10-21T10:00:00Z"); // exactly 7 days: still in
  assert.deepEqual((await sitesReadiness(DB, NOW)).chatbot, { ready: false, reason: REASONS.noSite });

  await testSite(DB, { live: false });
  const notLive = await sitesReadiness(DB, NOW);
  assert.deepEqual(notLive.chatbot, { ready: false, reason: REASONS.noSite });
  assert.deepEqual(notLive.review_booster, { ready: false, reason: REASONS.noSite });

  await DB.prepare("UPDATE client_sites SET status = 'live', live_at = '2026-10-27T09:00:00Z'").run();
  assert.deepEqual(await sitesReadiness(DB, NOW), { chatbot: { ready: true }, review_booster: { ready: true } });
});

test("sitesReadiness: a failed last test isn't a pass; a live real (not test) site doesn't count", async () => {
  const DB = fakeD1();
  await lastTest(DB, "2026-10-28T09:00:00Z", false);
  assert.deepEqual((await sitesReadiness(DB, NOW)).chatbot,
    { ready: false, reason: "The last chatbot test didn't pass: fix what it says and press Test again." });
  await setSetting(DB, "chat:last_test", "{broken");
  assert.deepEqual((await sitesReadiness(DB, NOW)).chatbot, { ready: false, reason: REASONS.noTest });

  await lastTest(DB, "2026-10-28T09:00:00Z");
  await insert(DB, "clients", {
    id: "c1", name: "Smith Roofing", package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-20", created_at: "2026-10-20T09:00:00Z",
  });
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p1" }, new Date("2026-10-20T09:00:00Z"));
  await DB.prepare("UPDATE client_sites SET status = 'live', live_at = '2026-10-27T09:00:00Z', review_url = ?").bind(REVIEW).run();
  const r = await sitesReadiness(DB, NOW);
  assert.deepEqual(r.chatbot, { ready: false, reason: REASONS.noSite });
  assert.deepEqual(r.review_booster, { ready: false, reason: REASONS.noSite });
});

test("sitesReadiness: the review booster needs the live test site's review card to render", async () => {
  const DB = fakeD1();
  await testSite(DB, { review: null });
  const noLink = await sitesReadiness(DB, NOW);
  assert.deepEqual(noLink.review_booster,
    { ready: false, reason: "The test site's review card has no QR code yet: add a Google review link on its Site page." });
  await DB.prepare("UPDATE client_sites SET review_url = 'https://example.com/review'").run();
  assert.equal((await sitesReadiness(DB, NOW)).review_booster.ready, false);
  await DB.prepare("UPDATE client_sites SET review_url = ?, features = ?").bind(REVIEW, JSON.stringify({ review_booster: false })).run();
  assert.deepEqual((await sitesReadiness(DB, NOW)).review_booster,
    { ready: false, reason: "The review booster is switched off for the test site: switch it back on on its Site page." });
  await DB.prepare("UPDATE client_sites SET features = '{}'").run();
  assert.deepEqual((await sitesReadiness(DB, NOW)).review_booster, { ready: true });
});

// ---------------------------------------------------------------- switches

test("switch: chatbot on only when ready (409 with the reason otherwise); off any time", async () => {
  const DB = fakeD1();
  const refused = await post(DB, "?switch=chatbot");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, REASONS.noTest);
  assert.equal(await getSetting(DB, "offer:chatbot_live"), null);

  await lastTest(DB, "2026-10-28T09:00:00Z");
  const noSite = await post(DB, "?switch=chatbot");
  assert.equal(noSite.status, 409);
  assert.equal((await noSite.json()).error, REASONS.noSite);

  await testSite(DB);
  const on = await post(DB, "?switch=chatbot");
  assert.equal(on.status, 200);
  assert.equal((await on.json()).switches.chatbot, true);
  assert.equal(await getSetting(DB, "offer:chatbot_live"), "1");

  // Off works whatever readiness says (here: the test is now stale).
  await lastTest(DB, "2026-10-01T09:00:00Z");
  const off = await post(DB, "?switch=chatbot&off=1");
  assert.equal(off.status, 200);
  assert.equal(await getSetting(DB, "offer:chatbot_live"), "0");
  const offAgain = await post(fakeD1(), "?switch=chatbot&off=1");
  assert.equal(offAgain.status, 200);
});

test("switch: review_booster on only when ready; off any time; an unknown switch is 400", async () => {
  const DB = fakeD1();
  const refused = await post(DB, "?switch=review_booster");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, REASONS.noSite);
  await testSite(DB);
  assert.equal((await post(DB, "?switch=review_booster")).status, 200);
  assert.equal(await getSetting(DB, "offer:review_booster_live"), "1");
  assert.equal(await getSetting(DB, "offer:chatbot_live"), null, "one switch at a time");
  assert.equal((await post(DB, "?switch=review_booster&off=1")).status, 200);
  assert.equal(await getSetting(DB, "offer:review_booster_live"), "0");

  const unknown = await post(DB, "?switch=prices");
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "There's no switch called that.");
  const test2 = await post(DB, "?test=nope");
  assert.equal(test2.status, 400);
});

// ---------------------------------------------------------------- the Setup section (pure renderer, no browser)

test("sitesHtml: 'saved ✓' never a value, switches disabled with the reason, escaped values, the test client and the Sites link", async () => {
  const stub = () => ({
    innerHTML: "", textContent: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], append() {}, prepend() {}, before() {}, remove() {},
  });
  globalThis.document ??= { getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [], body: stub() };
  globalThis.window ??= globalThis;
  globalThis.addEventListener ??= () => {};
  const { sitesHtml, SWITCH_CONFIRM } = await import("../public/js/setup.js");
  assert.equal(SWITCH_CONFIRM.chatbot, "Have the chat checks in 'Perfect when' (items 5 and 6) passed on the test site?");
  assert.equal(SWITCH_CONFIRM.review_booster, "Has the QR check in 'Perfect when' (item 7) passed?");

  const DB = fakeD1();
  await setSecret(DB, "cf_ai:token", TOKEN);
  await setSetting(DB, "care:nik_google_email", "nik+<b>@gmail.com");
  const status = await (await get(DB)).json();
  const html = sitesHtml(status, NOW);
  assert.ok(html.includes("Client sites"));
  assert.ok(html.includes("saved ✓"));
  assert.ok(!html.includes(TOKEN));
  assert.ok(html.includes("nik+&lt;b&gt;@gmail.com") && !html.includes("<b>@"));
  assert.ok(html.includes(REASONS.noTest), "the chatbot switch says why it's off");
  assert.match(html, /data-cs-switch="chatbot" disabled/);
  assert.match(html, /data-cs-switch="review_booster" disabled/);
  assert.ok(html.includes("Create test client"));
  assert.ok(html.includes('href="#/sites"') && html.includes("All client sites"));
  assert.ok(html.includes("AI receptionist (chatbot)"));

  await lastTest(DB, "2026-10-28T09:00:00Z");
  await testSite(DB);
  const ready = sitesHtml(await (await get(DB)).json(), NOW);
  assert.match(ready, /data-cs-switch="chatbot" >/);
  assert.ok(ready.includes("Delete test client"));
  assert.ok(ready.includes('href="#/site/cl_test_1"'));
  assert.ok(sitesHtml({ error: "<x>" }).includes("&lt;x&gt;"));
});
