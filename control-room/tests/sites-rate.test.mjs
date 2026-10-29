// Per-visitor rate limits for client sites (09-build.md Task 15): visitor ids that never hold the IP, hourly
// windows in rate_hits, pruning after 48 h.
// Run: node --test control-room/tests/sites-rate.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { hit, pruneHits, visitorId } from "../functions/_lib/sites/rate.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const IP = "203.0.113.45";
const T = new Date("2026-10-19T09:15:00Z");
const HOUR = 3600000;

const req = (ip) => new Request("https://www.smithroofing.co.uk/s/chat", { headers: ip ? { "CF-Connecting-IP": ip } : {} });

test("visitorId: same IP + client + UK day → same id; never the IP", async () => {
  const a = await visitorId(req(IP), "c1", T);
  const b = await visitorId(req(IP), "c1", new Date("2026-10-19T22:59:00Z")); // still 19 Oct in the UK (BST)
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes(IP));
  assert.ok(!a.includes("203"));

  // Different client → different id.
  const other = await visitorId(req(IP), "c2", T);
  assert.match(other, /^[0-9a-f]{16}$/);
  assert.notEqual(other, a);

  // Next UK day (23:30 UTC on 19 Oct is 00:30 BST on 20 Oct) → a new id.
  const nextDay = await visitorId(req(IP), "c1", new Date("2026-10-19T23:30:00Z"));
  assert.notEqual(nextDay, a);

  // Different IP → different id.
  assert.notEqual(await visitorId(req("198.51.100.7"), "c1", T), a);
});

test("visitorId: first 16 hex of SHA-256(ip|client_id|UK date)", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${IP}|c1|2026-10-19`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(await visitorId(req(IP), "c1", T), hex.slice(0, 16));
  // ISO strings work as `now` too.
  assert.equal(await visitorId(req(IP), "c1", "2026-10-19T09:15:00Z"), hex.slice(0, 16));
});

test("visitorId: no CF-Connecting-IP still gives a 16-hex id", async () => {
  assert.match(await visitorId(req(null), "c1", T), /^[0-9a-f]{16}$/);
});

test("hit: 20 allowed with limit 20, 21st refused, next hour allowed again", async () => {
  const DB = fakeD1();
  const key = "chat:c1:0123456789abcdef";
  for (let i = 1; i <= 20; i++) {
    assert.deepEqual(await hit(DB, key, new Date(T.getTime() + i * 1000), 20), { allowed: true, count: i });
  }
  assert.deepEqual(await hit(DB, key, T, 20), { allowed: false, count: 21 });

  // One row per key and UTC hour; no IP stored anywhere.
  const rows = DB.raw.prepare("SELECT key, win, count FROM rate_hits").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key, win: "2026-10-19T09", count: 21 }]);
  assert.ok(!JSON.stringify(rows).includes(IP));

  // Another key is counted on its own.
  assert.deepEqual(await hit(DB, "form:c1:0123456789abcdef", T, 5), { allowed: true, count: 1 });

  // Next UTC hour → allowed again.
  assert.deepEqual(await hit(DB, key, new Date("2026-10-19T10:00:00Z"), 20), { allowed: true, count: 1 });
});

test("hit: a missing limit is a plain-English error, not a silent refusal of every visitor", async () => {
  const DB = fakeD1();
  await assert.rejects(hit(DB, "chat:c1:0123456789abcdef", T), /rate limit for chat isn't a number/);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM rate_hits").get().n, 0);
});

test("pruneHits at +49 h deletes the old window", async () => {
  const DB = fakeD1();
  const key = "chat:c1:0123456789abcdef";
  await hit(DB, key, T, 20);
  await hit(DB, key, T, 20);

  // At +47 h the window is kept.
  assert.equal(await pruneHits(DB, new Date(T.getTime() + 47 * HOUR)), 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM rate_hits").get().n, 1);

  // A recent window survives the prune at +49 h.
  const later = new Date(T.getTime() + 49 * HOUR);
  await hit(DB, key, later, 20);
  assert.equal(await pruneHits(DB, later), 1);
  const left = DB.raw.prepare("SELECT win, count FROM rate_hits").all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ win: "2026-10-21T10", count: 1 }]);
});
