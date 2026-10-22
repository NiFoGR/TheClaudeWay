// Health lights, setup gaps, the health tick step and GET /api/health (stage 0, Task 17; Part A "Health lights" and
// "Setup gaps", overview §8).
// Run: node --test control-room/tests/health.test.mjs
//
// tick.js and api/health.js are imported only in the last tests (dynamically): importing tick.js runs every later
// stage's registerLight call, and the counts above them are about stage 0's lights and the lights each test registers.
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { computeLights, healthFromDb, healthStep, registerLight } from "../functions/_lib/health.js";
import { ROUTINES, beat } from "../functions/_lib/routines.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { loadSetupStatus, setupGaps } from "../functions/_lib/setupStatus.js";
import { addTodo } from "../functions/_lib/todo.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-19T12:00:00Z"); // 13:00 UK (BST)
const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const before = (ms) => iso(new Date(NOW.getTime() - ms));
const later = (ms) => new Date(NOW.getTime() + ms);

const NAMES = [
  "tick", "relay", "routine:research", "routine:reply", "routine:weekly-kpis", "routine:build", "routine:monthly-care",
  "mailboxes", "scrape", "setup",
];
const TICK_FIX = "Check the relay light below. If it's green, open GitHub → Actions → Deploy mail relay and run it again.";
const RELAY_FIX = "GitHub → Actions → Deploy mail relay → open the latest run. If it's red, its last step says what to fix.";
const ERR_401 = "Claude rejected the token: generate a new one in the Routine (Edit → API trigger) and paste it on Setup.";
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01AbC9xyz/fire";
const FIRE_TOKEN = "sk-ant-oat01-routine-token-xyz";
const BOUNCED = "2 emails bounced in 7 days (last: bob@example.com). Check your addresses are real, then press Resume.";

const byName = (lights, name) => lights.find((l) => l.name === name);

// Every one of stage 0's lights green.
function greenFacts() {
  return {
    heartbeats: {
      tick: { at: before(MIN), ok: true, detail: "inbound: 0 processed | send: sent 0, failed 0, held 0" },
      health: { at: before(MIN), ok: true, detail: "10 green, 0 amber, 0 red" },
      relay: { at: before(2 * MIN), ok: true, detail: "" },
    },
    routines: ROUTINES.map((r) => ({
      name: r.name,
      label: r.label,
      connected: true,
      last_fire: null,
      last_beat: { at: before(HOUR), ok: true, detail: "done" },
    })),
    mailboxes: [{ id: "m1", address: "nik@aetoswebsites.com", status: "active", paused_reason: null }],
    jobs: [],
    scans: [],
    gaps: [],
  };
}
const lightOf = (facts, name) => byName(computeLights(facts, NOW), name);
const research = (facts) => facts.routines.find((r) => r.name === "research");

// ---------------------------------------------------------------- computeLights (pure)

test("computeLights: exactly stage 0's 10 lights, in order, each {name, level, detail, fix}", () => {
  for (const facts of [greenFacts(), {}]) {
    const lights = computeLights(facts, NOW);
    assert.equal(lights.length, 10);
    assert.deepEqual(lights.map((l) => l.name), NAMES);
    for (const l of lights) {
      assert.deepEqual(Object.keys(l).sort(), ["detail", "fix", "level", "name"]);
      assert.ok(["green", "amber", "red", "grey"].includes(l.level), l.level);
      assert.equal(typeof l.detail, "string");
      assert.equal(typeof l.fix, "string");
    }
  }
  const green = computeLights(greenFacts(), NOW);
  assert.deepEqual(green.map((l) => l.level), Array(10).fill("green"), JSON.stringify(green));
  assert.ok(green.every((l) => l.fix === ""), "a green light has nothing to fix");
});

test("computeLights takes now as a Date or ISO text, and nothing else", () => {
  assert.deepEqual(computeLights(greenFacts(), iso(NOW)), computeLights(greenFacts(), NOW));
  assert.throws(() => computeLights(greenFacts(), "yesterday"), TypeError);
});

test("tick: a tick beat 16 min ago is red, at 15 min it's green; a health beat 16 min ago is red", () => {
  const f = greenFacts();
  f.heartbeats.tick.at = before(16 * MIN);
  assert.deepEqual(lightOf(f, "tick"), {
    name: "tick",
    level: "red",
    detail: "The heartbeat has stopped: no timed work for 16 min",
    fix: TICK_FIX,
  });
  f.heartbeats.tick.at = before(15 * MIN);
  assert.deepEqual(lightOf(f, "tick"), { name: "tick", level: "green", detail: "Heartbeat ran 15 min ago", fix: "" });

  const g = greenFacts();
  g.heartbeats.health.at = before(16 * MIN);
  assert.deepEqual(lightOf(g, "tick"), {
    name: "tick",
    level: "red",
    detail: "Health checks have stopped: lights and todos not updated for 16 min",
    fix: TICK_FIX,
  });
});

test("tick: no tick or no health heartbeat is red; long gaps read in hours and days", () => {
  const f = greenFacts();
  delete f.heartbeats.tick;
  assert.equal(lightOf(f, "tick").level, "red");
  const g = greenFacts();
  delete g.heartbeats.health;
  assert.equal(lightOf(g, "tick").level, "red");
  assert.match(lightOf(g, "tick").detail, /^Health checks/);
  const h = greenFacts();
  h.heartbeats.tick.at = before(3 * HOUR + 59 * MIN);
  assert.equal(lightOf(h, "tick").detail, "The heartbeat has stopped: no timed work for 3 h");
  h.heartbeats.tick.at = before(49 * HOUR);
  assert.equal(lightOf(h, "tick").detail, "The heartbeat has stopped: no timed work for 2 days");
  // A heartbeats row as D1 returns it (last_at, ok 1) reads the same.
  const raw = greenFacts();
  raw.heartbeats.tick = { last_at: before(16 * MIN), ok: 1, detail: "" };
  assert.equal(lightOf(raw, "tick").level, "red");
});

test("relay: missing is red; stale is red; fresh is green", () => {
  const f = greenFacts();
  delete f.heartbeats.relay;
  assert.equal(lightOf(f, "relay").level, "red");
  assert.equal(lightOf(f, "relay").fix, RELAY_FIX);
  f.heartbeats.relay = { at: before(16 * MIN), ok: true, detail: "" };
  assert.deepEqual(lightOf(f, "relay"), {
    name: "relay",
    level: "red",
    detail: "The mail relay hasn't checked in for 16 min",
    fix: RELAY_FIX,
  });
  f.heartbeats.relay.at = before(2 * MIN);
  assert.deepEqual(lightOf(f, "relay"), { name: "relay", level: "green", detail: "Mail relay checked in 2 min ago", fix: "" });
});

// The relay beats ok=0 with what went wrong (mail-relay/src/index.js tickAndBeat): a fresh beat isn't enough.
const RELAY_1042 = "tick call failed: cron: HTTP 530 (error 1042: set CONTROL_ROOM_URL to the project's *.pages.dev address, then re-run Deploy mail relay)";
const URL_FIX = "Set the GitHub repo variable CONTROL_ROOM_URL to the project's *.pages.dev address (GitHub → Settings → Secrets and variables → Actions → Variables), then run Deploy mail relay again.";

test("relay: a fresh beat whose tick calls failed is red, with what the relay said and how to fix it", () => {
  const f = greenFacts();
  f.heartbeats.relay = { at: before(MIN), ok: false, detail: RELAY_1042 };
  assert.deepEqual(lightOf(f, "relay"), {
    name: "relay",
    level: "red",
    detail: `The mail relay can't reach the Control Room, so no timed work runs: ${RELAY_1042}`,
    fix: URL_FIX,
  });
  // As D1 returns the row (last_at, ok 0), and without the 1042 hint: still red, the fix names CONTROL_ROOM_URL.
  f.heartbeats.relay = { last_at: before(MIN), ok: 0, detail: "tick call failed: cron: HTTP 500; health: HTTP 500" };
  const red = lightOf(f, "relay");
  assert.equal(red.level, "red");
  assert.ok(red.detail.endsWith(": tick call failed: cron: HTTP 500; health: HTTP 500"), red.detail);
  assert.match(red.fix, /CONTROL_ROOM_URL/);
  assert.match(red.fix, /\*\.pages\.dev/);
  // So the tick light's "Check the relay light below" points at the real problem.
  f.heartbeats.tick.at = before(40 * MIN);
  assert.equal(lightOf(f, "tick").level, "red");
});

test("relay: a fresh beat with any other problem is amber; a fresh ok beat stays green", () => {
  const f = greenFacts();
  f.heartbeats.relay = { at: before(MIN), ok: false, detail: "forward copy failed: destination address not verified" };
  const amber = lightOf(f, "relay");
  assert.equal(amber.level, "amber");
  assert.ok(amber.detail.includes("forward copy failed: destination address not verified"), amber.detail);
  assert.match(amber.fix, /FORWARD_COPY_TO/);
  f.heartbeats.relay = { at: before(MIN), ok: true, detail: "cron and health ticks called" };
  assert.deepEqual(lightOf(f, "relay"), { name: "relay", level: "green", detail: "Mail relay checked in 1 min ago", fix: "" });
  // Stale still wins: a beat 16 min old is red as before, whatever it said.
  f.heartbeats.relay = { at: before(16 * MIN), ok: false, detail: RELAY_1042 };
  assert.equal(lightOf(f, "relay").detail, "The mail relay hasn't checked in for 16 min");
});

test("routine: Research connected, heartbeat 27 h ago, is red: hasn't run for 1 day", () => {
  const f = greenFacts();
  research(f).last_beat.at = before(27 * HOUR);
  const light = lightOf(f, "routine:research");
  assert.equal(light.level, "red");
  assert.equal(light.detail, "Claude's Research Routine hasn't run for 1 day");
  assert.equal(light.fix, "Setup → Claude → Research: paste its URL and token, then press Test fire.");
  research(f).last_beat.at = before(50 * HOUR);
  assert.equal(lightOf(f, "routine:research").detail, "Claude's Research Routine hasn't run for 2 days");
  // Within the 26 h cadence it's green, with how long ago it ran (whole minutes, hours or days).
  research(f).last_beat.at = before(26 * HOUR);
  assert.deepEqual(lightOf(f, "routine:research"), {
    name: "routine:research",
    level: "green",
    detail: "Claude's Research Routine last ran 1 day ago",
    fix: "",
  });
  research(f).last_beat.at = before(23 * HOUR + 59 * MIN);
  assert.equal(lightOf(f, "routine:research").detail, "Claude's Research Routine last ran 23 h ago");
  research(f).last_beat.at = before(5 * MIN);
  assert.equal(lightOf(f, "routine:research").detail, "Claude's Research Routine last ran 5 min ago");
  // Each Routine has its own cadence; Build has none (only a failed fire makes it red).
  const g = greenFacts();
  for (const r of g.routines) r.last_beat.at = before(100 * HOUR);
  const lights = computeLights(g, NOW);
  assert.equal(byName(lights, "routine:reply").level, "red");
  assert.equal(byName(lights, "routine:weekly-kpis").level, "green", "192 h cadence");
  assert.equal(byName(lights, "routine:build").level, "green");
  assert.equal(byName(lights, "routine:build").detail, "Claude's Build Routine last ran 4 days ago");
  assert.equal(byName(lights, "routine:monthly-care").level, "green", "768 h cadence");
});

test("routine: a failed fire newer than the last heartbeat is red, with the fire's error as the fix", () => {
  const f = greenFacts();
  research(f).last_beat.at = before(2 * HOUR);
  research(f).last_fire = { at: before(30 * MIN), http_status: 401, error: ERR_401 };
  const light = lightOf(f, "routine:research");
  assert.equal(light.level, "red");
  assert.equal(light.fix, ERR_401);
  assert.match(light.detail, /^Claude's Research Routine /);
  // The same failure before the last heartbeat is history: green.
  research(f).last_fire.at = before(3 * HOUR);
  assert.equal(lightOf(f, "routine:research").level, "green");
  // A fire Claude accepted is never a failure.
  research(f).last_fire = { at: before(30 * MIN), ok: true, http_status: 200, error: null };
  assert.equal(lightOf(f, "routine:research").level, "green");
  // A fire held by an earlier 429 (logged with Claude's hourly-limit text) is a failed fire too.
  const held = "Claude's hourly limit for this Routine was hit. It will be tried again when the work is next due, after 14:00.";
  research(f).last_fire = { at: before(10 * MIN), ok: false, http_status: null, error: held };
  assert.equal(lightOf(f, "routine:research").level, "red");
  assert.equal(lightOf(f, "routine:research").fix, held);
  assert.equal(lightOf(f, "routine:research").detail, "Claude's Research Routine couldn't be started 10 min ago");
  // A failed fire with no heartbeat ever is red too (Build fires only when a form comes in).
  const g = greenFacts();
  const build = g.routines.find((r) => r.name === "build");
  build.last_beat = null;
  build.last_fire = { at: before(MIN), ok: false, http_status: 400, error: "The Routine is paused or its API trigger is off: open it in Claude and switch it back on." };
  assert.equal(lightOf(g, "routine:build").level, "red");
  assert.equal(lightOf(g, "routine:build").fix, build.last_fire.error);
});

test("routine: connected but never checked in is amber; not connected is amber; a not-ok heartbeat is amber", () => {
  const f = greenFacts();
  const build = f.routines.find((r) => r.name === "build");
  build.last_beat = null;
  build.last_fire = null;
  const light = lightOf(f, "routine:build");
  assert.equal(light.level, "amber");
  assert.match(light.detail, /hasn't checked in yet/);
  assert.equal(light.detail, "Claude's Build Routine hasn't checked in yet");

  research(f).connected = false;
  assert.deepEqual(lightOf(f, "routine:research"), {
    name: "routine:research",
    level: "amber",
    detail: "Claude's Research Routine isn't connected",
    fix: "Setup → Claude → Research: paste its URL and token, then press Test fire.",
  });
  // Not connected wins over the failed fires it causes (the setup:routine:<name> todo covers it).
  research(f).last_fire = {
    at: before(MIN),
    ok: false,
    http_status: null,
    error: "The Research Routine isn't connected: paste its URL and token on Setup → Claude.",
  };
  assert.equal(lightOf(f, "routine:research").level, "amber");
  // A Routine missing from facts counts as not connected.
  assert.equal(lightOf({ ...greenFacts(), routines: [] }, "routine:reply").level, "amber");

  const g = greenFacts();
  research(g).last_beat = { at: before(HOUR), ok: false, detail: "Couldn't open the lead list" };
  const notOk = lightOf(g, "routine:research");
  assert.equal(notOk.level, "amber");
  assert.match(notOk.detail, /Couldn't open the lead list/);
  assert.ok(notOk.fix.length > 0);
});

test("routine: once connected, an old 'isn't connected' fire doesn't make it red", () => {
  const f = greenFacts();
  research(f).last_beat = null;
  research(f).last_fire = {
    at: before(HOUR),
    ok: false,
    http_status: null,
    error: "The Research Routine isn't connected: paste its URL and token on Setup → Claude.",
  };
  assert.equal(lightOf(f, "routine:research").level, "amber");
  assert.equal(lightOf(f, "routine:research").detail, "Claude's Research Routine hasn't checked in yet");
});

test("mailboxes: a paused mailbox is red; no mailboxes is amber; otherwise green", () => {
  const f = greenFacts();
  f.mailboxes = [
    { id: "m1", address: "nik@aetoswebsites.com", status: "paused", paused_reason: BOUNCED },
    { id: "m2", address: "hello@aetoswebsites.com", status: "active", paused_reason: null },
  ];
  const red = lightOf(f, "mailboxes");
  assert.equal(red.level, "red");
  assert.ok(red.detail.startsWith("nik@aetoswebsites.com is paused: "), red.detail);
  assert.equal(red.detail, `nik@aetoswebsites.com is paused: ${BOUNCED}`);
  assert.equal(red.fix, "Read the reason, fix it, then press Resume on Setup → Mailboxes.");

  f.mailboxes = [];
  assert.deepEqual(lightOf(f, "mailboxes"), {
    name: "mailboxes",
    level: "amber",
    detail: "No mailbox yet",
    fix: "Buy one Namecheap Private Email mailbox and add it on Setup → Mailboxes.",
  });
  assert.equal(lightOf(greenFacts(), "mailboxes").detail, "1 mailbox sending");
  f.mailboxes = [{ id: "a", address: "a@x.com", status: "active" }, { id: "b", address: "b@x.com", status: "active" }];
  assert.equal(lightOf(f, "mailboxes").detail, "2 mailboxes sending");
});

test("scrape: a job running 46 min is amber; a care scan running 46 min is left to stage 11", () => {
  const f = greenFacts();
  f.jobs = [{ status: "running", updated_at: before(46 * MIN) }];
  assert.deepEqual(lightOf(f, "scrape"), {
    name: "scrape",
    level: "amber",
    detail: "A lead search has been running for 46 min",
    fix: "It's probably stuck. Start a new one on Lead Scraper; the old one is marked failed automatically.",
  });
  f.jobs = [{ status: "running", updated_at: before(45 * MIN) }];
  assert.equal(lightOf(f, "scrape").level, "green");

  const g = greenFacts();
  g.scans = [{ status: "running", source: "care", updated_at: before(46 * MIN) }];
  assert.deepEqual(lightOf(g, "scrape"), { name: "scrape", level: "green", detail: "No stuck searches", fix: "" });
  g.scans.push({ status: "queued", source: "manual", updated_at: before(50 * MIN) });
  assert.equal(lightOf(g, "scrape").level, "amber");
  assert.equal(lightOf(g, "scrape").detail, "A lead search has been running for 50 min");
  // Finished ones never count.
  const h = greenFacts();
  h.jobs = [{ status: "done", updated_at: before(5 * HOUR) }, { status: "failed", updated_at: before(5 * HOUR) }];
  assert.equal(lightOf(h, "scrape").level, "green");
});

test("setup: gaps make it amber with how many; none is green", () => {
  const f = greenFacts();
  f.gaps = setupGaps({ agent_token: { set: true }, mailboxes: [], routines: [], business: { legal_name: "N", address: "1 St" } });
  assert.equal(f.gaps.length, 6);
  assert.deepEqual(lightOf(f, "setup"), {
    name: "setup",
    level: "amber",
    detail: "6 things still to set up",
    fix: "Open Setup: each item says what to do.",
  });
  f.gaps = [{ key: "business" }];
  assert.equal(lightOf(f, "setup").detail, "1 thing still to set up");
  f.gaps = [];
  assert.deepEqual(lightOf(f, "setup"), { name: "setup", level: "green", detail: "Setup complete", fix: "" });
});

test("no light name is a prefix of another", () => {
  const names = computeLights(greenFacts(), NOW).map((l) => l.name);
  assert.equal(new Set(names).size, names.length);
  for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);
});

// ---------------------------------------------------------------- setupGaps (pure)

test("setupGaps: an empty status gives first_mailbox, agent_token, the 5 Routines and business", () => {
  for (const status of [{}, { mailboxes: [], routines: [], dns: {}, agent_token: { set: false }, business: {} }]) {
    const gaps = setupGaps(status);
    assert.deepEqual(gaps.map((g) => g.key), [
      "first_mailbox", "agent_token", "routine:research", "routine:reply", "routine:weekly-kpis", "routine:build",
      "routine:monthly-care", "business",
    ]);
    for (const g of gaps) {
      assert.deepEqual(Object.keys(g).sort(), ["detail", "key", "link", "title"]);
      assert.equal(g.link, "/#/setup");
      assert.ok(g.detail.length > 0, g.key);
    }
    const title = (key) => gaps.find((g) => g.key === key).title;
    assert.equal(title("first_mailbox"), "Add your first mailbox");
    assert.equal(title("agent_token"), "Make Claude's access key");
    assert.equal(title("routine:research"), "Connect Claude's Research Routine");
    assert.equal(title("routine:reply"), "Connect Claude's Replies Routine");
    assert.equal(title("business"), "Add your name and business address");
  }
});

test("setupGaps: a mailbox without a password gives mailbox_password:<id>; an unchecked or failing domain dns:<domain>", () => {
  const status = {
    mailboxes: [
      { id: "m1", address: "nik@aetoswebsites.com", has_password: false },
      { id: "m2", address: "hello@aetoswebsites.com", has_password: true },
      { id: "m3", address: "nik@aetos-mail.co.uk", has_password: true },
    ],
    dns: { "aetoswebsites.com": { at: null, ok: false, checks: [] }, "aetos-mail.co.uk": { at: "2026-10-19T11:00:00Z", ok: false, checks: [] } },
    agent_token: { set: true, created_at: "2026-10-19T10:00:00Z" },
    routines: ROUTINES.map((r) => ({ name: r.name, connected: true })),
    business: { legal_name: "Nikiforos Example", address: "1 High St, Leeds" },
  };
  const gaps = setupGaps(status);
  assert.deepEqual(gaps.map((g) => g.key), ["mailbox_password:m1", "dns:aetoswebsites.com", "dns:aetos-mail.co.uk"]);
  assert.equal(gaps[0].title, "Add the password for nik@aetoswebsites.com");
  assert.equal(gaps[1].title, "Add the email DNS records for aetoswebsites.com");
  // A domain with no DNS check at all is a gap too; all green is not.
  delete status.dns["aetoswebsites.com"];
  status.dns["aetos-mail.co.uk"].ok = true;
  assert.deepEqual(setupGaps(status).map((g) => g.key), ["mailbox_password:m1", "dns:aetoswebsites.com"]);
  status.dns["aetoswebsites.com"] = { at: "2026-10-19T11:00:00Z", ok: true, checks: [] };
  status.mailboxes[0].has_password = true;
  assert.deepEqual(setupGaps(status), []);
  // Business details: both needed, and blanks don't count.
  status.business.address = "   ";
  assert.deepEqual(setupGaps(status).map((g) => g.key), ["business"]);
});

// ---------------------------------------------------------------- loadSetupStatus (db)

async function addMailbox(DB, id, address, { status = "active", paused_reason = null, role = "cold", started_on = "2026-09-01" } = {}) {
  await DB.prepare(
    `INSERT INTO mailboxes (id, address, display_name, role, started_on, status, paused_reason, created_at)
     VALUES (?, ?, 'Nik', ?, ?, ?, ?, ?)`,
  ).bind(id, address, role, started_on, status, paused_reason, `2026-09-01T10:00:0${id.slice(-1)}Z`).run();
}

async function addFire(DB, routine, at, { http_status = 200, error = null, session_url = null } = {}) {
  await DB.prepare("INSERT INTO routine_fires (id, routine, reason, http_status, error, session_url, at) VALUES (?, ?, 'test', ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), routine, http_status, error, session_url, at)
    .run();
}

async function connectRoutine(DB, name) {
  await setSecret(DB, `routine:${name}:url`, FIRE_URL);
  await setSecret(DB, `routine:${name}:token`, FIRE_TOKEN);
}

test("loadSetupStatus: everything the Setup page shows, never a secret, in at most 7 queries", async () => {
  const DB = fakeD1();
  await addMailbox(DB, "m1", "nik@aetoswebsites.com"); // bought 1 Sep: day 48, cap 10
  await addMailbox(DB, "m2", "hello@aetos-mail.co.uk", { role: "system", status: "paused", paused_reason: "you paused it on Setup." });
  await setSecret(DB, "mailbox:m1", "mailbox-password-123");
  for (let i = 0; i < 2; i++) {
    await DB.prepare(
      `INSERT INTO messages (id, mailbox_id, direction, kind, author, to_addr, body, status, sent_at, created_at)
       VALUES (?, 'm1', 'out', 'first', 'nik', 'a@b.com', 'x', 'sent', ?, ?)`,
    ).bind(`msg${i}`, before(HOUR), before(HOUR)).run();
  }
  const dnsCache = { at: before(HOUR), ok: true, checks: [{ name: "SPF", ok: true, found: "v=spf1", fix: "" }], mx_note: "Mail to aetoswebsites.com goes to Namecheap (mx1/mx2.privateemail.com)" };
  await setSetting(DB, "dns:last:aetoswebsites.com", JSON.stringify(dnsCache));
  await setSecret(DB, "agent_token", "agent-token-abcdefghijklmnopqrstuvwxyz0123456");
  await setSetting(DB, "agent_token:created_at", "2026-10-19T10:00:00Z");
  await connectRoutine(DB, "research");
  await addFire(DB, "research", before(3 * HOUR), { http_status: 429, error: "old" });
  await addFire(DB, "research", before(2 * HOUR), { session_url: "https://claude.ai/code/session_abc" });
  await addFire(DB, "reply", before(HOUR), { http_status: null, error: "The Replies Routine isn't connected: paste its URL and token on Setup → Claude." });
  await beat(DB, "routine:research", true, "researched 4 leads", new Date(before(90 * MIN)));
  await beat(DB, "relay", true, "", new Date(before(3 * MIN)));
  await DB.prepare("INSERT INTO inbound_raw (id, received_at, headers, raw) VALUES ('i1', ?, '{}', 'x')").bind(before(10 * MIN)).run();
  await setSetting(DB, "business:sender_name", "Nik");
  await setSetting(DB, "business:legal_name", "Nikiforos Example");
  await setSetting(DB, "business:address", "1 High St, Leeds <b>");
  const proof = { at: before(HOUR), ok: true, ms: 1400, mailbox_id: "m1", error: null };
  await setSetting(DB, "smtp:proof", JSON.stringify(proof));
  await setSetting(DB, "setup:test_to", "nik@gmail.com");

  const c = countingDB(DB);
  const status = await loadSetupStatus(c.DB, {}, NOW);
  assert.ok(c.used() <= 7, `used ${c.used()} queries`);

  assert.deepEqual(Object.keys(status).sort(), ["agent_token", "business", "dns", "mailboxes", "receiving", "routines", "smtp_proof", "test_to"]);
  assert.equal(status.mailboxes.length, 2);
  const [m1, m2] = status.mailboxes;
  assert.equal(m1.id, "m1");
  assert.equal(m1.address, "nik@aetoswebsites.com");
  assert.equal(m1.started_on, "2026-09-01");
  assert.equal(m1.has_password, true);
  assert.equal(m1.cap_today, 10);
  assert.equal(m1.sent_today, 2);
  assert.equal(m2.has_password, false);
  assert.equal(m2.cap_today, 0, "paused");
  assert.equal(m2.sent_today, 0);
  assert.equal(m2.paused_reason, "you paused it on Setup.");

  assert.deepEqual(status.routines.map((r) => [r.name, r.label, r.connected]), ROUTINES.map((r) => [r.name, r.label, r.name === "research"]));
  const res = status.routines[0];
  assert.deepEqual(res.last_fire, { at: before(2 * HOUR), ok: true, http_status: 200, error: null, session_url: "https://claude.ai/code/session_abc" });
  assert.deepEqual(res.last_beat, { at: before(90 * MIN), ok: true, detail: "researched 4 leads" });
  const reply = status.routines[1];
  assert.equal(reply.last_fire.ok, false);
  assert.match(reply.last_fire.error, /isn't connected/);
  assert.equal(reply.last_beat, null);
  assert.equal(status.routines[2].last_fire, null);

  assert.deepEqual(status.agent_token, { set: true, created_at: "2026-10-19T10:00:00Z" });
  assert.deepEqual(status.business, {
    sender_name: "Nik",
    legal_name: "Nikiforos Example",
    address: "1 High St, Leeds <b>",
    contact_email: "hello@aetoswebsites.com",
    ico_number: "",
  });
  assert.deepEqual(status.dns, {
    "aetoswebsites.com": dnsCache,
    "aetos-mail.co.uk": { at: null, ok: false, checks: [], mx_note: null },
  });
  assert.deepEqual(status.receiving, { relay_last_at: before(3 * MIN), relay_ok: true, relay_detail: "", last_inbound_at: before(10 * MIN) });
  assert.deepEqual(status.smtp_proof, proof);
  assert.equal(status.test_to, "nik@gmail.com");

  const text = JSON.stringify(status);
  for (const secret of ["mailbox-password-123", "agent-token-abcdefghij", FIRE_TOKEN, "trig_01AbC9xyz"]) {
    assert.ok(!text.includes(secret), `the status holds a secret: ${secret}`);
  }
  // The gaps for that status: m2's password, aetos-mail.co.uk's DNS, and the four Routines not connected.
  assert.deepEqual(setupGaps(status).map((g) => g.key), [
    "mailbox_password:m2", "dns:aetos-mail.co.uk", "routine:reply", "routine:weekly-kpis", "routine:build", "routine:monthly-care",
  ]);
});

test("loadSetupStatus on an empty database: no mailboxes, nothing set, the default contact email", async () => {
  const status = await loadSetupStatus(fakeD1(), {}, NOW);
  assert.deepEqual(status.mailboxes, []);
  assert.deepEqual(status.dns, {});
  assert.deepEqual(status.agent_token, { set: false, created_at: null });
  assert.deepEqual(status.business, { sender_name: "", legal_name: "", address: "", contact_email: "hello@aetoswebsites.com", ico_number: "" });
  assert.deepEqual(status.receiving, { relay_last_at: null, relay_ok: null, relay_detail: null, last_inbound_at: null });
  assert.equal(status.smtp_proof, null);
  assert.equal(status.test_to, null);
  assert.ok(status.routines.every((r) => r.connected === false && r.last_fire === null && r.last_beat === null));
});

// ---------------------------------------------------------------- healthFromDb and healthStep (db)

const ctx = (DB, now = NOW) => ({ DB, env: {}, now, reason: "health", results: {}, budget: { left: () => 50 } });
const todo = (DB, dedupe) => DB.prepare("SELECT * FROM todos WHERE dedupe = ?").bind(dedupe).first();
const openDedupes = async (DB) =>
  (await DB.prepare("SELECT dedupe FROM todos WHERE status = 'open' ORDER BY dedupe").all()).results.map((r) => r.dedupe);
const allTodos = async (DB) => (await DB.prepare("SELECT * FROM todos ORDER BY id").all()).results;

test("healthFromDb: stage 0's 10 lights from the database, and the gaps, in at most 8 queries", async () => {
  const DB = fakeD1();
  const c = countingDB(DB);
  const { lights, gaps } = await healthFromDb(c.DB, {}, NOW);
  assert.ok(c.used() <= 8, `used ${c.used()} queries`);
  assert.deepEqual(lights.map((l) => l.name), NAMES);
  assert.deepEqual(lights.map((l) => l.level), ["red", "red", "amber", "amber", "amber", "amber", "amber", "amber", "green", "amber"]);
  assert.deepEqual(gaps.map((g) => g.key), setupGaps({}).map((g) => g.key));
  assert.equal(byName(lights, "setup").detail, "8 things still to set up");
});

test("healthFromDb reads jobs and scans (not care scans) for the scrape light, and the heartbeats", async () => {
  const DB = fakeD1();
  await DB.prepare("INSERT INTO scans (id, keyword, town, grid, spacing_m, source, status, created_at, updated_at) VALUES ('s1', 'roofer', 'Leeds', 5, 500, 'care', 'running', ?, ?)")
    .bind(before(2 * HOUR), before(2 * HOUR)).run();
  await beat(DB, "tick", true, "", new Date(before(16 * MIN)));
  await beat(DB, "health", true, "", new Date(before(MIN)));
  await beat(DB, "relay", true, "", new Date(before(MIN)));
  let { lights } = await healthFromDb(DB, {}, NOW);
  assert.equal(byName(lights, "scrape").level, "green");
  assert.equal(byName(lights, "tick").detail, "The heartbeat has stopped: no timed work for 16 min");
  assert.equal(byName(lights, "relay").level, "green");
  await DB.prepare("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES ('j1', 'roofer', 'Leeds', 20, 'running', ?, ?)")
    .bind(before(HOUR), before(46 * MIN)).run();
  ({ lights } = await healthFromDb(DB, {}, NOW));
  assert.equal(byName(lights, "scrape").detail, "A lead search has been running for 46 min");
  // A paused mailbox, from the mailboxes table.
  await addMailbox(DB, "m1", "nik@aetoswebsites.com", { status: "paused", paused_reason: BOUNCED });
  ({ lights } = await healthFromDb(DB, {}, NOW));
  assert.equal(byName(lights, "mailboxes").detail, `nik@aetoswebsites.com is paused: ${BOUNCED}`);
});

test("healthStep: a red tick light adds health:tick; fresh tick and health beats close it; gaps become setup todos", async () => {
  const DB = fakeD1();
  const summary = await healthStep.run(ctx(DB));
  assert.equal(typeof summary, "string");
  const row = await todo(DB, "health:tick");
  assert.equal(row.status, "open");
  assert.equal(row.kind, "health");
  assert.equal(row.link, "/#/setup");
  assert.equal(row.detail, TICK_FIX);
  assert.ok(row.title.length > 0);
  assert.equal((await todo(DB, "health:relay")).status, "open");
  for (const key of ["first_mailbox", "agent_token", "routine:research", "routine:monthly-care", "business"]) {
    const gap = await todo(DB, `setup:${key}`);
    assert.equal(gap?.status, "open", key);
    assert.equal(gap.kind, "setup");
    assert.equal(gap.link, "/#/setup");
  }
  assert.equal((await todo(DB, "setup:first_mailbox")).title, "Add your first mailbox");
  // Amber and green lights add nothing.
  assert.equal(await todo(DB, "health:routine:research"), null);
  assert.equal(await todo(DB, "health:mailboxes"), null);
  assert.equal(await todo(DB, "health:setup"), null);
  // The health heartbeat: tick and relay red, the 5 Routines, mailboxes and setup amber, scrape green.
  const hb = await DB.prepare("SELECT * FROM heartbeats WHERE name = 'health'").first();
  assert.ok(hb, "the health heartbeat row exists");
  assert.equal(hb.ok, 1);
  assert.equal(hb.detail, "1 green, 7 amber, 2 red");
  assert.equal(hb.last_at, iso(NOW));

  const next = later(5 * MIN);
  await beat(DB, "tick", true, "", next);
  await beat(DB, "health", true, "", next);
  await healthStep.run(ctx(DB, later(5 * MIN + 10 * S)));
  assert.equal(await todo(DB, "health:tick"), null, "health:tick is closed, its dedupe freed");
  const closed = await DB.prepare("SELECT * FROM todos WHERE dedupe LIKE 'health:tick@%'").first();
  assert.equal(closed.status, "done");
  assert.equal(closed.done_at, iso(later(5 * MIN + 10 * S)));
  assert.equal(closed.dedupe, `health:tick@${closed.done_at}`);
  assert.equal((await todo(DB, "health:relay")).status, "open", "the relay is still red");
});

test("the health step counts itself as running: a stale health beat doesn't add health:tick", async () => {
  const DB = fakeD1();
  await beat(DB, "tick", true, "", new Date(before(MIN)));
  await beat(DB, "health", true, "", new Date(before(3 * HOUR))); // health stopped for 3 h and is now back
  await healthStep.run(ctx(DB));
  assert.equal(await todo(DB, "health:tick"), null);
  // /api/health (healthFromDb) still reads the real health heartbeat: now fresh.
  assert.equal(byName((await healthFromDb(DB, {}, NOW)).lights, "tick").level, "green");
});

test("bounded queries: 10 red registered lights, 3 mailboxes without passwords, nothing connected", async () => {
  const DB = fakeD1();
  for (const id of ["m1", "m2", "m3"]) await addMailbox(DB, id, `nik${id}@aetoswebsites.com`);
  const offs = [];
  for (let i = 0; i < 10; i++) {
    offs.push(registerLight(async (lightDB) => {
      await lightDB.prepare("SELECT 1 AS x").first();
      return { name: `demo_${i}_light`, level: "red", detail: `Demo ${i} is broken`, fix: "Fix the demo" };
    }));
  }
  try {
    const c = countingDB(DB);
    await healthStep.run({ DB: c.DB, env: {}, now: NOW, budget: { left: () => 50 } });
    assert.ok(c.used() <= 30, `used ${c.used()} queries`);
    const open = await openDedupes(DB);
    for (let i = 0; i < 10; i++) assert.ok(open.includes(`health:demo_${i}_light`), `demo ${i}`);
    for (const id of ["m1", "m2", "m3"]) assert.ok(open.includes(`setup:mailbox_password:${id}`), id);
    assert.ok(open.includes("setup:dns:aetoswebsites.com"));
    assert.equal(open.length, 23, open.join(", ")); // 12 health (10 + tick + relay) + 11 setup

    const first = await allTodos(DB);
    const c2 = countingDB(DB);
    await healthStep.run({ DB: c2.DB, env: {}, now: NOW, budget: { left: () => 50 } });
    assert.deepEqual(await allTodos(DB), first, "a second identical run adds no todos and closes none");
    assert.ok(c2.used() <= 21, `a run with nothing to add or close sends no INSERT or UPDATE (used ${c2.used()})`);
  } finally {
    for (const off of offs) off();
  }
});

test("more than 15 new todos are added 15 rows to an INSERT (D1's 100 bound values)", async () => {
  const DB = fakeD1();
  const offs = [];
  for (let i = 0; i < 31; i++) {
    offs.push(registerLight(async () => ({ name: `bulk_${i}_light`, level: "red", detail: `Bulk ${i}`, fix: "" })));
  }
  try {
    const sqls = [];
    const spy = {
      prepare: (sql) => {
        sqls.push(sql);
        return DB.prepare(sql);
      },
      batch: (s) => DB.batch(s),
    };
    await healthStep.run(ctx(spy));
    const inserts = sqls.filter((s) => /^INSERT OR IGNORE INTO todos/.test(s));
    // 31 + tick + relay = 33 health todos and 8 setup todos: 41 rows, so 3 INSERTs.
    assert.equal(inserts.length, 3);
    assert.equal((await openDedupes(DB)).length, 41);
    const added = await DB.prepare("SELECT title, detail, kind FROM todos WHERE dedupe = 'health:bulk_30_light'").first();
    assert.deepEqual(added, { title: "Bulk 30", detail: "", kind: "health" });

    // The 31 lights turn green: all 31 todos close in ONE UPDATE (exact dedupes), after ONE read of the open todos.
    for (const off of offs) off();
    offs.length = 0;
    for (let i = 0; i < 31; i++) {
      offs.push(registerLight(async () => ({ name: `bulk_${i}_light`, level: "green", detail: "ok", fix: "" })));
    }
    sqls.length = 0;
    const summary = await healthStep.run(ctx(spy, later(5 * MIN)));
    const updates = sqls.filter((s) => /^UPDATE todos/.test(s));
    assert.equal(updates.length, 1);
    assert.ok(updates[0].startsWith("UPDATE todos SET status='done', done_at=?1, dedupe=dedupe||'@'||?1"), updates[0]);
    assert.match(updates[0], /WHERE status='open' AND dedupe IN \(/);
    assert.equal(sqls.filter((s) => /^SELECT/.test(s) && /\bFROM todos\b/.test(s)).length, 1);
    assert.equal(sqls.filter((s) => /^INSERT OR IGNORE INTO todos/.test(s)).length, 0);
    assert.deepEqual((await openDedupes(DB)).filter((d) => d.startsWith("health:bulk_")), []);
    assert.match(summary, /; 0 todos added, 31 closed$/, summary);
  } finally {
    for (const off of offs) off();
  }
});

test("a registered function may give back a list of lights (stage 11's careLights): each shows and syncs", async () => {
  const DB = fakeD1();
  const off = registerLight(async () => [
    { name: "care_scans", level: "red", detail: "A Google scan for Smith Roofing hasn't finished.", fix: "Open their page and press Retry the day-7 scan." },
    { name: "care_reviews", level: "grey", detail: "No clients yet", fix: "" },
  ]);
  try {
    const { lights } = await healthFromDb(DB, {}, NOW);
    assert.deepEqual(lights.slice(10).map((l) => [l.name, l.level]), [["care_scans", "red"], ["care_reviews", "grey"]]);
    await healthStep.run(ctx(DB));
    assert.equal((await todo(DB, "health:care_scans")).status, "open");
    assert.equal(await todo(DB, "health:care_reviews"), null, "grey adds nothing");
  } finally {
    off();
  }
  // A list with something in it that isn't a light is that function's fault: one red light of its own.
  const offBad = registerLight(async () => [{ name: "care_scans", level: "green", detail: "", fix: "" }, null]);
  try {
    const extra = (await healthFromDb(DB, {}, NOW)).lights.slice(10);
    assert.equal(extra.length, 1);
    assert.equal(extra[0].level, "red");
    assert.match(extra[0].name, /^light_\d+_failed$/);
  } finally {
    offBad();
  }
});

test("each of stage 0's setup todos closes once its gap is fixed; look-alike dedupes are never touched", async () => {
  const DB = fakeD1();
  await addMailbox(DB, "m1", "nik@aetoswebsites.com");
  await addMailbox(DB, "m2", "hello@aetoswebsites.com");
  await healthStep.run(ctx(DB));
  const setupOpen = async () =>
    (await DB.prepare("SELECT dedupe FROM todos WHERE status = 'open' AND kind = 'setup' ORDER BY dedupe").all()).results.map((r) => r.dedupe);
  // "Perfect when" 9: nothing connected, so all five setup:routine:<name> todos are open (and the lights are amber).
  assert.deepEqual(await setupOpen(), [
    "setup:agent_token", "setup:business", "setup:dns:aetoswebsites.com", "setup:mailbox_password:m1",
    "setup:mailbox_password:m2", "setup:routine:build", "setup:routine:monthly-care", "setup:routine:reply",
    "setup:routine:research", "setup:routine:weekly-kpis",
  ]);
  const { lights } = await healthFromDb(DB, {}, NOW);
  assert.deepEqual(lights.filter((l) => l.name.startsWith("routine:")).map((l) => l.level), Array(5).fill("amber"));

  // Other stages' todos that only look like stage 0's (exact match, never a prefix).
  await addTodo(DB, { kind: "setup", title: "Look-alike", dedupe: "setup:business:extra" });
  await addTodo(DB, { kind: "setup", title: "Not one of the 5 Routines", dedupe: "setup:routine:old-one" });
  await addTodo(DB, { kind: "health", title: "Look-alike", dedupe: "health:tickle" });

  // Every gap fixed, m2 removed, and the heartbeats fresh.
  await DB.prepare("DELETE FROM mailboxes WHERE id = 'm2'").run();
  await setSecret(DB, "mailbox:m1", "pw-123");
  await setSetting(DB, "dns:last:aetoswebsites.com", JSON.stringify({ at: before(MIN), ok: true, checks: [], mx_note: null }));
  await setSecret(DB, "agent_token", "agent-token-abcdefghijklmnopqrstuvwxyz0123456");
  for (const r of ROUTINES) await connectRoutine(DB, r.name);
  await setSetting(DB, "business:legal_name", "Nikiforos Example");
  await setSetting(DB, "business:address", "1 High St, Leeds");
  for (const name of ["tick", "health", "relay"]) await beat(DB, name, true, "", later(5 * MIN));
  const summary = await healthStep.run(ctx(DB, later(5 * MIN + 10 * S)));

  assert.deepEqual(await setupOpen(), ["setup:business:extra", "setup:routine:old-one"]);
  assert.equal((await todo(DB, "health:tickle")).status, "open");
  const done = (await DB.prepare("SELECT dedupe, done_at FROM todos WHERE status = 'done'").all()).results;
  assert.equal(done.length, 12, JSON.stringify(done)); // 10 setup + health:tick + health:relay
  for (const row of done) assert.ok(row.dedupe.endsWith(`@${iso(later(5 * MIN + 10 * S))}`), row.dedupe);
  // Connected Routines that haven't checked in yet are amber: 5 green, 5 amber.
  assert.equal(summary, "5 green, 5 amber, 0 red; 0 todos added, 12 closed");
});

test("a registered light follows the 10 in healthFromDb; red adds health:<name>, grey adds nothing and closes it", async () => {
  const DB = fakeD1();
  const off = registerLight(async () => ({ name: "demo_light", level: "red", detail: "The demo light is red", fix: "Do the demo thing" }));
  try {
    const { lights } = await healthFromDb(DB, {}, NOW);
    assert.deepEqual(lights.slice(0, 10).map((l) => l.name), NAMES);
    assert.equal(lights.length, 11);
    assert.deepEqual(lights[10], { name: "demo_light", level: "red", detail: "The demo light is red", fix: "Do the demo thing" });
    await healthStep.run(ctx(DB));
    const row = await todo(DB, "health:demo_light");
    assert.equal(row.status, "open");
    assert.equal(row.kind, "health");
    assert.equal(row.title, "The demo light is red");
    assert.equal(row.detail, "Do the demo thing");
    assert.equal(row.link, "/#/setup");
  } finally {
    off();
  }
  assert.equal((await healthFromDb(DB, {}, NOW)).lights.length, 10, "unregistered");

  // Grey on a fresh database: nothing added.
  const fresh = fakeD1();
  const offGrey = registerLight(async () => ({ name: "demo_light", level: "grey", detail: "Not in use", fix: "" }));
  try {
    await healthStep.run(ctx(fresh));
    assert.equal(await todo(fresh, "health:demo_light"), null);
    // Grey closes the open one from the red run above.
    await healthStep.run(ctx(DB, later(5 * MIN)));
    assert.equal(await todo(DB, "health:demo_light"), null);
    const closed = await DB.prepare("SELECT status FROM todos WHERE dedupe = ?").bind(`health:demo_light@${iso(later(5 * MIN))}`).first();
    assert.equal(closed.status, "done");
  } finally {
    offGrey();
  }
});

test("registerLight: needs a function; a light that throws or isn't a light is a red light of its own", async () => {
  assert.throws(() => registerLight({ name: "x" }), TypeError);
  const DB = fakeD1();
  const offs = [
    registerLight(async () => {
      throw new Error("no such table: care near sk-ant-oat01-Secret_9");
    }),
    registerLight(async () => ({ name: "", level: "purple" })),
    registerLight(async () => ({ name: "fine_light", level: "green", detail: "All good", fix: "", extra: 1 })),
  ];
  try {
    const { lights } = await healthFromDb(DB, {}, NOW);
    const extra = lights.slice(10);
    assert.equal(extra.length, 3);
    assert.equal(extra[0].level, "red");
    assert.match(extra[0].detail, /no such table: care/);
    assert.ok(!extra[0].detail.includes("sk-ant-"), "secrets are hidden");
    assert.equal(extra[1].level, "red");
    assert.notEqual(extra[0].name, extra[1].name);
    assert.deepEqual(extra[2], { name: "fine_light", level: "green", detail: "All good", fix: "" });
    const names = lights.map((l) => l.name);
    for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);
    // The step still runs, and the broken ones become health todos.
    await healthStep.run(ctx(DB));
    assert.equal((await todo(DB, `health:${extra[0].name}`)).status, "open");
    assert.equal((await todo(DB, `health:${extra[1].name}`)).status, "open");
  } finally {
    for (const off of offs) off();
  }
  // Once the faulty lights are gone (fixed), their todos close.
  await healthStep.run(ctx(DB, later(5 * MIN)));
  assert.deepEqual((await openDedupes(DB)).filter((d) => /_failed$/.test(d)), []);
});

// Everything set up and running: every light green, no gaps.
async function greenDb() {
  const DB = fakeD1();
  await addMailbox(DB, "m1", "nik@aetoswebsites.com");
  await setSecret(DB, "mailbox:m1", "pw-123");
  await setSetting(DB, "dns:last:aetoswebsites.com", JSON.stringify({ at: before(HOUR), ok: true, checks: [], mx_note: "" }));
  await setSecret(DB, "agent_token", "agent-token-abcdefghijklmnopqrstuvwxyz0123456");
  await setSetting(DB, "agent_token:created_at", before(HOUR));
  for (const r of ROUTINES) {
    await connectRoutine(DB, r.name);
    await beat(DB, `routine:${r.name}`, true, "done", new Date(before(HOUR)));
  }
  await setSetting(DB, "business:legal_name", "Nikiforos Example");
  await setSetting(DB, "business:address", "1 High St, Leeds");
  await beat(DB, "tick", true, "", new Date(before(MIN)));
  await beat(DB, "health", true, "", new Date(before(5 * MIN)));
  await beat(DB, "relay", true, "", new Date(before(MIN)));
  return DB;
}

test("other stages' health: and setup: todos stay open after a run with every light green and no gaps", async () => {
  const DB = await greenDb();
  await addTodo(DB, { kind: "health", title: "Add more towns to your automatic search", dedupe: "health:find:towns" });
  await addTodo(DB, { kind: "setup", title: "Pick the demo template", dedupe: "setup:demo-template" });
  await addTodo(DB, { kind: "setup", title: "Set up the system mailbox", dedupe: "setup:system_mailbox" });
  const { lights, gaps } = await healthFromDb(DB, {}, NOW);
  assert.deepEqual(lights.map((l) => l.level), Array(10).fill("green"), JSON.stringify(lights));
  assert.deepEqual(gaps, []);
  await healthStep.run(ctx(DB));
  assert.deepEqual(await openDedupes(DB), ["health:find:towns", "setup:demo-template", "setup:system_mailbox"]);
  const hb = await DB.prepare("SELECT detail FROM heartbeats WHERE name = 'health'").first();
  assert.equal(hb.detail, "10 green, 0 amber, 0 red");
});

test("setup:mailbox_password:m1 stays open across runs while the gap persists; setup:first_mailbox closes once a mailbox exists", async () => {
  const DB = fakeD1();
  await healthStep.run(ctx(DB));
  assert.equal((await todo(DB, "setup:first_mailbox")).status, "open");
  assert.equal(await todo(DB, "setup:mailbox_password:m1"), null);

  await addMailbox(DB, "m1", "nik@aetoswebsites.com");
  await healthStep.run(ctx(DB, later(5 * MIN)));
  assert.equal(await todo(DB, "setup:first_mailbox"), null);
  const closed = await DB.prepare("SELECT * FROM todos WHERE dedupe LIKE 'setup:first_mailbox@%'").first();
  assert.equal(closed.status, "done");
  const pw = await todo(DB, "setup:mailbox_password:m1");
  assert.equal(pw.status, "open");
  assert.equal(pw.title, "Add the password for nik@aetoswebsites.com");

  await healthStep.run(ctx(DB, later(10 * MIN)));
  const again = await todo(DB, "setup:mailbox_password:m1");
  assert.equal(again.id, pw.id, "never closed and re-added");
  assert.equal(again.status, "open");
  const rows = await DB.prepare("SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'setup:mailbox_password:m1%'").first("n");
  assert.equal(rows, 1);

  // The password saved: the gap goes, and so does the todo (exact dedupe; another mailbox's is untouched).
  await addMailbox(DB, "m2", "hello@aetoswebsites.com");
  await setSecret(DB, "mailbox:m1", "pw");
  await healthStep.run(ctx(DB, later(15 * MIN)));
  assert.equal(await todo(DB, "setup:mailbox_password:m1"), null);
  assert.equal((await todo(DB, "setup:mailbox_password:m2")).status, "open");
});

test("a todo Nik dismissed keeps its dedupe: the health step doesn't add it again or close it", async () => {
  const DB = fakeD1();
  await healthStep.run(ctx(DB));
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE dedupe = 'setup:business'").run();
  const summary = await healthStep.run(ctx(DB, later(5 * MIN)));
  const rows = (await DB.prepare("SELECT status FROM todos WHERE dedupe LIKE 'setup:business%'").all()).results;
  assert.deepEqual(rows, [{ status: "dismissed" }]);
  // The summary counts only the todos really added: the ignored dismissed one isn't one.
  assert.match(summary, /; 0 todos added, 0 closed$/, summary);
});

// ---------------------------------------------------------------- the tick and the route (imported last)

test("tick.js: healthStep is the last of STEPS, and ?reason=health runs it", async () => {
  const { STEPS, runTick } = await import("../functions/_lib/tick.js");
  assert.equal(STEPS.at(-1), healthStep);
  assert.equal(healthStep.name, "health");
  assert.equal(healthStep.everyMinutes, 0);
  assert.equal(typeof healthStep.run, "function");
  const DB = fakeD1();
  const cron = await runTick({ DB }, "cron", NOW);
  assert.ok(!("health" in cron.steps));
  const r = await runTick({ DB }, "health", NOW);
  assert.equal(r.ran, true);
  assert.deepEqual(Object.keys(r.steps), ["health"]);
  assert.equal(typeof r.steps.health, "string", JSON.stringify(r.steps));
  const hb = await DB.prepare("SELECT * FROM heartbeats WHERE name = 'health'").first();
  assert.ok(hb);
  assert.equal(await todo(DB, "health:tick"), null, "the cron tick just beat");
  assert.equal((await todo(DB, "health:relay")).status, "open");
});

test("GET /api/health → {lights, gaps}, stage 0's 10 lights first; login required", async () => {
  const { onRequestGet } = await import("../functions/api/health.js");
  const res = await onRequestGet({ request: new Request("https://control.x/api/health"), env: { DB: fakeD1() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["gaps", "lights"]);
  assert.deepEqual(body.lights.slice(0, 10).map((l) => l.name), NAMES);
  assert.ok(body.gaps.some((g) => g.key === "first_mailbox"));
  for (const l of body.lights) assert.deepEqual(Object.keys(l).sort(), ["detail", "fix", "level", "name"]);

  // No database: a plain-English error, not a crash.
  const broken = await onRequestGet({ request: new Request("https://control.x/api/health"), env: {} });
  assert.equal(broken.status, 500);
  assert.match((await broken.json()).error, /database isn't connected/);

  const { onRequest } = await import("../functions/_middleware.js");
  const gated = await onRequest({
    request: new Request("https://control.x/api/health"),
    env: { CONTROL_ROOM_PASSWORD: "pw" },
    next: async () => new Response("ok"),
  });
  assert.equal(gated.status, 401);
});
