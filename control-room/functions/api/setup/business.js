// Business details (D-7), on Setup → Business details:
//   GET /api/setup/business → {sender_name, legal_name, address, contact_email, ico_number, complete}
//   PUT /api/setup/business {sender_name?, legal_name?, address?, contact_email?, ico_number?} → the same.
// Settings: business:sender_name (Nik's name in emails), business:legal_name, business:address, site:contact_email
// (blank = hello@aetoswebsites.com) and business:ico_number. complete is true once the legal name and the address are
// both filled: the landing footer needs them by law, and the Control Room shows a red banner until then.
// Values are stored as typed (trimmed), never HTML-escaped: escaping happens where they're shown. A field left out
// of a PUT keeps its value; a blank (or null) one clears it by deleting the setting, so every reader's
// getSetting(DB, key, fallback) gets its fallback rather than "". Nothing is saved unless every field given is valid,
// and the changes are written in one batch (all or none).
import { bad, db, json } from "../../_lib/util.js";
import { ERRORS, readJson } from "./mailboxes.js";

export const DEFAULT_CONTACT_EMAIL = "hello@aetoswebsites.com";

const KEYS = {
  sender_name: "business:sender_name",
  legal_name: "business:legal_name",
  address: "business:address",
  contact_email: "site:contact_email",
  ico_number: "business:ico_number",
};
const FIELDS = Object.keys(KEYS);

// The same shape the public site accepts for its mailto: link (site.js), so a saved address is never silently
// replaced by the default there.
const CONTACT_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ICO_RE = /^[A-Z0-9]{6,12}$/;

export const BUSINESS_ERRORS = {
  json: ERRORS.json,
  text: "Each business detail must be text.",
  senderBreak: "Your name for emails can't contain line breaks.",
  senderLong: "Your name for emails is too long: keep it to 100 characters or fewer.",
  legalBreak: "Your full legal name can't contain line breaks.",
  legalLong: "Your full legal name is too long: keep it to 200 characters or fewer.",
  addressLong: "The business address is too long: keep it to 300 characters or fewer.",
  email: "That contact email doesn't look like an email address.",
  ico: "That doesn't look like an ICO registration number (it's on your ICO certificate, e.g. ZA123456).",
};

// Each field's check: the value to store from the trimmed text ("" clears it), or {error}.
const oneLine = (max, breakError, longError) => (s) => {
  if (/[\r\n]/.test(s)) return { error: breakError };
  return s.length > max ? { error: longError } : { value: s };
};
const CHECKS = {
  sender_name: oneLine(100, BUSINESS_ERRORS.senderBreak, BUSINESS_ERRORS.senderLong),
  legal_name: oneLine(200, BUSINESS_ERRORS.legalBreak, BUSINESS_ERRORS.legalLong),
  // An address may be typed over several lines: the site shows it on one line, joined with commas.
  address: (s) => (s.length > 300 ? { error: BUSINESS_ERRORS.addressLong } : { value: s }),
  contact_email: (s) => (!s || (s.length <= 254 && CONTACT_RE.test(s)) ? { value: s.toLowerCase() } : { error: BUSINESS_ERRORS.email }),
  ico_number: (s) => {
    const ico = s.replace(/\s+/g, "").toUpperCase(); // "za 123456" as typed from the certificate is ZA123456
    return !ico || ICO_RE.test(ico) ? { value: ico } : { error: BUSINESS_ERRORS.ico };
  },
};

const filled = (s) => typeof s === "string" && s.trim() !== "";
// The same upsert as settings.js's setSetting; a cleared field deletes its row.
const UPSERT_SQL = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
const DELETE_SQL = "DELETE FROM settings WHERE key = ?";

async function readBusiness(DB) {
  const { results } = await DB.prepare(`SELECT key, value FROM settings WHERE key IN (${FIELDS.map(() => "?").join(", ")})`)
    .bind(...Object.values(KEYS))
    .all();
  const saved = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const out = Object.fromEntries(FIELDS.map((f) => [f, typeof saved[KEYS[f]] === "string" ? saved[KEYS[f]] : ""]));
  out.contact_email = out.contact_email.trim() || DEFAULT_CONTACT_EMAIL;
  out.complete = filled(out.legal_name) && filled(out.address);
  return out;
}

export async function onRequestGet({ env }) {
  return json(await readBusiness(await db(env)));
}

export async function onRequestPut({ request, env }) {
  const DB = await db(env);
  const body = await readJson(request);
  if (!body) return bad(BUSINESS_ERRORS.json);

  const changes = [];
  for (const f of FIELDS) {
    if (body[f] === undefined) continue; // left out: keep what's saved
    if (body[f] !== null && typeof body[f] !== "string") return bad(BUSINESS_ERRORS.text);
    const checked = CHECKS[f]((body[f] ?? "").trim());
    if (checked.error) return bad(checked.error);
    changes.push([KEYS[f], checked.value]);
  }
  if (changes.length) {
    await DB.batch(changes.map(([key, value]) => (value ? DB.prepare(UPSERT_SQL).bind(key, value) : DB.prepare(DELETE_SQL).bind(key))));
  }
  return json(await readBusiness(DB));
}
