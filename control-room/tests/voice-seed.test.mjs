// Stage 7 (docs/rebuild/07-replies-calls.md Task 14): GET /api/voice adds Nik's two example replies once (seedVoice,
// setting voice:seeded) and has_price_reply counts any example he wrote whose situation or text is about the price
// (/price|how much|cost/i); a rule, or a first email he sent (nik_sent), never counts.
// Handlers are called the way Pages calls them: {request, env: {DB}, params, now}.
// Run: node --test control-room/tests/voice-seed.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { VOICE_SEEDS } from "../functions/_lib/replies-db.js";
import { db } from "../functions/_lib/util.js";
import * as exampleId from "../functions/api/voice/examples/[id].js";
import * as examples from "../functions/api/voice/examples/index.js";
import * as voice from "../functions/api/voice/index.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-21T10:00:00Z");

// db() checks the schema once per isolate: done here, before the test's own requests.
await db({ DB: fakeD1() });

test("GET /api/voice seeds Nik's two examples once; only his own price example counts", async () => {
  const DB = fakeD1();
  /** A request as Pages hands it to a handler: a JSON body means POST, params with no body DELETE. */
  const ctx = (path, body, params = {}) => {
    const init = { method: body ? "POST" : Object.keys(params).length ? "DELETE" : "GET" };
    if (body) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return { request: new Request(`${ORIGIN}${path}`, init), env: { DB }, params, now: NOW };
  };

  const get = async () => (await voice.onRequestGet(ctx("/api/voice"))).json();
  // Nik's first email to Sam, saved as stage 5–6's syncSent saves it (DB = the fakeD1 behind ctx)
  DB.raw.prepare("INSERT INTO style_examples (id, kind, situation, body, source, created_at) VALUES ('sent:m1', 'example', 'first email', 'Hi Sam,\n\nA slow site is costing you jobs: have a look.', 'nik_sent', '2026-10-20T09:00:00Z')").run();
  const g = await get();
  assert.deepEqual(g.examples.filter((i) => i.source === "nik_written").map((i) => i.situation).sort(), ["They ask for a call", "They ask for more info"]);
  assert.equal(g.has_price_reply, false);                                 // a sent first email saying "costing you" doesn't count
  await examples.onRequestPost(ctx("/api/voice/examples", { kind: "rule", situation: "Always", body: "Never discuss price." }));
  assert.equal((await get()).has_price_reply, false);                     // a rule doesn't count
  // (and not because the rule was refused: it was saved, as Nik's own words)
  assert.ok((await get()).examples.some((i) => i.kind === "rule" && i.source === "nik_written" && i.body === "Never discuss price."));
  await examples.onRequestPost(ctx("/api/voice/examples", { kind: "example", situation: "They ask what it costs", body: "It's £1,950 for the site." }));
  assert.equal((await get()).has_price_reply, true);
  const seed = g.examples.find((i) => i.situation === "They ask for more info");
  await exampleId.onRequestDelete(ctx(`/api/voice/examples/${seed.id}`, null, { id: seed.id }));
  assert.ok(!(await get()).examples.some((i) => i.situation === "They ask for more info"));   // deleted seed stays deleted
});

test("has_price_reply: the situation or the text of Nik's own example, in any case", () => {
  const own = (situation, body, extra = {}) => ({ source: "nik_written", kind: "example", situation, body, ...extra });
  assert.equal(voice.hasPriceReply([own("they ask the price", "It's around £2,000.")]), true);
  assert.equal(voice.hasPriceReply([own("They want to know", "It's around £2,000, the PRICE of a good van service.")]), true);
  assert.equal(voice.hasPriceReply([own("HOW MUCH is it", "Have a look at the page.")]), true);
  assert.equal(voice.hasPriceReply([own("They ask for a call", "Yes of course.")]), false);
  assert.equal(voice.hasPriceReply([own("they ask the price", "It's £1,950.", { kind: "rule" })]), false);
  assert.equal(voice.hasPriceReply([own("they ask the price", "It's £1,950.", { source: "nik_sent" })]), false);
  assert.equal(voice.hasPriceReply([own(null, null)]), false);
});

test("the seeds: Nik's exact words as his own examples, each once even when two first GETs race; D1 cost", async () => {
  const DB = fakeD1();
  const getWith = (D) => voice.onRequestGet({ request: new Request(`${ORIGIN}/api/voice`), env: { DB: D }, params: {}, now: NOW });

  // The very first GET: stage 5-6's 4 statements, seedVoice's check and its batch of 3 writes. Then 5 from there on.
  const first = countingDB(DB);
  await getWith(first.DB);
  assert.equal(first.used(), 8);
  const again = countingDB(DB);
  await getWith(again.DB);
  assert.equal(again.used(), 5);

  const seeds = (await (await getWith(DB)).json()).examples.filter((e) => e.id.startsWith("seed:"));
  assert.deepEqual(
    seeds.map(({ id, kind, situation, body, source }) => ({ id, kind, situation, body, source })).sort((a, b) => a.id.localeCompare(b.id)),
    VOICE_SEEDS.map((s) => ({ id: s.id, kind: "example", situation: s.situation, body: s.body, source: "nik_written" }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.ok(seeds.every((e) => e.created_at === "2026-10-21T10:00:00Z"));

  // Two first GETs at once (no voice:seeded yet for either): each seed is still added once.
  const DB2 = fakeD1();
  const [a, b] = await Promise.all([getWith(DB2), getWith(DB2)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const rows = DB2.raw.prepare("SELECT situation FROM style_examples ORDER BY situation").all().map((r) => r.situation);
  assert.deepEqual(rows, ["They ask for a call", "They ask for more info"]);
  assert.equal((await (await getWith(DB2)).json()).has_price_reply, false); // neither seed is a price answer
});

test("has_price_reply goes back to false when Nik deletes his price example (the card comes back)", async () => {
  const DB = fakeD1();
  const call = (handler, path, init = {}, params = {}) =>
    handler({ request: new Request(`${ORIGIN}${path}`, init), env: { DB }, params, now: NOW });
  const get = async () => (await call(voice.onRequestGet, "/api/voice")).json();
  assert.equal((await get()).has_price_reply, false);
  const added = await call(examples.onRequestPost, "/api/voice/examples", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "example", situation: "send me more info", body: "Happy to: HOW MUCH it is is on the page." }),
  });
  assert.equal(added.status, 200);
  const mine = (await get()).examples.find((e) => e.situation === "send me more info");
  assert.equal((await get()).has_price_reply, true); // the text alone is enough
  const gone = await call(exampleId.onRequestDelete, `/api/voice/examples/${mine.id}`, { method: "DELETE" }, { id: mine.id });
  assert.equal(gone.status, 200);
  assert.equal((await get()).has_price_reply, false);
});
