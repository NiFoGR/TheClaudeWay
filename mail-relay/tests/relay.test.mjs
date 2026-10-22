// The mail relay Worker (Part A "Trigger" and "Email in", Task 18). Run: node --test mail-relay/tests/relay.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeD1 } from "../../control-room/tests/helpers/fakeD1.mjs";
import * as relayModule from "../src/index.js";
import relay, { headersToJson, readCapped, tickUrl } from "../src/index.js";

const CAP = 262144;
const TICK = (reason) => `https://app.x/api/tick?reason=${reason}`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utf8Length = (s) => new TextEncoder().encode(s).length;
const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// A byte stream handed out in chunks, like message.raw. `source.cancelled` says whether the reader stopped early.
function streamOf(bytes, chunk = 65536) {
  const source = { offset: 0, cancelled: false };
  source.stream = new ReadableStream({
    pull(controller) {
      if (source.offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(source.offset, source.offset + chunk));
      source.offset += chunk;
    },
    cancel() {
      source.cancelled = true;
    },
  });
  return source;
}

// The ForwardableEmailMessage Cloudflare hands email(): 300,000 bytes of raw MIME, and a forward() that's recorded.
function fakeMessage({ log = [], forwardError = null } = {}) {
  const source = streamOf(new Uint8Array(300000).fill(0x61));
  const forwards = [];
  return {
    from: "srs=abc123=x.co.uk=nik@x",
    to: "replies@r.co.uk",
    headers: new Headers({ Subject: "Hi", "Message-ID": "<a@b>" }),
    raw: source.stream,
    rawSize: 300000,
    forward: async (to, ...rest) => {
      forwards.push([to, ...rest]);
      log.push("forward");
      if (forwardError) throw forwardError;
    },
    forwards,
    source,
  };
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), passThroughOnException() {}, settle: () => Promise.all(pending) };
}

// Replaces global fetch for one test; every call is recorded as {url, method}.
function stubFetch(t, respond = async () => new Response('{"ran":true,"steps":{}}', { status: 200 })) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method });
    return respond(String(url), calls.length);
  });
  return calls;
}

const relayBeat = (DB) => DB.prepare("SELECT * FROM heartbeats WHERE name = 'relay'").first();
const inboundRows = async (DB) => (await DB.prepare("SELECT * FROM inbound_raw").all()).results;
const env = (DB, extra = {}) => ({ DB, APP_URL: "https://app.x/", FORWARD_COPY_TO: "", ...extra });

// ---------------------------------------------------------------- email()

test("email() stores one inbound_raw row: lower-case header keys, raw capped at 262,144 bytes, envelope kept", async (t) => {
  stubFetch(t);
  const DB = fakeD1();
  const msg = fakeMessage();
  const ctx = fakeCtx();
  await relay.email(msg, env(DB), ctx);
  await ctx.settle();

  const rows = await inboundRows(DB);
  assert.equal(rows.length, 1);
  const [row] = rows;
  const headers = JSON.parse(row.headers);
  assert.equal(headers.subject, "Hi");
  assert.equal(headers["message-id"], "<a@b>");
  for (const key of Object.keys(headers)) assert.equal(key, key.toLowerCase(), key);
  assert.ok(!("Subject" in headers) && !("Message-ID" in headers));
  assert.equal(utf8Length(row.raw), CAP);
  assert.equal(row.raw, "a".repeat(CAP));
  assert.equal(row.envelope_from, "srs=abc123=x.co.uk=nik@x");
  assert.equal(row.envelope_to, "replies@r.co.uk");
  assert.match(row.id, UUID);
  assert.match(row.received_at, ISO);
  assert.equal(row.processed_at, null);
  assert.equal(row.outcome, null);
  assert.ok(msg.source.cancelled, "stops reading the raw stream once the cap is reached");
});

test("email() beats relay with ok=1 and POSTs the inbound tick through ctx.waitUntil", async (t) => {
  const calls = stubFetch(t);
  const DB = fakeD1();
  const ctx = fakeCtx();
  await relay.email(fakeMessage(), env(DB), ctx);
  assert.ok(ctx.pending.length >= 1, "the tick call runs in ctx.waitUntil");
  await ctx.settle();

  assert.deepEqual(calls, [{ url: "https://app.x/api/tick?reason=inbound", method: "POST" }]);
  const beat = await relayBeat(DB);
  assert.equal(beat.ok, 1);
  assert.match(beat.last_at, ISO);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM heartbeats").first("n"), 1, "only the relay heartbeat");
});

test("forward isn't called when FORWARD_COPY_TO is empty or the placeholder, and is called with the address when set", async (t) => {
  stubFetch(t);
  for (const value of ["", "__FORWARD_COPY_TO__", undefined]) {
    const msg = fakeMessage();
    const ctx = fakeCtx();
    await relay.email(msg, env(fakeD1(), { FORWARD_COPY_TO: value }), ctx);
    await ctx.settle();
    assert.equal(msg.forwards.length, 0, `FORWARD_COPY_TO = ${JSON.stringify(value)}`);
  }
  const DB = fakeD1();
  const msg = fakeMessage();
  const ctx = fakeCtx();
  await relay.email(msg, env(DB, { FORWARD_COPY_TO: "nik.copy@gmail.com" }), ctx);
  await ctx.settle();
  assert.deepEqual(msg.forwards, [["nik.copy@gmail.com"]]);
  assert.equal((await inboundRows(DB)).length, 1, "the mail is still saved");
});

test("a D1 insert failure makes email() throw, after forwarding when FORWARD_COPY_TO is set", async (t) => {
  const calls = stubFetch(t);
  // No tables: the database before Pages has first run (Part A, "Relay can't write to D1").
  const log = [];
  const bare = fakeD1({ schema: false });
  const DB = { ...bare, prepare: (sql) => (log.push(sql.trim().split(/\s+/)[0].toLowerCase()), bare.prepare(sql)) };
  const msg = fakeMessage({ log });
  const ctx = fakeCtx();
  await assert.rejects(relay.email(msg, env(DB, { FORWARD_COPY_TO: "nik.copy@gmail.com" }), ctx), /no such table: inbound_raw/);
  assert.deepEqual(msg.forwards, [["nik.copy@gmail.com"]]);
  assert.deepEqual(log, ["forward", "insert"], "forwards first, then tries the insert");
  await ctx.settle();
  assert.equal(calls.length, 0, "no tick call for mail that wasn't saved");

  // Without a copy address it still throws (Cloudflare then gives the sender a temporary failure).
  const msg2 = fakeMessage();
  await assert.rejects(relay.email(msg2, env(fakeD1({ schema: false })), fakeCtx()), /no such table: inbound_raw/);
  assert.equal(msg2.forwards.length, 0);
});

test("a forward copy that fails doesn't stop the mail being saved; the heartbeat says so", async (t) => {
  const calls = stubFetch(t);
  const DB = fakeD1();
  const msg = fakeMessage({ forwardError: new Error("destination address not verified") });
  const ctx = fakeCtx();
  await relay.email(msg, env(DB, { FORWARD_COPY_TO: "nik.copy@gmail.com" }), ctx);
  await ctx.settle();
  assert.equal((await inboundRows(DB)).length, 1);
  assert.equal(calls.length, 1);
  const beat = await relayBeat(DB);
  assert.equal(beat.ok, 0);
  assert.match(beat.detail, /^forward copy failed: destination address not verified/);
});

// ---------------------------------------------------------------- scheduled()

test("scheduled() calls the cron tick, then the health tick once the cron call has settled, even if it failed", async (t) => {
  let failCron;
  const cronPending = new Promise((_, reject) => (failCron = reject));
  const calls = stubFetch(t, (url) => (url.endsWith("reason=cron") ? cronPending : new Response('{"ran":true,"steps":{}}', { status: 200 })));
  const DB = fakeD1();
  const ctx = fakeCtx();
  await relay.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env(DB), ctx);
  assert.equal(ctx.pending.length, 1, "one waitUntil runs both calls");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c.url), [TICK("cron")], "the health call waits for the cron call");

  failCron(new TypeError("fetch failed"));
  await ctx.settle();
  assert.deepEqual(calls, [
    { url: TICK("cron"), method: "POST" },
    { url: TICK("health"), method: "POST" },
  ]);
  const beat = await relayBeat(DB);
  assert.ok(beat, "beats relay");
  assert.match(beat.detail, /^tick call failed:/);
});

test("scheduled() with both calls answering: exactly the two URLs, in order, and relay beats ok=1", async (t) => {
  const calls = stubFetch(t);
  const DB = fakeD1();
  const ctx = fakeCtx();
  await relay.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env(DB), ctx);
  await ctx.settle();
  assert.deepEqual(calls.map((c) => c.url), [TICK("cron"), TICK("health")]);
  assert.ok(calls.every((c) => c.method === "POST"));
  const beat = await relayBeat(DB);
  assert.equal(beat.ok, 1);
  assert.match(beat.last_at, ISO);
  assert.doesNotMatch(beat.detail, /failed/);
});

test("a fetch rejection doesn't throw out of either handler, and the heartbeat detail starts \"tick call failed:\"", async (t) => {
  stubFetch(t, async () => {
    throw new TypeError("Network connection lost.");
  });
  // scheduled()
  let DB = fakeD1();
  let ctx = fakeCtx();
  await relay.scheduled({}, env(DB), ctx);
  await ctx.settle();
  let beat = await relayBeat(DB);
  assert.equal(beat.ok, 0);
  assert.match(beat.detail, /^tick call failed:/);
  assert.match(beat.detail, /Network connection lost/);

  // email(): the mail is saved all the same
  DB = fakeD1();
  ctx = fakeCtx();
  await relay.email(fakeMessage(), env(DB), ctx);
  await ctx.settle();
  assert.equal((await inboundRows(DB)).length, 1);
  beat = await relayBeat(DB);
  assert.equal(beat.ok, 0);
  assert.match(beat.detail, /^tick call failed:/);
});

test("an HTTP error from the tick counts as a failed call; error 1042 says how to fix it", async (t) => {
  stubFetch(t, async (url) =>
    url.endsWith("reason=cron") ? new Response("error code: 1042", { status: 404 }) : new Response("oops", { status: 500 }));
  const DB = fakeD1();
  const ctx = fakeCtx();
  await relay.scheduled({}, env(DB), ctx);
  await ctx.settle();
  const beat = await relayBeat(DB);
  assert.equal(beat.ok, 0);
  assert.match(beat.detail, /^tick call failed: cron: HTTP 404 \(error 1042: set CONTROL_ROOM_URL to the project's \*\.pages\.dev address/);
  assert.match(beat.detail, /health: HTTP 500/);
  assert.ok(beat.detail.length <= 500);
});

test("a 200 that isn't the tick's answer (a login page, a wrong CONTROL_ROOM_URL) counts as a failed call", async (t) => {
  const calls = stubFetch(t, async (url) =>
    url.endsWith("reason=cron")
      ? new Response("<!doctype html><title>Log in</title>", { status: 200, headers: { "content-type": "text/html" } })
      : new Response('{"ran":true,"steps":{"health":"ok"}}', { status: 200 }));
  const DB = fakeD1();
  const ctx = fakeCtx();
  await relay.scheduled({}, env(DB), ctx);
  await ctx.settle();
  assert.deepEqual(calls.map((c) => c.url), [TICK("cron"), TICK("health")]);
  const beat = await relayBeat(DB);
  assert.equal(beat.ok, 0, "never says the tick was called when something else answered");
  assert.match(beat.detail, /^tick call failed: cron: the answer \(HTTP 200\) wasn't from the Control Room's \/api\/tick\. Check that CONTROL_ROOM_URL is the Control Room's address/);
  assert.doesNotMatch(beat.detail, /health:/, "the health call answered like a tick");

  // JSON that isn't the tick's shape doesn't count either; {ran:false} does (too soon or locked).
  for (const [body, ok] of [["{}", 0], ["null", 0], ['{"ran":"yes"}', 0], ['{"ran":false,"why":"locked"}', 1]]) {
    t.mock.restoreAll();
    stubFetch(t, async () => new Response(body, { status: 200 }));
    const DB2 = fakeD1();
    const ctx2 = fakeCtx();
    await relay.scheduled({}, env(DB2), ctx2);
    await ctx2.settle();
    assert.equal((await relayBeat(DB2)).ok, ok, body);
  }
});

test("the heartbeat detail is capped at 500 characters like beat(), never cutting an emoji in half", async (t) => {
  stubFetch(t);
  const prefix = "forward copy failed: ";
  // The 500th character would be the first half of "👍" (2 UTF-16 units), so it's left out: 499 characters.
  const message = "a".repeat(499 - prefix.length) + "👍" + "b".repeat(50);
  const DB = fakeD1();
  const ctx = fakeCtx();
  await relay.email(fakeMessage({ forwardError: new Error(message) }), env(DB, { FORWARD_COPY_TO: "nik.copy@gmail.com" }), ctx);
  await ctx.settle();
  const { detail } = await relayBeat(DB);
  assert.equal(detail, prefix + "a".repeat(499 - prefix.length));
  assert.equal(detail.length, 499);
  assert.ok(detail.isWellFormed(), "no lone surrogate");

  // A long plain detail is cut at exactly 500.
  const DB2 = fakeD1();
  const ctx2 = fakeCtx();
  await relay.email(fakeMessage({ forwardError: new Error("x".repeat(800)) }), env(DB2, { FORWARD_COPY_TO: "nik.copy@gmail.com" }), ctx2);
  await ctx2.settle();
  assert.equal((await relayBeat(DB2)).detail.length, 500);
});

test("APP_URL left unset or as the placeholder: no fetch, and the heartbeat says what to set", async (t) => {
  for (const APP_URL of [undefined, "", "__APP_URL__"]) {
    const calls = stubFetch(t);
    const DB = fakeD1();
    const ctx = fakeCtx();
    await relay.scheduled({}, env(DB, { APP_URL }), ctx);
    await ctx.settle();
    assert.equal(calls.length, 0, `APP_URL = ${JSON.stringify(APP_URL)}`);
    const beat = await relayBeat(DB);
    assert.equal(beat.ok, 0);
    assert.match(beat.detail, /^tick call failed: cron: APP_URL isn't set\. Add the repository variable CONTROL_ROOM_URL/);
    t.mock.restoreAll();
  }
});

// ---------------------------------------------------------------- helpers

test("readCapped returns a short stream whole, across chunks", async () => {
  const text = "From: Café Plumbing <a@b.co.uk>\r\nSubject: Hi\r\n\r\nCheers 👍\r\n".repeat(50);
  const source = streamOf(new TextEncoder().encode(text), 7);
  assert.equal(await readCapped(source.stream), text);
  assert.equal(source.cancelled, false);
});

test("readCapped's default cap is 262,144 bytes, and it stops reading there", async () => {
  const source = streamOf(new Uint8Array(CAP + 10).fill(0x62), 1000);
  const out = await readCapped(source.stream);
  assert.equal(out.length, CAP);
  assert.equal(utf8Length(out), CAP);
  assert.ok(source.cancelled);
  assert.ok(source.offset < CAP + 10 + 1000);
});

test("readCapped drops a character cut in half at the cap, and never encodes to more than the cap", async () => {
  // "é" is 2 bytes: with 9 "a"s before it, a 10-byte cap lands inside it.
  const split = await readCapped(streamOf(new TextEncoder().encode("aaaaaaaaaéb")).stream, 10);
  assert.equal(split, "aaaaaaaaa");
  assert.ok(!split.includes("�"));
  // "👍" is 4 bytes
  assert.equal(await readCapped(streamOf(new TextEncoder().encode("ab👍cd")).stream, 4), "ab");
  assert.equal(await readCapped(streamOf(new TextEncoder().encode("ab👍cd")).stream, 6), "ab👍");
  // Bytes that aren't UTF-8 (8-bit Latin-1 bodies) become U+FFFD (3 bytes each), still within the cap.
  const latin = await readCapped(streamOf(new Uint8Array(CAP + 5).fill(0xe9)).stream);
  assert.ok(utf8Length(latin) <= CAP, String(utf8Length(latin)));
  assert.ok(latin.length > 0 && /^�+$/.test(latin));
  // a stream that ends on a broken character keeps what it was sent
  assert.equal(await readCapped(streamOf(new Uint8Array([0x61, 0xc3])).stream), "a�");
});

test("headersToJson lower-cases names and joins a repeated header with \", \"", () => {
  const h = new Headers();
  h.append("Received", "from a");
  h.append("Received", "from b");
  h.append("In-Reply-To", "<orig@aetoswebsites.com>");
  const out = JSON.parse(headersToJson(h));
  assert.deepEqual(out, { "in-reply-to": "<orig@aetoswebsites.com>", received: "from a, from b" });
  // plain pairs and objects too, case folded the same way
  assert.deepEqual(JSON.parse(headersToJson([["X-Autoreply", "yes"], ["x-autoreply", "again"], ["Constructor", "c"]])), {
    "x-autoreply": "yes, again",
    constructor: "c",
  });
  assert.deepEqual(JSON.parse(headersToJson({ "Content-Type": "text/plain" })), { "content-type": "text/plain" });
  assert.equal(headersToJson(undefined), "{}");
});

test("tickUrl strips the trailing slash", () => {
  assert.equal(tickUrl("https://app.x/", "inbound"), "https://app.x/api/tick?reason=inbound");
  assert.equal(tickUrl("https://app.x", "cron"), "https://app.x/api/tick?reason=cron");
  assert.equal(tickUrl("https://control.aetoswebsites.com//", "health"), "https://control.aetoswebsites.com/api/tick?reason=health");
});

test("each beat replaces the relay row: one row, holding the latest result", async (t) => {
  let fail = true;
  stubFetch(t, async () => {
    if (fail) throw new TypeError("fetch failed");
    return new Response('{"ran":false,"why":"too_soon"}', { status: 200 });
  });
  const DB = fakeD1();
  let ctx = fakeCtx();
  await relay.scheduled({}, env(DB), ctx);
  await ctx.settle();
  assert.equal((await relayBeat(DB)).ok, 0);
  fail = false;
  ctx = fakeCtx();
  await relay.scheduled({}, env(DB), ctx);
  await ctx.settle();
  const rows = (await DB.prepare("SELECT * FROM heartbeats").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "relay");
  assert.equal(rows[0].ok, 1, "a tick that answers {ran:false} (too soon or locked) still counts as called");
  assert.doesNotMatch(rows[0].detail, /failed/);
});

// ---------------------------------------------------------------- the Worker's files

// workerd refuses to start a Worker whose module has a named export that isn't a function or a handler object
// ("Incorrect type for map entry 'RAW_CAP': the provided value is not of type 'function or ExportedHandler'"),
// so the deploy would fail. Found by running the Worker in workerd (miniflare).
test("the module exports only functions besides the default handler, so workerd will start it", () => {
  for (const [name, value] of Object.entries(relayModule)) {
    if (name === "default") continue;
    assert.equal(typeof value, "function", `export ${name}`);
  }
  assert.equal(typeof relay.email, "function");
  assert.equal(typeof relay.scheduled, "function");
  assert.equal(relay.fetch, undefined, "no public HTTP surface (workers_dev = false and no fetch handler)");
});

test("wrangler.toml carries the exact deploy settings and the placeholders the workflow fills in", () => {
  const toml = file("wrangler.toml");
  for (const line of [
    'name = "aetos-mail-relay"',
    'main = "src/index.js"',
    'compatibility_date = "2026-10-01"',
    "workers_dev = false",
    "[triggers]",
    'crons = ["*/5 * * * *"]',
    "[vars]",
    'APP_URL = "__APP_URL__"',
    'FORWARD_COPY_TO = "__FORWARD_COPY_TO__"',
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "goldbarwebsites"',
    'database_id = "__D1_DATABASE_ID__"',
  ]) {
    assert.ok(toml.split(/\r?\n/).some((l) => l.trim() === line), line);
  }
});

test("the Worker imports nothing from control-room or legacy, and the README says it's deployed by the workflow", () => {
  const src = file("src/index.js");
  assert.doesNotMatch(src, /\bfrom\s+["'][^"']*(control-room|legacy)\//);
  assert.doesNotMatch(src, /^\s*import\b/m, "the Worker imports nothing at all");
  assert.doesNotMatch(src, /\bimport\s*\(/);
  // Workers runtime only: no Node built-ins (there's no nodejs_compat flag in wrangler.toml)
  assert.doesNotMatch(src, /\bnode:|\brequire\s*\(|\bprocess\.|\bBuffer\b|\b__dirname\b/);
  assert.doesNotMatch(file("wrangler.toml"), /nodejs_compat/);
  const readme = file("README.md");
  assert.equal(readme.trimEnd().split(/\r?\n/).length, 5);
  assert.match(readme, /deploy-relay\.yml/);
  assert.match(readme, /never by hand/i);
});
