// The tick (db): all timed work, run by /api/tick (overview §2 and §8, Part A "Tick"). The relay Worker's cron calls
// ?reason=cron every 5 minutes and then ?reason=health once that returns; it also calls ?reason=inbound after saving
// each email.
//
// Guards. A call whose db() created tables or indexes (the first call after a deploy that added some) returns
// {ran:false, why:"migrated"} before anything else. A call less than 20 s after the last one returns
// {ran:false, why:"too_soon"}. A call that can't take the lease (a settings row holding its expiry, 50 s after the
// start) returns {ran:false, why:"locked"}. The lease is released at the end, and one left behind by a tick that was
// killed (Error 1102) simply expires.
//
// Health runs on its own: reason "health" runs only the health step, with its own gap and lease keys
// (tick:health:last, tick:health:lock) and the full budget; every other reason runs every step except health. A
// non-health tick ends by beating `tick` with the steps summary (its last query); the health step beats `health`.
//
// D1 budget: the free plan allows 50 D1 queries per invocation. DB is wrapped in countingDB from the first statement
// (the schema check in a new isolate, the gap check, the lease), so the runner's own queries count too. Each step gets
// ctx.budget, whose left() is 50 − used. A step isn't started with fewer than 10 left: it reports "deferred" and runs
// on a later tick. A step that throws becomes {error} and the rest still run. Step details go to the heartbeat only;
// /api/tick shows ok / error / skipped / deferred.
//
// The runner's own cost: the gap check (1 query, which also reads every timed step's last run), the lease (1),
// tick:last (1); then, after the steps, one write for all the timed steps that ran (only if any did), the release (1)
// and the tick beat (1). The finishing queries never undo the tick: if one fails it's logged and the results stand.
import { runCallsStep } from "./calls-db.js";
import { countingDB } from "./d1count.js";
import { dailyFindStep, staleJobsStep } from "./find.js";
import { followupsStep } from "./followups.js";
import { healthStep } from "./health.js";
import { hotStep } from "./hot.js";
import { inboundStep } from "./mail/inbound-db.js";
import { sendStep } from "./mail/outbox.js";
import { purgeStep } from "./purge.js";
import { runReplyFire } from "./replies-db.js"; // also registers the Replies health light
import "./research-db.js"; // no tick step: imported so its research health light is registered
import { beat } from "./routines.js";
import { setSetting } from "./settings.js";
import { pickStep } from "./shortlist-db.js";
import { sitesStep } from "./sites/tick.js"; // also registers the sites and chat health lights
import "./stripe.js"; // no tick step: imported so its Payments health light is registered
import { db } from "./util.js";

export const TICK_BUDGET = Object.freeze({ total: 50, minToStart: 10 });

const GAP_MS = 20_000; // the shortest time between two ticks of the same kind
const LEASE_MS = 50_000;
// A step is due once everyMinutes have passed since it last ran, less this: the cron calls drift by a few seconds, and
// a 5-minute step shouldn't be skipped (and so run every 10 minutes) because a tick came 2 s early.
const DUE_SLACK_MS = 30_000;
const ERROR_MAX = 300;
const REASON_RE = /^[a-z_]{1,20}$/;

/**
 * The tick's steps, in run order: {name, everyMinutes, run: async (ctx) => summary}. Each stage inserts its step at
 * its marker below and nowhere else (everyMinutes in brackets in overview §8).
 */
export const STEPS = [
  // slot: inbound (every tick; stage 0, stage 7 adds its reply hook inside it)
  inboundStep,
  // slot: reply_fire (every tick; stage 7)
  { name: "reply_fire", everyMinutes: 0, run: runReplyFire },
  // slot: followups (every 5 min; stage 6)
  { name: "followups", everyMinutes: 5, run: (ctx) => followupsStep(ctx) },
  // slot: send (every tick; stage 0)
  sendStep,
  // slot: hot (every 5 min; stages 4 and 6)
  { name: "hot", everyMinutes: 5, run: (ctx) => hotStep(ctx) },
  // slot: pick (every 30 min; stage 3)
  { name: "pick", everyMinutes: 30, run: (ctx) => pickStep(ctx) },
  // slot: daily_find (every 5 min; stage 1)
  dailyFindStep,
  // slot: stale_jobs (every 15 min; stage 1)
  staleJobsStep,
  // slot: calls (every 5 min; stage 8)
  { name: "calls", everyMinutes: 5, run: runCallsStep },
  // slot: sites (every 5 min; stage 10)
  { name: "sites", everyMinutes: 5, run: sitesStep },
  // slot: care (every 10 min; stage 11)
  // slot: purge (monthly; file 11)
  purgeStep,
  // slot: health (only in the ?reason=health call; stage 0)
  healthStep,
];

// The main tick and the health call each have their own gap key and lease. The lease SQL is Part A's, word for word:
// ?1 = the lease's expiry, ?2 = now; it changes one row only when the lease is free or has expired.
const KEYS = {
  main: {
    last: "tick:last",
    lease: "INSERT INTO settings (key,value) VALUES ('tick:lock',?1) ON CONFLICT(key) DO UPDATE SET value=?1 WHERE settings.value < ?2",
    release: "DELETE FROM settings WHERE key='tick:lock' AND value=?1",
  },
  health: {
    last: "tick:health:last",
    lease: "INSERT INTO settings (key,value) VALUES ('tick:health:lock',?1) ON CONFLICT(key) DO UPDATE SET value=?1 WHERE settings.value < ?2",
    release: "DELETE FROM settings WHERE key='tick:health:lock' AND value=?1",
  },
};

// The gap key and every timed step's last run, in one query (the keys are bound as one JSON list).
const LASTS_SQL = "SELECT key, value FROM settings WHERE key IN (SELECT j.value FROM json_each(?) AS j)";
// Every timed step that ran (or threw) this tick gets ?1 as its tick:last:<step>, in one statement after the loop
// rather than one each (later stages add nine timed steps, and the tick has only 50 queries). ?2 is the keys, as JSON.
// SQLite needs the WHERE before ON CONFLICT when an upsert takes its rows from a SELECT.
const LAST_RUN_SQL =
  "INSERT INTO settings (key, value) SELECT j.value, ?1 FROM json_each(?2) AS j WHERE 1 ON CONFLICT (key) DO UPDATE SET value = excluded.value";

// UTC ISO without milliseconds, like util.now(); the lease compares these as text, so they must all look alike.
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
const stepKey = (step) => `tick:last:${step.name}`;
const isError = (value) => typeof value === "object" && value !== null;

/** The reason as the tick uses it: ^[a-z_]{1,20}$ as given, anything else "unknown". */
export function tickReason(raw) {
  return typeof raw === "string" && REASON_RE.test(raw) ? raw : "unknown";
}

function toDate(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError("runTick needs the time now, as a Date or an ISO time.");
  return new Date(ms);
}

// Less than 20 s from the last start. A time that can't be read, or one far in the future, never stops the tick.
function tooSoon(last, at) {
  const t = Date.parse(last ?? "");
  return Number.isFinite(t) && Math.abs(at.getTime() - t) < GAP_MS;
}

// everyMinutes is a whole or part number of minutes, 0 meaning every tick.
const isEvery = (every) => typeof every === "number" && Number.isFinite(every) && every >= 0;

function isDue(step, last, at) {
  const every = step.everyMinutes;
  if (!(every > 0)) return true;
  const t = Date.parse(last ?? "");
  if (!Number.isFinite(t)) return true;
  const since = at.getTime() - t;
  return since < 0 || since >= every * 60_000 - DUE_SLACK_MS;
}

// No heartbeat detail or error holds a secret: the Cloudflare variables that are secrets (by name), and anything
// shaped like an Anthropic token, are replaced. Steps scrub what they know (e.g. mailbox passwords) themselves.
const SECRET_NAME = /PASSWORD|TOKEN|SECRET|KEY/i;
/** `text` with the secret Cloudflare variables in `env` (by name) and anything shaped like sk-ant-… as [hidden]. */
export function scrub(text, env) {
  const secrets = Object.entries(env ?? {})
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("[hidden]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[hidden]");
}

// The text of anything a step throws. It never throws itself, so one odd error can't stop the other steps: a
// null-prototype object, or an Error whose message getter throws, can't be turned into text with String().
function thrownText(err) {
  try {
    return err instanceof Error ? String(err.message || err.name) : String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "";
    }
  }
}

/** An error as one scrubbed line of at most 300 characters (never cutting an emoji in half). Never throws. */
export function errorText(err, env) {
  const line = scrub(thrownText(err), env).replace(/\s+/g, " ").trim() || "unknown error";
  if (line.length <= ERROR_MAX) return line;
  const code = line.charCodeAt(ERROR_MAX - 1);
  return line.slice(0, code >= 0xd800 && code <= 0xdbff ? ERROR_MAX - 1 : ERROR_MAX);
}

const summaryOf = (out) => (typeof out === "string" ? out : out == null ? "done" : String(out));

// "inbound: 3 processed: 1 human, 2 auto | send: sent 1, failed 0, held 0 | hot: skipped", in run order. beat() keeps
// only the first 500 characters, so when it's longer than that the errors go first: the cut must never hide one.
const DETAIL_MAX = 500;
function stepsSummary(results) {
  const entries = Object.entries(results);
  const line = (list) => list.map(([name, v]) => `${name}: ${isError(v) ? `error: ${v.error}` : v}`).join(" | ");
  const inOrder = line(entries);
  if (inOrder.length <= DETAIL_MAX) return inOrder || "no steps";
  return line([...entries.filter(([, v]) => isError(v)), ...entries.filter(([, v]) => !isError(v))]);
}

/**
 * Run the steps that are due. reason "health" runs only the health step; any other reason runs every step but
 * health and beats `tick`. Returns {ran:false, why:"migrated"|"too_soon"|"locked"} when turned away, else
 * {ran:true, steps: {name: summary | {error} | "skipped" | "deferred"}}.
 */
export async function runTick(env, reason, now = new Date(), { steps = STEPS } = {}) {
  if (!Array.isArray(steps)) throw new TypeError("runTick's steps must be a list of {name, everyMinutes, run}.");
  const at = toDate(now);
  const why = tickReason(reason);
  const health = why === "health";
  const keys = health ? KEYS.health : KEYS.main;

  // Counting starts before anything runs. With no DB bound, db() gives its plain-English error. A call whose db()
  // created tables or indexes (the first one after a deploy that added some) stops there, before the gap check and
  // the lease: its queries don't stack on the migration's, and no lease is left held. The next tick runs the steps.
  // A version-only write (nothing missing) costs 2 queries and simply counts in the budget.
  const counter = countingDB(env?.DB);
  const schema = {};
  const DB = await db(env?.DB ? { ...env, DB: counter.DB } : { ...env }, schema);
  if (schema.created > 0) return { ran: false, why: "migrated" };
  const budget = Object.freeze({ left: () => TICK_BUDGET.total - counter.used() });

  const todo = steps.filter((step) => (step?.name === "health") === health);
  const timed = todo.filter((step) => isEvery(step.everyMinutes) && step.everyMinutes > 0);
  const { results: rows } = await DB.prepare(LASTS_SQL).bind(JSON.stringify([keys.last, ...timed.map(stepKey)])).all();
  const last = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (tooSoon(last[keys.last], at)) return { ran: false, why: "too_soon" };

  const nowIso = iso(at);
  const expiry = iso(new Date(at.getTime() + LEASE_MS));
  const lease = await DB.prepare(keys.lease).bind(expiry, nowIso).run();
  if (lease?.meta?.changes !== 1) return { ran: false, why: "locked" };
  await setSetting(DB, keys.last, nowIso);

  // Steps get the counted DB, also as ctx.env.DB, so nothing they do escapes the count.
  const stepEnv = { ...env, DB };
  const results = {};
  const timedRan = []; // tick:last:<step> of each timed step that ran or threw (skipped and deferred keep theirs)
  for (const step of todo) {
    const { name } = step;
    if (!isEvery(step.everyMinutes)) {
      // Not run at all, rather than run every tick: a step meant for once a month (e.g. everyMinutes "monthly") must
      // never quietly run every 5 minutes.
      results[name] = { error: `The ${name} step's everyMinutes must be a number of minutes (0 = every tick), so it wasn't run.` };
      if (health) console.error(`The tick's ${name} step failed: ${results[name].error}`);
      continue;
    }
    if (!isDue(step, last[stepKey(step)], at)) {
      results[name] = "skipped";
      continue;
    }
    if (budget.left() < TICK_BUDGET.minToStart) {
      results[name] = "deferred"; // tick:last:<step> stays as it was, so it runs on a later tick
      continue;
    }
    try {
      const out = await step.run({ DB, env: stepEnv, now: new Date(at), reason: why, results: { ...results }, budget });
      results[name] = summaryOf(out);
    } catch (err) {
      results[name] = { error: errorText(err, env) };
      // The health call doesn't beat (the health step does, and a beat here would make broken health look fresh),
      // so its errors would show nowhere: they go to the Cloudflare log.
      if (health) console.error(`The tick's ${name} step failed: ${results[name].error}`);
    }
    if (step.everyMinutes > 0) timedRan.push(stepKey(step));
  }

  // The finishing queries. The tick beat (not made by the health call: its step beats `health`) is always made, as
  // the last query. Before it, only when there's room for the query and the beat: the timed steps' last runs (if
  // that's skipped they simply run again next time) and the lease's release (if skipped it lapses within 50 s).
  // A failure here is logged and doesn't undo the steps, which have already run.
  const beatCost = health ? 0 : 1;
  const finish = async (what, query) => {
    try {
      await query();
    } catch (err) {
      console.error(`The tick (${why}) couldn't ${what}: ${errorText(err, env)}`);
    }
  };
  if (timedRan.length && budget.left() >= 1 + beatCost) {
    await finish("save when its timed steps ran", () => DB.prepare(LAST_RUN_SQL).bind(nowIso, JSON.stringify(timedRan)).run());
  }
  if (budget.left() >= 1 + beatCost) await finish("release its lease", () => DB.prepare(keys.release).bind(expiry).run());
  if (!health) {
    const ok = !Object.values(results).some(isError);
    await finish("beat", () => beat(DB, "tick", ok, scrub(stepsSummary(results), env), at));
  }
  return { ran: true, steps: results };
}
