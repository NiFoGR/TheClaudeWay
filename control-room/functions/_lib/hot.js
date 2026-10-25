// The tick's `hot` step (stage 4, docs/rebuild/05-demo.md Part A §2 and §9, Task 12; overview §8 slot 5, every 5
// minutes). Each run, in this order:
//   1. syncDemoExpiry: every lead's latest demo stays up until 180 days after the last email we sent them (1 statement);
//   2. closes the open `hot` todos of prospects who replied or left emailed/viewed: only dedupes starting
//      hot:<place_id>: (stage 9's payment-page todos are checkout:<place_id> and are never touched) (1);
//   3. the safety net: up to 3 missing demos (missingDemos, then ensureDemo each: 1 + 3 × 4), skipped when the tick
//      has fewer than 25 queries left, which the summary then says;
//   4. one "Call now" todo per hot prospect per UK day, most recent view first, at most 3 a run (1 select, then one
//      DB.batch of 3 each: insert-or-ignore today's todo, bring its title and detail up to date, close that lead's
//      older days).
// That's at most 1 + 1 + 13 + 1 + 9 = 25 D1 statements (Global Constraints). Every part is also held to what's left,
// within 25 and within what the tick has left (less one for the tick's closing beat): a demo is made only while 12
// are left (its usual 4 with the hot todos' 10 kept, less the 2 a look's first demo may take for its setup todo, once
// per look), the hot select only while it and one todo fit, and each hot todo only while its 3 fit. So the run that
// adds a setup todo still makes 3 demos, and if 3 hot todos are due then too, the third waits for the next run. Even a
// demo that costs twice the usual (a slug clash, a prospect the research route made at the same moment, a setup todo)
// leaves room for the hot select and a todo. What doesn't fit is done on the next run. Who is hot is stage 3's isHot
// (_lib/shortlist.js), the app's only rule.
import { countingDB } from "./d1count.js";
import { ensureDemo, missingDemos, syncDemoExpiry } from "./demo-db.js";
import { cleanText, shortName } from "./demo/text.js";
import { isHot } from "./shortlist.js";
import { ukDate, ukParts } from "./ukTime.js";
import { iso } from "./util.js";

const DAY_MS = 86_400_000;
const STEP_MAX = 25; // D1 statements a run, at most
const DEMO_MIN_LEFT = 25; // the missing-demo part runs only when the tick has this many queries left
const DEMOS_PER_RUN = 3;
const HOT_PER_RUN = 3;
const ENSURE_COST = 4; // ensureDemo's usual new demo: its read, the demo, applyStageEvent's read and insert
const SETUP_TODOS_MAX = 2; // a look's first demo also adds its setup todo (+1): once per look, so at most 2 a run
const BATCH_COST = 3; // each hot todo's batch
const HOT_RESERVE = 1 + HOT_PER_RUN * BATCH_COST; // the hot select and its batches, kept while demos are made
// A demo is made only while this many statements are left (12): its usual 4, with the hot part's 10 kept less what
// the setup todos may take from them.
const DEMO_MIN_ROOM = ENSURE_COST + HOT_RESERVE - SETUP_TODOS_MAX;
const TICK_KEEP = 1; // the tick's closing beat comes after every step
const FULL_TICK = 50; // the tick's whole budget, for a caller that gives no ctx.budget
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SKIPPED = " · demos skipped: low budget";

const pad = (n) => String(n).padStart(2, "0");
const prefixOf = (placeId) => `hot:${placeId}:`;

/**
 * The hot todo's title (pure): "Call now: <name> opened their site <N> times", or "… once" for one view. A hot lead
 * opened it at least once, so a count below 2 (or one that can't be read) reads "once", never "0 times".
 */
export function hotTitle(name, views) {
  const n = Math.floor(Number(views));
  return `Call now: ${name} opened their site ${Number.isFinite(n) && n > 1 ? `${n} times` : "once"}`;
}

// When they last opened it, on the UK clock: "Wed 14:05", with the date too ("Sat 10 Oct 11:00") once it's 6 days or
// more ago, so the weekday can't be read as this week's. "" when the time can't be read.
function lastOpened(lastViewAt, nowMs) {
  const ms = Date.parse(lastViewAt ?? "");
  if (!Number.isFinite(ms)) return "";
  const { m, d, hh, mm, weekday } = ukParts(new Date(ms));
  const day = nowMs - ms < 6 * DAY_MS ? WEEKDAYS[weekday] : `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
  return `${day} ${pad(hh)}:${pad(mm)}`;
}

// "Last opened Tue 14:05. Phone: 0113 496 0000. No reply yet." ("No phone number on file." when there's none).
function hotDetail(row, nowMs) {
  const seen = lastOpened(row.last_view_at, nowMs);
  const phone = cleanText(row.phone, 40);
  return [seen && `Last opened ${seen}.`, phone ? `Phone: ${phone}.` : "No phone number on file.", "No reply yet."]
    .filter(Boolean)
    .join(" ");
}

// The business name as people say it (scraped text: invisible characters removed, one line, at most 80 characters).
const displayName = (name) => cleanText(shortName(name), 80) || cleanText(name, 80) || "A lead";

// 2. The open hot todos of prospects that aren't emailed/viewed with no reply (or are gone), closed as closeTodos
// closes one (status done, dedupe freed with "@" + done_at). Only kind hot with a dedupe starting hot:<its place_id>:
// (substr, not LIKE: a place_id may hold _ or %). ?1 = now.
const CLOSE_NOT_HOT_SQL = `UPDATE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
  WHERE status = 'open' AND kind = 'hot' AND place_id IS NOT NULL AND substr(dedupe, 1, 4) = 'hot:'
    AND substr(dedupe, 1, length(place_id) + 5) = 'hot:' || place_id || ':'
    AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.place_id = todos.place_id
      AND p.stage IN ('emailed', 'viewed') AND COALESCE(trim(p.last_inbound_at), '') = '')`;

// 4. The prospects that may be hot (isHot decides), most recent view first, each with today's todo when it's still
// open; one whose todo for today Nik ticked or dismissed isn't read (that todo keeps its dedupe, so it isn't made
// again today). The view window is an hour wider than isHot's 24 hours, so the text compare can't drop one.
// ?1 = today's UK date, ?2 = 25 hours ago.
const HOT_SQL = `SELECT p.place_id, p.stage, p.views, p.last_view_at, p.last_inbound_at, l.name, l.phone,
    t.id AS todo_id, t.title AS todo_title, t.detail AS todo_detail
  FROM prospects p
  JOIN leads l ON l.place_id = p.place_id
  LEFT JOIN todos t ON t.dedupe = 'hot:' || p.place_id || ':' || ?1
  WHERE p.stage IN ('emailed', 'viewed') AND COALESCE(trim(p.last_inbound_at), '') = ''
    AND (p.views >= 2 OR p.last_view_at >= ?2)
    AND (t.id IS NULL OR t.status = 'open')
  ORDER BY p.last_view_at DESC, p.place_id`;
// addTodo's insert (todo.js), as a statement for the batch: today's todo, unless that dedupe is taken.
const INSERT_HOT_SQL = `INSERT OR IGNORE INTO todos (id, kind, place_id, client_id, title, detail, link, draft, due_at, status, dedupe, created_at)
  VALUES (?, 'hot', ?, NULL, ?, ?, ?, NULL, ?, 'open', ?, ?)`;
// The count grows, and with it the title and the last-opened time: only while today's is open.
const RETITLE_SQL = "UPDATE todos SET title = ?, detail = ? WHERE dedupe = ? AND status = 'open'";
// That lead's older days, once today's is there. ?1 = now, ?2 = hot:<place_id>:, ?3 = today's dedupe.
const CLOSE_OLDER_SQL = `UPDATE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
  WHERE status = 'open' AND kind = 'hot' AND substr(dedupe, 1, length(?2)) = ?2 AND dedupe <> ?3`;

// What the tick has left for this step (ctx.budget.left()); a caller with no budget gets the whole tick's.
function leftOf(budget) {
  if (typeof budget?.left !== "function") return FULL_TICK;
  const n = Number(budget.left());
  return Number.isFinite(n) ? n : 0;
}

function toDate(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError("The hot step needs the time now, as a Date or an ISO time.");
  return new Date(ms);
}

// The first line of an error, short: the tick keeps 300 characters of a step's error, and the summary comes after it
// (with 3 leads named, the message stays under 300).
function firstLine(err) {
  let text = "";
  try {
    text = err instanceof Error ? String(err.message || err.name) : String(err);
  } catch {
    text = "unknown error";
  }
  return cleanText(text.split("\n")[0], 70) || "unknown error";
}

/**
 * The tick's `hot` step. `ctx` is the tick's ({DB, env, now, budget}; budget = {left: () => number}, env unused).
 * → "expiry +<n> · demos made <n> · hot <n> · closed <n>", plus " · demos skipped: low budget" when the tick had
 * fewer than 25 queries left for the missing demos. expiry = demos extended, demos made = leads the safety net gave
 * their demo and prospect, hot = hot todos added or brought up to date, closed = hot todos closed.
 * A demo that can't be made doesn't stop the rest: the step finishes, then throws one plain-English error naming the
 * lead (the tick shows it on its light), and that lead is tried again on the next run. At most 25 D1 statements.
 */
export async function hotStep({ DB, now = new Date(), budget } = {}) {
  const at = toDate(now);
  const nowMs = at.getTime();
  const atIso = iso(at);
  const startLeft = leftOf(budget);
  const counter = countingDB(DB);
  const q = counter.DB;
  // Statements this step may still make: 25 at most, and never the tick's last (its closing beat). Measured on this
  // step's own count, so it holds whether ctx.budget.left() goes down as it's used (the tick's) or not (a test's).
  const room = () => Math.min(STEP_MAX, startLeft - TICK_KEEP) - counter.used();

  // 1. Expiry follows the latest email we sent.
  const expiry = await syncDemoExpiry(q);

  // 2. They replied, or moved on: their hot todos are done.
  let closed = Number((await q.prepare(CLOSE_NOT_HOT_SQL).bind(atIso).run())?.meta?.changes) || 0;

  // 3. The safety net: up to 3 missing demos, while there's room for them and the hot todos after.
  let made = 0;
  const failed = [];
  const skipped = leftOf(budget) < DEMO_MIN_LEFT;
  if (!skipped) {
    for (const placeId of await missingDemos(q, at, DEMOS_PER_RUN)) {
      if (room() < DEMO_MIN_ROOM) break; // the rest on the next run
      try {
        if ((await ensureDemo(q, placeId, at)).ok) made++;
      } catch (err) {
        failed.push({ placeId: cleanText(placeId, 40), error: firstLine(err) });
      }
    }
  }

  // 4. Hot prospects: today's todo, made or brought up to date, most recent view first.
  let hot = 0;
  if (room() >= 1 + BATCH_COST) {
    const today = ukDate(at);
    const { results } = await q.prepare(HOT_SQL).bind(today, iso(nowMs - DAY_MS - 3_600_000)).all();
    const due = [];
    for (const row of results) {
      if (due.length >= HOT_PER_RUN) break;
      if (!isHot(row, at)) continue;
      const views = Math.max(1, Math.floor(Number(row.views)) || 0);
      const title = hotTitle(displayName(row.name), views);
      const detail = hotDetail(row, nowMs);
      if (row.todo_id && row.todo_title === title && row.todo_detail === detail) continue; // already right
      due.push({ placeId: row.place_id, title, detail });
    }
    for (const { placeId, title, detail } of due) {
      if (room() < BATCH_COST) break; // the rest on the next run
      const dedupe = `${prefixOf(placeId)}${today}`;
      const link = `/#/lead/${encodeURIComponent(placeId)}`;
      const [, , older] = await q.batch([
        q.prepare(INSERT_HOT_SQL).bind(crypto.randomUUID(), placeId, title, detail, link, atIso, dedupe, atIso),
        q.prepare(RETITLE_SQL).bind(title, detail, dedupe),
        q.prepare(CLOSE_OLDER_SQL).bind(atIso, prefixOf(placeId), dedupe),
      ]);
      hot++;
      closed += Number(older?.meta?.changes) || 0;
    }
  }

  const summary = `expiry +${expiry} · demos made ${made} · hot ${hot} · closed ${closed}${skipped ? SKIPPED : ""}`;
  if (failed.length) {
    // The leads, then the first one's error (when D1 is having a moment, it's the same for all of them).
    const leads = `${failed.length} lead${failed.length === 1 ? "" : "s"}`;
    const which = `${failed.map((f) => f.placeId).join(", ")}: ${failed[0].error}`;
    throw new Error(`The hot step couldn't make the demo site for ${leads} (${which}). It tries again on the next run. Done: ${summary}`);
  }
  return summary;
}
