// POST /api/setup/site-check → {ok, message}: is the landing page live on the root domain (site:root_host, default
// aetoswebsites.com)? Setup → Business details → Check aetoswebsites.com. It's live when https://<root>/ answers 2xx
// with the landing page's marker (data-aetos-landing on its root element); anything else, an error or no answer
// included, means the custom domain isn't on the Pages project yet.
import { rootHostFor } from "../../_lib/site.js";
import { db, json } from "../../_lib/util.js";

const MARKER = "data-aetos-landing";
const TIMEOUT_MS = 10_000;
export const SITE_LIVE = "The landing page is live.";

export const notLive = (root) =>
  `${root} doesn't show the landing page yet: Cloudflare → Workers & Pages → your Control Room project → Custom domains → add ${root} and www.${root}.`;

export async function onRequestPost({ env }) {
  const DB = await db(env);
  // The very host the middleware serves the landing page on (site:root_host tidied, default aetoswebsites.com).
  const root = await rootHostFor(env, DB);
  const fetchImpl = env.__fetch ?? fetch; // tests only; live it's fetch
  let live = false;
  try {
    const res = await fetchImpl(`https://${root}/`, {
      headers: { accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) live = (await res.text()).includes(MARKER);
    else await res.body?.cancel(); // an error page is never read: let the connection go
  } catch {
    live = false; // no answer: the domain isn't serving the landing page
  }
  return json(live ? { ok: true, message: SITE_LIVE } : { ok: false, message: notLive(root) });
}
