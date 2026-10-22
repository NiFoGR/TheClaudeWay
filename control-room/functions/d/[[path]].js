// /d/* that isn't a demo page (/d/, /d/:slug/<unknown>): the branded 404 page, never the Control Room's index.html
// (Pages' single-page-app fallback, which /d/* would otherwise fall through to without a login, on both hosts).
// /d/:slug, /d/:slug/order and /d/:slug/e are more specific, so Pages runs them first. Tested in tests/site.test.mjs.
import { renderNotFound, siteResponse } from "../_lib/site.js";

export const onRequest = ({ request }) => {
  const res = siteResponse(renderNotFound(), 404);
  return request.method === "HEAD" ? new Response(null, res) : res;
};
