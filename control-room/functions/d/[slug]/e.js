// POST /d/:slug/e {kind} → the demo page's beacon (05-demo.md Part A §8, Task 11): "view" after 4 seconds with the tab
// visible, "order_page" when "Order this site" is clicked or the order page has been open 4 seconds, "order_click" for
// the order page's payment buttons. Always 204 with no body, whatever happens, so the page learns nothing from it.
//
// Stored only when the request is a real prospect's: nothing for a body over 200 bytes or whose kind isn't view,
// order_page or order_click ("ordered" only ever comes from Stripe), a bot, link scanner or empty user-agent
// (demo/bots.js), Nik's login cookie (session.js), an unknown or bad slug, an ended demo, or a lead with no prospect
// or no first email gone out (demo-db.js's mayCount: then it can only be Nik or a leak). A prospect still `ready` whose
// first email has gone counts: stage 6 records the send (ready → emailed) only on its next followups run, minutes
// later, and they may tap the link as it arrives. A view goes to countView (one per 30 minutes, prospects.views, a
// ready prospect's first_sent, emailed → viewed); the order kinds to mayCount, then recordEvent.
// D1: none for anything turned away before the database (body, user-agent, Nik); demoBySlug's batch of 4, then
// countView's 1–7 (4–5 for a counted view, 7 when it moves a ready prospect on), or mayCount's 1 and recordEvent's 1.
// Tested in control-room/tests/demo-routes.test.mjs and tests/email-e2e.test.mjs.
import { isBotUA } from "../../_lib/demo/bots.js";
import { countView, demoBySlug, mayCount, recordEvent } from "../../_lib/demo-db.js";
import { isOwnerRequest } from "../../_lib/session.js";
import { db } from "../../_lib/util.js";

const MAX_BODY = 200; // bytes: {"kind":"order_click"} is 22
const KINDS = new Set(["view", "order_page", "order_click"]);

// The request body as text when it is at most `max` bytes, else null. Reads no more than `max` bytes plus the chunk
// that crosses it, then cancels the rest.
async function smallBody(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// The beacon's kind from its body ({"kind": "<kind>"}), or "" when the body isn't one we store.
function kindOf(text) {
  if (!text) return "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  const kind = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.kind : undefined;
  return typeof kind === "string" && KINDS.has(kind) ? kind : "";
}

async function store({ request, env, params }) {
  if (isBotUA(request.headers.get("user-agent"))) return;
  const kind = kindOf(await smallBody(request, MAX_BODY));
  if (!kind) return;
  if (await isOwnerRequest(request, env)) return;
  const now = new Date();
  const DB = await db(env);
  const found = await demoBySlug(DB, params?.slug, now);
  if (!found || found.expired || !found.prospect) return;
  // A prospect with a first email gone (mayCount): countView checks it itself, as it reads the stage it moves.
  if (kind === "view") await countView(DB, found.demo, now);
  else if (await mayCount(DB, found.demo)) await recordEvent(DB, found.demo, kind, now);
}

export async function onRequestPost(context) {
  try {
    await store(context);
  } catch (err) {
    // Never the request's cookie or the password: only the error's first line.
    const message = String(err?.message ?? err).split("\n")[0].slice(0, 300);
    console.error(`The demo page's view counter couldn't store a visit: ${message}`);
  }
  return new Response(null, { status: 204 });
}
