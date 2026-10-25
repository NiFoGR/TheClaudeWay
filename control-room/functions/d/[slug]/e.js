// POST /d/:slug/e {kind} → the demo page's beacon (05-demo.md Part A §8, Task 11): "view" after 4 seconds with the tab
// visible, "order_page" when "Order this site" is clicked or the order page has been open 4 seconds, "order_click" for
// the order page's payment buttons. Always 204 with no body, whatever happens, so the page learns nothing from it.
//
// Stored only when the request is a real prospect's: nothing for a body over 200 bytes or whose kind isn't view,
// order_page or order_click ("ordered" only ever comes from Stripe), a bot, link scanner or empty user-agent
// (demo/bots.js), Nik's login cookie (session.js), an unknown or bad slug, an ended demo, or a lead whose prospect is
// missing or still `ready` (no email has gone out, so it can only be Nik or a leak). A view goes to countView (one per
// 30 minutes, prospects.views, emailed → viewed); the order kinds to recordEvent.
// D1: none for anything turned away before the database (body, user-agent, Nik); demoBySlug's batch of 4, then
// countView's 4–5 or recordEvent's 1. Tested in control-room/tests/demo-routes.test.mjs.
import { isBotUA } from "../../_lib/demo/bots.js";
import { countView, demoBySlug, recordEvent } from "../../_lib/demo-db.js";
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
  if (!found || found.expired) return;
  const stage = found.prospect?.stage;
  if (!stage || stage === "ready") return;
  if (kind === "view") await countView(DB, found.demo, now);
  else await recordEvent(DB, found.demo, kind, now);
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
