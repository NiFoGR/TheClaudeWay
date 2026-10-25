// The Control Room's login session (stage 0), in one place: the cookie the login sets and checks, and whether a
// request carries it. The middleware's gate uses these, and the demo beacon (d/[slug]/e.js) uses isOwnerRequest so
// Nik's own visits to a demo never count as views.
// The name and the token are what the login has always set (moved here from _middleware.js unchanged): a change to
// either would log Nik out of the live Control Room. Tested in control-room/tests/demo-routes.test.mjs.

/** The login cookie's name. */
export const SESSION_COOKIE = "cr_session";

/** The login cookie's value for `password`: HMAC-SHA256 of "goldbar-control-room-session" keyed by it, as hex. */
export async function sessionToken(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("goldbar-control-room-session"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether two strings are equal, taking the same time wherever they first differ (for comparing tokens). */
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The value of cookie `name` (a fixed name, never user input) in the request, or "". */
export function readCookie(request, name) {
  const match = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : "";
}

/**
 * Whether the request carries Nik's valid login cookie (cr_session for the current CONTROL_ROOM_PASSWORD), compared in
 * constant time. False when no password is set, so nobody counts as Nik on a misconfigured site.
 */
export async function isOwnerRequest(request, env) {
  const password = env?.CONTROL_ROOM_PASSWORD;
  if (typeof password !== "string" || !password) return false;
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return false;
  return safeEqual(cookie, await sessionToken(password));
}
