// POST /api/agent/research/<place_id> (agent token) → {ok: true, place_id, grade, total, capped, warnings}: the
// research Routine posts one lead's research (stage 2, 03-research-grade.md). Every field is checked (_lib/research.js
// validateResearch; every problem in one 400 {error: "<n> problems: …", problems}, so Claude fixes them all in one
// retry), the grade is worked out here from the four points (_lib/grade.js; Claude never sends one), and the row is
// stored as done with Nik's note lines kept and the claim deleted (_lib/research-db.js saveResearch). A lead whose row
// is already 'skipped' keeps it untouched (200, with a warning saying the research wasn't saved). The leads table is
// never written. An unknown place_id is a 404. Then stage 4's ensureDemo makes the lead's demo site and its `ready`
// prospect when it qualifies (A+, A or B with an email: 05-demo.md Part A §1); that never changes the reply, and a demo
// that fails here is made by the tick's safety net. Tested in tests/research-post.test.mjs.
import { requireAgent } from "../../../_lib/agentAuth.js";
import { ensureDemo } from "../../../_lib/demo-db.js";
import { gradeFrom } from "../../../_lib/grade.js";
import { saveResearch } from "../../../_lib/research-db.js";
import { validateResearch } from "../../../_lib/research.js";
import { db, json } from "../../../_lib/util.js";

const NOT_OBJECT = "Body must be a JSON object.";
const NO_LEAD = "No lead with that place_id. Use the place_id from the queue exactly.";
// A lead taken off the list while Claude researched it (research-db.js saveResearch leaves a skipped row as it is).
const STAYS_SKIPPED = "This lead was taken off the list while you were researching it (marked not a fit, excluded by " +
  "the scraper or on the do-not-contact list), so this research wasn't saved. Nothing to fix: go on to the next lead.";
// The lead's names the owner check needs, and its research row's status (NULL when it has no row).
const LEAD_SQL = `SELECT l.name, l.town, l.search_town, r.status AS research_status
  FROM leads l LEFT JOIN research r ON r.place_id = l.place_id
  WHERE l.place_id = ?`;

// Every problem at once: {error: "3 problems: a; b; c", problems: [a, b, c]} ("1 problem: …" for one).
function problems(list) {
  const n = `${list.length} ${list.length === 1 ? "problem" : "problems"}`;
  return json({ error: `${n}: ${list.join("; ")}`, problems: list }, 400);
}

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, params, now }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  // The plain message (the same text validateResearch gives), still with `problems` like every other 400 here.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: NOT_OBJECT, problems: [NOT_OBJECT] }, 400);
  }

  const placeId = typeof params?.id === "string" ? params.id : "";
  const lead = placeId ? await DB.prepare(LEAD_SQL).bind(placeId).first() : null;
  if (!lead) return json({ error: NO_LEAD }, 404);

  const checked = validateResearch(body, { name: lead.name, town: lead.town, search_town: lead.search_town });
  if (checked.errors) return problems(checked.errors);
  const { clean } = checked;
  const warnings = [...checked.warnings];
  if (lead.research_status === "skipped") warnings.push(STAYS_SKIPPED);

  const { grade, total, capped } = gradeFrom(clean.points, clean.too_big);
  const at = now ?? new Date();
  await saveResearch(DB, placeId, clean, { grade, total, capped }, warnings, at);
  // A lead that doesn't qualify simply gets no demo; a failure is logged and left to the hot step's safety net.
  try {
    await ensureDemo(DB, placeId, at);
  } catch (err) {
    console.error(`The research was saved, but its demo site couldn't be made now (the tick tries again): ${err?.message ?? err}`);
  }
  return json({ ok: true, place_id: placeId, grade, total, capped, warnings });
}
