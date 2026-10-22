// Claude Routines (db + fetch): wake a Routine through its API trigger, and record heartbeats (overview §7).
//
// A Routine's /fire URL and token are secrets pasted on Setup → Claude (secret:routine:<name>:url and :token). Every
// attempt is logged in routine_fires (error is NULL only for a fire Claude accepted). Nothing is ever retried
// automatically: /fire has no idempotency key, so a retry would start a second session. A 429 holds that Routine's
// fires until its Retry-After has passed (the setting routine:<name>:retry_after), without calling Claude. The token
// is only ever sent to a URL matching FIRE_URL_RE, and no result, log row or error contains the URL or the token.
import { getSecret, getSetting, setSetting } from "./settings.js";
import { ukParts } from "./ukTime.js";

export const ROUTINES = [
  { name: "research", label: "Research", cadenceHours: 26 },
  { name: "reply", label: "Replies", cadenceHours: 26 },
  { name: "weekly-kpis", label: "Weekly KPIs", cadenceHours: 192 },
  { name: "build", label: "Build", cadenceHours: null },
  { name: "monthly-care", label: "Monthly care", cadenceHours: 768 },
];

export const FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;
export const TOKEN_RE = /^sk-ant-oat01-/;

const FIRE_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_S = 3600;
const MAX_HOLD_S = 24 * 3600; // a Retry-After past a day is nonsense for an hourly limit (and could overflow a Date)
const MAX_PAYLOAD = 65_536; // what /fire accepts
const REASON_MAX = 500;
const DETAIL_MAX = 500;
const REACH_MAX = 300;

// UTC ISO without milliseconds, like util.now(), so times compare as text.
const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");

// The first n characters, never cutting an emoji (a surrogate pair) in half.
function cap(text, n) {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

function ukClock(date) {
  const { hh, mm } = ukParts(date);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const notConnected = (label) => `The ${label} Routine isn't connected: paste its URL and token on Setup → Claude.`;
const limitHit = (until) =>
  `Claude's hourly limit for this Routine was hit. It will be tried again when the work is next due, after ${ukClock(until)}.`;

function httpError(status) {
  if (status === 400) return "The Routine is paused or its API trigger is off: open it in Claude and switch it back on.";
  if (status === 401 || status === 403) {
    return "Claude rejected the token: generate a new one in the Routine (Edit → API trigger) and paste it on Setup.";
  }
  if (status === 404) {
    return "Claude couldn't find this Routine (HTTP 404): it may have been deleted. Recreate it from routines/README.md, then paste its new URL and token on Setup → Claude.";
  }
  if (status >= 500) {
    return `Claude couldn't start the Routine (HTTP ${status}, a problem on Claude's side). Wait a few minutes, then press Test fire on Setup → Claude.`;
  }
  return `Claude refused to start the Routine (HTTP ${status}). Open it in Claude, check its API trigger is on, then press Test fire on Setup → Claude.`;
}

const NO_ANSWER = "Couldn't reach Claude: no answer came back.";

// "Couldn't reach Claude: <message>", with the URL, its trigger id and the token taken out of the message, and
// anything shaped like an Anthropic token too (a message may show the token escaped or cut short).
function reachError(err, secrets) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return "Couldn't reach Claude: no answer within 15 seconds (the Routine may still have started).";
  }
  let message = String(err?.message || err || "unknown error");
  const cause = err?.cause?.message;
  if (cause && !message.includes(cause)) message += ` (${cause})`;
  // Longest first, so a secret that contains another is hidden whole.
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("[hidden]");
  }
  message = message.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[hidden]");
  return `Couldn't reach Claude: ${cap(message.replace(/\s+/g, " ").trim(), REACH_MAX)}`;
}

// An HTTP date as Retry-After sends it ("Mon, 19 Oct 2026 12:30:00 GMT"). Checked by shape first: Date.parse alone
// reads junk like "1 2" or "-5" as a date in the past, which would mean no hold at all after a 429.
const HTTP_DATE_RE = /^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// When a 429's Retry-After (seconds, or an HTTP date) ends; an hour when it's missing or unreadable. Rounded up to
// the second, so the stored time is never earlier than Claude asked.
function retryUntil(header, now) {
  const value = String(header ?? "").trim();
  let seconds = DEFAULT_RETRY_AFTER_S;
  if (/^\d+(?:\.\d+)?$/.test(value)) seconds = Number(value);
  else if (HTTP_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
    seconds = Math.max(0, (Date.parse(value) - now.getTime()) / 1000);
  }
  const ms = now.getTime() + Math.min(seconds, MAX_HOLD_S) * 1000;
  return new Date(Math.ceil(ms / 1000) * 1000);
}

// A response header (name in lower case), from a real Response or a test's plain stand-in ({status, headers: {...}}),
// whose keys may be in any case ("Retry-After").
function header(res, name) {
  const headers = res?.headers;
  if (typeof headers?.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? null : headers[key] ?? null;
}

// The response's JSON, or null when there's none (or it can't be read): a fire Claude accepted stays accepted.
async function bodyJson(res) {
  try {
    return typeof res?.json === "function" ? await res.json() : null;
  } catch {
    return null;
  }
}

// An error response's body is never read: let it go, so Workers doesn't keep the connection waiting on it.
async function discard(res) {
  try {
    await res?.body?.cancel?.();
  } catch {
    // nothing to free
  }
}

// The claude.ai link of the session the fire started: the response's session URL, else one made from its session id.
// /fire documents its answer as {type: "routine_fire", claude_code_session_id, claude_code_session_url}; the plain
// session_url / session_id names are read too. Only an https:// link or a plain id is kept (Setup shows the link).
function sessionLink(body) {
  for (const url of [body?.session_url, body?.claude_code_session_url]) {
    if (typeof url === "string" && url.startsWith("https://")) return url;
  }
  for (const id of [body?.session_id, body?.claude_code_session_id]) {
    if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)) return `https://claude.ai/code/${id}`;
  }
  return undefined;
}

async function logFire(DB, name, text, at, { http_status = null, error = null, session_url = null } = {}) {
  await DB.prepare(
    "INSERT INTO routine_fires (id, routine, reason, http_status, error, session_url, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), name, cap(text, REASON_MAX), http_status, error, session_url, at)
    .run();
}

/**
 * Wake the Routine `name` with the payload `text` (short and factual, e.g. "reply waiting: 1 message(s)").
 * Returns {ok, status, error?, session_url?}; status is the HTTP status, 429 for a fire held by an earlier 429, and
 * null when Claude wasn't reached. Never throws for a failed fire (only for an unknown name or an empty payload, which
 * are bugs in the caller). One D1 query per secret and setting read, one for the log row, one more after a 429.
 */
export async function fireRoutine(DB, name, text, { fetchImpl = fetch, now = new Date() } = {}) {
  const routine = ROUTINES.find((r) => r.name === name);
  if (!routine) throw new TypeError(`Unknown routine: use one of ${ROUTINES.map((r) => r.name).join(", ")}`);
  if (typeof text !== "string" || !text || text.length > MAX_PAYLOAD) {
    throw new TypeError("A Routine fire needs a text payload of 1 to 65,536 characters.");
  }
  const when = new Date(now);
  const at = iso(when);
  const failed = async (status, error, http_status = null) => {
    await logFire(DB, name, text, at, { http_status, error });
    return { ok: false, status, error };
  };

  const url = await getSecret(DB, `routine:${name}:url`);
  const token = await getSecret(DB, `routine:${name}:token`);
  // A saved URL that isn't a Routine's /fire URL is never called, so the token can't be sent anywhere else.
  if (!url || !token || !FIRE_URL_RE.test(url)) return failed(null, notConnected(routine.label));

  const heldUntil = Date.parse((await getSetting(DB, `routine:${name}:retry_after`)) ?? "");
  if (heldUntil > when.getTime()) return failed(429, limitHit(new Date(heldUntil)));

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
      },
      body: JSON.stringify({ text }),
      redirect: "manual", // the token never follows a redirect to another host
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
  } catch (err) {
    return failed(null, reachError(err, [url, url.match(/trig_[A-Za-z0-9]+/)?.[0], token]));
  }

  // Judged by the status code, so a test's plain {status: 200} stand-in counts the same as a real Response.
  const status = Number.isInteger(res?.status) ? res.status : res?.ok === true ? 200 : 0;
  if (!status) return failed(null, NO_ANSWER); // no response at all (or an opaque one): Claude wasn't reached
  if (status >= 200 && status < 300) {
    const session_url = sessionLink(await bodyJson(res));
    await logFire(DB, name, text, at, { http_status: status, session_url: session_url ?? null });
    return session_url ? { ok: true, status, session_url } : { ok: true, status };
  }
  await discard(res);
  if (status === 429) {
    const until = retryUntil(header(res, "retry-after"), when);
    await setSetting(DB, `routine:${name}:retry_after`, iso(until));
    return failed(429, limitHit(until), 429);
  }
  return failed(status, httpError(status), status);
}

/**
 * Record that `name` (tick, health, relay, routine:<name>, …) checked in: one heartbeats row per name, replaced each
 * time. ok is stored as 1/0 and detail is capped at 500 characters. Never put a secret in detail.
 */
export async function beat(DB, name, ok, detail = "", now = new Date()) {
  if (typeof name !== "string" || !name) {
    throw new TypeError('A heartbeat needs a name, e.g. "tick" or "routine:research".');
  }
  await DB.prepare(
    `INSERT INTO heartbeats (name, last_at, ok, detail) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET last_at = excluded.last_at, ok = excluded.ok, detail = excluded.detail`,
  )
    .bind(name, iso(now), ok ? 1 : 0, cap(String(detail ?? ""), DETAIL_MAX))
    .run();
}
