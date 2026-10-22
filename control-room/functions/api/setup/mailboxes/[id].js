// PATCH /api/setup/mailboxes/<id> {display_name?, role?, started_on?, cap_override?, status?: "active"|"paused", password?}
// → {mailbox}: Setup's Edit, Pause and Resume. Every field is checked before anything is saved, so one bad field
// changes nothing. Resume (paused → active) clears paused_reason and sets mailbox:<id>:resumed_at, so only bounces after
// it count towards the next automatic pause. A blank password keeps the saved one; none is ever sent back.
// Setup's Edit form must not send `status`: a stale "active" from when the page loaded would resume a mailbox that
// bounces paused since (and restart its bounce count). Only the Pause and Resume buttons send {status}.
import { setSecret, setSetting } from "../../../_lib/settings.js";
import { bad, db, json, now } from "../../../_lib/util.js";
import {
  ERRORS, checkName, checkPassword, checkRole, checkStartedOn, loadMailbox, publicMailbox, readJson,
} from "../mailboxes.js";

const CAP_MAX = 200;
const CAP_ERROR = `The daily cap must be a whole number from 0 to ${CAP_MAX}, or leave it empty to follow the warm-up.`;
const STATUS_ERROR = "Status must be active or paused.";
const ADDRESS_FIXED = "A mailbox's address can't be changed. Add the new address as a new mailbox, then pause this one.";
const NOTHING = "Nothing to change.";
export const MANUAL_PAUSE = "you paused it on Setup.";

/** {value} = a whole number 0–CAP_MAX, or null (empty: follow the warm-up ramp), or {error}. */
function checkCap(value) {
  if (value === null || value === "") return { value: null };
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= CAP_MAX ? { value: n } : { error: CAP_ERROR };
}

export async function onRequestPatch({ request, env, params }) {
  const DB = await db(env);
  const body = await readJson(request);
  if (!body) return bad(ERRORS.json);
  const current = await loadMailbox(DB, params.id);
  if (!current) return bad(ERRORS.notFound, 404);

  const sets = [];
  const values = [];
  let touched = false;
  const field = (column, value) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (body.address !== undefined) {
    // The Edit form may send the address back: the same one (any capitals) is fine, a different one isn't.
    const same = typeof body.address === "string" && body.address.trim().toLowerCase() === String(current.address).toLowerCase();
    if (!same) return bad(ADDRESS_FIXED);
    touched = true;
  }
  for (const [key, check] of [["display_name", checkName], ["role", checkRole], ["started_on", checkStartedOn], ["cap_override", checkCap]]) {
    if (body[key] === undefined) continue;
    const r = check(body[key]);
    if (r.error) return bad(r.error);
    field(key, r.value);
    touched = true;
  }

  let resumed = false;
  if (body.status !== undefined) {
    if (body.status === "paused") {
      if (current.status !== "paused") {
        // SET reads the row as it was, so a bounce pause that lands between our read and this write keeps its reason.
        sets.push("status = 'paused'", "paused_reason = CASE WHEN status = 'paused' THEN paused_reason ELSE ? END");
        values.push(MANUAL_PAUSE);
      } // already paused: keep its reason (e.g. the bounces that paused it)
    } else if (body.status === "active") {
      if (current.status !== "active") {
        field("status", "active");
        field("paused_reason", null);
        resumed = true;
      } // already active: nothing to write (writing it could undo a bounce pause that lands meanwhile)
    } else {
      return bad(STATUS_ERROR);
    }
    touched = true;
  }

  const password = checkPassword(body.password);
  if (password.error) return bad(password.error);
  if (body.password !== undefined) touched = true;
  if (!touched) return bad(NOTHING);

  // resumed_at first: if the status write then failed, the mailbox would just stay paused.
  if (resumed) await setSetting(DB, `mailbox:${current.id}:resumed_at`, now());
  if (sets.length) await DB.prepare(`UPDATE mailboxes SET ${sets.join(", ")} WHERE id = ?`).bind(...values, current.id).run();
  if (password.value) await setSecret(DB, `mailbox:${current.id}`, password.value);
  const row = await loadMailbox(DB, current.id);
  if (!row) return bad(ERRORS.notFound, 404);
  return json({ mailbox: await publicMailbox(DB, row) });
}
