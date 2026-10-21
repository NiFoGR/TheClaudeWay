// Demo sites: database side. One live demo per lead; a new one is made if the last has expired.
import { PREVIEW_DAYS, slugFor } from "./demo.js";
import { now } from "./util.js";

/** The lead's current demo, made now if it has none (or only an expired one). */
export async function ensureDemo(DB, lead, at = new Date()) {
  const current = await DB.prepare("SELECT * FROM demos WHERE place_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(lead.place_id, at.toISOString()).first();
  if (current) return current;
  const demo = {
    slug: slugFor(lead.name),
    place_id: lead.place_id,
    created_at: now(),
    expires_at: new Date(at.getTime() + PREVIEW_DAYS * 86400000).toISOString(),
  };
  await DB.prepare("INSERT INTO demos (slug, place_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(demo.slug, demo.place_id, demo.created_at, demo.expires_at).run();
  return demo;
}

/** Demo and its lead by slug, or null. */
export async function demoBySlug(DB, slug) {
  if (!/^[a-z0-9-]{3,60}$/.test(String(slug))) return null;
  const demo = await DB.prepare("SELECT * FROM demos WHERE slug = ?").bind(slug).first();
  if (!demo) return null;
  const lead = await DB.prepare("SELECT * FROM leads WHERE place_id = ?").bind(demo.place_id).first();
  return lead ? { demo, lead } : null;
}

export const EVENT_KINDS = ["view", "order_page", "order_click", "ordered"];

/** Record what a prospect did; repeat views within 30 minutes count once. */
export async function recordEvent(DB, demo, kind, at = new Date()) {
  if (!EVENT_KINDS.includes(kind)) return false;
  if (kind !== "ordered" && Date.parse(demo.expires_at) < at.getTime()) return false;
  if (kind === "view") {
    const recent = await DB.prepare("SELECT 1 FROM demo_events WHERE slug = ? AND kind = 'view' AND at > ? LIMIT 1")
      .bind(demo.slug, new Date(at.getTime() - 30 * 60000).toISOString()).first();
    if (recent) return false;
  }
  await DB.prepare("INSERT INTO demo_events (slug, place_id, kind, at) VALUES (?, ?, ?, ?)").bind(demo.slug, demo.place_id, kind, at.toISOString()).run();
  return true;
}
