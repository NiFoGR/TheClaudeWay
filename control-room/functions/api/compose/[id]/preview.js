// POST /api/compose/<place_id>/preview {to, subject, body} → {text, from, issues}, always 200 (stage 5–6,
// docs/rebuild/06-email-followups.md Part A §A3, Task 10): the composer's "What they'll see", sent 300 ms after Nik
// stops typing. text = the email exactly as they'll get it (greeting, his body with {demo_link} filled in, the cold
// footer), from = "display_name <address>" of the mailbox that will send it, issues = every check Send makes, each
// {code, message} in plain English, in Send's order; [] means Send will go. Part A: Send stays disabled until every
// check passes, so Send's own two (the do-not-email list, an address another lead is being emailed at: sendChecks) are
// run here too once the address is one from the list, where Send puts them (after the text checks, before the demo
// and mailbox ones). A body that isn't JSON {to, subject, body} as text is still 200, with one bad_request issue. No
// email is queued and the tick isn't nudged (composeContext's demoReady may still make a qualifying lead's missing demo,
// as the drawer's demo card does). Behind the login (_middleware.js). Tested in tests/compose-routes.test.mjs.
// D1: composeContext's 9 statements, plus sendChecks' batch of 2.
import { composeContext, previewFirst, sendChecks } from "../../../_lib/first-email.js";
import { db, json } from "../../../_lib/util.js";

// composeContext's codes about where the lead is: they lead the list, and the demo and mailbox ones (the rest of its
// blocking) end it.
const STATE_CODES = new Set(["no_prospect", "already_emailed", "queued_already"]);
const NO_SEND_CHECKS = new Set(["bad_request", "not_in_list"]);

const idOf = (params) => (typeof params?.id === "string" ? params.id : "");

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, params, now }) {
  const input = await request.json().catch(() => null); // previewFirst turns anything unreadable into bad_request
  const DB = await db(env);
  const ctx = await composeContext(DB, idOf(params), now ?? new Date());
  const out = previewFirst(ctx, input);
  // As sendFirst: only for a lead with a prospect and an address from its list.
  if (ctx.stage !== null && !out.issues.some((i) => NO_SEND_CHECKS.has(i.code))) {
    const found = await sendChecks(DB, ctx, input.to);
    if (found.length) {
      const tail = new Set(ctx.blocking.filter((i) => !STATE_CODES.has(i.code)));
      const at = out.issues.findIndex((i) => tail.has(i));
      out.issues.splice(at === -1 ? out.issues.length : at, 0, ...found);
    }
  }
  return json(out);
}
