// An HTML response for demo pages: never indexed, never framed, never cached by the browser.
export const page = (html, status = 200) => new Response(html, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": "noindex, nofollow",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
    "referrer-policy": "strict-origin-when-cross-origin",
  },
});
