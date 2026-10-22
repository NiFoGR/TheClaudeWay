// Aetos mail relay: a Cloudflare Worker that exists only because Pages can't run cron or receive email.
// - Cron, every 5 minutes: POST APP_URL/api/tick?reason=cron, then (once that has settled) ?reason=health; beat `relay`.
// - Email: forward a copy first when FORWARD_COPY_TO is set, save the lower-cased headers (JSON) and the raw MIME
//   (first 262,144 bytes) to inbound_raw, then POST ?reason=inbound. If D1 can't be written it throws, so Cloudflare
//   gives the sender a temporary failure. All the logic lives in the Control Room; this file imports nothing.

// Only functions and the default handler may be exported: workerd refuses to start a Worker with any other named
// export ("Incorrect type for map entry 'X': the provided value is not of type 'function or ExportedHandler'").
const RAW_CAP = 262144; // bytes of raw MIME kept (overview §4)
const DETAIL_CAP = 500; // heartbeat detail, in characters, as beat() caps it
const INSERT_SQL = "INSERT INTO inbound_raw (id, received_at, envelope_from, envelope_to, headers, raw) VALUES (?, ?, ?, ?, ?, ?)";
// The same upsert as beat() in control-room/functions/_lib/routines.js, inlined because the Worker imports nothing.
const BEAT_SQL = "INSERT INTO heartbeats (name, last_at, ok, detail) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (name) DO UPDATE SET last_at = excluded.last_at, ok = excluded.ok, detail = excluded.detail";

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // UTC, no milliseconds, like util.now()
const errorText = (err) => String(err?.message || err || "unknown error");
// The first n characters, never cutting an emoji (a surrogate pair) in half: beat()'s cap.
const cap = (text, n) => {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
};
// /api/tick always answers JSON with a boolean `ran`; anything else (a login page, another site) means it didn't run.
const isTickAnswer = (body) => {
  try {
    return typeof JSON.parse(body)?.ran === "boolean";
  } catch {
    return false;
  }
};
const setting = (value, placeholder) => {
  const v = String(value ?? "").trim();
  return v && v !== placeholder ? v : "";
};
const toBytes = (v) => (typeof v === "string" ? new TextEncoder().encode(v)
  : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v));

/** The first maxBytes of a byte stream as UTF-8 text; it stops reading there. A character cut in half at the cap is
 *  dropped, and the text never encodes to more than maxBytes (bytes that aren't UTF-8 become U+FFFD). */
export async function readCapped(stream, maxBytes = RAW_CAP) {
  const buf = new Uint8Array(maxBytes);
  const reader = stream.getReader();
  let size = 0;
  let ended = false;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      const chunk = toBytes(value);
      const n = Math.min(chunk.length, maxBytes - size);
      buf.set(chunk.subarray(0, n), size);
      size += n;
    }
  } finally {
    if (ended) reader.releaseLock();
    else await reader.cancel().catch(() => {}); // the rest isn't kept
  }
  // stream: true holds back a character cut in half at the cap, instead of turning it into U+FFFD
  const text = new TextDecoder("utf-8").decode(buf.subarray(0, size), { stream: !ended });
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}

/** Headers (or [name, value] pairs, or a plain object) as JSON of lower-cased name → value; a repeated name is
 *  joined with ", ", as Headers does. */
export function headersToJson(headers) {
  const out = Object.create(null);
  const pairs = headers && typeof headers[Symbol.iterator] === "function" ? headers : Object.entries(headers ?? {});
  for (const [name, value] of pairs) {
    const key = String(name).toLowerCase();
    out[key] = Object.hasOwn(out, key) ? `${out[key]}, ${value}` : String(value);
  }
  return JSON.stringify(out);
}

export const tickUrl = (appUrl, reason) => `${String(appUrl).trim().replace(/\/+$/, "")}/api/tick?reason=${encodeURIComponent(reason)}`;

// One tick call: null when it worked, else what went wrong. It never throws.
async function callTick(env, reason) {
  const app = setting(env.APP_URL, "__APP_URL__");
  if (!app) return `${reason}: APP_URL isn't set. Add the repository variable CONTROL_ROOM_URL, then re-run Deploy mail relay.`;
  try {
    const res = await fetch(tickUrl(app, reason), { method: "POST" });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      const hint = /\b1042\b/.test(body) ? " (error 1042: set CONTROL_ROOM_URL to the project's *.pages.dev address, then re-run Deploy mail relay)" : "";
      return `${reason}: HTTP ${res.status}${hint}`;
    }
    if (isTickAnswer(body)) return null; // {ran:false} (too soon or locked) still means the tick was reached
    return `${reason}: the answer (HTTP ${res.status}) wasn't from the Control Room's /api/tick. Check that CONTROL_ROOM_URL is the Control Room's address, then re-run Deploy mail relay.`;
  } catch (err) {
    return `${reason}: ${errorText(err)}`;
  }
}

// Calls the ticks one after the other (never overlapping), then beats `relay` with what happened.
async function tickAndBeat(env, reasons, problems, okDetail) {
  const failed = [];
  for (const reason of reasons) {
    const problem = await callTick(env, reason);
    if (problem) failed.push(problem);
  }
  if (failed.length) problems.unshift(`tick call failed: ${failed.join("; ")}`);
  const detail = cap(problems.length ? problems.join("; ") : okDetail, DETAIL_CAP);
  await env.DB.prepare(BEAT_SQL).bind("relay", isoNow(), problems.length ? 0 : 1, detail).run();
}

export default {
  async email(message, env, ctx) {
    const problems = [];
    const copyTo = setting(env.FORWARD_COPY_TO, "__FORWARD_COPY_TO__");
    if (copyTo) {
      try {
        await message.forward(copyTo); // first, so a copy exists even when D1 can't be written
      } catch (err) {
        problems.push(`forward copy failed: ${errorText(err)}`); // the mail is still saved below
      }
    }
    const raw = await readCapped(message.raw);
    await env.DB.prepare(INSERT_SQL)
      .bind(crypto.randomUUID(), isoNow(), message.from ?? null, message.to ?? null, headersToJson(message.headers), raw)
      .run();
    ctx.waitUntil(tickAndBeat(env, ["inbound"], problems, "email saved, inbound tick called"));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tickAndBeat(env, ["cron", "health"], [], "cron and health ticks called"));
  },
};
