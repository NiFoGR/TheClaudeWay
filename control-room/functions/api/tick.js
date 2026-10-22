// GET or POST /api/tick?reason=<reason> → {ran, steps: {name: "ok" | "error" | "skipped" | "deferred"}}, or
// {ran:false, why:"migrated"|"too_soon"|"locked"} when turned away ("migrated": this call created the schema's new
// tables, so the steps wait for the next tick). Called by the relay Worker (cron every 5 minutes, then
// ?reason=health; ?reason=inbound after each email saved). Public but harmless: it only does work that is already due,
// under the tick's lease, and reads nothing from the request but ?reason (anything not ^[a-z_]{1,20}$ is "unknown").
// What each step did, errors included, goes to the `tick` heartbeat, never into this response.
import { errorText, runTick, tickReason } from "../_lib/tick.js";
import { json } from "../_lib/util.js";

const SHOWN = new Set(["skipped", "deferred"]);
const shown = (value) => (typeof value === "object" && value !== null ? "error" : SHOWN.has(value) ? value : "ok");

async function tick({ request, env }) {
  const reason = tickReason(new URL(request.url).searchParams.get("reason"));
  // Tests only: env.__tickSteps replaces the real steps (a Cloudflare variable can't hold functions).
  const steps = Array.isArray(env?.__tickSteps) && env.__tickSteps.every((s) => typeof s?.run === "function") ? env.__tickSteps : undefined;
  let result;
  try {
    result = await runTick(env, reason, new Date(), steps ? { steps } : {});
  } catch (err) {
    // Before any step ran (e.g. no database bound). The reason goes to the Cloudflare log (scrubbed of secrets), not
    // to whoever called.
    console.error(`The tick (${reason}) couldn't run: ${errorText(err, env)}`);
    return json({ ran: false, why: "error" }, 500);
  }
  if (!result.ran) return json({ ran: false, why: result.why });
  return json({ ran: true, steps: Object.fromEntries(Object.entries(result.steps).map(([name, v]) => [name, shown(v)])) });
}

export const onRequestGet = tick;
export const onRequestPost = tick;
