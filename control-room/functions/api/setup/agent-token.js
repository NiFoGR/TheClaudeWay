// POST /api/setup/agent-token → {token}: make Claude's access key (Setup → Claude → Generate / Replace). 32 random
// bytes as base64url, stored as the secret agent_token with agent_token:created_at. This answer is the only time the
// key is ever shown (no-store): Nik pastes it into the Claude environment as a network secret. Each press makes a
// new key, which replaces the old one at once, so every Routine stops until the new key is pasted.
import { setSecret, setSetting } from "../../_lib/settings.js";
import { db, json, now } from "../../_lib/util.js";

export function makeAgentToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function onRequestPost({ env }) {
  const DB = await db(env);
  const token = makeAgentToken();
  await setSecret(DB, "agent_token", token);
  await setSetting(DB, "agent_token:created_at", now());
  return json({ token });
}
