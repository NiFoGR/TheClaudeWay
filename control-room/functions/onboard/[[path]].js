// /onboard/* (public on both hosts): nothing is built here yet, so the branded 404 page, never the Control Room's
// index.html (Pages' single-page-app fallback). Stage 9's onboarding routes (e.g. onboard/[token].js) are more
// specific, so Pages runs them first and this stays as the 404 for anything else. Tested in tests/site.test.mjs.
import { renderNotFound, siteResponse } from "../_lib/site.js";

export const onRequest = ({ request }) => {
  const res = siteResponse(renderNotFound(), 404);
  return request.method === "HEAD" ? new Response(null, res) : res;
};
