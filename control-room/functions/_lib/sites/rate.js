// Per-visitor rate limits for client sites (chat and the contact form). A visitor is the first 16 hex characters of
// SHA-256(CF-Connecting-IP | client_id | UK date): raw IPs are never stored, and the id changes every UK day.
// Counts live in rate_hits, one row per key and UTC hour ("YYYY-MM-DDTHH"); rows older than 48 h are pruned.

import { ukDate } from "../ukTime.js";

const HOUR_MS = 3600000;
const KEEP_HOURS = 48;

function toDate(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error(`The rate-limit time isn't a valid date: ${JSON.stringify(String(now))}`);
  return date;
}

// The UTC hour window, "YYYY-MM-DDTHH".
const windowOf = (date) => date.toISOString().slice(0, 13);

/** The visitor id for this request on this site today: 16 hex characters, never the IP itself. */
export async function visitorId(request, client_id, now) {
  const ip = request?.headers?.get("CF-Connecting-IP") || "";
  const text = `${ip}|${client_id}|${ukDate(toDate(now))}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Counts one hit for `key` in the current UTC hour; allowed while the count is at most `limit`. */
export async function hit(DB, key, now, limit) {
  if (!Number.isFinite(limit)) throw new Error(`The rate limit for ${String(key).split(":")[0]} isn't a number: ${JSON.stringify(String(limit))}`);
  const row = await DB.prepare(
    `INSERT INTO rate_hits (key, win, count) VALUES (?, ?, 1)
     ON CONFLICT(key, win) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(String(key), windowOf(toDate(now)))
    .first();
  const count = Number(row?.count) || 0;
  return { allowed: count <= limit, count };
}

/** Deletes windows older than 48 h; returns how many rows went. */
export async function pruneHits(DB, now) {
  const cutoff = windowOf(new Date(toDate(now).getTime() - KEEP_HOURS * HOUR_MS));
  const result = await DB.prepare("DELETE FROM rate_hits WHERE win < ?").bind(cutoff).run();
  return Number(result?.meta?.changes) || 0;
}
