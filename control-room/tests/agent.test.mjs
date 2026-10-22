// Agent auth (requireAgent) and POST /api/agent/heartbeat (stage 0, Task 9; overview §7).
// Run: node --test control-room/tests/agent.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { requireAgent } from "../functions/_lib/agentAuth.js";
import { ROUTINES } from "../functions/_lib/routines.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { onRequestPost as heartbeat } from "../functions/api/agent/heartbeat.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// What Setup's Generate makes: 32 random bytes, base64url (43 characters).
const KEY = randomBytes(32).toString("base64url");
const ENV_TOKEN = "outreach-agent-token-0123456789"; // 31 characters: the legacy Cloudflare variable
const NO_KEY = "No agent key yet: generate one on Setup → Claude.";
const UNKNOWN = "Unknown routine: use one of research, reply, weekly-kpis, build, monthly-care";
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const ENDPOINT = "https://control.aetoswebsites.com/api/agent/heartbeat";
function req(body, token, { scheme = "Bearer", headers = {} } = {}) {
  const h = { "content-type": "application/json", ...headers };
  if (token !== null && token !== undefined) h.authorization = `${scheme} ${token}`;
  return new Request(ENDPOINT, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function call(env, body, token, opts) {
  const res = await heartbeat({ request: req(body, token, opts), env });
  const text = await res.text();
  return { res, status: res.status, text, data: JSON.parse(text) };
}

async function withKey(extra = {}) {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", KEY);
  return { DB, env: { DB, ...extra } };
}

const beatRow = (DB, name) => DB.prepare("SELECT * FROM heartbeats WHERE name = ?").bind(name).first();
const beatCount = (DB) => DB.prepare("SELECT COUNT(*) AS n FROM heartbeats").first("n");

// ---------------------------------------------------------------- the Step 1 list

test("the right Bearer gets 200 and beats routine:research with ok=1 and detail 'started'", async () => {
  assert.equal(KEY.length, 43);
  const { DB, env } = await withKey();
  const r = await call(env, { routine: "research" }, KEY);
  assert.equal(r.status, 200, r.text);
  const row = await beatRow(DB, "routine:research");
  assert.ok(row, "a heartbeats row routine:research");
  assert.equal(row.ok, 1);
  assert.equal(row.detail, "started");
  assert.match(row.last_at, ISO_S);
  assert.ok(Math.abs(Date.parse(row.last_at) - Date.now()) < 5000, row.last_at);
});

test("{routine:'reply', ok:false, summary: 900 x's} stores ok=0 and 500 characters", async () => {
  const { DB, env } = await withKey();
  const r = await call(env, { routine: "reply", ok: false, summary: "x".repeat(900) }, KEY);
  assert.equal(r.status, 200, r.text);
  const row = await beatRow(DB, "routine:reply");
  assert.equal(row.ok, 0);
  assert.equal(row.detail.length, 500);
  assert.equal(row.detail, "x".repeat(500));
});

test("a wrong Bearer gets 401 and no heartbeat", async () => {
  const { DB, env } = await withKey();
  const r = await call(env, { routine: "research" }, "wrong");
  assert.equal(r.status, 401);
  assert.deepEqual(r.data, { error: "Wrong token" });
  assert.equal(await beatCount(DB), 0);
});

test("with no token anywhere the response is 503 with the spec text", async () => {
  const DB = fakeD1();
  const r = await call({ DB }, { routine: "research" }, KEY);
  assert.equal(r.status, 503);
  assert.deepEqual(r.data, { error: NO_KEY });
  assert.equal(await beatCount(DB), 0);
  // Straight from requireAgent too.
  const res = await requireAgent(req({}, KEY), {}, DB);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: NO_KEY });
});

test("env.OUTREACH_AGENT_TOKEN with 24+ characters works", async () => {
  assert.ok(ENV_TOKEN.length >= 24);
  const DB = fakeD1();
  const env = { DB, OUTREACH_AGENT_TOKEN: ENV_TOKEN };
  const r = await call(env, { routine: "build", summary: "via the env token" }, ENV_TOKEN);
  assert.equal(r.status, 200, r.text);
  const row = await beatRow(DB, "routine:build");
  assert.deepEqual([row.ok, row.detail], [1, "via the env token"]);
  // Exactly 24 is enough.
  const t24 = "a".repeat(24);
  assert.equal((await call({ DB, OUTREACH_AGENT_TOKEN: t24 }, { routine: "build" }, t24)).status, 200);
});

test("an unknown routine gets 400 with the list of names", async () => {
  const { DB, env } = await withKey();
  const r = await call(env, { routine: "nope" }, KEY);
  assert.equal(r.status, 400);
  assert.deepEqual(r.data, { error: UNKNOWN });
  assert.equal(await beatCount(DB), 0);
});

// ---------------------------------------------------------------- requireAgent

test("requireAgent returns null when allowed, a Response otherwise", async () => {
  const { DB, env } = await withKey();
  assert.equal(await requireAgent(req({}, KEY), env, DB), null);
  const denied = await requireAgent(req({}, "nope"), env, DB);
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("content-type"), /application\/json/);
  assert.equal(denied.headers.get("cache-control"), "no-store");
});

test("near misses are wrong tokens: a prefix, an extra character, one changed character, other cases", async () => {
  const { DB, env } = await withKey();
  const flip = KEY.slice(0, -1) + (KEY.at(-1) === "A" ? "B" : "A");
  for (const given of [KEY.slice(0, -1), KEY + "x", flip, KEY.toLowerCase() === KEY ? KEY.toUpperCase() : KEY.toLowerCase(), "", " ", `${KEY}${KEY}`]) {
    const res = await requireAgent(req({}, given), env, DB);
    assert.equal(res?.status, 401, JSON.stringify(given));
  }
});

test("no Authorization header, or another scheme, is a wrong token", async () => {
  const { DB, env } = await withKey();
  assert.equal((await requireAgent(req({}, null), env, DB)).status, 401);
  assert.equal((await requireAgent(req({}, KEY, { scheme: "Basic" }), env, DB)).status, 401);
  // The bare key without the scheme isn't a Bearer token either.
  const bare = new Request(ENDPOINT, { method: "POST", headers: { authorization: KEY } });
  assert.equal((await requireAgent(bare, env, DB)).status, 401);
});

test("the Bearer scheme is case-insensitive and surrounding spaces don't matter", async () => {
  const { DB, env } = await withKey();
  assert.equal(await requireAgent(req({}, KEY, { scheme: "bearer" }), env, DB), null);
  assert.equal(await requireAgent(req({}, `  ${KEY}  `, { scheme: "BEARER" }), env, DB), null);
});

test("a network secret saved with the prefix 'Bearer' and no space still works", async () => {
  const { DB, env } = await withKey();
  const glued = new Request(ENDPOINT, { method: "POST", headers: { authorization: `Bearer${KEY}` } });
  assert.equal(await requireAgent(glued, env, DB), null);
  // Only the scheme may be glued on: the token itself must still match exactly.
  const wrong = new Request(ENDPOINT, { method: "POST", headers: { authorization: `Bearer:${KEY}` } });
  assert.equal((await requireAgent(wrong, env, DB)).status, 401);
  const r = await heartbeat({ request: new Request(ENDPOINT, { method: "POST", headers: { authorization: `Bearer${KEY}` }, body: '{"routine":"reply"}' }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await beatRow(DB, "routine:reply").then((row) => [row.ok, row.detail]), [1, "started"]);
});

test("with both a saved key and the env token, either works and anything else is 401", async () => {
  const { DB, env } = await withKey({ OUTREACH_AGENT_TOKEN: ENV_TOKEN });
  assert.equal(await requireAgent(req({}, KEY), env, DB), null);
  assert.equal(await requireAgent(req({}, ENV_TOKEN), env, DB), null);
  assert.equal((await requireAgent(req({}, "something-else-entirely-0123456789"), env, DB)).status, 401);
});

test("an env token under 24 characters doesn't count", async () => {
  const short = "a".repeat(23);
  const DB = fakeD1();
  // Alone, it's as if there were no token: 503.
  const alone = await requireAgent(req({}, short), { OUTREACH_AGENT_TOKEN: short }, DB);
  assert.equal(alone.status, 503);
  assert.deepEqual(await alone.json(), { error: NO_KEY });
  // Next to a saved key, presenting it is a wrong token.
  await setSecret(DB, "agent_token", KEY);
  assert.equal((await requireAgent(req({}, short), { OUTREACH_AGENT_TOKEN: short }, DB)).status, 401);
  // A non-string env value doesn't count either.
  const DB2 = fakeD1();
  assert.equal((await requireAgent(req({}, "x"), { OUTREACH_AGENT_TOKEN: undefined }, DB2)).status, 503);
});

test("an empty saved key counts as no key", async () => {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", "");
  const res = await requireAgent(req({}, ""), {}, DB);
  assert.equal(res.status, 503);
  const res2 = await requireAgent(req({}, null), {}, DB);
  assert.equal(res2.status, 503);
});

test("a replaced key stops the old one straight away", async () => {
  const { DB, env } = await withKey();
  const next = randomBytes(32).toString("base64url");
  await setSecret(DB, "agent_token", next);
  assert.equal((await requireAgent(req({}, KEY), env, DB)).status, 401);
  assert.equal(await requireAgent(req({}, next), env, DB), null);
});

// Counts every statement run (first/all/run/raw, and each one in a batch), so this test needs nothing beyond fakeD1.
function counting(DB) {
  let used = 0;
  const wrap = (stmt) => ({
    bind: (...values) => wrap(stmt.bind(...values)),
    ...Object.fromEntries(["first", "all", "run", "raw"].map((m) => [m, (...args) => (used++, stmt[m](...args))])),
  });
  return { DB: { prepare: (sql) => wrap(DB.prepare(sql)), batch: (s) => ((used += s.length), DB.batch(s)) }, used: () => used };
}

test("requireAgent makes one D1 query", async () => {
  const { DB, env } = await withKey();
  const counted = counting(DB);
  assert.equal(await requireAgent(req({}, KEY), env, counted.DB), null);
  assert.equal(counted.used(), 1);
  assert.equal((await requireAgent(req({}, "wrong"), env, counted.DB)).status, 401);
  assert.equal(counted.used(), 2);
});

test("no denial contains the key or the token that was sent", async () => {
  const { DB, env } = await withKey({ OUTREACH_AGENT_TOKEN: ENV_TOKEN });
  const sent = "a-wrong-but-long-token-0123456789";
  const r = await call(env, { routine: "research" }, sent);
  assert.equal(r.status, 401);
  for (const secret of [KEY, ENV_TOKEN, sent]) assert.ok(!r.text.includes(secret), "a secret in the 401 body");
  const r503 = await call({ DB: fakeD1() }, { routine: "research" }, sent);
  assert.ok(!r503.text.includes(sent));
});

// ---------------------------------------------------------------- the heartbeat route

test("each of the 5 Routines can beat, as routine:<name>", async () => {
  const { DB, env } = await withKey();
  for (const { name } of ROUTINES) {
    const r = await call(env, { routine: name, ok: true, summary: `${name} done` }, KEY);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    assert.deepEqual(r.data, { ok: true });
    const row = await beatRow(DB, `routine:${name}`);
    assert.deepEqual([row.ok, row.detail], [1, `${name} done`]);
  }
  assert.equal(await beatCount(DB), 5);
});

test("the start beat then the finish beat leave one row with the last result", async () => {
  const { DB, env } = await withKey();
  await call(env, { routine: "research" }, KEY);
  await call(env, { routine: "research", ok: false, summary: "3 of 8 failed: site down" }, KEY);
  assert.equal(await beatCount(DB), 1);
  const row = await beatRow(DB, "routine:research");
  assert.deepEqual([row.ok, row.detail], [0, "3 of 8 failed: site down"]);
});

test("ok and summary given as null mean the defaults (ok ?? true, summary ?? 'started')", async () => {
  const { DB, env } = await withKey();
  assert.equal((await call(env, { routine: "weekly-kpis", ok: null, summary: null }, KEY)).status, 200);
  const row = await beatRow(DB, "routine:weekly-kpis");
  assert.deepEqual([row.ok, row.detail], [1, "started"]);
  // An empty summary is kept as empty (?? only replaces a missing one).
  await call(env, { routine: "weekly-kpis", ok: true, summary: "" }, KEY);
  assert.equal((await beatRow(DB, "routine:weekly-kpis")).detail, "");
});

test("Perfect when #10's curl (-d, so curl's form content-type) is read as JSON", async () => {
  const { DB, env } = await withKey();
  const body = '{"routine":"research","ok":true,"summary":"manual test"}';
  const r = await call(env, body, KEY, { headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await beatRow(DB, "routine:research")).detail, "manual test");
});

test("names that aren't exactly a Routine's are unknown", async () => {
  const { DB, env } = await withKey();
  for (const routine of ["routine:research", "Research", " research", "research ", "", null, 1, ["research"], undefined]) {
    const body = routine === undefined ? {} : { routine };
    const r = await call(env, body, KEY);
    assert.equal(r.status, 400, JSON.stringify(routine));
    assert.deepEqual(r.data, { error: UNKNOWN });
  }
  assert.equal(await beatCount(DB), 0);
});

test("a body that isn't a JSON object gets 400 and no heartbeat", async () => {
  const { DB, env } = await withKey();
  for (const body of ["not json", "", "[]", "null", '"research"', "42"]) {
    const r = await call(env, body, KEY);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, /Send JSON/);
  }
  assert.equal(await beatCount(DB), 0);
});

test("ok must be true or false, and summary must be text", async () => {
  const { DB, env } = await withKey();
  for (const ok of ["false", "true", 0, 1, {}]) {
    const r = await call(env, { routine: "reply", ok }, KEY);
    assert.equal(r.status, 400, JSON.stringify(ok));
    assert.deepEqual(r.data, { error: 'ok must be true or false, e.g. {"routine":"reply","ok":true,"summary":"one line"}.' });
  }
  for (const summary of [42, { a: 1 }, ["x"], true]) {
    const r = await call(env, { routine: "reply", summary }, KEY);
    assert.equal(r.status, 400, JSON.stringify(summary));
    assert.deepEqual(r.data, { error: "summary must be text: one line saying what the Routine did." });
  }
  assert.equal(await beatCount(DB), 0);
});

test("auth comes before the body: a wrong token with a bad body is 401, not 400", async () => {
  const { DB, env } = await withKey();
  assert.equal((await call(env, "not json", "wrong")).status, 401);
  assert.equal((await call(env, { routine: "nope" }, "wrong")).status, 401);
  assert.equal((await call({ DB: fakeD1() }, { routine: "nope" }, "wrong")).status, 503);
  assert.equal(await beatCount(DB), 0);
});

test("the route calls db(env) first: no DB binding gives its plain-English error", async () => {
  await assert.rejects(() => heartbeat({ request: req({ routine: "research" }, KEY), env: {} }), /The database isn't connected/);
});

test("a summary never stores the key it was sent with, nor an Anthropic token", async () => {
  const { DB, env } = await withKey();
  const summary = `oops ${KEY} and sk-ant-oat01-AbC_d-9 leaked`;
  assert.equal((await call(env, { routine: "research", summary }, KEY)).status, 200);
  const { detail } = await beatRow(DB, "routine:research");
  assert.ok(!detail.includes(KEY), detail);
  assert.ok(!detail.includes("sk-ant-oat01-AbC_d-9"), detail);
  assert.equal(detail, "oops [hidden] and [hidden] leaked");
});

test("the legacy env token is hidden too, even when the request used the saved key", async () => {
  const { DB, env } = await withKey({ OUTREACH_AGENT_TOKEN: ENV_TOKEN });
  assert.equal((await call(env, { routine: "reply", summary: `env was ${ENV_TOKEN}.` }, KEY)).status, 200);
  assert.equal((await beatRow(DB, "routine:reply")).detail, "env was [hidden].");
  // A short env token isn't a key, so it isn't hidden (that would mangle ordinary words).
  const short = { ...env, OUTREACH_AGENT_TOKEN: "done" };
  assert.equal((await call(short, { routine: "reply", summary: "all done" }, KEY)).status, 200);
  assert.equal((await beatRow(DB, "routine:reply")).detail, "all done");
});

test("the key is hidden before the 500-character cap, so no part of it is kept", async () => {
  const { DB, env } = await withKey();
  const summary = "y".repeat(480) + KEY; // the key straddles character 500
  assert.equal((await call(env, { routine: "research", summary }, KEY)).status, 200);
  const { detail } = await beatRow(DB, "routine:research");
  assert.equal(detail, "y".repeat(480) + "[hidden]");
  assert.ok(!detail.includes(KEY.slice(0, 20)));
});

test("a long summary is cut to 500 characters without splitting an emoji", async () => {
  const { DB, env } = await withKey();
  const summary = "z".repeat(499) + "😀" + "tail";
  assert.equal((await call(env, { routine: "reply", summary }, KEY)).status, 200);
  const { detail } = await beatRow(DB, "routine:reply");
  assert.equal(detail, "z".repeat(499));
});

test("the heartbeat doesn't touch other settings or heartbeats", async () => {
  const { DB, env } = await withKey();
  await setSetting(DB, "routine:research:retry_after", "2026-10-21T13:00:00Z");
  await DB.prepare("INSERT INTO heartbeats (name, last_at, ok, detail) VALUES ('tick', '2026-10-21T12:00:00Z', 1, 'inbound ok')").run();
  assert.equal((await call(env, { routine: "research" }, KEY)).status, 200);
  const tick = await beatRow(DB, "tick");
  assert.deepEqual([tick.last_at, tick.ok, tick.detail], ["2026-10-21T12:00:00Z", 1, "inbound ok"]);
  const held = await DB.prepare("SELECT value FROM settings WHERE key = 'routine:research:retry_after'").first("value");
  assert.equal(held, "2026-10-21T13:00:00Z");
});

// ---------------------------------------------------------------- through the middleware (stage 0 integration)

// The middleware lets /api/agent/* through without the login cookie (the function checks its own token), and an
// error a function throws there (e.g. no D1 bound) reaches the Routine as the same plain-English JSON as every other
// /api/ path, not Cloudflare's bare error page.
test("through the middleware: no cookie needed, and a thrown error comes back as plain-English JSON", async () => {
  const { onRequest } = await import("../functions/_middleware.js");
  const through = (env) => (request) => onRequest({ request, env, next: () => heartbeat({ request, env }) });

  const { DB, env } = await withKey({ CONTROL_ROOM_PASSWORD: "pw" });
  const ok = await through(env)(req({ routine: "build" }, KEY));
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await beatRow(DB, "routine:build")).detail, "started");
  assert.equal((await through(env)(req({ routine: "build" }, "wrong"))).status, 401);

  const noDb = { CONTROL_ROOM_PASSWORD: "pw" };
  const res = await through(noDb)(req({ routine: "build" }, KEY));
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await res.json(), {
    error: "The database isn't connected. In Cloudflare: your Pages project → Settings → Bindings → add D1 database, variable name DB, then redeploy.",
  });
});
