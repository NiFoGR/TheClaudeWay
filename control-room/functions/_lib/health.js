// Health lights (pure), the lights later stages register, and the health tick step (db): Part A "Health lights" and
// "Setup gaps", overview §8.
//
// One light shape everywhere: {name, level: "green"|"amber"|"red"|"grey", detail, fix}. Grey means "not in use" and
// never adds a todo. computeLights gives stage 0's 10 lights, worked out purely from numbers; later stages add theirs
// with registerLight(fn) from the module that holds their tick step (so importing tick.js registers every light), and
// never edit computeLights. healthFromDb returns stage 0's lights followed by the registered ones.
//
// The health step runs only in the ?reason=health call. It turns lights and setup gaps into todos: a red light opens
// health:<name>, any other level closes it; a gap opens setup:<key>, and stage 0's own setup:<key> todos close once
// their gap has gone. Closing is by exact dedupe, never by prefix, so other stages' health:… and setup:… todos (e.g.
// health:find:towns, setup:demo-template) are never touched. A closed todo's dedupe gets "@<done_at>", so the same
// problem can come back later as a new item; a todo Nik dismissed keeps its dedupe, so it never comes back.
//
// D1 budget: 8 queries for the facts and the setup status, at most 1 per registered light, then the todo sync (1
// SELECT of the open health:/setup: todos, 1 INSERT per 15 new todos, 1 UPDATE when any close) and the health beat.
import { ROUTINES, beat } from "./routines.js";
import { readSetup, setupGaps } from "./setupStatus.js";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const BEAT_STALE_MS = 15 * MIN_MS; // tick, health and relay check in every 5 minutes
const STUCK_MS = 45 * MIN_MS;
const LEVELS = new Set(["green", "amber", "red", "grey"]);
const ACTIVE = new Set(["queued", "running"]);
const TODO_LINK = "/#/setup";
const ROWS_PER_INSERT = 15; // 2 shared + 5 bound values a row: 77, under D1's 100 per statement
const ERROR_MAX = 300;

const TICK_FIX = "Check the relay light below. If it's green, open GitHub → Actions → Deploy mail relay and run it again.";
const TICK_STEP_FIX = "If this stays amber for more than a few heartbeats, tell Claude: the step name and error above say what broke. Everything else keeps running.";
const RELAY_FIX = "GitHub → Actions → Deploy mail relay → open the latest run. If it's red, its last step says what to fix.";
const RELAY_1042_FIX =
  "Set the GitHub repo variable CONTROL_ROOM_URL to the project's *.pages.dev address (GitHub → Settings → Secrets and variables → Actions → Variables), then run Deploy mail relay again.";
const RELAY_URL_FIX =
  "CONTROL_ROOM_URL must be the Control Room's own address (the *.pages.dev one always works): fix it in GitHub → Settings → Secrets and variables → Actions → Variables, then run Deploy mail relay again.";
const RELAY_COPY_FIX =
  "Cloudflare → Email → Email Routing → Destination addresses: verify the address in the GitHub repo variable FORWARD_COPY_TO (or delete that variable), then run Deploy mail relay again. The email itself was saved.";
const MAILBOX_PAUSED_FIX = "Read the reason, fix it, then press Resume on Setup → Mailboxes.";
const NO_MAILBOX_FIX = "Buy one Namecheap Private Email mailbox and add it on Setup → Mailboxes.";
const SCRAPE_FIX = "It's probably stuck. Start a new one on Lead Scraper; the old one is marked failed automatically.";
const SETUP_FIX = "Open Setup: each item says what to do.";
const BROKEN_FIX =
  "This is a fault in the Control Room's code, not in your setup: ask Claude to fix it, and give it this message.";
const routineFix = (label) => `Setup → Claude → ${label}: paste its URL and token, then press Test fire.`;
const routineProblemFix = (label) =>
  `Read what the Routine said (or its latest session in Claude), sort that out, then press Test fire on Setup → Claude → ${label}.`;

// The jobs and scans that are queued or running (care scans are stage 11's light). One query.
const ACTIVE_SQL = `SELECT 'job' AS kind, status, updated_at, NULL AS source FROM jobs WHERE status IN ('queued', 'running')
  UNION ALL
  SELECT 'scan' AS kind, status, updated_at, source FROM scans WHERE status IN ('queued', 'running') AND source <> 'care'`;
// The open health:/setup: todos (status = 'open' reads only open todos, by the todos_open index; the ranges are every
// dedupe starting "health:" or "setup:", since ':' + 1 is ';').
const OPEN_SQL = `SELECT dedupe FROM todos WHERE status = 'open'
  AND ((dedupe >= 'health:' AND dedupe < 'health;') OR (dedupe >= 'setup:' AND dedupe < 'setup;'))`;
// ?1 = done_at, ?2 = the exact dedupes to close, as one JSON list (so it's one statement however many close).
const CLOSE_SQL = `UPDATE todos SET status='done', done_at=?1, dedupe=dedupe||'@'||?1
  WHERE status='open' AND dedupe IN (SELECT j.value FROM json_each(?2) AS j)`;

// UTC ISO without milliseconds, like util.now().
const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");

// now as ms: a Date, ISO text, or ms (inside this module).
function toMs(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : typeof now === "number" ? now : NaN;
  if (!Number.isFinite(ms)) throw new TypeError("Health needs the time now, as a Date or an ISO time.");
  return ms;
}

// A stored time in ms, or null when there's none or it can't be read.
function msOf(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
// A heartbeat as {at, ok, detail}, or a heartbeats row as D1 returns it ({last_at, ok: 1|0, detail}).
const beatMs = (b) => (b ? msOf(b.at ?? b.last_at) : null);
const beatOk = (b) => b.ok === undefined || b.ok === true || Number(b.ok) === 1;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const days = (ms) => plural(Math.floor(Math.floor(ms / HOUR_MS) / 24), "day", "days");
// How long, in whole minutes, hours or days (rounded down).
function span(ms) {
  const t = Math.max(0, ms);
  if (t < HOUR_MS) return `${Math.floor(t / MIN_MS)} min`;
  if (t < DAY_MS) return `${Math.floor(t / HOUR_MS)} h`;
  return days(t);
}

const light = (name, level, detail, fix = "") => ({ name, level, detail, fix });

function tickLight(heartbeats, now) {
  const tick = beatMs(heartbeats.tick);
  const health = beatMs(heartbeats.health);
  if (tick === null) return light("tick", "red", "The heartbeat hasn't run yet: no timed work has been done", TICK_FIX);
  if (now - tick > BEAT_STALE_MS) {
    return light("tick", "red", `The heartbeat has stopped: no timed work for ${span(now - tick)}`, TICK_FIX);
  }
  if (health === null) {
    return light("tick", "red", "Health checks haven't run yet: lights and todos aren't being updated", TICK_FIX);
  }
  if (now - health > BEAT_STALE_MS) {
    return light("tick", "red", `Health checks have stopped: lights and todos not updated for ${span(now - health)}`, TICK_FIX);
  }
  // runTick beats ok=0 when a step threw; its detail lists the errors first. Amber, not red: one bad tick shouldn't
  // open and close a todo every 5 minutes, but a step that fails on every run must not hide behind a green light.
  if (!beatOk(heartbeats.tick)) {
    const errors = String(heartbeats.tick.detail ?? "").split(" | ").filter((part) => /^[a-z_]+: error: /.test(part));
    const said = errors.join(" | ") || String(heartbeats.tick.detail ?? "").trim() || "no details";
    return light("tick", "amber", `Heartbeat ran ${span(now - tick)} ago, but a step failed: ${said}`, TICK_STEP_FIX);
  }
  return light("tick", "green", `Heartbeat ran ${span(now - tick)} ago`);
}

// The relay beats ok=0 with what went wrong (mail-relay/src/index.js tickAndBeat). "tick call failed: …" first means
// no timed work runs: red. Anything else (e.g. "forward copy failed: …", the email still saved) is amber, so the
// health todo doesn't open and close each cycle.
function relayLight(heartbeats, now) {
  const beat = heartbeats.relay;
  const relay = beatMs(beat);
  if (relay === null) return light("relay", "red", "The mail relay hasn't checked in yet", RELAY_FIX);
  if (now - relay > BEAT_STALE_MS) {
    return light("relay", "red", `The mail relay hasn't checked in for ${span(now - relay)}`, RELAY_FIX);
  }
  if (!beatOk(beat)) {
    const said = String(beat.detail ?? "").trim();
    if (said.startsWith("tick call failed")) {
      const fix = /\berror 1042\b/.test(said) ? RELAY_1042_FIX : RELAY_URL_FIX;
      return light("relay", "red", `The mail relay can't reach the Control Room, so no timed work runs: ${said}`, fix);
    }
    const fix = said.includes("forward copy failed") ? RELAY_COPY_FIX : RELAY_FIX;
    return light("relay", "amber", `Mail relay checked in ${span(now - relay)} ago with a problem: ${said || "no details"}`, fix);
  }
  return light("relay", "green", `Mail relay checked in ${span(now - relay)} ago`);
}

// A fire that didn't start the Routine: error is NULL only for a fire Claude accepted (and a test may give just the
// HTTP status).
function fireFailed(fire) {
  if (typeof fire.ok === "boolean") return !fire.ok;
  if (fire.error) return true;
  return !(Number.isInteger(fire.http_status) && fire.http_status >= 200 && fire.http_status < 300);
}

function routineLight(routine, routines, now) {
  const { name, label, cadenceHours } = routine;
  const id = `routine:${name}`;
  const state = routines.find((r) => r?.name === name) ?? {};
  if (state.connected !== true) return light(id, "amber", `Claude's ${label} Routine isn't connected`, routineFix(label));

  const beatAt = beatMs(state.last_beat);
  const fire = state.last_fire;
  const fireAt = fire ? msOf(fire.at) : null;
  // A fire logged before the Routine was connected ("The <label> Routine isn't connected: …") says nothing about it now.
  const beforeConnected = typeof fire?.error === "string" && fire.error.startsWith(`The ${label} Routine isn't connected`);
  if (fire && fireAt !== null && fireFailed(fire) && !beforeConnected && (beatAt === null || fireAt > beatAt)) {
    const fix = typeof fire.error === "string" && fire.error.trim() ? fire.error : routineFix(label);
    return light(id, "red", `Claude's ${label} Routine couldn't be started ${span(now - fireAt)} ago`, fix);
  }
  if (beatAt === null) return light(id, "amber", `Claude's ${label} Routine hasn't checked in yet`, routineFix(label));
  const since = now - beatAt;
  if (cadenceHours && since > cadenceHours * HOUR_MS) {
    return light(id, "red", `Claude's ${label} Routine hasn't run for ${days(since)}`, routineFix(label));
  }
  if (!beatOk(state.last_beat)) {
    const said = String(state.last_beat.detail ?? "").trim();
    return light(id, "amber", `Claude's ${label} Routine had a problem ${span(since)} ago${said ? `: ${said}` : ""}`, routineProblemFix(label));
  }
  return light(id, "green", `Claude's ${label} Routine last ran ${span(since)} ago`);
}

function mailboxesLight(mailboxes) {
  const paused = mailboxes.filter((m) => m?.status === "paused");
  if (paused.length) {
    const [first] = paused;
    const reason = String(first.paused_reason ?? "").trim() || "no reason was saved.";
    const more = paused.length > 1 ? ` (and ${plural(paused.length - 1, "more mailbox", "more mailboxes")} paused)` : "";
    return light("mailboxes", "red", `${first.address} is paused: ${reason}${more}`, MAILBOX_PAUSED_FIX);
  }
  if (!mailboxes.length) return light("mailboxes", "amber", "No mailbox yet", NO_MAILBOX_FIX);
  return light("mailboxes", "green", `${plural(mailboxes.length, "mailbox", "mailboxes")} sending`);
}

function scrapeLight(jobs, scans, now) {
  const rows = [...jobs, ...scans.filter((s) => s?.source !== "care")];
  const stuck = rows
    .filter((r) => ACTIVE.has(r?.status))
    .map((r) => msOf(r.updated_at))
    .filter((t) => t !== null && now - t > STUCK_MS);
  if (!stuck.length) return light("scrape", "green", "No stuck searches");
  return light("scrape", "amber", `A lead search has been running for ${span(now - Math.min(...stuck))}`, SCRAPE_FIX);
}

function setupLight(gaps) {
  const n = Array.isArray(gaps) ? gaps.length : Math.max(0, Math.floor(Number(gaps) || 0));
  if (!n) return light("setup", "green", "Setup complete");
  return light("setup", "amber", `${plural(n, "thing", "things")} still to set up`, SETUP_FIX);
}

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * Stage 0's 10 lights (pure), in this order: tick, relay, routine:<name> for the 5 ROUTINES, mailboxes, scrape, setup.
 * facts = {heartbeats: {tick, health, relay: {at, ok, detail}}, routines: [{name, connected, last_fire, last_beat}]
 * (as loadSetupStatus gives them), mailboxes: [{address, status, paused_reason}], jobs: [{status, updated_at}],
 * scans: [{status, updated_at, source}], gaps: setupGaps(…)}. Missing facts count as missing (never set up, never ran).
 */
export function computeLights(facts, now) {
  const at = toMs(now);
  const f = facts && typeof facts === "object" ? facts : {};
  const heartbeats = f.heartbeats && typeof f.heartbeats === "object" ? f.heartbeats : {};
  return [
    tickLight(heartbeats, at),
    relayLight(heartbeats, at),
    ...ROUTINES.map((r) => routineLight(r, list(f.routines), at)),
    mailboxesLight(list(f.mailboxes)),
    scrapeLight(list(f.jobs), list(f.scans), at),
    setupLight(f.gaps),
  ];
}

// ---------------------------------------------------------------- registered lights

const registered = [];

/**
 * Add a light (a later stage's): fn(DB, env, now) → Promise<{name, level, detail, fix}>, making at most 1 D1 query.
 * It shows after stage 0's 10, in registration order. Returns a function that unregisters it (tests use it).
 * A function may also give back a list of lights (stage 11's careLights does), shown in its order.
 */
export function registerLight(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("registerLight needs a function: (DB, env, now) → Promise<{name, level, detail, fix}>.");
  }
  const entry = { fn };
  registered.push(entry);
  return () => {
    const i = registered.indexOf(entry);
    if (i >= 0) registered.splice(i, 1);
  };
}

// An error as one line of at most 300 characters, with secrets hidden: the values of Cloudflare variables named like
// secrets, and anything shaped like an Anthropic token. Never throws.
function errorLine(err, env) {
  let text;
  try {
    text = String(err instanceof Error ? err.message || err.name : err);
  } catch {
    text = "unknown error";
  }
  const secrets = Object.entries(env && typeof env === "object" ? env : {})
    .filter(([name, value]) => /PASSWORD|TOKEN|SECRET|KEY/i.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join("[hidden]");
  text = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[hidden]").replace(/\s+/g, " ").trim() || "unknown error";
  return text.length <= ERROR_MAX ? text : text.slice(0, ERROR_MAX);
}

// A registered light as the 4 fields of the shape, or an error when it isn't one.
function asLight(value) {
  if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name || !LEVELS.has(value.level)) {
    throw new Error("it didn't give back a light ({name, level: green, amber, red or grey, detail, fix})");
  }
  return light(value.name, value.level, String(value.detail ?? ""), String(value.fix ?? ""));
}

// Each registered light in turn. One that throws (or gives back something else) becomes a red light of its own, so a
// fault in one stage's check never stops the others or the todos. Its name ends "_failed", so it's never a prefix of
// another one's. A function that gives back a list adds each light in it (one bad item makes the whole list a fault).
const brokenName = (i) => `light_${i + 1}_failed`;
const BROKEN_DEDUPE_RE = /^health:light_\d+_failed$/;
async function registeredLights(DB, env, at) {
  const out = [];
  for (const [i, { fn }] of [...registered].entries()) {
    try {
      const value = await fn(DB, env, new Date(at));
      out.push(...(Array.isArray(value) ? value : [value]).map(asLight));
    } catch (err) {
      out.push(light(brokenName(i), "red", `A health check couldn't run: ${errorLine(err, env)}`, BROKEN_FIX));
    }
  }
  return out;
}

// The facts, stage 0's lights, the registered lights and the gaps. `running` (the health step itself) counts the
// health heartbeat as now: health checks are running, so only a stale tick can make the tick light red there.
async function collect(DB, env, now, { running = false } = {}) {
  const at = toMs(now);
  const { status, heartbeats } = await readSetup(DB, env, new Date(at));
  const { results: active } = await DB.prepare(ACTIVE_SQL).all();
  const gaps = setupGaps(status);
  const beats = running ? { ...heartbeats, health: { at: iso(at), ok: true, detail: "" } } : heartbeats;
  const lights = computeLights(
    {
      heartbeats: beats,
      routines: status.routines,
      mailboxes: status.mailboxes,
      jobs: active.filter((r) => r.kind === "job"),
      scans: active.filter((r) => r.kind === "scan"),
      gaps,
    },
    at,
  );
  lights.push(...(await registeredLights(DB, env, at)));
  return { lights, gaps };
}

/** {lights, gaps}: computeLights(...) followed by every registered light, in registration order, and setupGaps. */
export async function healthFromDb(DB, env, now = new Date()) {
  return collect(DB, env, now);
}

// ---------------------------------------------------------------- the health step

// The setup:<key> todos the health step owns (Part A's gaps table), matched exactly. Other stages' setup: todos
// (demo-template, followups, system_mailbox, …) are theirs to close.
const ROUTINE_NAMES = new Set(ROUTINES.map((r) => r.name));
function ownSetupDedupe(dedupe) {
  const key = dedupe.slice("setup:".length);
  if (!dedupe.startsWith("setup:") || !key) return false;
  if (key === "first_mailbox" || key === "agent_token" || key === "business") return true;
  if (/^mailbox_password:.+/.test(key) || /^dns:.+/.test(key)) return true;
  return key.startsWith("routine:") && ROUTINE_NAMES.has(key.slice("routine:".length));
}

// One multi-row INSERT OR IGNORE; returns how many rows it really added. A todo Nik dismissed (or marked done) keeps
// its dedupe, so its row is ignored here and isn't counted as added.
async function insertTodos(DB, rows, createdAt) {
  const values = rows.map((_, i) => {
    const b = 3 + i * 5;
    return `(?${b}, ?${b + 1}, ?${b + 2}, ?${b + 3}, ?2, 'open', ?${b + 4}, ?1)`;
  });
  const params = [createdAt, TODO_LINK];
  for (const [dedupe, t] of rows) params.push(crypto.randomUUID(), t.kind, t.title, t.detail, dedupe);
  const result = await DB.prepare(
    `INSERT OR IGNORE INTO todos (id, kind, title, detail, link, status, dedupe, created_at) VALUES ${values.join(", ")}`,
  ).bind(...params).run();
  const changes = Number(result?.meta?.changes);
  return Number.isFinite(changes) ? changes : rows.length;
}

async function run({ DB, env, now }) {
  const at = toMs(now);
  const { lights, gaps } = await collect(DB, env, at, { running: true });

  // dedupe → the todo it should be, for every red light and every gap; and the dedupes that should be closed.
  const wanted = new Map();
  const closable = new Set();
  for (const l of lights) {
    const dedupe = `health:${l.name}`;
    if (l.level !== "red") closable.add(dedupe);
    else if (!wanted.has(dedupe)) {
      wanted.set(dedupe, { kind: "health", title: l.detail.trim() || `The ${l.name} light is red`, detail: l.fix });
    }
  }
  for (const dedupe of wanted.keys()) closable.delete(dedupe); // two lights with one name: red wins
  for (const g of gaps) wanted.set(`setup:${g.key}`, { kind: "setup", title: g.title, detail: g.detail });

  const { results } = await DB.prepare(OPEN_SQL).all();
  const open = new Set(results.map((r) => r.dedupe));
  // Stage 0's own setup:<key> todos, and the todos of broken registered lights (named by this module), close when
  // they're no longer wanted.
  for (const dedupe of open) {
    if ((ownSetupDedupe(dedupe) || BROKEN_DEDUPE_RE.test(dedupe)) && !wanted.has(dedupe)) closable.add(dedupe);
  }
  const adds = [...wanted].filter(([dedupe]) => !open.has(dedupe));
  const closes = [...closable].filter((dedupe) => open.has(dedupe));

  const stamp = iso(at);
  let added = 0;
  for (let i = 0; i < adds.length; i += ROWS_PER_INSERT) added += await insertTodos(DB, adds.slice(i, i + ROWS_PER_INSERT), stamp);
  if (closes.length) await DB.prepare(CLOSE_SQL).bind(stamp, JSON.stringify(closes)).run();

  const count = (level) => lights.filter((l) => l.level === level).length;
  const line = `${count("green")} green, ${count("amber")} amber, ${count("red")} red`;
  await beat(DB, "health", true, line, new Date(at));
  return `${line}; ${plural(added, "todo", "todos")} added, ${closes.length} closed`;
}

/** The tick's health step: lights, the health:/setup: todo sync and the health beat. Only in ?reason=health. */
export const healthStep = { name: "health", everyMinutes: 0, run };
