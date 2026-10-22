// PUT /api/setup/routines/<name> {url?, token?} → {connected}: save a Claude Routine's API trigger (Setup → Claude →
// the Routine's row → Save). Both are secrets (routine:<name>:url and :token) and are never sent back. A blank or
// missing field keeps what's saved, so the URL and the token can be pasted one at a time; nothing is saved unless
// every field given is valid. A new fire URL is a new trigger, so an earlier 429 hold (routine:<name>:retry_after)
// is cleared with it.
import { FIRE_URL_RE, ROUTINES, TOKEN_RE } from "../../../_lib/routines.js";
import { getSecret, secretStatus, setSecret, setSetting } from "../../../_lib/settings.js";
import { bad, db, json } from "../../../_lib/util.js";
import { ERRORS, readJson } from "../mailboxes.js";

export const ROUTINE_ERRORS = {
  unknown: "Unknown routine",
  json: ERRORS.json,
  url: "That isn't a Routine fire URL. In Claude: open the Routine → Edit → API trigger → copy the URL that ends in /fire.",
  token: "That isn't a Routine token (they start with sk-ant-oat01-). Generate one in the Routine's API trigger and paste it straight away: it's only shown once.",
  empty: "Nothing to save: paste the Routine's fire URL and its token, then press Save.",
};

/** The Routine called `name` in ROUTINES, or undefined. */
export const routineNamed = (name) => ROUTINES.find((r) => r.name === name);

// {value: the trimmed text, or null for "keep what's saved"} or {error}.
function field(value, valid, error) {
  if (value == null) return { value: null };
  if (typeof value !== "string") return { error };
  const s = value.trim();
  if (!s) return { value: null };
  return valid(s) ? { value: s } : { error };
}

// TOKEN_RE checks the prefix; a token also needs something after it, and no spaces or control characters (it goes
// into the Authorization header as it is).
const isToken = (s) => TOKEN_RE.test(s) && /^sk-ant-oat01-[\x21-\x7e]+$/.test(s);

export async function onRequestPut({ request, env, params }) {
  const routine = routineNamed(params?.name);
  if (!routine) return bad(ROUTINE_ERRORS.unknown, 404);
  const DB = await db(env);
  const body = await readJson(request);
  if (!body) return bad(ROUTINE_ERRORS.json);

  const url = field(body.url, (s) => FIRE_URL_RE.test(s), ROUTINE_ERRORS.url);
  if (url.error) return bad(url.error);
  const token = field(body.token, isToken, ROUTINE_ERRORS.token);
  if (token.error) return bad(token.error);
  if (!url.value && !token.value) return bad(ROUTINE_ERRORS.empty);

  const names = { url: `routine:${routine.name}:url`, token: `routine:${routine.name}:token` };
  if (url.value) {
    const saved = await getSecret(DB, names.url);
    await setSecret(DB, names.url, url.value);
    if (saved && saved !== url.value) await setSetting(DB, `routine:${routine.name}:retry_after`, "");
  }
  if (token.value) await setSecret(DB, names.token, token.value);
  const set = await secretStatus(DB, [names.url, names.token]);
  return json({ connected: set[names.url] && set[names.token] });
}
