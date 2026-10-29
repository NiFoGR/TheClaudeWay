// Setup's test client (stage 10, docs/rebuild/09-build.md sections 13 and 16, Task 24), behind the login.
//   POST   /api/sites/test-client → makes a Full Package client "Aetos Test Site" (notes TEST, build fee and monthly
//          £0), its onboarding row (status sent, a fresh 32-character token) and its site (is_test = 1: noindex, the
//          chat ignores the offer switch) on site-test.aetoswebsites.com. → {ok: true, client_id, onboard_url,
//          site_link}: Nik fills the form at onboard_url on his phone and the stage runs end to end. 409 while a test
//          client exists (delete it first).
//   DELETE /api/sites/test-client → removes every test client (client_sites.is_test = 1 and clients.notes = 'TEST'):
//          its client, onboarding row, site, enquiries, photos, chat counts, rate-limit counters, todos and unsent
//          emails. Sent mail stays in the history. 404 when there is none.
// Static segments win over [client_id] in Pages routing, so /api/sites/test-client reaches this file.
// A fresh client id each time, so the build Routine fires logged for an earlier test client (routine_fires reasons
// "build: client <id>") can never count against a new one. Tested in control-room/tests/sites-api.test.mjs.
import { ensureSite, setHost } from "../../_lib/sites/db.js";
import { TEST_SITE_HOST } from "../../_lib/sites/hosts.js";
import { ukDate } from "../../_lib/ukTime.js";
import { bad, db, iso, json } from "../../_lib/util.js";
import { nowOf } from "./[client_id].js";

export const TEST_HOST = TEST_SITE_HOST;
export const TEST_NAME = "Aetos Test Site";
const EXISTS = "There's already a test client: delete it first to make a new one.";
const NONE = "There's no test client to delete.";

const TEST_SQL = `SELECT cs.client_id FROM client_sites cs JOIN clients c ON c.id = cs.client_id
  WHERE cs.is_test = 1 AND c.notes = 'TEST'`;
// What DELETE removes: those, plus a test client this route started but never gave a site (a POST cut off between
// its two writes): notes TEST, an id only this route makes (cl_test_…), and no site at all. A real client never
// matches: their ids come from Stripe or the Money page, and their site (if any) has is_test = 0.
const DELETE_SQL = `${TEST_SQL}
  UNION SELECT c.id AS client_id FROM clients c
  WHERE c.notes = 'TEST' AND substr(c.id, 1, 8) = 'cl_test_'
    AND NOT EXISTS (SELECT 1 FROM client_sites cs WHERE cs.client_id = c.id)`;

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

// 24 random bytes as base64url without padding: 32 characters, like stage 9's onboarding tokens.
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function onRequestPost(context) {
  const now = nowOf(context);
  const DB = await db(context.env);
  const existing = await DB.prepare(`${TEST_SQL} LIMIT 1`).first();
  if (existing) return json({ error: EXISTS, client_id: existing.client_id }, 409);

  const id = `cl_test_${hex(6)}`;
  const token = newToken();
  const at = iso(now);
  await DB.batch([
    DB.prepare(
      `INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, notes, created_at)
       VALUES (?, ?, NULL, 'full', 0, 0, 0, ?, 'TEST', ?)`,
    ).bind(id, TEST_NAME, ukDate(now), at),
    DB.prepare("INSERT INTO onboarding (client_id, token, status, created_at) VALUES (?, ?, 'sent', ?)").bind(id, token, at),
  ]);
  let host;
  try {
    await ensureSite(DB, id, { name: TEST_NAME, place_id: null, is_test: true }, now);
    host = await setHost(DB, id, TEST_HOST, now, { test: true });
  } catch (err) {
    await removeClients(DB, [id]); // never leave a half-made test client behind
    throw err;
  }
  if (!host.ok) {
    // Another (real) site holds the test host: undo, so a half-made test client never lingers.
    await removeClients(DB, [id]);
    return bad(host.error, 409);
  }
  const origin = new URL(context.request.url).origin;
  return json({ ok: true, client_id: id, onboard_url: `${origin}/onboard/${token}`, site_link: `/#/site/${id}` });
}

// Everything the test clients left behind, one batch (a few statements per client).
async function removeClients(DB, ids) {
  const stmts = [];
  for (const id of ids) {
    const prefixes = [`build:${id}:`, `setup:client-mail:${id}:`];
    stmts.push(
      DB.prepare("DELETE FROM site_leads WHERE client_id = ?").bind(id),
      DB.prepare("DELETE FROM site_files WHERE client_id = ?").bind(id),
      DB.prepare("DELETE FROM chat_usage WHERE client_id = ?").bind(id),
      DB.prepare("DELETE FROM rate_hits WHERE substr(key, 1, length(?1)) = ?1 OR substr(key, 1, length(?2)) = ?2")
        .bind(`chat:${id}:`, `form:${id}:`),
      DB.prepare(
        `DELETE FROM todos WHERE client_id = ?1 OR substr(dedupe, 1, length(?2)) = ?2 OR substr(dedupe, 1, length(?3)) = ?3`,
      ).bind(id, prefixes[0], prefixes[1]),
      DB.prepare("DELETE FROM messages WHERE client_id = ? AND status = 'queued'").bind(id),
      DB.prepare("DELETE FROM client_sites WHERE client_id = ?").bind(id),
      DB.prepare("DELETE FROM onboarding WHERE client_id = ?").bind(id),
      DB.prepare("DELETE FROM client_links WHERE client_id = ?").bind(id),
      DB.prepare("DELETE FROM clients WHERE id = ? AND notes = 'TEST'").bind(id),
    );
  }
  if (stmts.length) await DB.batch(stmts);
}

export async function onRequestDelete(context) {
  const DB = await db(context.env);
  const { results } = await DB.prepare(DELETE_SQL).all();
  const ids = (results ?? []).map((r) => r.client_id);
  if (!ids.length) return bad(NONE, 404);
  await removeClients(DB, ids);
  return json({ ok: true, deleted: ids });
}
