// Auth for /api/agent/* (overview §7): Claude's Routines send `Authorization: Bearer <agent token>`, never the owner's
// password. The token is the access key made on Setup → Claude (secret:agent_token, 32 random bytes, base64url). The
// legacy Cloudflare variable OUTREACH_AGENT_TOKEN also works while it's set with 24+ characters. Comparisons are
// constant time, and no response says anything about the key or the token that was sent.
import { getSecret } from "./settings.js";
import { json } from "./util.js";

const ENV_TOKEN_MIN = 24;
const NO_KEY = "No agent key yet: generate one on Setup → Claude.";
const WRONG = "Wrong token";

/**
 * The token after "Bearer" in the Authorization header (the scheme in any case), or "" when there's none. The space
 * after "Bearer" may be missing: the Claude environment's network secret adds the header from a prefix ("Bearer")
 * and the key, and a prefix saved without its space must not turn into a mysterious "Wrong token".
 */
export function bearerToken(request) {
  const header = request?.headers?.get?.("authorization") || "";
  const match = /^Bearer\s*(.*)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

// Constant time for a given key: the lengths are compared first (folded into diff, as in _lib/agent.js), then every
// character of the key is checked whatever the token sent, so the time doesn't depend on how much of it matched.
function sameToken(key, given) {
  let diff = key.length ^ given.length;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i % Math.max(1, given.length));
  return diff === 0;
}

/**
 * null when the request carries a valid agent token; otherwise the Response to send: 503 when no key exists yet
 * (neither secret:agent_token nor a 24+ character env.OUTREACH_AGENT_TOKEN), 401 for a missing or wrong token.
 * One D1 query.
 */
export async function requireAgent(request, env, DB) {
  const saved = await getSecret(DB, "agent_token");
  const legacy = typeof env?.OUTREACH_AGENT_TOKEN === "string" ? env.OUTREACH_AGENT_TOKEN : "";
  const keys = [saved, legacy.length >= ENV_TOKEN_MIN ? legacy : null].filter(Boolean);
  if (!keys.length) return json({ error: NO_KEY }, 503);
  const given = bearerToken(request);
  let allowed = false;
  for (const key of keys) allowed = sameToken(key, given) || allowed; // every key is checked, no early exit
  return allowed ? null : json({ error: WRONG }, 401);
}
