// GET /s/f/<id> → a client site's photo or logo (stage 10, docs/rebuild/09-build.md section 10): the bytes from
// site_files with their type and `cache-control: public, max-age=31536000, immutable`, through the Cache API
// (caches.default, when the runtime has it), so D1 is read once per Cloudflare location. Public on every host (the
// /s/ prefix in _middleware.js): the client's own host and ours, for previews. HEAD gives the headers only; other
// methods are 405. The work is _lib/sites/files.js serveFile; tested in control-room/tests/sites-files.test.mjs.
import { serveFile } from "../../_lib/sites/files.js";
import { db } from "../../_lib/util.js";

const plain = (text, status, extra = {}) => new Response(text, {
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
});

export async function onRequest({ request, env, params, waitUntil }) {
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return plain("Photos can only be fetched.", 405, { allow: "GET, HEAD" });
  let res;
  try {
    const id = typeof params?.id === "string" ? params.id : "";
    const cache = globalThis.caches?.default;
    // The database only on a cache miss: a cached photo is served without touching D1 (not even the schema check).
    res = await serveFile(() => db(env), id, { cache, origin: new URL(request.url).origin, waitUntil });
  } catch (err) {
    console.error(`A client photo couldn't be served: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    res = plain("This photo can't be shown just now. Please try again in a minute.", 503);
  }
  return head ? new Response(null, res) : res;
}
