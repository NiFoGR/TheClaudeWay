// POST /api/voice/examples {kind, situation, body} → {example}: Nik added an example reply or a rule under "Your style"
// on the Voice page (stage 5–6, docs/rebuild/06-email-followups.md Part A §A7, Task 12). The reply Routine (stage 7)
// reads them: rules are followed as rules, examples copied closely where the situation matches. `kind` is "example"
// (Example reply) or "rule" (Rule); `situation` is the "When" box, on one line (e.g. "they ask the price", decision
// D-3); `body` the text, trimmed, at most 2,000 characters. Saved with source "nik_written" and a new id.
// Refusals, nothing saved (400, checked in the form's order): "Pick Example reply or Rule.", an empty or over-long
// "When", "Write the text first.", "Too long: <n> characters. Keep it to 2,000."
// Behind the login (_middleware.js). D1: 1 statement. Tested in control-room/tests/voice.test.mjs.
import { bad, db, iso, json } from "../../../_lib/util.js";
import { chars, lf, tooLong } from "../index.js";

export const KINDS = Object.freeze(["example", "rule"]);
export const PICK_KIND = "Pick Example reply or Rule.";
export const NO_SITUATION = 'Fill in "When", e.g. "they ask the price".';
export const SITUATION_MAX = 200; // characters
export const SITUATION_LONG = `Keep "When" short: ${SITUATION_MAX} characters at most.`;
export const NO_TEXT = "Write the text first.";

const INSERT_SQL = "INSERT INTO style_examples (id, kind, situation, body, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, now }) {
  const input = await request.json().catch(() => null);
  const b = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (!KINDS.includes(b.kind)) return bad(PICK_KIND);
  const situation = typeof b.situation === "string" ? b.situation.replace(/\s+/g, " ").trim() : "";
  if (!situation) return bad(NO_SITUATION);
  if (chars(situation) > SITUATION_MAX) return bad(SITUATION_LONG);
  const body = typeof b.body === "string" ? lf(b.body).trim() : "";
  if (!body) return bad(NO_TEXT);
  const long = tooLong(body);
  if (long) return bad(long);

  const DB = await db(env);
  const example = {
    id: crypto.randomUUID(), kind: b.kind, situation, body, source: "nik_written", created_at: iso(now ?? new Date()),
  };
  await DB.prepare(INSERT_SQL)
    .bind(example.id, example.kind, example.situation, example.body, example.source, example.created_at)
    .run();
  return json({ example });
}
