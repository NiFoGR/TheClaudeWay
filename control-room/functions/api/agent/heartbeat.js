// POST /api/agent/heartbeat {routine, ok?, summary?} → {ok: true}: a Claude Routine checks in (overview §7). Every
// Routine posts {routine} when it starts and {routine, ok, summary} when it finishes; this beats routine:<routine>
// with ok ?? true and summary ?? "started" (capped at 500 characters), which the routine:<name> health light reads.
import { bearerToken, requireAgent } from "../../_lib/agentAuth.js";
import { ROUTINES, beat } from "../../_lib/routines.js";
import { bad, db, json } from "../../_lib/util.js";

const UNKNOWN = `Unknown routine: use one of ${ROUTINES.map((r) => r.name).join(", ")}`;
const example = (name) => `{"routine":"${name}","ok":true,"summary":"one line"}`;

// A heartbeat detail never holds a secret: the key this request was sent with, the legacy OUTREACH_AGENT_TOKEN (a
// plain variable an old Claude environment may still show), or anything shaped like an Anthropic token (a Routine's
// sk-ant-oat01-… token) is replaced before the summary is stored (and before the cap, so no part of one is kept).
function hideSecrets(text, keys) {
  let out = text;
  // Longest first, so a key that contains the other is hidden whole.
  for (const key of keys.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(key).join("[hidden]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[hidden]");
}

// The same rule as requireAgent: the env token only counts with 24+ characters (a shorter one is never a key, and
// hiding a few common characters would mangle the summary).
const envToken = (env) =>
  typeof env.OUTREACH_AGENT_TOKEN === "string" && env.OUTREACH_AGENT_TOKEN.length >= 24 ? env.OUTREACH_AGENT_TOKEN : "";

export async function onRequestPost({ request, env }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(`Send JSON: ${example("research")}.`);
  const routine = ROUTINES.find((r) => r.name === body.routine);
  if (!routine) return bad(UNKNOWN);
  const ok = body.ok ?? true;
  if (typeof ok !== "boolean") return bad(`ok must be true or false, e.g. ${example(routine.name)}.`);
  const summary = body.summary ?? "started";
  if (typeof summary !== "string") return bad("summary must be text: one line saying what the Routine did.");

  await beat(DB, `routine:${routine.name}`, ok, hideSecrets(summary, [bearerToken(request), envToken(env)]));
  return json({ ok: true });
}
