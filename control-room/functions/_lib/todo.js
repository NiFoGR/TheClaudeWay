// Todo items (db) and the board grouping (pure): everything Nik has to do, in one `todos` table (overview §6).
//
// A dedupe stops the same item being added twice. It stays taken while the todo is open, after Nik dismisses it, and
// after Nik marks it done, so none of those come back. Only closeTodos (the system closing a todo because the problem
// went away) frees it, by adding "@<done_at>", so the same problem can come back later as a new item.
import { addUkDays, ukDate, ukDayStartUtc, ukToUtc } from "./ukTime.js";
import { now as nowIso } from "./util.js";

// due_at is stored as UTC ISO text without milliseconds, like util.now(), so every row sorts and compares the same
// way as text (the todos_open index). It takes a Date or ISO text with a zone (Z or ±HH:MM). Anything else is refused:
// "2026-10-26 08:00" has no zone (Workers would read it as UTC, an hour out in BST), and groupBoard would show a time
// it can't read under Today.
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// A real day and time of day. Date.parse would roll 30 Feb over to 2 Mar, and read 24:00 as the next day.
function realDayAndTime([, y, mo, d, hh, mm, ss = "0"]) {
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return day.getUTCMonth() === Number(mo) - 1 && day.getUTCDate() === Number(d)
    && Number(hh) < 24 && Number(mm) < 60 && Number(ss) < 60;
}

function dueText(value) {
  if (value === null || value === undefined || value === "") return null;
  const parts = typeof value === "string" ? ISO_WITH_ZONE.exec(value) : null;
  const t = value instanceof Date ? value.getTime()
    : parts && realDayAndTime(parts) ? Date.parse(value)
    : NaN;
  if (Number.isNaN(t)) {
    const got = value instanceof Date ? "an invalid Date" : typeof value === "string" ? JSON.stringify(value) : typeof value;
    throw new TypeError(`A todo's due_at must be a Date or UTC ISO text like 2026-10-26T08:00:00Z, got ${got}.`);
  }
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Add a todo. With a dedupe, it's added only when no todo holds that dedupe yet (INSERT OR IGNORE).
 * Returns the new id, or null when it was already there.
 */
export async function addTodo(DB, { kind, title, detail, link, place_id, client_id, draft, due_at, dedupe } = {}) {
  // INSERT OR IGNORE also skips a row that breaks NOT NULL, so a missing kind or title would vanish without a word.
  if (typeof kind !== "string" || !kind || typeof title !== "string" || !title) {
    throw new TypeError("A todo needs a kind and a title.");
  }
  // An empty dedupe would be taken by the first such todo and silently swallow every later one.
  if (dedupe !== undefined && dedupe !== null && (typeof dedupe !== "string" || !dedupe)) {
    throw new TypeError("A todo's dedupe must be text like \"health:tick\" (leave it out for no dedupe).");
  }
  const due = dueText(due_at);
  const id = crypto.randomUUID();
  const { meta } = await DB.prepare(
    `INSERT OR IGNORE INTO todos (id, kind, place_id, client_id, title, detail, link, draft, due_at, status, dedupe, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(id, kind, place_id ?? null, client_id ?? null, title, detail ?? "", link ?? null, draft ?? null,
      due, dedupe ?? null, nowIso())
    .run();
  return meta.changes === 0 ? null : id;
}

// done_at is part of the freed dedupe ("<dedupe>@<done_at>"), which must stay unique: a todo re-added and closed
// again within the same millisecond would collide, so done_at never repeats within an isolate.
let lastDoneMs = 0;
function doneAt() {
  lastDoneMs = Math.max(Date.now(), lastDoneMs + 1);
  return new Date(lastDoneMs).toISOString();
}

/**
 * Close every open todo whose dedupe starts with `dedupePrefix`, freeing each dedupe (dedupe || '@' || done_at).
 * Returns how many were closed. The match is exact text (substr, not LIKE, so % and _ are literal), but it is a
 * prefix: "health:tick" also closes "health:tickle". Use it only when no other key starts with the prefix.
 * Dismissed and done todos are left alone.
 */
export async function closeTodos(DB, dedupePrefix) {
  if (typeof dedupePrefix !== "string" || !dedupePrefix) {
    throw new TypeError("closeTodos needs a dedupe prefix, e.g. \"health:tick\" (an empty one would close everything).");
  }
  const at = doneAt();
  const { meta } = await DB.prepare(
    `UPDATE todos SET status = 'done', done_at = ?, dedupe = dedupe || '@' || ?
     WHERE status = 'open' AND substr(dedupe, 1, length(?)) = ?`,
  )
    .bind(at, at, dedupePrefix, dedupePrefix)
    .run();
  return meta.changes;
}

// Milliseconds since 1970, or null for no time (a time that can't be read counts as none, so the item still shows).
function ms(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Earlier first, no time last.
function byTime(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * The board's three groups, from open todos only (pure). Overdue: due before today started (UK). Today: no due time,
 * or due during today (UK). Later: due after today ends (UK). Each group is sorted by due_at (none last), then
 * created_at.
 */
export function groupBoard(rows, now) {
  const at = now instanceof Date ? now : new Date(now);
  const start = ukDayStartUtc(at).getTime();
  const end = ukToUtc(addUkDays(ukDate(at), 1), "00:00").getTime();
  const groups = { today: [], overdue: [], later: [] };
  for (const row of rows) {
    if (row.status !== "open") continue;
    const due = ms(row.due_at);
    const group = due === null || (due >= start && due < end) ? "today" : due < start ? "overdue" : "later";
    groups[group].push(row);
  }
  const order = (a, b) => byTime(ms(a.due_at), ms(b.due_at)) || byTime(ms(a.created_at), ms(b.created_at));
  for (const list of Object.values(groups)) list.sort(order);
  return groups;
}
