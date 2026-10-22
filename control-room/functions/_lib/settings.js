// Settings and secrets (db), in the `settings` table. Every value is a plain string: callers JSON.stringify objects
// themselves. The old JSON keys (stripe, territory, setup_done) keep using stripe.js's getSetting and putSetting.
//
// Secrets are settings whose key starts "secret:". Only server code reads them (getSecret); the Setup page gets
// secretStatus, which says whether each one is set and never sends a value. No error here contains a value.

const SECRET = "secret:";

function checkKey(key, what = "setting") {
  if (typeof key !== "string" || !key) {
    throw new TypeError(`A ${what} needs a name, got ${key === "" ? "an empty one" : typeof key}.`);
  }
}

// What goes into settings.value (TEXT NOT NULL): strings as they are, finite numbers as text.
function text(key, value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // A Date is refused too: JSON.stringify would store it with quotes, and String() isn't ISO.
  const [got, hint] = value instanceof Date ? ["a Date", " (store times as UTC ISO text, as util.now() gives)"]
    : value === null ? ["null", ""]
    : typeof value === "object" ? ["an object", " (JSON.stringify objects before saving them)"]
    : [typeof value, ""];
  throw new TypeError(`The setting ${key} must be text, got ${got}${hint}.`);
}

/** The text stored under `key`, or `fallback` when there's no such setting. */
export async function getSetting(DB, key, fallback = null) {
  checkKey(key);
  const value = await DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  return value ?? fallback;
}

/** Store `value` (a string; a number is stored as text) under `key`, replacing what was there. */
export async function setSetting(DB, key, value) {
  checkKey(key);
  await DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, text(key, value))
    .run();
}

/** The secret stored as "secret:" + name, or null when it isn't set (an empty value counts as not set). */
export async function getSecret(DB, name) {
  checkKey(name, "secret");
  return (await getSetting(DB, SECRET + name)) || null;
}

/** Store a secret as "secret:" + name. The value must be a string, and is never echoed in an error. */
export async function setSecret(DB, name, value) {
  checkKey(name, "secret");
  if (typeof value !== "string") throw new TypeError(`The secret ${name} must be text, got ${value === null ? "null" : typeof value}.`);
  await setSetting(DB, SECRET + name, value);
}

/**
 * For Setup: {[name]: true|false}, whether each secret is set. Never the value. One query however many names
 * (they're bound as one JSON array, since D1 allows only 100 bound values per statement).
 */
export async function secretStatus(DB, names) {
  if (!Array.isArray(names)) throw new TypeError("secretStatus needs a list of secret names.");
  names.forEach((name) => checkKey(name, "secret"));
  const status = Object.fromEntries(names.map((name) => [name, false]));
  if (!names.length) return status;
  const { results } = await DB.prepare(
    "SELECT key FROM settings WHERE key IN (SELECT 'secret:' || j.value FROM json_each(?) AS j) AND value <> ''",
  ).bind(JSON.stringify(names)).all();
  for (const { key } of results) status[key.slice(SECRET.length)] = true;
  return status;
}
