// POST /api/demo/approve {template, version} → {ok: true}: Nik pressed "Approve this look" on the Demo page (stage 4,
// docs/rebuild/05-demo.md Part A §7, decision D-5). `version` is the look's version his page showed, as a JSON number;
// approveTemplate (demo-db.js) stores demo:template:<id>:approved = {version, at} and closes the look's setup todos.
// Refusals, nothing stored: 400 for a look that isn't one, 409 "This look changed since you opened the page. Refresh
// and check it again before approving." when the version isn't the current one, 400 "There's no graded lead to
// preview this look with yet. Approve it once research grades one." when no lead could have shown him the look.
// Behind the login (_middleware.js). D1: 3 statements (the trades, the setting, closing the todos).
// Tested in control-room/tests/demo-api.test.mjs.
import { TEMPLATES } from "../../_lib/demo/render.js";
import { approveTemplate } from "../../_lib/demo-db.js";
import { bad, db, json } from "../../_lib/util.js";
import { NO_LOOK, isLook, lookTrades } from "./index.js";

/** Part A "Errors in plain English", word for word. */
export const CHANGED = "This look changed since you opened the page. Refresh and check it again before approving.";
export const NO_PREVIEW = "There's no graded lead to preview this look with yet. Approve it once research grades one.";

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, now }) {
  const body = await request.json().catch(() => null);
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (!isLook(b.template)) return bad(NO_LOOK);
  // Strict: only the number the page was given ("1" or a newer version is a page from before a change).
  if (b.version !== TEMPLATES[b.template].TEMPLATE.version) return bad(CHANGED, 409);
  const DB = await db(env);
  if (!(await lookTrades(DB))[b.template].graded) return bad(NO_PREVIEW);
  try {
    await approveTemplate(DB, b.template, b.version, now ?? new Date());
  } catch (err) {
    if (err?.message === CHANGED) return bad(CHANGED, 409);
    throw err;
  }
  return json({ ok: true });
}
