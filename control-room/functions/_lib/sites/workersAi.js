// The client-site chatbot's model call: Cloudflare Workers AI over its REST API (stage 10, docs/rebuild/09-build.md
// section 11, decision D-6). runModel sends one chat to POST
// https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model} with the secrets cf_ai:account_id and
// cf_ai:token (Setup → "Client sites") and the model in setting chat:model, and gives up after 8 s; testModel is
// Setup's Test button and stores its result in setting chat:last_test as {at, ok, detail}.
//
// runModel never throws and never puts the token or account id in what it returns: an error is {ok: false, status,
// error} with Cloudflare's first error message (scrubbed) or a plain description. D1: 3 setting reads, run in
// parallel, unless the caller passes `config` it has already read.
import { getSecret, getSetting, setSetting } from "../settings.js";
import { iso } from "../util.js";

export const CHAT_MODEL_DEFAULT = "@cf/google/gemma-3-12b-it";
/** Messages across all client sites per UK day (section 11's check 4; protects the Workers AI bill). */
export const CHAT_DAILY_CAP_ALL = 1000;

const API = "https://api.cloudflare.com/client/v4/accounts";
const TIMEOUT_MS = 8000;
const MAX_TOKENS = 200;
const TEMPERATURE = 0.3;
const ERROR_MAX = 200;
const TEST_PROMPT = "Reply with the word OK.";
// Workers AI model names: "@cf/google/gemma-3-12b-it", "@hf/…"; anything else never goes into the URL.
const MODEL_RE = /^@[a-z0-9_-]+(?:\/[a-z0-9._-]+){1,3}$/i;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/; // a 32-hex account id; nothing that could change the path

const NOT_CONNECTED = "The chatbot isn't connected: add the Cloudflare account ID and token on Setup → \"Client sites\".";
const REJECTED = "Cloudflare rejected the token. Make a new token with the 'Workers AI' template and paste it again.";
const BAD_ACCOUNT = "The Cloudflare account ID doesn't look right: copy it again from the Cloudflare dashboard.";
const unknownModel = (model) => `Cloudflare doesn't know the model ${model}. Check the name in the Workers AI model list.`;

/** The model, account and token runModel uses: setting chat:model (else the default) and the two secrets. */
export async function chatConfig(DB) {
  const [account_id, token, model] = await Promise.all([
    getSecret(DB, "cf_ai:account_id"),
    getSecret(DB, "cf_ai:token"),
    getSetting(DB, "chat:model"),
  ]);
  return { account_id, token, model: String(model ?? "").trim() || CHAT_MODEL_DEFAULT };
}

// One line, no secrets, at most 200 characters.
function scrub(text, secrets) {
  let out = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[hidden]");
  return out.slice(0, ERROR_MAX);
}

// The model's text: result.response (section 11), or the chat-completions shape some newer models answer with.
function replyText(body) {
  const r = body?.result;
  if (typeof r?.response === "string") return r.response;
  const choice = r?.choices?.[0]?.message?.content;
  return typeof choice === "string" ? choice : null;
}

/**
 * Runs the model on `messages` ([{role, content}], system first) → {ok: true, text} or {ok: false, status, error}.
 * status is Cloudflare's HTTP status, 0 when nothing came back (timeout, network, not connected). No answer within
 * `timeoutMs` (8 s) is an error, even if the fetch ignores its abort signal. `config` ({account_id, token, model})
 * skips the setting reads.
 */
export async function runModel(DB, messages, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, config } = {}) {
  const { account_id, token, model } = config ?? (await chatConfig(DB));
  if (!account_id || !token) return { ok: false, status: 0, error: NOT_CONNECTED };
  const name = String(model || CHAT_MODEL_DEFAULT);
  if (!MODEL_RE.test(name)) return { ok: false, status: 0, error: `No such model: ${scrub(name, [])}` };
  if (!ACCOUNT_RE.test(String(account_id))) {
    return { ok: false, status: 0, error: BAD_ACCOUNT };
  }
  const secrets = [String(token), String(account_id)];

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, status: 0, error: `Cloudflare didn't answer within ${Math.round(timeoutMs / 100) / 10} s` });
    }, timeoutMs);
  });
  const call = (async () => {
    let res;
    try {
      res = await fetchImpl(`${API}/${account_id}/ai/run/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ messages, max_tokens: MAX_TOKENS, temperature: TEMPERATURE }),
        signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, status: 0, error: `Couldn't reach Cloudflare: ${scrub(err?.message ?? err, secrets) || "network error"}` };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const first = scrub(body?.errors?.[0]?.message, secrets);
    if (!res.ok || body?.success === false) {
      return { ok: false, status: res.status, error: first || "no error message" };
    }
    const text = replyText(body);
    if (text === null) return { ok: false, status: res.status, error: "Cloudflare's answer had no reply in it" };
    return { ok: true, text };
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Setup's wording for a failed Test (section 11). A message that already ends a sentence doesn't get a second ".".
function testDetail(out, model) {
  if (out.status === 401 || out.status === 403) return REJECTED;
  if (out.status === 404 || /no such model/i.test(out.error ?? "")) return unknownModel(model);
  if (out.error === NOT_CONNECTED || out.error === BAD_ACCOUNT) return out.error;
  const said = String(out.error ?? "").replace(/[.!\s]+$/, "") || "no error message";
  if (!out.status) return `${said}. Try again in a minute.`;
  return `Cloudflare answered ${out.status}: ${said}. Try again in a minute.`;
}

/**
 * Setup's Test: sends "Reply with the word OK." → {ok, detail}, "Chatbot connection works ✓ (answered in {s} s)" or
 * what to do about the failure. The result is stored in setting chat:last_test as JSON {at, ok, detail}.
 */
export async function testModel(DB, { fetchImpl = fetch, now = new Date(), timeoutMs = TIMEOUT_MS } = {}) {
  const config = await chatConfig(DB);
  const started = Date.now();
  const out = await runModel(DB, [{ role: "user", content: TEST_PROMPT }], { fetchImpl, timeoutMs, config });
  const seconds = Math.max(0, Date.now() - started) / 1000;
  const result = out.ok
    ? { ok: true, detail: `Chatbot connection works ✓ (answered in ${seconds.toFixed(1)} s)` }
    : { ok: false, detail: testDetail(out, config.model) };
  await setSetting(DB, "chat:last_test", JSON.stringify({ at: iso(now), ...result }));
  return result;
}
