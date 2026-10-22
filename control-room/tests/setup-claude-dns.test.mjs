// Setup API: Claude's access key and Routines, DNS checks, business details, the site check and GET /api/setup's
// status (stage 0, Task 21). Fake fetches stand in for Claude, Cloudflare's DNS-over-HTTPS and the public site
// through env.__fetch, so nothing here touches the network. Run: node --test control-room/tests/setup-claude-dns.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getSetup } from "../functions/api/setup.js";
import { onRequestPost as makeAgentToken } from "../functions/api/setup/agent-token.js";
import { onRequestGet as getBusiness, onRequestPut as putBusiness } from "../functions/api/setup/business.js";
import { onRequestGet as getDns } from "../functions/api/setup/dns.js";
import { onRequestPut as putRoutine } from "../functions/api/setup/routines/[name].js";
import { onRequestPost as testRoutine } from "../functions/api/setup/routines/[name]/test.js";
import { onRequestPost as siteCheck } from "../functions/api/setup/site-check.js";
import { DKIM_LEGACY_SELECTOR, DNS_UNREACHABLE, DnsLookupError, dnsVerdicts, dohMx, dohTxt } from "../functions/_lib/dns.js";
import { requireAgent } from "../functions/_lib/agentAuth.js";
import { ROUTINES } from "../functions/_lib/routines.js";
import { getSetting, setSecret, setSetting } from "../functions/_lib/settings.js";
import { loadSetupStatus, setupGaps } from "../functions/_lib/setupStatus.js";
import { rootHostFor } from "../functions/_lib/site.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const URL_OK = "https://api.anthropic.com/v1/claude_code/routines/trig_01AbC9xyz/fire";
const URL_NEW = "https://api.anthropic.com/v1/claude_code/routines/trig_02NewOne/fire";
const TOKEN_OK = "sk-ant-oat01-SecretRoutineToken_123";
const MAILBOX_PASSWORD = "MailboxPassw0rd!";

const URL_ERROR = "That isn't a Routine fire URL. In Claude: open the Routine → Edit → API trigger → copy the URL that ends in /fire.";
const TOKEN_ERROR = "That isn't a Routine token (they start with sk-ant-oat01-). Generate one in the Routine's API trigger and paste it straight away: it's only shown once.";
const DNS_DOWN = "Couldn't check DNS right now (Cloudflare's DNS lookup didn't answer). Try again in a minute.";
const LIVE = "The landing page is live.";
const NOT_LIVE = "aetoswebsites.com doesn't show the landing page yet: Cloudflare → Workers & Pages → your Control Room project → Custom domains → add aetoswebsites.com and www.aetoswebsites.com.";
const TEST_TEXT = "Test from the Control Room Setup page: post your heartbeat and stop.";
const SPF_NAMECHEAP = "v=spf1 include:spf.privateemail.com ~all";
const SPF_BOTH = "v=spf1 include:spf.privateemail.com include:_spf.mx.cloudflare.net ~all";
const DMARC_SUGGESTED = "v=DMARC1; p=none; rua=mailto:hello@aetoswebsites.com";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const request = (url, method, body) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

async function call(handler, ctx) {
  const res = await handler(ctx);
  const text = await res.text();
  return { status: res.status, text, data: JSON.parse(text), headers: res.headers };
}

const setting = (DB, key) => DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
const count = (DB, table) => DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");

const newToken = (env) => call(makeAgentToken, { request: request("https://control.x/api/setup/agent-token", "POST"), env });
const saveRoutine = (env, name, body) =>
  call(putRoutine, { request: request(`https://control.x/api/setup/routines/${name}`, "PUT", body), env, params: { name } });
const fireTest = (env, name) =>
  call(testRoutine, { request: request(`https://control.x/api/setup/routines/${name}/test`, "POST", {}), env, params: { name } });
const checkDns = (env, domain) =>
  call(getDns, { request: new Request(`https://control.x/api/setup/dns${domain === undefined ? "" : `?domain=${encodeURIComponent(domain)}`}`), env });
const readBusiness = (env) => call(getBusiness, { request: new Request("https://control.x/api/setup/business"), env });
const saveBusiness = (env, body) => call(putBusiness, { request: request("https://control.x/api/setup/business", "PUT", body), env });
const checkSite = (env) => call(siteCheck, { request: request("https://control.x/api/setup/site-check", "POST", {}), env });
const readSetup = (env) => call(getSetup, { request: new Request("https://control.x/api/setup"), env });

// A fake fetch that records every call and answers with `answer(url, init)` (a Response, or throws).
function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init);
  };
  return { calls, fetchImpl };
}

// A fake Cloudflare DoH server. `records` maps "name/TYPE" to the DoH `data` strings it returns (TXT as DoH sends it,
// quoted; MX as "priority host."). A name/type that isn't listed is NXDOMAIN (Status 3).
const TYPE_CODES = { TXT: 16, MX: 15, CNAME: 5 };
function fakeDoh(records) {
  return fakeFetch((url) => {
    const u = new URL(url);
    const name = u.searchParams.get("name");
    const type = u.searchParams.get("type");
    const data = records[`${name}/${type}`];
    if (data === undefined) return Response.json({ Status: 3, Question: [{ name, type: TYPE_CODES[type] }] });
    return Response.json({
      Status: 0,
      Question: [{ name, type: TYPE_CODES[type] }],
      Answer: data.map((d) => ({ name: `${name}.`, type: TYPE_CODES[type], TTL: 300, data: d })),
    });
  });
}

// aetoswebsites.com with every record right: SPF, a 2048-bit DKIM split in two strings, DMARC and Namecheap's MX.
const GOOD_DNS = {
  "aetoswebsites.com/TXT": [`"${SPF_NAMECHEAP}"`, '"google-site-verification=abc123"'],
  "privateemail._domainkey.aetoswebsites.com/TXT": ['"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOC" "AQ8AMIIBCgKCAQEAx2Lp"'],
  "_dmarc.aetoswebsites.com/TXT": [`"${DMARC_SUGGESTED}"`],
  "aetoswebsites.com/MX": ["10 mx1.privateemail.com.", "10 mx2.privateemail.com."],
};

async function addMailbox(DB, id = "m1", address = "nik@aetoswebsites.com") {
  await DB.prepare(
    "INSERT INTO mailboxes (id, address, display_name, role, started_on, status, created_at) VALUES (?, ?, 'Nik', 'cold', '2026-10-19', 'active', '2026-10-19T09:00:00Z')",
  ).bind(id, address).run();
}

// ---------------------------------------------------------------- agent token (Step 1)

test("the agent token is 32 random bytes as base64url, stored, and GET /api/setup never shows it or any other secret", async () => {
  const env = { DB: fakeD1() };
  const r = await newToken(env);
  assert.equal(r.status, 200, r.text);
  const { token } = r.data;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await setting(env.DB, "secret:agent_token"), token);
  assert.equal(r.headers.get("cache-control"), "no-store");

  await addMailbox(env.DB);
  await setSecret(env.DB, "mailbox:m1", MAILBOX_PASSWORD);
  await setSecret(env.DB, "routine:research:url", URL_OK);
  await setSecret(env.DB, "routine:research:token", TOKEN_OK);

  const setup = await readSetup(env);
  assert.equal(setup.status, 200, setup.text);
  for (const secret of [token, MAILBOX_PASSWORD, TOKEN_OK, URL_OK, "trig_01AbC9xyz"]) {
    assert.ok(!setup.text.includes(secret), `GET /api/setup leaks ${secret.slice(0, 12)}…`);
  }
});

test("each press makes a new token, records when it was made, and the new one is the one Claude must send", async () => {
  const env = { DB: fakeD1() };
  const first = (await newToken(env)).data.token;
  const second = (await newToken(env)).data.token;
  assert.notEqual(first, second);
  assert.equal(await setting(env.DB, "secret:agent_token"), second);
  assert.match(await setting(env.DB, "agent_token:created_at"), ISO);

  const asClaude = (t) => new Request("https://control.x/api/agent/heartbeat", { method: "POST", headers: { authorization: `Bearer ${t}` } });
  assert.equal(await requireAgent(asClaude(second), {}, env.DB), null);
  assert.equal((await requireAgent(asClaude(first), {}, env.DB)).status, 401, "replacing the key stops the old one");

  const status = await loadSetupStatus(env.DB, env, new Date());
  assert.equal(status.agent_token.set, true);
  assert.match(status.agent_token.created_at, ISO);
  assert.ok(!setupGaps(status).some((g) => g.key === "agent_token"));
});

// ---------------------------------------------------------------- GET /api/setup

test("GET /api/setup keeps the database, GitHub and Stripe checks and adds the status and gaps", async () => {
  const env = { DB: fakeD1() };
  await addMailbox(env.DB);
  await setSecret(env.DB, "routine:research:url", URL_OK);
  await setSecret(env.DB, "routine:research:token", TOKEN_OK);
  const r = await readSetup(env);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.checks.map((c) => c.name), ["Password", "Database (Cloudflare D1)", "Scraper connection (GitHub)", "Payments (Stripe)"]);
  assert.equal(r.data.checks[1].ok, true);
  assert.equal(r.data.checks[2].ok, false);
  assert.match(r.data.checks[2].fix, /GITHUB_TOKEN and GITHUB_REPO/);
  assert.equal(r.data.checks[3].ok, false);
  assert.match(r.data.note, /Google Places and Companies House/);

  const { status, gaps } = r.data;
  assert.equal(status.mailboxes.length, 1);
  assert.equal(status.mailboxes[0].has_password, false);
  assert.equal(status.routines.find((x) => x.name === "research").connected, true);
  assert.equal(status.agent_token.set, false);
  assert.equal(status.business.contact_email, "hello@aetoswebsites.com");
  assert.deepEqual(gaps.map((g) => g.key), [
    "mailbox_password:m1", "dns:aetoswebsites.com", "agent_token",
    "routine:reply", "routine:weekly-kpis", "routine:build", "routine:monthly-care", "business",
  ]);
  for (const g of gaps) assert.equal(g.link, "/#/setup");
  assert.ok(!("status_error" in r.data));
});

test("GET /api/setup without a database still answers: the checks say how to fix it and status_error says why", async () => {
  const r = await readSetup({});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.checks[1].ok, false);
  assert.match(r.data.checks[1].fix, /add a D1 database called DB/);
  assert.equal(r.data.status, null);
  assert.deepEqual(r.data.gaps, []);
  assert.match(r.data.status_error, /^Couldn't read the setup status: The database isn't connected/);
});

// ---------------------------------------------------------------- Routine URL and token (Step 1)

test("saving a Routine: a bad URL or token is refused with Part A's text, valid ones connect it, an unknown name is 404", async () => {
  const env = { DB: fakeD1() };
  const badUrl = await saveRoutine(env, "research", { url: "https://evil.com/fire" });
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.data.error, URL_ERROR);
  const badToken = await saveRoutine(env, "research", { token: "abc" });
  assert.equal(badToken.status, 400);
  assert.equal(badToken.data.error, TOKEN_ERROR);
  assert.equal(await count(env.DB, "settings"), 0, "nothing refused is saved");

  const ok = await saveRoutine(env, "research", { url: URL_OK, token: TOKEN_OK });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.data, { connected: true });
  assert.equal(await setting(env.DB, "secret:routine:research:url"), URL_OK);
  assert.equal(await setting(env.DB, "secret:routine:research:token"), TOKEN_OK);
  assert.ok(!ok.text.includes(TOKEN_OK));

  const unknown = await saveRoutine(env, "nope", { url: URL_OK, token: TOKEN_OK });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, "Unknown routine");
});

test("a Routine's URL and token can be saved one at a time; a blank field keeps what's saved", async () => {
  const env = { DB: fakeD1() };
  assert.deepEqual((await saveRoutine(env, "weekly-kpis", { url: ` ${URL_OK} ` })).data, { connected: false });
  assert.equal(await setting(env.DB, "secret:routine:weekly-kpis:url"), URL_OK, "trimmed");
  assert.deepEqual((await saveRoutine(env, "weekly-kpis", { url: "", token: `${TOKEN_OK}\n` })).data, { connected: true });
  assert.equal(await setting(env.DB, "secret:routine:weekly-kpis:token"), TOKEN_OK);
  const blank = await saveRoutine(env, "weekly-kpis", { url: null, token: "  " });
  assert.equal(blank.status, 400, "both blank is nothing to save");
  assert.equal(await setting(env.DB, "secret:routine:weekly-kpis:url"), URL_OK);
  assert.equal(await setting(env.DB, "secret:routine:weekly-kpis:token"), TOKEN_OK);

  const status = await loadSetupStatus(env.DB, env, new Date());
  assert.equal(status.routines.find((r) => r.name === "weekly-kpis").connected, true);
  assert.ok(!setupGaps(status).some((g) => g.key === "routine:weekly-kpis"));
});

test("Routine saves refuse odd input in plain English and save nothing", async () => {
  const env = { DB: fakeD1() };
  for (const [body, error] of [
    [{ url: 42 }, URL_ERROR],
    [{ url: `${URL_OK}?x=1` }, URL_ERROR],
    [{ url: URL_OK.replace("https", "http") }, URL_ERROR],
    [{ token: 42 }, TOKEN_ERROR],
    [{ token: "sk-ant-oat01-" }, TOKEN_ERROR],
    [{ token: "sk-ant-oat01-abc def" }, TOKEN_ERROR],
    [{ token: "sk-ant-oat01-abc\r\nx-evil: 1" }, TOKEN_ERROR],
    [{ url: URL_OK, token: "sk-ant-api03-abc" }, TOKEN_ERROR],
  ]) {
    const r = await saveRoutine(env, "reply", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, error, JSON.stringify(body));
  }
  const empty = await saveRoutine(env, "reply", {});
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, "Nothing to save: paste the Routine's fire URL and its token, then press Save.");
  const notJson = await saveRoutine(env, "reply", "not json");
  assert.equal(notJson.status, 400);
  assert.match(notJson.data.error, /couldn't be read/);
  assert.equal(await count(env.DB, "settings"), 0);
});

test("pasting a new fire URL clears the old trigger's 429 hold; a new token alone keeps it", async () => {
  const env = { DB: fakeD1() };
  await saveRoutine(env, "reply", { url: URL_OK, token: TOKEN_OK });
  await setSetting(env.DB, "routine:reply:retry_after", "2099-01-01T00:00:00Z");
  await saveRoutine(env, "reply", { token: "sk-ant-oat01-another" });
  assert.equal(await setting(env.DB, "routine:reply:retry_after"), "2099-01-01T00:00:00Z");
  await saveRoutine(env, "reply", { url: URL_OK });
  assert.equal(await setting(env.DB, "routine:reply:retry_after"), "2099-01-01T00:00:00Z", "the same URL is the same trigger");
  await saveRoutine(env, "reply", { url: URL_NEW });
  assert.equal(await setting(env.DB, "routine:reply:retry_after"), "");
});

// ---------------------------------------------------------------- Test fire

test("Test fire sends the standard test payload to the saved URL and returns the fireRoutine result", async () => {
  const claude = fakeFetch(() => Response.json({ type: "routine_fire", claude_code_session_id: "session_abc" }));
  const env = { DB: fakeD1(), __fetch: claude.fetchImpl };
  await saveRoutine(env, "build", { url: URL_OK, token: TOKEN_OK });
  const r = await fireTest(env, "build");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data, { ok: true, status: 200, session_url: "https://claude.ai/code/session_abc" });
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].url, URL_OK);
  assert.equal(claude.calls[0].init.method, "POST");
  assert.equal(claude.calls[0].init.headers.authorization, `Bearer ${TOKEN_OK}`);
  assert.deepEqual(JSON.parse(claude.calls[0].init.body), { text: TEST_TEXT });
  assert.ok(!r.text.includes(TOKEN_OK));
  const fire = await env.DB.prepare("SELECT routine, reason, http_status, error FROM routine_fires").first();
  assert.deepEqual(fire, { routine: "build", reason: TEST_TEXT, http_status: 200, error: null });
});

test("Test fire on a Routine that isn't connected says so without calling Claude; a rejected token gives Part A's text", async () => {
  const claude = fakeFetch(() => new Response("{}", { status: 401 }));
  const env = { DB: fakeD1(), __fetch: claude.fetchImpl };
  const notConnected = await fireTest(env, "monthly-care");
  assert.equal(notConnected.status, 200);
  assert.deepEqual(notConnected.data, {
    ok: false, status: null, error: "The Monthly care Routine isn't connected: paste its URL and token on Setup → Claude.",
  });
  assert.equal(claude.calls.length, 0);

  await saveRoutine(env, "monthly-care", { url: URL_OK, token: TOKEN_OK });
  const rejected = await fireTest(env, "monthly-care");
  assert.equal(rejected.data.ok, false);
  assert.equal(rejected.data.status, 401);
  assert.equal(rejected.data.error, "Claude rejected the token: generate a new one in the Routine (Edit → API trigger) and paste it on Setup.");

  const unknown = await fireTest(env, "nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, "Unknown routine");
  assert.equal(claude.calls.length, 1);
});

test("every Routine in ROUTINES can be saved and test-fired by its name", async () => {
  const claude = fakeFetch(() => Response.json({ session_url: "https://claude.ai/code/s1" }));
  const env = { DB: fakeD1(), __fetch: claude.fetchImpl };
  for (const { name } of ROUTINES) {
    assert.deepEqual((await saveRoutine(env, name, { url: URL_OK, token: TOKEN_OK })).data, { connected: true }, name);
    assert.equal((await fireTest(env, name)).data.ok, true, name);
  }
  assert.equal(claude.calls.length, ROUTINES.length);
});

// ---------------------------------------------------------------- dnsVerdicts (Step 1)

const DKIM_OK = ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx2Lp"];
const verdicts = (over = {}) => dnsVerdicts({
  domain: "aetoswebsites.com", root: [SPF_NAMECHEAP], mx: ["mx1.privateemail.com", "mx2.privateemail.com"],
  dkim: DKIM_OK, dmarc: ["v=DMARC1; p=none"], contactEmail: "hello@aetoswebsites.com", ...over,
});
const check = (v, name) => v.checks.find((c) => c.name === name);

test("dnsVerdicts: SPF with Namecheap's include passes; the result has SPF, DKIM and DMARC checks and an MX note", () => {
  const v = verdicts();
  assert.equal(v.ok, true);
  assert.deepEqual(v.checks.map((c) => c.name), ["SPF", "DKIM", "DMARC"]);
  for (const c of v.checks) {
    assert.deepEqual(Object.keys(c).sort(), ["fix", "found", "name", "ok", "record"]);
    assert.equal(c.ok, true);
    assert.equal(c.fix, "");
  }
  assert.equal(check(v, "SPF").found, SPF_NAMECHEAP);
  assert.equal(v.mx_note, "Mail to aetoswebsites.com goes to Namecheap (mx1/mx2.privateemail.com)");
});

test("dnsVerdicts: two SPF records fail with \"Merge them into one\"", () => {
  const v = verdicts({ root: [SPF_NAMECHEAP, "v=spf1 include:_spf.google.com ~all"] });
  const spf = check(v, "SPF");
  assert.equal(v.ok, false);
  assert.equal(spf.ok, false);
  assert.equal(spf.fix, "You have 2 SPF records. Merge them into one.");
  assert.equal(spf.found, `${SPF_NAMECHEAP}\nv=spf1 include:_spf.google.com ~all`);
  assert.equal(spf.record.content, SPF_NAMECHEAP);
});

test("dnsVerdicts: SPF without Namecheap's include fails, and its fix gives the record to use", () => {
  for (const root of [[], ["v=spf1 ~all"], ["google-site-verification=abc"], ["v=spf1 include:_spf.google.com ~all"]]) {
    const spf = check(verdicts({ root }), "SPF");
    assert.equal(spf.ok, false, JSON.stringify(root));
    assert.ok(spf.fix.includes("v=spf1 include:spf.privateemail.com ~all"), spf.fix);
    assert.equal(spf.record.type, "TXT");
    assert.equal(spf.record.name, "@");
    assert.ok(spf.fix.endsWith(spf.record.content), "the fix ends with the exact content to paste, no full stop after it");
  }
  for (const root of [[], ["v=spf1 ~all"], ["google-site-verification=abc"]]) {
    assert.deepEqual(check(verdicts({ root }), "SPF").record, { type: "TXT", name: "@", content: SPF_NAMECHEAP });
  }
  const none = check(verdicts({ root: [] }), "SPF");
  assert.equal(none.found, "");
  assert.equal(none.fix, `In Cloudflare → aetoswebsites.com → DNS → Add record: type TXT, name @, content ${SPF_NAMECHEAP}`);
  const edit = check(verdicts({ root: ["v=spf1 ~all"] }), "SPF");
  assert.equal(edit.fix, `In Cloudflare → aetoswebsites.com → DNS, edit your SPF record (TXT, name @). Never add a second SPF record. Its content should be: ${SPF_NAMECHEAP}`);

  // An SPF record that already lists another sender is edited, never replaced: that sender and its own "all" stay.
  const keep = check(verdicts({ root: ["v=spf1 include:_spf.google.com -all"] }), "SPF");
  const merged = "v=spf1 include:spf.privateemail.com include:_spf.google.com -all";
  assert.equal(keep.record.content, merged);
  assert.equal(keep.fix, `In Cloudflare → aetoswebsites.com → DNS, edit your SPF record (TXT, name @). Never add a second SPF record. The record you need is ${SPF_NAMECHEAP}, but keep the other senders it already lists (include:_spf.google.com), so its content should be: ${merged}`);
  assert.equal(check(verdicts({ root: ["v=spf1 ip4:192.0.2.1 ~all"] }), "SPF").record.content, "v=spf1 include:spf.privateemail.com ip4:192.0.2.1 ~all");
  assert.match(check(verdicts({ root: ["v=spf1 -all"] }), "SPF").fix, /but keep its -all, so its content should be: v=spf1 include:spf\.privateemail\.com -all$/);
  assert.equal(check(verdicts({ root: ["v=spf1 redirect=_spf.example.net"] }), "SPF").record.content,
    "v=spf1 include:spf.privateemail.com redirect=_spf.example.net", "no ~all added in front of a redirect (it would switch the redirect off)");

  const softInclude = check(verdicts({ root: ["v=spf1 ~include:spf.privateemail.com ~all"] }), "SPF");
  assert.equal(softInclude.ok, false, "a ~include doesn't authorise Namecheap");
  assert.equal(softInclude.record.content, SPF_NAMECHEAP, "the soft include is replaced, not kept as well");
});

test("dnsVerdicts: with Cloudflare's MX the SPF must carry both includes, and the MX note says Cloudflare", () => {
  const v = verdicts({ mx: ["route1.mx.cloudflare.net"], root: [SPF_NAMECHEAP] });
  const spf = check(v, "SPF");
  assert.equal(spf.ok, false);
  assert.ok(spf.fix.includes("include:_spf.mx.cloudflare.net"), spf.fix);
  assert.equal(spf.record.content, SPF_BOTH);
  assert.equal(v.mx_note, "Mail to aetoswebsites.com goes to Cloudflare Email Routing");

  const cfOnly = check(verdicts({ mx: ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"], root: ["v=spf1 include:_spf.mx.cloudflare.net ~all"] }), "SPF");
  assert.equal(cfOnly.ok, false);
  assert.ok(cfOnly.fix.includes(SPF_BOTH), cfOnly.fix);

  const both = verdicts({ mx: ["route1.mx.cloudflare.net."], root: [SPF_BOTH] });
  assert.equal(check(both, "SPF").ok, true);
  assert.equal(both.ok, true);
});

test("dnsVerdicts: DKIM with a key passes; none, an empty key or two records fail with the Namecheap steps", () => {
  assert.equal(check(verdicts({ dkim: ["v=DKIM1; k=rsa; p=MIIB…"] }), "DKIM").ok, true);
  assert.equal(check(verdicts({ dkim: ["k=rsa; p=MIIBIjANBg"] }), "DKIM").ok, true, "v= is optional in DKIM");
  const none = check(verdicts({ dkim: [] }), "DKIM");
  assert.equal(none.ok, false);
  assert.equal(none.found, "");
  assert.deepEqual(none.record, {
    type: "TXT", name: "privateemail._domainkey",
    content: "the DKIM value Namecheap shows for your domain (Namecheap → Private Email → Manage → DNS records)",
  });
  assert.equal(none.fix, "In Cloudflare → aetoswebsites.com → DNS → Add record: type TXT, name privateemail._domainkey, content the DKIM value Namecheap shows for your domain (Namecheap → Private Email → Manage → DNS records)");
  assert.equal(check(verdicts({ dkim: ["v=DKIM1; k=rsa; p="] }), "DKIM").ok, false, "a revoked (empty) key");
  assert.equal(check(verdicts({ dkim: ["v=DKIM2; p=MIIB"] }), "DKIM").ok, false);
  const two = check(verdicts({ dkim: [DKIM_OK[0], "v=DKIM1; p=OLDKEY"] }), "DKIM");
  assert.equal(two.ok, false);
  assert.match(two.fix, /^You have 2 DKIM records at privateemail\._domainkey\./);
});

// Namecheap subscriptions bought before 2 June 2026 put the DKIM key at default._domainkey; later ones at
// privateemail._domainkey. A record at privateemail._domainkey, valid or not, is the one judged.
const DKIM_FIX_NONE = "In Cloudflare → aetoswebsites.com → DNS → Add record: type TXT, name privateemail._domainkey, content the DKIM value Namecheap shows for your domain (Namecheap → Private Email → Manage → DNS records)";

test("dnsVerdicts: DKIM at default._domainkey (older Namecheap subscriptions) passes when privateemail._domainkey has none", () => {
  assert.equal(DKIM_LEGACY_SELECTOR, "default._domainkey");
  const legacy = check(verdicts({ dkim: [], dkimLegacy: DKIM_OK }), "DKIM");
  assert.equal(legacy.ok, true);
  assert.equal(legacy.found, DKIM_OK[0]);
  assert.equal(legacy.record.name, "default._domainkey");
  // Neither: Part A's fix and record, unchanged.
  const none = check(verdicts({ dkim: [], dkimLegacy: [] }), "DKIM");
  assert.equal(none.ok, false);
  assert.equal(none.fix, DKIM_FIX_NONE);
  assert.equal(none.record.name, "privateemail._domainkey");
  assert.equal(check(verdicts({ dkim: [] }), "DKIM").fix, DKIM_FIX_NONE, "no dkimLegacy given means none");
  // privateemail._domainkey wins whenever it has a record.
  const both = check(verdicts({ dkim: DKIM_OK, dkimLegacy: ["anything"] }), "DKIM");
  assert.equal(both.ok, true);
  assert.equal(both.record.name, "privateemail._domainkey");
  assert.equal(both.found, DKIM_OK[0]);
  // A broken privateemail record is never passed over for the old selector.
  const revoked = check(verdicts({ dkim: ["v=DKIM1; p="], dkimLegacy: DKIM_OK }), "DKIM");
  assert.equal(revoked.ok, false);
  assert.match(revoked.fix, /^The DKIM record at privateemail\._domainkey has no valid key\./);
  // Two records at the old selector: named there.
  const two = check(verdicts({ dkim: [], dkimLegacy: [DKIM_OK[0], "v=DKIM1; p=OLDKEY"] }), "DKIM");
  assert.equal(two.ok, false);
  assert.match(two.fix, /^You have 2 DKIM records at default\._domainkey\./);
  assert.equal(two.record.name, "default._domainkey");
  const bad = check(verdicts({ dkim: [], dkimLegacy: ["v=DKIM1; p="] }), "DKIM");
  assert.match(bad.fix, /^The DKIM record at default\._domainkey has no valid key\./);
});

test("dnsVerdicts: DMARC with a policy passes; a missing one suggests p=none with reports to the contact email", () => {
  assert.equal(check(verdicts({ dmarc: ["v=DMARC1; p=none"] }), "DMARC").ok, true);
  assert.equal(check(verdicts({ dmarc: ["v=DMARC1;p=reject;rua=mailto:x@y.com"] }), "DMARC").ok, true);
  const missing = check(verdicts({ dmarc: [], contactEmail: undefined }), "DMARC");
  assert.equal(missing.ok, false);
  assert.equal(missing.record.content, DMARC_SUGGESTED);
  assert.equal(missing.fix, `In Cloudflare → aetoswebsites.com → DNS → Add record: type TXT, name _dmarc, content ${DMARC_SUGGESTED}`);
  assert.equal(check(verdicts({ dmarc: [], contactEmail: "nik@aetoswebsites.com" }), "DMARC").record.content,
    "v=DMARC1; p=none; rua=mailto:nik@aetoswebsites.com");
  for (const contactEmail of ["", "  ", "not an address", "a@b.com; p=reject"]) {
    assert.equal(check(verdicts({ dmarc: [], contactEmail }), "DMARC").record.content, DMARC_SUGGESTED,
      `${JSON.stringify(contactEmail)} isn't a plain address, so reports go to the default, as on the landing page`);
  }
  const noPolicy = check(verdicts({ dmarc: ["v=DMARC1; rua=mailto:x@y.com"] }), "DMARC");
  assert.equal(noPolicy.ok, false);
  assert.ok(noPolicy.fix.includes(DMARC_SUGGESTED));
  assert.equal(check(verdicts({ dmarc: ["v=dmarc1; p=none"] }), "DMARC").ok, false, "DMARC1 is case-sensitive");
  const two = check(verdicts({ dmarc: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] }), "DMARC");
  assert.equal(two.ok, false);
  assert.match(two.fix, /^You have 2 DMARC records\. Merge them into one: /);
});

test("dnsVerdicts: the MX note for no records, for another provider, and for priority-prefixed answers", () => {
  assert.equal(verdicts({ mx: [] }).mx_note, "No MX records");
  assert.equal(verdicts({ mx: ["0 ."] }).mx_note, "No MX records", "a null MX means no mail");
  assert.equal(verdicts({ mx: ["aspmx.l.google.com"] }).mx_note, "Mail to aetoswebsites.com goes to aspmx.l.google.com");
  assert.equal(verdicts({ mx: ["10 MX1.PrivateEmail.com."] }).mx_note, "Mail to aetoswebsites.com goes to Namecheap (mx1/mx2.privateemail.com)");
  assert.equal(verdicts({ mx: [] }).ok, true, "the MX line is information, not a check");
});

// ---------------------------------------------------------------- DNS-over-HTTPS (Step 1)

test("dohTxt joins a TXT record's quoted chunks and asks Cloudflare's DoH for JSON", async () => {
  const doh = fakeFetch(() => Response.json({ Answer: [{ data: '"v=DKIM1; p=AAA" "BBB"' }] }));
  assert.deepEqual(await dohTxt("privateemail._domainkey.aetoswebsites.com", { fetchImpl: doh.fetchImpl }), ["v=DKIM1; p=AAABBB"]);
  assert.equal(doh.calls[0].url, "https://cloudflare-dns.com/dns-query?name=privateemail._domainkey.aetoswebsites.com&type=TXT");
  assert.equal(doh.calls[0].init.headers.accept, "application/dns-json");
  assert.ok(doh.calls[0].init.signal instanceof AbortSignal, "the lookup has a timeout");
});

test("dohTxt: NXDOMAIN and an empty answer are no records", async () => {
  const nx = fakeFetch(() => Response.json({ Status: 3 }));
  assert.deepEqual(await dohTxt("_dmarc.nowhere.example", { fetchImpl: nx.fetchImpl }), []);
  const nodata = fakeFetch(() => Response.json({ Status: 0 }));
  assert.deepEqual(await dohTxt("_dmarc.aetoswebsites.com", { fetchImpl: nodata.fetchImpl }), []);
});

test("dohTxt reads escapes, unquoted answers and skips the CNAME records in a chain", async () => {
  const doh = fakeFetch(() => Response.json({
    Status: 0,
    Answer: [
      { name: "_dmarc.aetoswebsites.com.", type: 5, data: "_dmarc.elsewhere.net." },
      { name: "_dmarc.elsewhere.net.", type: 16, data: '"say \\"hi\\" \\\\ ok" "\\059 done"' },
      { name: "_dmarc.elsewhere.net.", type: 16, data: "v=spf1 -all" },
    ],
  }));
  assert.deepEqual(await dohTxt("_dmarc.aetoswebsites.com", { fetchImpl: doh.fetchImpl }), ['say "hi" \\ ok; done', "v=spf1 -all"]);
});

test("dohMx returns the mail hosts, most preferred first, lower-cased and without the trailing dot", async () => {
  const doh = fakeFetch(() => Response.json({
    Status: 0,
    Answer: [{ type: 15, data: "20 MX2.privateemail.com." }, { type: 15, data: "10 mx1.privateemail.com." }],
  }));
  assert.deepEqual(await dohMx("aetoswebsites.com", { fetchImpl: doh.fetchImpl }), ["mx1.privateemail.com", "mx2.privateemail.com"]);
  assert.equal(doh.calls[0].url, "https://cloudflare-dns.com/dns-query?name=aetoswebsites.com&type=MX");
});

test("a DoH lookup that fails, errors, or doesn't answer in time throws DnsLookupError with the plain-English text", async () => {
  for (const answer of [
    () => Response.json({ Status: 2 }), // SERVFAIL
    () => new Response("busy", { status: 503 }),
    () => new Response("<html>not json</html>", { status: 200 }),
    () => { throw new TypeError("fetch failed"); },
  ]) {
    const doh = fakeFetch(answer);
    await assert.rejects(dohTxt("aetoswebsites.com", { fetchImpl: doh.fetchImpl }), (err) => {
      assert.ok(err instanceof DnsLookupError);
      assert.equal(err.message, DNS_UNREACHABLE);
      return true;
    });
  }
  // A lookup that never answers is cut off by its timeout. (Node's AbortSignal.timeout timer doesn't keep the process
  // alive on its own, so a plain timer does while we wait.)
  const hang = fakeFetch((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(dohMx("aetoswebsites.com", { fetchImpl: hang.fetchImpl, timeoutMs: 20 }), DnsLookupError);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(DNS_UNREACHABLE, DNS_DOWN);
});

// ---------------------------------------------------------------- GET /api/setup/dns

test("the DNS route checks the 5 records, caches the verdicts in dns:last:<domain>, and Setup's status reads them", async () => {
  const doh = fakeDoh(GOOD_DNS);
  const env = { DB: fakeD1(), __fetch: doh.fetchImpl };
  await addMailbox(env.DB);
  const r = await checkDns(env, "AetosWebsites.com");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.domain, "aetoswebsites.com");
  assert.equal(r.data.ok, true);
  assert.match(r.data.at, ISO);
  assert.deepEqual(r.data.checks.map((c) => [c.name, c.ok]), [["SPF", true], ["DKIM", true], ["DMARC", true]]);
  assert.equal(r.data.checks[1].found, "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx2Lp");
  assert.equal(r.data.mx_note, "Mail to aetoswebsites.com goes to Namecheap (mx1/mx2.privateemail.com)");
  assert.deepEqual(doh.calls.map((c) => c.url).sort(), [
    "https://cloudflare-dns.com/dns-query?name=_dmarc.aetoswebsites.com&type=TXT",
    "https://cloudflare-dns.com/dns-query?name=aetoswebsites.com&type=MX",
    "https://cloudflare-dns.com/dns-query?name=aetoswebsites.com&type=TXT",
    "https://cloudflare-dns.com/dns-query?name=default._domainkey.aetoswebsites.com&type=TXT",
    "https://cloudflare-dns.com/dns-query?name=privateemail._domainkey.aetoswebsites.com&type=TXT",
  ]);

  const cached = JSON.parse(await setting(env.DB, "dns:last:aetoswebsites.com"));
  assert.deepEqual(cached, { at: r.data.at, ok: true, checks: r.data.checks, mx_note: r.data.mx_note });
  const status = await loadSetupStatus(env.DB, env, new Date());
  assert.equal(status.dns["aetoswebsites.com"].ok, true);
  assert.ok(!setupGaps(status).some((g) => g.key.startsWith("dns:")), "the DNS gap closes once every record is ✓");
});

test("the DNS route finds DKIM at default._domainkey for an older Namecheap subscription, and caches it as ok", async () => {
  const legacy = { ...GOOD_DNS, "privateemail._domainkey.aetoswebsites.com/TXT": undefined,
    "default._domainkey.aetoswebsites.com/TXT": GOOD_DNS["privateemail._domainkey.aetoswebsites.com/TXT"] };
  const env = { DB: fakeD1(), __fetch: fakeDoh(legacy).fetchImpl };
  const r = await checkDns(env, "aetoswebsites.com");
  assert.equal(r.status, 200, r.text);
  const dkim = r.data.checks.find((c) => c.name === "DKIM");
  assert.equal(dkim.ok, true);
  assert.equal(dkim.record.name, "default._domainkey");
  assert.equal(r.data.ok, true);
  assert.equal(JSON.parse(await setting(env.DB, "dns:last:aetoswebsites.com")).ok, true);
});

test("the DNS route's DMARC suggestion uses the contact email from Business details", async () => {
  const doh = fakeDoh({ ...GOOD_DNS, "_dmarc.aetoswebsites.com/TXT": undefined });
  const env = { DB: fakeD1(), __fetch: doh.fetchImpl };
  await setSetting(env.DB, "site:contact_email", "nik@aetoswebsites.com");
  const r = await checkDns(env, "aetoswebsites.com");
  assert.equal(r.data.ok, false);
  assert.equal(r.data.checks[2].record.content, "v=DMARC1; p=none; rua=mailto:nik@aetoswebsites.com");
  assert.equal(JSON.parse(await setting(env.DB, "dns:last:aetoswebsites.com")).ok, false);
});

test("a DoH timeout makes the DNS route answer 502 with Part A's text, and the last good check is kept", async () => {
  const env = { DB: fakeD1(), __fetch: fakeDoh(GOOD_DNS).fetchImpl };
  await checkDns(env, "aetoswebsites.com");
  const before = await setting(env.DB, "dns:last:aetoswebsites.com");

  // What a lookup's AbortSignal.timeout does when DoH never answers (the timer itself is tested on dohMx above).
  const signals = [];
  env.__fetch = async (url, init) => {
    signals.push(init.signal);
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const r = await checkDns(env, "aetoswebsites.com");
  assert.ok(signals.length >= 1 && signals.every((s) => s instanceof AbortSignal), "every lookup the route makes has a timeout");
  assert.equal(r.status, 502);
  assert.equal(r.data.error, DNS_DOWN);
  assert.equal(await setting(env.DB, "dns:last:aetoswebsites.com"), before);
});

test("the DNS route refuses a missing or malformed domain without looking anything up", async () => {
  const doh = fakeDoh(GOOD_DNS);
  const env = { DB: fakeD1(), __fetch: doh.fetchImpl };
  for (const domain of [undefined, "", "not a domain", "localhost", "a..b.com", "x.com/evil", "nik@aetoswebsites.com"]) {
    const r = await checkDns(env, domain);
    assert.equal(r.status, 400, String(domain));
    assert.equal(r.data.error, "Say which domain to check: the part of your mailbox address after the @, e.g. aetoswebsites.com.");
  }
  assert.equal(doh.calls.length, 0);
  assert.equal((await checkDns(env, "aetoswebsites.com.")).data.domain, "aetoswebsites.com", "a trailing dot is fine");
});

// ---------------------------------------------------------------- business details (Step 1)

test("business details: an address with <script> is stored raw; complete needs both the legal name and the address", async () => {
  const env = { DB: fakeD1() };
  const empty = await readBusiness(env);
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.data, {
    sender_name: "", legal_name: "", address: "", contact_email: "hello@aetoswebsites.com", ico_number: "", complete: false,
  });

  const address = "1 High St <script>alert(1)</script>";
  const onlyAddress = await saveBusiness(env, { sender_name: "Nik", legal_name: "", address, contact_email: "", ico_number: "" });
  assert.equal(onlyAddress.status, 200, onlyAddress.text);
  assert.equal(await setting(env.DB, "business:address"), address);
  assert.equal(onlyAddress.data.address, address);
  assert.equal(onlyAddress.data.complete, false);
  assert.equal((await readBusiness(env)).data.complete, false);

  const full = await saveBusiness(env, {
    sender_name: "Nik", legal_name: "Nikiforos Surname", address, contact_email: "Nik@AetosWebsites.com", ico_number: "za123456",
  });
  assert.deepEqual(full.data, {
    sender_name: "Nik", legal_name: "Nikiforos Surname", address, contact_email: "nik@aetoswebsites.com", ico_number: "ZA123456", complete: true,
  });
  assert.deepEqual((await readBusiness(env)).data, full.data);
  for (const [key, value] of [
    ["business:sender_name", "Nik"], ["business:legal_name", "Nikiforos Surname"], ["business:address", address],
    ["site:contact_email", "nik@aetoswebsites.com"], ["business:ico_number", "ZA123456"],
  ]) assert.equal(await setting(env.DB, key), value, key);

  const status = await loadSetupStatus(env.DB, env, new Date());
  assert.equal(status.business.legal_name, "Nikiforos Surname");
  assert.ok(!setupGaps(status).some((g) => g.key === "business"));
});

test("business details: a blank contact email means the default, spaces don't count as filled, a missing field is kept", async () => {
  const env = { DB: fakeD1() };
  await saveBusiness(env, { sender_name: " Nik ", legal_name: "  ", address: " 1 St ", contact_email: "nik@aetoswebsites.com" });
  let b = (await readBusiness(env)).data;
  assert.equal(b.sender_name, "Nik");
  assert.equal(b.legal_name, "");
  assert.equal(b.address, "1 St");
  assert.equal(b.complete, false);

  b = (await saveBusiness(env, { legal_name: "N Surname", contact_email: "" })).data;
  assert.equal(b.contact_email, "hello@aetoswebsites.com");
  assert.equal(await setting(env.DB, "site:contact_email"), null, "a cleared field has no setting, so readers get their default");
  assert.equal(await getSetting(env.DB, "site:contact_email", "hello@aetoswebsites.com"), "hello@aetoswebsites.com");
  assert.equal(b.sender_name, "Nik", "a field left out keeps its value");
  assert.equal(b.address, "1 St");
  assert.equal(b.complete, true);

  const multiLine = (await saveBusiness(env, { address: "Unit 4\n12 High Street\nLeeds LS1 1AA" })).data;
  assert.equal(multiLine.address, "Unit 4\n12 High Street\nLeeds LS1 1AA", "an address typed over several lines is kept as typed");
});

test("business details: clearing a field (blank or null) removes its setting; an ICO number typed with spaces is tidied", async () => {
  const env = { DB: fakeD1() };
  const saved = await saveBusiness(env, {
    sender_name: "Nik", legal_name: "N Surname", address: "1 St", contact_email: "nik@aetoswebsites.com", ico_number: "za 123 456",
  });
  assert.equal(saved.data.ico_number, "ZA123456");
  assert.equal(await count(env.DB, "settings"), 5);

  const cleared = await saveBusiness(env, { sender_name: "", legal_name: null, address: "   ", contact_email: "", ico_number: "" });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.data, {
    sender_name: "", legal_name: "", address: "", contact_email: "hello@aetoswebsites.com", ico_number: "", complete: false,
  });
  assert.equal(await count(env.DB, "settings"), 0, "every cleared field's setting is gone");
  assert.equal(await getSetting(env.DB, "business:sender_name", "fallback"), "fallback");
  const status = await loadSetupStatus(env.DB, env, new Date());
  assert.ok(setupGaps(status).some((g) => g.key === "business"), "the business gap is back once the details are cleared");
});

test("business details: line breaks, bad emails, odd ICO numbers and non-text are refused, and nothing is saved", async () => {
  const env = { DB: fakeD1() };
  for (const [body, error] of [
    [{ sender_name: "Nik\r\nBcc: x@y.com" }, "Your name for emails can't contain line breaks."],
    [{ sender_name: "N".repeat(101) }, "Your name for emails is too long: keep it to 100 characters or fewer."],
    [{ legal_name: "Nik\nSurname" }, "Your full legal name can't contain line breaks."],
    [{ legal_name: "N".repeat(201) }, "Your full legal name is too long: keep it to 200 characters or fewer."],
    [{ address: "x".repeat(301) }, "The business address is too long: keep it to 300 characters or fewer."],
    [{ contact_email: "hello" }, "That contact email doesn't look like an email address."],
    [{ contact_email: "a@b.com?cc=x@y.com" }, "That contact email doesn't look like an email address."],
    [{ ico_number: "ZA 12/34" }, "That doesn't look like an ICO registration number (it's on your ICO certificate, e.g. ZA123456)."],
    [{ sender_name: 42 }, "Each business detail must be text."],
    [{ sender_name: "Nik", legal_name: "N", address: "1 St", contact_email: "nope" }, "That contact email doesn't look like an email address."],
  ]) {
    const r = await saveBusiness(env, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, error, JSON.stringify(body));
  }
  const notJson = await saveBusiness(env, "{");
  assert.equal(notJson.status, 400);
  assert.match(notJson.data.error, /couldn't be read/);
  assert.equal(await count(env.DB, "settings"), 0);
});

// ---------------------------------------------------------------- site check (Step 1)

test("site check: the landing marker at https://aetoswebsites.com/ means it's live; otherwise Part A's message", async () => {
  const live = fakeFetch(() => new Response('<!doctype html><html lang="en-GB" data-aetos-landing><title>Aetos</title></html>', {
    status: 200, headers: { "content-type": "text/html; charset=utf-8" },
  }));
  const env = { DB: fakeD1(), __fetch: live.fetchImpl };
  const ok = await checkSite(env);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.data, { ok: true, message: LIVE });
  assert.equal(live.calls.length, 1);
  assert.equal(live.calls[0].url, "https://aetoswebsites.com/");

  for (const answer of [
    () => new Response("<html><body>Parked domain</body></html>", { status: 200 }),
    () => new Response("<html data-aetos-landing>error</html>", { status: 522 }),
    () => { throw new TypeError("fetch failed"); },
  ]) {
    env.__fetch = fakeFetch(answer).fetchImpl;
    assert.deepEqual((await checkSite(env)).data, { ok: false, message: NOT_LIVE });
  }
});

test("site check uses the site:root_host setting when it's set", async () => {
  const site = fakeFetch(() => new Response("<html data-aetos-landing></html>", { status: 200 }));
  const env = { DB: fakeD1(), __fetch: site.fetchImpl };
  await setSetting(env.DB, "site:root_host", "Example.ORG");
  assert.deepEqual((await checkSite(env)).data, { ok: true, message: LIVE });
  assert.equal(site.calls[0].url, "https://example.org/");

  env.__fetch = fakeFetch(() => new Response("nothing here", { status: 404 })).fetchImpl;
  assert.deepEqual((await checkSite(env)).data, {
    ok: false,
    message: "example.org doesn't show the landing page yet: Cloudflare → Workers & Pages → your Control Room project → Custom domains → add example.org and www.example.org.",
  });
});

// Integration (stage 0): the check must look at the very host the middleware serves the landing page on, so a
// setting the middleware reads one way is never checked another way.
test("site check checks the same host the middleware serves (rootHostFor), whatever site:root_host holds", async () => {
  for (const [value, host] of [
    ["localhost", "localhost"],
    ["https://Sub.Example.co.uk:8443/path?q=1", "sub.example.co.uk"],
    ["Example.ORG.", "example.org"],
    ["not a host!", "aetoswebsites.com"],
    ["", "aetoswebsites.com"],
  ]) {
    const label = JSON.stringify(value);
    const other = fakeD1(); // the middleware's view, from its own database object (so no shared cache)
    await setSetting(other, "site:root_host", value);
    assert.equal(await rootHostFor({ DB: other }), host, label);

    const site = fakeFetch(() => new Response("<html data-aetos-landing></html>", { status: 200 }));
    const env = { DB: fakeD1(), __fetch: site.fetchImpl };
    await setSetting(env.DB, "site:root_host", value);
    assert.deepEqual((await checkSite(env)).data, { ok: true, message: LIVE }, label);
    assert.equal(site.calls.length, 1, label);
    assert.equal(site.calls[0].url, `https://${host}/`, label);
  }
});
