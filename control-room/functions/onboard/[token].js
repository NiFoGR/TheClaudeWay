// GET /onboard/<token> → a paying client's onboarding form (stage 10, docs/rebuild/09-build.md section 4). Public:
// the unguessable token is the key (_middleware.js lets /onboard/ through without a login). Unknown token → the 404
// page "This link isn't valid…"; after Send → the thanks page with their answers. The first open makes the client's
// site row. The work is _lib/sites/onboard.js; tested in control-room/tests/sites-onboard.test.mjs.
// Anything else under /onboard/ is functions/onboard/[[path]].js, the 404 page.
import { page } from "../_lib/page.js";
import { onboardPage } from "../_lib/sites/onboard.js";
import { db } from "../_lib/util.js";

// The token is in the address, so nothing on the page may leak it: no referrer, nothing loaded from elsewhere, only
// the inline style and the inline autosave script (which posts to this site only), never framed.
export const ONBOARD_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
});

const UNAVAILABLE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Please try again</title></head><body style="font-family:system-ui,sans-serif;background:#F6F4EF;color:#1A1C20;margin:0;padding:24px 16px"><h1 style="font-size:24px">Please try again in a minute</h1><p>Your form couldn't load just now. Your answers so far are safe. If it keeps happening, reply to our email.</p></body></html>`;

export async function onRequestGet({ env, params }) {
  try {
    const { status, html } = await onboardPage(await db(env), String(params.token ?? ""), new Date());
    return page(html, status, ONBOARD_HEADERS);
  } catch (err) {
    console.error(`The onboarding form couldn't load: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    return page(UNAVAILABLE, 503, ONBOARD_HEADERS);
  }
}

// HEAD (link checkers in mail apps) gets the GET's status and headers, without the body.
export async function onRequestHead(context) {
  const res = await onRequestGet(context);
  return new Response(null, res);
}
