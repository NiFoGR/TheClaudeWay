// Stage 10's tables (09-build.md Task 1): client_sites, site_leads, chat_usage, site_files, rate_hits and their keys.
// Run: node --test control-room/tests/sites-schema.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA } from "../functions/_lib/schema.js";
import { schemaObject } from "../functions/_lib/util.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const T = "2026-10-19T09:00:00Z";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

test("site tables exist with keys", async () => {
  const DB = fakeD1();

  // client_sites: host is unique.
  await insert(DB, "client_sites", {
    client_id: "c1", slug: "smith-roofing-abc123", host: "www.smithroofing.co.uk", status: "draft", domain: "{}",
    created_at: T, updated_at: T,
  });
  await assert.rejects(
    insert(DB, "client_sites", {
      client_id: "c2", slug: "jones-roofing-def456", host: "www.smithroofing.co.uk", status: "draft", domain: "{}",
      created_at: T, updated_at: T,
    }),
    /UNIQUE/,
  );
  // host is NULL until known: any number of sites may wait for one. slug and client_id stay unique.
  await insert(DB, "client_sites", { client_id: "c3", slug: "a-plumbing-111111", status: "draft", domain: "{}", created_at: T, updated_at: T });
  await insert(DB, "client_sites", { client_id: "c4", slug: "b-plumbing-222222", status: "draft", domain: "{}", created_at: T, updated_at: T });
  await assert.rejects(
    insert(DB, "client_sites", { client_id: "c5", slug: "a-plumbing-111111", created_at: T, updated_at: T }),
    /UNIQUE/,
  );
  await assert.rejects(
    insert(DB, "client_sites", { client_id: "c1", slug: "other-slug-333333", created_at: T, updated_at: T }),
    /UNIQUE/,
  );
  const site = await DB.prepare("SELECT * FROM client_sites WHERE client_id = 'c1'").first();
  assert.equal(site.status, "draft");
  assert.equal(site.features, "{}");
  assert.equal(site.is_test, 0);
  // Defaults when the insert names only the required columns.
  const bare = await DB.prepare("SELECT status, domain, features, host FROM client_sites WHERE client_id = 'c3'").first();
  assert.deepEqual(bare, { status: "draft", domain: "{}", features: "{}", host: null });

  // site_leads: any number of form leads (session NULL); one lead per chat session per site.
  const lead = (id, session) => insert(DB, "site_leads", {
    id, client_id: "c1", source: session ? "chat" : "form", name: "Mark", session, created_at: T, updated_at: T,
  });
  await lead("l1", null);
  await lead("l2", null);
  await lead("l3", "s1");
  await assert.rejects(lead("l4", "s1"), /UNIQUE/);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM site_leads").first("n"), 3);
  assert.equal(await DB.prepare("SELECT message FROM site_leads WHERE id = 'l1'").first("message"), "");

  // chat_usage: one row per site per UK day.
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-19" });
  await assert.rejects(insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-19" }), /UNIQUE/);
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-20" });
  assert.deepEqual(
    await DB.prepare("SELECT messages, fallbacks, ai_errors FROM chat_usage WHERE client_id = 'c1' AND day = '2026-10-19'").first(),
    { messages: 0, fallbacks: 0, ai_errors: 0 },
  );

  // site_files: bytes are a BLOB.
  await insert(DB, "site_files", {
    id: "a".repeat(32), client_id: "c1", kind: "photo", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), size: 3,
    width: 3, height: 2, created_at: T,
  });
  const file = await DB.prepare("SELECT * FROM site_files WHERE id = ?").bind("a".repeat(32)).first();
  assert.equal(file.bytes.length, 3);
  assert.deepEqual(Array.from(file.bytes), [1, 2, 3]);
  assert.equal(file.width, 3);
  assert.equal(file.height, 2);
  assert.equal(file.alt, "");

  // rate_hits: (key, win) is the primary key.
  await insert(DB, "rate_hits", { key: "chat:c1:0123456789abcdef", win: "2026-10-19T09", count: 1 });
  await insert(DB, "rate_hits", { key: "chat:c1:0123456789abcdef", win: "2026-10-19T10", count: 1 });
  await assert.rejects(
    insert(DB, "rate_hits", { key: "chat:c1:0123456789abcdef", win: "2026-10-19T09", count: 1 }),
    /UNIQUE/,
  );
});

test("db() can tell when the UNIQUE index on site_leads is missing", () => {
  const sql = SCHEMA.find((s) => /site_leads_session/.test(s));
  assert.match(sql, /^CREATE UNIQUE INDEX IF NOT EXISTS site_leads_session ON site_leads \(client_id, session\)$/);
  assert.equal(schemaObject(sql), "index:site_leads_session");
  for (const t of ["client_sites", "site_leads", "chat_usage", "site_files", "rate_hits"]) {
    assert.ok(SCHEMA.some((s) => schemaObject(s) === `table:${t}`), t);
  }
});
