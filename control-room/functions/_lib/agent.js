// The weekly Claude review (a Routine on the owner's Claude subscription) calls /api/agent/* with a bearer token
// (Cloudflare secret OUTREACH_AGENT_TOKEN), not the owner's password.
import { json } from "./util.js";

export function agentDenied(request, env) {
  const token = String(env.OUTREACH_AGENT_TOKEN || "");
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token.length < 24) return json({ error: "OUTREACH_AGENT_TOKEN isn't set in Cloudflare (needs 24+ characters)." }, 503);
  let diff = token.length ^ given.length;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i % Math.max(1, given.length));
  return diff === 0 ? null : json({ error: "Wrong token" }, 401);
}
