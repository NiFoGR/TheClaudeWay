// /w/ with no slug (public on both hosts): the branded 404 page, never the Control Room's index.html (Pages'
// single-page-app fallback). The temporary links /w/<slug>/… are w/[slug]/[[path]].js, more specific, so Pages runs
// them first. Tested in tests/site.test.mjs.
import { renderNotFound, siteResponse } from "../_lib/site.js";

export const onRequest = ({ request }) => {
  const res = siteResponse(renderNotFound(), 404);
  return request.method === "HEAD" ? new Response(null, res) : res;
};
