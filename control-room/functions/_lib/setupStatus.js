// Setup status (db) and setup gaps (pure): what the Setup page shows, and what's still to set up (Part A "Setup page"
// and "Setup gaps"). The health step turns each gap into a `setup` todo (dedupe setup:<key>, link /#/setup).
//
// The status never holds a secret value: mailbox passwords, the agent token and the Routines' URLs and tokens are only
// ever "set or not" (secretStatus). No query here reads a secret: settings are read by exact key, none of them secret:.
//
// D1 budget: 7 queries, whatever the number of mailboxes: the mailboxes, which secrets are set, the settings,
// sentToday, the latest fire per Routine, the heartbeats and the last inbound email. The health step loads this and
// its own facts (one more query) within 8.
import { mailboxCap } from "./mail/capacity.js";
import { sentToday } from "./mail/outbox.js";
import { ROUTINES } from "./routines.js";
import { secretStatus } from "./settings.js";
import { ukDate } from "./ukTime.js";

export const DEFAULT_CONTACT_EMAIL = "hello@aetoswebsites.com";

const SETUP_LINK = "/#/setup";
const BUSINESS_KEYS = {
  sender_name: "business:sender_name",
  legal_name: "business:legal_name",
  address: "business:address",
  contact_email: "site:contact_email",
  ico_number: "business:ico_number",
};
const OTHER_KEYS = ["agent_token:created_at", "smtp:proof", "setup:test_to"];

// The latest fire per Routine, among the most recent FIRES_LOOKED_AT rows. routine_fires has no index, and the health
// step runs every 5 minutes: reading the newest rows by rowid (insertion order) keeps each run's rows read bounded,
// however long the log grows. A Routine whose last fire is older than that window shows no last fire.
const FIRES_LOOKED_AT = 1000;
const FIRES_SQL = `SELECT routine, at, http_status, error, session_url FROM (
    SELECT routine, at, http_status, error, session_url,
      ROW_NUMBER() OVER (PARTITION BY routine ORDER BY at DESC, rowid DESC) AS n
    FROM routine_fires
    WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM routine_fires) - ?
  ) WHERE n = 1`;
const SETTINGS_SQL = "SELECT key, value FROM settings WHERE key IN (SELECT j.value FROM json_each(?) AS j)";
// The newest inbound email by rowid (the relay inserts them as they arrive): one row read, not a scan.
const LAST_INBOUND_SQL = "SELECT received_at FROM inbound_raw ORDER BY rowid DESC LIMIT 1";

function toDate(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError("The setup status needs the time now, as a Date or an ISO time.");
  return new Date(ms);
}

function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const filled = (value) => typeof value === "string" && value.trim() !== "";

/** The domain of a mailbox's address, lower-cased ("nik@AetosWebsites.com" → "aetoswebsites.com"), or null. */
export function mailboxDomain(mailbox) {
  const address = String(mailbox?.address ?? "").trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1) : "";
  return domain || null;
}

const uniqueDomains = (mailboxes) => [...new Set(mailboxes.map(mailboxDomain).filter(Boolean))];

// The last DNS check of a domain, as Setup's "Check again" cached it in dns:last:<domain> ({at, ok, checks, mx_note});
// a domain never checked (or an unreadable cache) is {at:null, ok:false, checks:[]}.
function dnsOf(text) {
  const v = parseJson(text);
  if (!isObject(v)) return { at: null, ok: false, checks: [], mx_note: null };
  return {
    at: typeof v.at === "string" ? v.at : null,
    ok: v.ok === true,
    checks: Array.isArray(v.checks) ? v.checks : [],
    mx_note: typeof v.mx_note === "string" ? v.mx_note : null,
  };
}

// A routine_fires row as Setup shows it. error is NULL only for a fire Claude accepted.
function fireOf(row) {
  if (!row) return null;
  const status = row.http_status ?? null;
  return {
    at: row.at,
    ok: row.error === null && Number.isInteger(status) && status >= 200 && status < 300,
    http_status: status,
    error: row.error ?? null,
    session_url: row.session_url ?? null,
  };
}

/**
 * The setup status plus every heartbeat ({[name]: {at, ok, detail}}), in 7 queries. health.js uses the heartbeats
 * for its tick and relay lights, so the health step reads them once; loadSetupStatus returns only the status.
 */
export async function readSetup(DB, env, now = new Date()) {
  const at = toDate(now);
  const { results: rows } = await DB.prepare("SELECT * FROM mailboxes ORDER BY created_at, id").all();
  const domains = uniqueDomains(rows);
  const secretNames = [
    ...rows.map((m) => `mailbox:${m.id}`),
    "agent_token",
    ...ROUTINES.flatMap((r) => [`routine:${r.name}:url`, `routine:${r.name}:token`]),
  ];
  const keys = [...Object.values(BUSINESS_KEYS), ...OTHER_KEYS, ...domains.map((d) => `dns:last:${d}`)];
  const [secrets, settingRows, sent, fireRows, beatRows, lastInbound] = await Promise.all([
    secretStatus(DB, secretNames),
    DB.prepare(SETTINGS_SQL).bind(JSON.stringify(keys)).all(),
    sentToday(DB, at),
    DB.prepare(FIRES_SQL).bind(FIRES_LOOKED_AT).all(),
    DB.prepare("SELECT name, last_at, ok, detail FROM heartbeats").all(),
    DB.prepare(LAST_INBOUND_SQL).first("received_at"),
  ]);

  const setting = Object.fromEntries(settingRows.results.map((r) => [r.key, r.value]));
  const text = (key) => (typeof setting[key] === "string" ? setting[key] : "");
  const heartbeats = Object.fromEntries(
    beatRows.results.map((r) => [r.name, { at: r.last_at, ok: Number(r.ok) === 1, detail: r.detail ?? "" }]),
  );
  const fires = Object.fromEntries(fireRows.results.map((r) => [r.routine, r]));
  const today = ukDate(at);

  const status = {
    mailboxes: rows.map((m) => ({
      ...m,
      has_password: secrets[`mailbox:${m.id}`] === true,
      cap_today: mailboxCap(m, today),
      sent_today: Number(sent[m.id]) || 0,
    })),
    routines: ROUTINES.map((r) => ({
      name: r.name,
      label: r.label,
      connected: secrets[`routine:${r.name}:url`] === true && secrets[`routine:${r.name}:token`] === true,
      last_fire: fireOf(fires[r.name]),
      last_beat: heartbeats[`routine:${r.name}`] ?? null,
    })),
    agent_token: { set: secrets.agent_token === true, created_at: setting["agent_token:created_at"] ?? null },
    business: {
      sender_name: text(BUSINESS_KEYS.sender_name),
      legal_name: text(BUSINESS_KEYS.legal_name),
      address: text(BUSINESS_KEYS.address),
      contact_email: text(BUSINESS_KEYS.contact_email).trim() || DEFAULT_CONTACT_EMAIL,
      ico_number: text(BUSINESS_KEYS.ico_number),
    },
    dns: Object.fromEntries(domains.map((d) => [d, dnsOf(setting[`dns:last:${d}`])])),
    // relay_ok/relay_detail: the relay's own beat (ok=0 says what went wrong, e.g. its tick calls failing); null when
    // it hasn't checked in.
    receiving: {
      relay_last_at: heartbeats.relay?.at ?? null,
      relay_ok: heartbeats.relay ? heartbeats.relay.ok : null,
      relay_detail: heartbeats.relay ? heartbeats.relay.detail : null,
      last_inbound_at: lastInbound ?? null,
    },
    smtp_proof: isObject(parseJson(setting["smtp:proof"])) ? parseJson(setting["smtp:proof"]) : null,
    // The address Send test email last went to, so the Setup form can offer it again (Task 20 saves it).
    test_to: setting["setup:test_to"] ?? null,
  };
  return { status, heartbeats };
}

/**
 * What the Setup page shows (never a secret value):
 * {mailboxes: [{…row, has_password, cap_today, sent_today}], routines: [{name, label, connected, last_fire,
 * last_beat}], agent_token: {set, created_at}, business: {sender_name, legal_name, address, contact_email,
 * ico_number}, dns: {[domain]: {at, ok, checks, mx_note}}, receiving: {relay_last_at, relay_ok, relay_detail, last_inbound_at}, smtp_proof,
 * test_to}. last_fire is {at, ok, http_status, error, session_url}; last_beat is {at, ok, detail}.
 */
export async function loadSetupStatus(DB, env, now = new Date()) {
  return (await readSetup(DB, env, now)).status;
}

/**
 * What's still to set up, from a status (pure): [{key, title, detail, link: "/#/setup"}], in the order of Part A's
 * gaps table. Missing parts of the status count as not set up.
 */
export function setupGaps(status) {
  const s = isObject(status) ? status : {};
  const gaps = [];
  const add = (key, title, detail) => gaps.push({ key, title, detail, link: SETUP_LINK });
  const mailboxes = (Array.isArray(s.mailboxes) ? s.mailboxes : []).filter(isObject);

  if (!mailboxes.length) {
    add(
      "first_mailbox",
      "Add your first mailbox",
      "Buy one Namecheap Private Email mailbox on aetoswebsites.com (Launch plan, not the trial), then add it on Setup → Mailboxes. Cold emails start 14 days after the date you bought it, to warm it up.",
    );
  }
  for (const m of mailboxes) {
    if (m.has_password === true || m.id === undefined || m.id === null) continue;
    add(
      `mailbox_password:${m.id}`,
      `Add the password for ${m.address}`,
      "Copy the mailbox password from Namecheap → Private Email, paste it on Setup → Mailboxes, press Save, then press Test login.",
    );
  }
  for (const domain of uniqueDomains(mailboxes)) {
    if (s.dns?.[domain]?.ok === true) continue;
    add(
      `dns:${domain}`,
      `Add the email DNS records for ${domain}`,
      `Setup → DNS for ${domain} shows each record to add in Cloudflare → ${domain} → DNS → Add record. Add the ones marked ✕, then press Check again.`,
    );
  }
  if (s.agent_token?.set !== true) {
    add(
      "agent_token",
      "Make Claude's access key",
      "Press Generate on Setup → Claude → Access key. Copy the key straight away and paste it into the Claude environment as a network secret (routines/README.md, section 1).",
    );
  }
  const routines = Array.isArray(s.routines) ? s.routines : [];
  for (const r of ROUTINES) {
    if (routines.find((x) => x?.name === r.name)?.connected === true) continue;
    add(
      `routine:${r.name}`,
      `Connect Claude's ${r.label} Routine`,
      `Create the aetos-${r.name} Routine as routines/README.md says. Then on Setup → Claude → ${r.label}: paste its URL and token, then press Test fire.`,
    );
  }
  if (!filled(s.business?.legal_name) || !filled(s.business?.address)) {
    add(
      "business",
      "Add your name and business address",
      "The law needs your full name and a business address on aetoswebsites.com (a service address is fine, not your home): add them on Setup → Business details.",
    );
  }
  return gaps;
}
