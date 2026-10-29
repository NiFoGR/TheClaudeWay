// POST /api/sites/<client_id>/changes {notes} → Ask Claude for changes (stage 10, docs/rebuild/09-build.md section 13,
// Task 24), behind the login. Saves Nik's notes as change_notes (Claude reads them from GET /api/agent/build/:id) and
// fires the build Routine with "changes: client <client_id>". A site in review goes back to draft ("Claude is making
// your changes", and its Approve todo closes); a live site stays live and gets the change when Claude posts it; the
// onboarding row goes back to building unless the site is live (approved). A fire Claude didn't accept is a 502 in
// plain English and the site and its notes stay as they were (a review site stays ready to approve). 400 "Tell Claude what to change." for empty notes; 409 before Claude has built the site
// (Build again is the button then); 404 for an unknown client. Tested in control-room/tests/sites-api.test.mjs.
import { setSiteStatus } from "../../../_lib/sites/db.js";
import { closeTodos } from "../../../_lib/todo.js";
import { bad, db, json } from "../../../_lib/util.js";
import { clientIdOf, fireBuild, fireError, loadSite, NO_CLIENT, NOT_JSON, nowOf, readBody } from "../[client_id].js";

export const NO_NOTES = "Tell Claude what to change.";
const NOTES_MAX = 4000;
const TOO_LONG = "That's over 4,000 characters: shorten it a little.";
const NOT_BUILT = "Claude hasn't built this site yet: press Build again instead.";

export async function onRequestPost(context) {
  const now = nowOf(context);
  const body = await readBody(context.request);
  if (!body) return bad(NOT_JSON);
  const notes = typeof body.notes === "string" ? body.notes.replace(/\r\n?/g, "\n").trim() : "";
  if (!notes) return bad(NO_NOTES);
  if (notes.length > NOTES_MAX) return bad(TOO_LONG);

  const DB = await db(context.env);
  const site = await loadSite(DB, clientIdOf(context.params));
  if (!site) return bad(NO_CLIENT, 404);
  if (!site.content) return bad(NOT_BUILT, 409);
  const id = site.client_id;
  const before = site.status;
  const after = before === "review" ? "draft" : before;

  // The notes first, so Claude finds them when the Routine starts.
  await setSiteStatus(DB, id, after, now, { notes });
  const fired = await fireBuild(context, DB, `changes: client ${id}`, now);
  if (fired?.ok !== true) {
    // Nothing reached Claude: the site and its notes go back to how they were (Nik presses Send to Claude again).
    await setSiteStatus(DB, id, before, now, { notes: site.change_notes ?? null });
    return bad(fireError(fired, "Send to Claude"), 502);
  }
  // Onboarding goes back to building, except for an approved (live) site: saveContent keeps a live site live and
  // never moves its onboarding row on, so it would be left at building; markLive finishes it instead.
  if (after !== "live") {
    await DB.prepare("UPDATE onboarding SET status = 'building' WHERE client_id = ? AND status <> 'live' AND live_at IS NULL")
      .bind(id)
      .run();
  }
  // A review site is no longer ready to approve: its Approve todo closes (Claude's next post files it again).
  if (before === "review") await closeTodos(DB, `build:${id}:approve`);
  await closeTodos(DB, `build:${id}:stuck`); // filed again 3 h from now if Claude still hasn't posted
  return json({ ok: true, status: after });
}
