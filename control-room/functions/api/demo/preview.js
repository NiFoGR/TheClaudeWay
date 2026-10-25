// GET /api/demo/preview?template=<look id>&place_id=<id> → one lead's demo page drawn in that look, as HTML: what the
// Demo page's phone-sized previews and the lead drawer's Preview toggle (stage 3's leadview.js) frame, in
// <iframe sandbox="">. Demo mode with their latest demo's Order button but no view beacon (previewOf in ./index.js,
// count_views false), so opening a preview never counts as a view. Unlike the public /d/<slug> page it may be framed,
// by the Control Room only: x-frame-options SAMEORIGIN and Part A §6's CSP with frame-ancestors 'self' (and, as it has
// no script, script-src and connect-src 'none'). 400 when the
// look isn't one, 404 "That lead isn't in the database any more." when the lead is gone, both as small HTML pages the
// frame can show. Behind the login (_middleware.js). D1: one statement (after the schema check).
// Tested in control-room/tests/demo-api.test.mjs.
import { h } from "../../_lib/demo/text.js";
import { DEMO_HEADERS, page } from "../../_lib/page.js";
import { db } from "../../_lib/util.js";
import { NO_LOOK, PREVIEW_COLUMNS, isLook, previewOf } from "./index.js";

/** Part A "Errors in plain English": a preview of a lead that's gone. */
export const LEAD_GONE = "That lead isn't in the database any more.";

// Part A §6's CSP with three directives changed. The Control Room may frame it (frame-ancestors 'self'). And since a
// preview never carries the view beacon (count_views false) yet is served on the Control Room's own, logged-in origin,
// no script may run and nothing may connect anywhere, even when this URL is opened directly instead of in the
// sandboxed frame: scraped text that ever slipped past h() still couldn't call /api/* with Nik's cookie.
const PREVIEW_CSP = Object.freeze({ "script-src": "'none'", "connect-src": "'none'", "frame-ancestors": "'self'" });
function previewCsp(csp) {
  const directives = csp.split(";").map((d) => d.trim()).filter(Boolean);
  const out = directives.map((d) => {
    const name = d.split(/\s+/)[0];
    return Object.hasOwn(PREVIEW_CSP, name) ? `${name} ${PREVIEW_CSP[name]}` : d;
  });
  for (const name of Object.keys(PREVIEW_CSP)) {
    if (!directives.some((d) => d.split(/\s+/)[0] === name)) out.push(`${name} ${PREVIEW_CSP[name]}`);
  }
  return out.join("; ");
}

/** The demo page's headers (no-referrer, noindex), with the CSP above: framed by the Control Room only, no script. */
export const PREVIEW_HEADERS = Object.freeze({
  ...DEMO_HEADERS,
  "content-security-policy": previewCsp(DEMO_HEADERS["content-security-policy"]),
  "x-frame-options": "SAMEORIGIN",
});

const PREVIEW_SQL = `SELECT ${PREVIEW_COLUMNS}
  FROM leads l
  LEFT JOIN research r ON r.place_id = l.place_id
  WHERE l.place_id = ?1`;

// A line of plain English in a page the frame can show (Charcoal, white text, nothing else).
function notice(text, status) {
  return page(`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Preview</title>
<style>body{margin:0;padding:32px 16px;background:#1a1c20;color:#fff;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;text-align:center}</style>
</head>
<body>
<p>${h(text)}</p>
</body>
</html>
`, status, PREVIEW_HEADERS);
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const query = new URL(request.url).searchParams;
  const template = query.get("template") ?? "";
  if (!isLook(template)) return notice(NO_LOOK, 400);
  const DB = await db(env);
  const row = await DB.prepare(PREVIEW_SQL).bind(query.get("place_id") ?? "").first();
  if (!row) return notice(LEAD_GONE, 404);
  return page(previewOf(row, template, now ?? new Date()).html, 200, PREVIEW_HEADERS);
}
