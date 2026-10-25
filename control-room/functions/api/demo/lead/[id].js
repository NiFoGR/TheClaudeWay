// GET /api/demo/lead/<place_id> → {demo: {slug, url, expires_at} | null, views, last_view_at, stage, ready}: the lead
// drawer's "Demo site" card (stage 4, docs/rebuild/05-demo.md "What Nik sees"; Task 14's demoCardHtml draws it into
// stage 3's #d-demo). `ready` is demoReady's answer ({ok, reason, url, slug}: "No demo yet: <reason>", "Their demo has
// expired: a new one is being made" or "Waiting for you to approve the <Label> look on the Demo page"), `demo` the
// lead's latest demo (url = the https://aetoswebsites.com/d/<slug> link the email carries; "Open demo" uses the
// relative /d/<slug> so Nik's views never count), views, last_view_at and stage their prospect's (0, null and null
// without one; the card shows no end date for a won prospect, whose page never ends: Part A §2).
// demoReady makes a qualifying lead's missing demo and prospect (as the hot step would), so the card is read after it.
// A lead that's gone answers 200 with ready "No demo yet: Lead not found". Behind the login (_middleware.js).
// D1: 2 statements for a lead that has its demo (demoReady's one select, then the card's).
// Tested in control-room/tests/demo-api.test.mjs.
import { demoLink, demoReady } from "../../../_lib/demo-db.js";
import { db, json } from "../../../_lib/util.js";

// The lead's latest demo (newest created_at, then slug: demo-db.js's latestDemo rule, inlined so the card is one
// statement; demoReady judges the same row) and its prospect's views.
const CARD_SQL = `SELECT d.slug, d.expires_at, p.views, p.last_view_at, p.stage
  FROM leads l
  LEFT JOIN prospects p ON p.place_id = l.place_id
  LEFT JOIN demos d ON d.slug = (SELECT d2.slug FROM demos d2 WHERE d2.place_id = l.place_id
    ORDER BY d2.created_at DESC, d2.slug DESC LIMIT 1)
  WHERE l.place_id = ?1`;

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, params, now }) {
  const DB = await db(env);
  const id = typeof params?.id === "string" ? params.id : "";
  const ready = await demoReady(DB, id, now ?? new Date());
  const row = await DB.prepare(CARD_SQL).bind(id).first();
  return json({
    demo: row?.slug ? { slug: row.slug, url: demoLink(row.slug), expires_at: row.expires_at } : null,
    views: Number(row?.views) || 0,
    last_view_at: row?.last_view_at ?? null,
    stage: row?.stage ?? null,
    ready,
  });
}
