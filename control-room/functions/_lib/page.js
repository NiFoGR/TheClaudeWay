// An HTML response for demo pages: never indexed, never framed, never cached by the browser.
// page(html, status, extraHeaders) → Response. extraHeaders are set on top (a name page() already sends is replaced,
// never doubled): GET /d/:slug adds DEMO_HEADERS; the order page sends page()'s own headers only.
// Tested in control-room/tests/demo-routes.test.mjs.

const PAGE_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "strict-origin-when-cross-origin",
});

/**
 * The demo page's own headers (05-demo.md Part A §6), for its 200, 410 and 404 alike: nothing loads from anywhere but
 * https images, the inline style and the inline view beacon (which posts to this site only); no form posts, no
 * <base>, no framing; and no-referrer, so their image hosts don't see where the page is.
 */
export const DEMO_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
});

export function page(html, status = 200, extraHeaders = {}) {
  const headers = new Headers(PAGE_HEADERS);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  return new Response(html, { status, headers });
}
