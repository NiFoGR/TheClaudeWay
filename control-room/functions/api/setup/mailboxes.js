// POST /api/setup/mailboxes {address, display_name, role, started_on, password?} → {mailbox}: add a sending mailbox
// (Namecheap Private Email). The password is stored only as the secret mailbox:<id>; no response ever contains it,
// just has_password. The checks and the mailbox shape below are shared with mailboxes/[id].js (PATCH) and
// mailboxes/[id]/test.js (Test login, Send test email).
import { secretStatus, setSecret } from "../../_lib/settings.js";
import { ukDate } from "../../_lib/ukTime.js";
import { bad, db, json, now } from "../../_lib/util.js";

// Plain ASCII only: worker-mailer doesn't speak SMTPUTF8, and it writes the address into MAIL FROM / RCPT TO as it is.
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const MAX_EMAIL = 254;
const NAME_MAX = 100;
export const ROLES = ["cold", "system"];

export const ERRORS = {
  json: "That request couldn't be read (it wasn't JSON). Reload Setup and try again.",
  address: "That doesn't look like an email address.",
  duplicate: "That mailbox is already added.",
  startedOn: "Pick the date you bought it (YYYY-MM-DD), today or earlier.",
  name: "Your name can't be empty or contain line breaks.",
  nameLong: `Your name is too long: keep it to ${NAME_MAX} characters or fewer.`,
  role: "Role must be cold or system.",
  password: "The password must be text: copy it again from Namecheap → Private Email and paste it here.",
  notFound: "That mailbox isn't on the list any more. Reload Setup and try again.",
};

const MAILBOX_COLUMNS = "id, address, display_name, role, smtp_host, smtp_port, started_on, cap_override, status, paused_reason, created_at";

/** The trimmed address if it's a plain email address, else null. */
export function emailOrNull(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s.length <= MAX_EMAIL && EMAIL_RE.test(s) ? s : null;
}

/** {value} = the trimmed name shown in the From line, or {error}. */
export function checkName(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value) || !value.trim()) return { error: ERRORS.name };
  const name = value.trim();
  return name.length > NAME_MAX ? { error: ERRORS.nameLong } : { value: name };
}

/** {value} = "cold" | "system", or {error}. */
export function checkRole(value) {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ROLES.includes(role) ? { value: role } : { error: ERRORS.role };
}

/** {value} = a real "YYYY-MM-DD" that isn't later than UK today (the warm-up clock can't start in the future), or {error}. */
export function checkStartedOn(value, today = ukDate(new Date())) {
  const s = typeof value === "string" ? value.trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { error: ERRORS.startedOn };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  const real = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  return real && s <= today ? { value: s } : { error: ERRORS.startedOn };
}

/** {value} = the password to save (null when the field was left blank: keep what's saved), or {error}. Never echoed. */
export function checkPassword(value) {
  if (value == null || value === "") return { value: null };
  return typeof value === "string" ? { value } : { error: ERRORS.password };
}

/** The request's JSON object, or null when it isn't one. */
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export async function loadMailbox(DB, id) {
  return DB.prepare(`SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE id = ?`).bind(String(id ?? "")).first();
}

/** The mailbox as the Setup page sees it: the row plus has_password, never the password itself. */
export async function publicMailbox(DB, row) {
  const name = `mailbox:${row.id}`;
  const status = await secretStatus(DB, [name]);
  return { ...row, has_password: status[name] };
}

const isUniqueClash = (err) => /UNIQUE constraint failed/i.test(String(err?.message ?? ""));

export async function onRequestPost({ request, env }) {
  const DB = await db(env);
  const body = await readJson(request);
  if (!body) return bad(ERRORS.json);

  const address = emailOrNull(body.address)?.toLowerCase();
  if (!address) return bad(ERRORS.address);
  const name = checkName(body.display_name);
  if (name.error) return bad(name.error);
  const role = checkRole(body.role);
  if (role.error) return bad(role.error);
  const startedOn = checkStartedOn(body.started_on);
  if (startedOn.error) return bad(startedOn.error);
  const password = checkPassword(body.password);
  if (password.error) return bad(password.error);

  // lower(): a row stored with capitals by anything else is still the same mailbox.
  if (await DB.prepare("SELECT id FROM mailboxes WHERE lower(address) = ?").bind(address).first("id")) return bad(ERRORS.duplicate, 409);
  const id = crypto.randomUUID();
  try {
    await DB.prepare(
      "INSERT INTO mailboxes (id, address, display_name, role, started_on, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).bind(id, address, name.value, role.value, startedOn.value, now()).run();
  } catch (err) {
    if (isUniqueClash(err)) return bad(ERRORS.duplicate, 409); // added by another tab a moment ago
    throw err;
  }
  if (password.value) await setSecret(DB, `mailbox:${id}`, password.value);
  return json({ mailbox: await publicMailbox(DB, await loadMailbox(DB, id)) }, 201);
}
