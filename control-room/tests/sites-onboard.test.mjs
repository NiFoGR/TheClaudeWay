// Onboarding routes and Send (stage 10, Task 12): GET /onboard/<token>, POST …/save, POST …/submit, and
// submitOnboarding / startTodos in _lib/sites/onboard.js.
// Run: node --test control-room/tests/sites-onboard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { formDefaults } from "../functions/_lib/sites/form.js";
import { GBP_EMAIL_BAD, saveGbpEmail, startTodos, submitOnboarding } from "../functions/_lib/sites/onboard.js";
import { getSetting, setSetting } from "../functions/_lib/settings.js";
import { addTodo } from "../functions/_lib/todo.js";
import { onRequestGet as getRoute, onRequestHead as headRoute } from "../functions/onboard/[token].js";
import { onRequestPost as saveRoute } from "../functions/onboard/[token]/save.js";
import { onRequestPost as submitRoute } from "../functions/onboard/[token]/submit.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const TOKEN = "t".repeat(32);
const OTHER = "u".repeat(32);
const SUBMITTED = new Date("2026-10-24T22:30:00Z");
const ORIGIN = "https://aetoswebsites.com";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const todo = (DB, dedupe) => one(DB, "SELECT * FROM todos WHERE dedupe = ? OR dedupe LIKE ? ORDER BY created_at DESC LIMIT 1", dedupe, `${dedupe}@%`);

async function seed({ pkg = "full", photos = [] } = {}) {
  const DB = fakeD1();
  await insert(DB, "leads", {
    place_id: "p1", name: "Smith Roofing", trade: "roofer", search_town: "Swindon", town: "Swindon",
    phone: "01793 123456", address: "1 High St, Swindon SN1 1AA", director_name: "Mark Smith",
    audit: JSON.stringify({ brand: { logo: "", colour: "", photos } }),
    first_seen_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T09:00:00Z",
  });
  await insert(DB, "research", {
    place_id: "p1", status: "done", best_email: "mark@smithroofing.co.uk",
    owner: JSON.stringify({ first: "Mark", full: "Mark Smith", confident: true }),
    copy: JSON.stringify({ services: ["Roof repairs", "Flat roofs"], areas: ["Swindon", "Wroughton"], about: "Family firm." }),
  });
  await insert(DB, "clients", {
    id: "c1", name: "Smith Roofing", place_id: "p1", package: pkg, build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-20", created_at: "2026-10-20T09:00:00Z",
  });
  await insert(DB, "onboarding", { client_id: "c1", token: TOKEN, status: "sent", created_at: "2026-10-20T09:00:00Z" });
  // stage 9's todo for the new client, and another client's whose dedupe starts the same way
  await addTodo(DB, { kind: "build", dedupe: "build:new:c1", title: "New client: Smith Roofing — onboarding form sent", client_id: "c1" });
  await addTodo(DB, { kind: "build", dedupe: "build:new:c10", title: "New client: Other — onboarding form sent", client_id: "c10" });
  return DB;
}

function goodForm(domain = {}) {
  const f = formDefaults({
    lead: { name: "Smith Roofing", phone: "01793 123456", address: "1 High St, Swindon SN1 1AA", town: "Swindon", director_name: "Mark Smith" },
    research: {
      best_email: "mark@smithroofing.co.uk",
      copy: { services: ["Roof repairs", "Flat roofs"], areas: ["Swindon", "Wroughton"], about: "Family firm." },
    },
  });
  f.business.show_address = "no";
  f.free_quotes = "yes";
  f.emergency = "no";
  f.domain.has = "no";
  f.domain.choices = ["smithroofing.co.uk", "smithroofs.co.uk", ""];
  Object.assign(f.domain, domain);
  f.gbp.has = "yes";
  return f;
}

function fakeFire(result = { ok: true, status: 200 }) {
  const calls = [];
  const fire = async (...args) => {
    calls.push(args);
    return result;
  };
  return { fire, calls };
}

const req = (path, { method = "GET", body } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const get = (DB, token) => getRoute({ request: req(`/onboard/${token}`), env: { DB }, params: { token } });
const save = (DB, token, body) => saveRoute({ request: req(`/onboard/${token}/save`, { method: "POST", body }), env: { DB }, params: { token } });
const submit = (DB, token, body) => submitRoute({ request: req(`/onboard/${token}/submit`, { method: "POST", body }), env: { DB }, params: { token } });

test("GET an unknown token → 404 'This link isn't valid.'", async () => {
  const DB = await seed();
  for (const token of [OTHER, "short", "<script>"]) {
    const res = await get(DB, token);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /This link isn&#39;t valid\.|This link isn't valid\./);
    assert.match(res.headers.get("content-type"), /text\/html/);
  }
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM client_sites")).n, 0);
});

test("GET a valid token → 200 form page and creates the client_sites row (once)", async () => {
  const DB = await seed();
  const res = await get(DB, TOKEN);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Your website, live in 7 days"));
  assert.ok(html.includes("Hi Mark,"));
  assert.ok(html.includes("Send: start my 7 days"));
  assert.ok(html.includes(`/onboard/${TOKEN}/save`));
  assert.ok(html.includes("Roof repairs"), "prefilled from research");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  const site = await one(DB, "SELECT * FROM client_sites WHERE client_id = 'c1'");
  assert.ok(site, "client_sites row made");
  assert.equal(site.place_id, "p1");
  assert.equal(site.status, "draft");
  await get(DB, TOKEN);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM client_sites")).n, 1);
  // Full Package with no Google account set: the GBP steps can't name it, so Nik gets the setup todo
  assert.equal((await todo(DB, "setup:gbp-email")).title, "Add the Google account clients invite as Manager");
});

test("GET shows the saved answers, and the GBP steps name care:nik_google_email when set", async () => {
  const DB = await seed();
  await setSetting(DB, "care:nik_google_email", "nik.aetos@gmail.com");
  const form = goodForm();
  form.business.name = "Smith & Sons <b>Roofing</b>";
  assert.equal((await save(DB, TOKEN, form)).status, 200);
  const html = await (await get(DB, TOKEN)).text();
  assert.ok(html.includes("Smith &amp; Sons &lt;b&gt;Roofing&lt;/b&gt;"), "saved answer restored, escaped");
  assert.ok(!html.includes("<b>Roofing</b>"));
  assert.ok(html.includes("nik.aetos@gmail.com"));
  assert.equal(await todo(DB, "setup:gbp-email"), null);
});

test("save → 200 and onboarding.form stored (normalised); bad JSON → 400; unknown token → 404", async () => {
  const DB = await seed();
  const form = goodForm();
  form.extra = "dropped";
  const res = await save(DB, TOKEN, form);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const row = await one(DB, "SELECT form, status, submitted_at FROM onboarding WHERE client_id = 'c1'");
  const stored = JSON.parse(row.form);
  assert.equal(stored.business.name, "Smith Roofing");
  assert.deepEqual(stored.domain.choices, ["smithroofing.co.uk", "smithroofs.co.uk", ""]);
  assert.equal(stored.extra, undefined);
  assert.equal(row.status, "sent");
  assert.equal(row.submitted_at, null);

  assert.equal((await save(DB, TOKEN, "{not json")).status, 400);
  assert.equal((await save(DB, TOKEN, "[1,2]")).status, 400);
  assert.equal((await save(DB, OTHER, form)).status, 404);
});

test("save over 32 KB → 413 and nothing stored", async () => {
  const DB = await seed();
  const form = goodForm();
  form.notes = "x".repeat(33 * 1024);
  const res = await save(DB, TOKEN, form);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /32 KB/);
  assert.equal((await one(DB, "SELECT form FROM onboarding WHERE client_id = 'c1'")).form, null);
  // exactly at the limit is fine
  const small = JSON.stringify(goodForm());
  const padded = JSON.stringify({ ...goodForm(), photos_note: "y".repeat(32 * 1024 - small.length - 2) });
  assert.equal(new TextEncoder().encode(padded).length <= 32 * 1024, true);
  assert.equal((await save(DB, TOKEN, padded)).status, 200);
});

test("a body sent without Content-Length (chunked) over 32 KB → 413, read no further; HEAD → GET's status, no body", async () => {
  const DB = await seed();
  let pulled = 0;
  const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 100) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const request = new Request(`${ORIGIN}/onboard/${TOKEN}/save`, { method: "POST", body: stream, duplex: "half" });
  assert.equal(request.headers.get("content-length"), null);
  const res = await saveRoute({ request, env: { DB }, params: { token: TOKEN } });
  assert.equal(res.status, 413);
  assert.ok(pulled < 10, `stopped reading after the limit (read ${pulled} chunks)`);
  assert.equal((await one(DB, "SELECT form FROM onboarding WHERE client_id = 'c1'")).form, null);

  const head = await headRoute({ request: new Request(`${ORIGIN}/onboard/${TOKEN}`, { method: "HEAD" }), env: { DB }, params: { token: TOKEN } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("referrer-policy"), "no-referrer");
  const bad = await headRoute({ request: new Request(`${ORIGIN}/onboard/${OTHER}`, { method: "HEAD" }), env: { DB }, params: { token: OTHER } });
  assert.equal(bad.status, 404);
});

test("submit invalid → 400 with errors, clock not started", async () => {
  const DB = await seed();
  const form = goodForm();
  form.business.phone = "";
  form.services = [];
  const { fire, calls } = fakeFire();
  const out = await submitOnboarding(DB, {}, TOKEN, form, SUBMITTED, { fire });
  assert.equal(out.status, 400);
  assert.equal(out.errors["business.phone"], "Please add a UK phone number customers can call.");
  assert.equal(out.errors.services, "Please tick at least one service.");
  assert.equal(calls.length, 0);
  const row = await one(DB, "SELECT status, submitted_at, due_live_at FROM onboarding WHERE client_id = 'c1'");
  assert.deepEqual({ ...row }, { status: "sent", submitted_at: null, due_live_at: null });

  const res = await submit(DB, TOKEN, form);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors["business.phone"], "Please add a UK phone number customers can call.");
});

test("submit valid at 2026-10-24T22:30:00Z → 7-day clock, one fire, status building, todos; second submit 409", async () => {
  const DB = await seed();
  await get(DB, TOKEN); // the client opened the form first
  const { fire, calls } = fakeFire();
  const out = await submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire });
  assert.equal(out.status, 200);
  assert.equal(out.due_live_at, "2026-10-31T22:30:00Z");
  const row = await one(DB, "SELECT * FROM onboarding WHERE client_id = 'c1'");
  assert.equal(row.submitted_at, "2026-10-24T22:30:00Z");
  assert.equal(row.due_live_at, "2026-10-31T22:30:00Z");
  assert.equal(row.status, "building");
  assert.equal(JSON.parse(row.form).domain.has, "no");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], DB);
  assert.deepEqual(calls[0].slice(1, 3), ["build", "build: client c1"]);

  const buy = await todo(DB, "build:c1:domain:buy");
  assert.ok(buy, "build:c1:domain:buy exists");
  assert.equal(buy.kind, "build");
  assert.equal(buy.status, "open");
  assert.equal(buy.title, "Buy a domain for Smith Roofing (their picks: smithroofing.co.uk, smithroofs.co.uk)");
  assert.equal(buy.link, "/#/site/c1");
  assert.equal(buy.client_id, "c1");
  assert.ok(await todo(DB, "build:c1:domain:pages"));
  const gbp = await todo(DB, "build:c1:gbp");
  assert.ok(gbp, "build:c1:gbp exists");
  assert.equal(gbp.title, "Accept Smith Roofing's Google Business Profile invite");
  assert.equal(gbp.link, "/#/site/c1");
  // the website gave no photos: Nik saves some from their Google listing
  assert.equal((await todo(DB, "build:c1:gphotos")).title,
    "Save up to 5 photos from Smith Roofing's Google listing and add them on the Site page");
  // stage 9's todo is closed; another client's that starts the same way is not
  assert.equal((await todo(DB, "build:new:c1")).status, "done");
  assert.equal((await todo(DB, "build:new:c10")).status, "open");
  // the domain plan is on the site row for the Site page and the tick
  const site = await one(DB, "SELECT domain, host FROM client_sites WHERE client_id = 'c1'");
  const plan = JSON.parse(site.domain);
  assert.equal(plan.mode, "buy");
  assert.deepEqual(plan.choices, ["smithroofing.co.uk", "smithroofs.co.uk", ""]);
  assert.equal(site.host, null);

  // second press: 409, never a second fire
  const again = await submitOnboarding(DB, {}, TOKEN, goodForm(), new Date("2026-10-24T22:30:05Z"), { fire });
  assert.equal(again.status, 409);
  assert.equal(calls.length, 1);
  assert.equal((await one(DB, "SELECT submitted_at FROM onboarding WHERE client_id = 'c1'")).submitted_at, "2026-10-24T22:30:00Z");

  // save after submit → 409, form unchanged
  const changed = goodForm();
  changed.business.name = "Changed";
  const res = await save(DB, TOKEN, changed);
  assert.equal(res.status, 409);
  assert.equal(JSON.parse((await one(DB, "SELECT form FROM onboarding WHERE client_id = 'c1'")).form).business.name, "Smith Roofing");
  // submit route after submit → 409 too
  assert.equal((await submit(DB, TOKEN, goodForm())).status, 409);
});

test("two Send presses at the same moment fire the Routine once", async () => {
  const DB = await seed();
  const { fire, calls } = fakeFire();
  const [a, b] = await Promise.all([
    submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire }),
    submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(calls.length, 1);
});

test("a failed fire leaves status submitted and still answers 200 (the client sees the thanks page)", async () => {
  const DB = await seed();
  const { fire, calls } = fakeFire({ ok: false, status: null, error: "not connected" });
  const out = await submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire });
  assert.equal(out.status, 200);
  assert.equal(calls.length, 1);
  const row = await one(DB, "SELECT status, submitted_at FROM onboarding WHERE client_id = 'c1'");
  assert.equal(row.status, "submitted");
  assert.equal(row.submitted_at, "2026-10-24T22:30:00Z");
  // a fire that throws counts as failed, not as a broken Send
  const DB2 = await seed();
  const out2 = await submitOnboarding(DB2, {}, TOKEN, goodForm(), SUBMITTED, { fire: async () => { throw new Error("boom"); } });
  assert.equal(out2.status, 200);
  assert.equal((await one(DB2, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "submitted");
});

test("submit route: 200 {ok, due_live_at}; then GET shows the thanks page with the answers", async () => {
  const DB = await seed();
  const res = await submit(DB, TOKEN, goodForm());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.due_live_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // no Routine connected: the real fireRoutine fails, the status stays submitted
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "submitted");
  const page = await get(DB, TOKEN);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Thanks, Mark!"));
  assert.ok(html.includes("Your website will be live by"));
  assert.ok(html.includes("Your answers"));
  assert.ok(!html.includes("Send: start my 7 days"));
});

test("thanks page date: submitted 2026-10-24T22:30:00Z → 'live by Sat 31 Oct'", async () => {
  const DB = await seed();
  await submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire: fakeFire().fire });
  const html = await (await get(DB, TOKEN)).text();
  assert.ok(html.includes("Your website will be live by Sat 31 Oct"));
});

test("submit with their own domain (can log in): nameserver steps, host www.<domain>, plan stored", async () => {
  const DB = await seed({ photos: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg", "https://a/4.jpg"] });
  const form = goodForm({ has: "yes", name: "SmithRoofing.co.uk", registrar: "GoDaddy", can_login: "yes", email_on_it: "yes" });
  form.gbp.has = "not_sure";
  const out = await submitOnboarding(DB, {}, TOKEN, form, SUBMITTED, { fire: fakeFire().fire });
  assert.equal(out.status, 200);
  for (const step of ["zone", "ns_email", "ns_wait", "pages"]) assert.ok(await todo(DB, `build:c1:domain:${step}`), step);
  assert.equal(await todo(DB, "build:c1:domain:buy"), null);
  assert.equal((await todo(DB, "build:c1:domain:zone")).title, "Add smithroofing.co.uk to Cloudflare");
  assert.equal((await todo(DB, "build:c1:gbp")).title, "Check whether Smith Roofing has a Google Business Profile");
  assert.equal(await todo(DB, "build:c1:gphotos"), null, "4 photos from their website: no gphotos todo");
  const site = await one(DB, "SELECT domain, host FROM client_sites WHERE client_id = 'c1'");
  assert.equal(site.host, "www.smithroofing.co.uk");
  const plan = JSON.parse(site.domain);
  assert.deepEqual({ mode: plan.mode, domain: plan.domain, registrar: plan.registrar, email_on_it: plan.email_on_it },
    { mode: "nameservers", domain: "smithroofing.co.uk", registrar: "GoDaddy", email_on_it: "yes" });
});

test("submit with their own domain (can't log in): www steps; a host another site uses is left for Nik", async () => {
  const DB = await seed();
  await insert(DB, "clients", {
    id: "c2", name: "Jones Plumbing", package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-01", created_at: "2026-10-01T09:00:00Z",
  });
  await insert(DB, "client_sites", {
    client_id: "c2", slug: "jones-plumbing-ab12", host: "www.smithroofing.co.uk", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z",
  });
  const form = goodForm({ has: "yes", name: "smithroofing.co.uk", can_login: "no", email_on_it: "no" });
  form.gbp.has = "no";
  const out = await submitOnboarding(DB, {}, TOKEN, form, SUBMITTED, { fire: fakeFire().fire });
  assert.equal(out.status, 200);
  assert.ok(await todo(DB, "build:c1:domain:pages_cname"));
  assert.ok(await todo(DB, "build:c1:domain:cname_email"));
  assert.equal((await todo(DB, "build:c1:gbp")).title, "Create a Google Business Profile with Smith Roofing");
  assert.equal((await one(DB, "SELECT host FROM client_sites WHERE client_id = 'c1'")).host, null);
  assert.equal(JSON.parse((await one(DB, "SELECT domain FROM client_sites WHERE client_id = 'c1'")).domain).mode, "cname");
});

test("Send with our own domain (control.aetoswebsites.com) is refused on the form and sets no host", async () => {
  const DB = await seed();
  const { fire, calls } = fakeFire();
  const form = goodForm({ has: "yes", name: "control.aetoswebsites.com", can_login: "yes", email_on_it: "no" });
  const out = await submitOnboarding(DB, {}, TOKEN, form, SUBMITTED, { fire });
  assert.equal(out.status, 400);
  assert.equal(out.errors["domain.name"], "That's our web address, not yours. Type your own, like smithroofing.co.uk.");
  assert.equal(calls.length, 0);
  assert.equal((await one(DB, "SELECT submitted_at FROM onboarding WHERE client_id = 'c1'")).submitted_at, null);
  assert.equal(await one(DB, "SELECT host FROM client_sites WHERE host IS NOT NULL"), null);
  // The backstop: startTodos with such a form (a row saved before this check) still sets no host.
  await get(DB, TOKEN);
  const site = await one(DB, "SELECT * FROM client_sites WHERE client_id = 'c1'");
  await startTodos(DB, site, form, { id: "c1", name: "Smith Roofing", package: "full", place_id: "p1" }, SUBMITTED);
  assert.equal((await one(DB, "SELECT host FROM client_sites WHERE client_id = 'c1'")).host, null);
});

test("Website Only: no Google questions needed, no gbp or gbp-email todo", async () => {
  const DB = await seed({ pkg: "website" });
  const form = goodForm();
  form.gbp = { has: "", invite_sent: false };
  const res = await get(DB, TOKEN);
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes("Google Business Profile"));
  const out = await submitOnboarding(DB, {}, TOKEN, form, SUBMITTED, { fire: fakeFire().fire });
  assert.equal(out.status, 200);
  assert.equal(await todo(DB, "build:c1:gbp"), null);
  assert.equal(await todo(DB, "setup:gbp-email"), null);
  assert.equal(await todo(DB, "setup:chatbot"), null, "Website Only has no chatbot");
  assert.ok(await todo(DB, "build:c1:domain:buy"));
});

test("Full Package Send files setup:chatbot until the chatbot Test has passed (section 14)", async () => {
  const DB = await seed();
  const out = await submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire: fakeFire().fire });
  assert.equal(out.status, 200);
  const t = await todo(DB, "setup:chatbot");
  assert.equal(t.title, "Connect the chatbot (Cloudflare Workers AI) on Setup");
  assert.equal(t.kind, "setup");
  assert.equal(t.link, "/#/setup");

  // a failed or unreadable last Test still files it; a passed one doesn't
  for (const [value, filed] of [[JSON.stringify({ at: "2026-10-20T09:00:00Z", ok: false, detail: "x" }), true], ["{oops", true],
    [JSON.stringify({ at: "2026-10-20T09:00:00Z", ok: true, detail: "Chatbot connection works ✓" }), false]]) {
    const DB2 = await seed();
    await setSetting(DB2, "chat:last_test", value);
    await startTodos(DB2, { client_id: "c1", place_id: "p1", host: null }, goodForm(), { id: "c1", name: "Smith Roofing", package: "full" }, SUBMITTED);
    assert.equal(Boolean(await todo(DB2, "setup:chatbot")), filed, value);
  }
});

test("startTodos is safe to run twice (dedupes) and needs no lead", async () => {
  const DB = await seed();
  await insert(DB, "clients", {
    id: "c3", name: "No Lead Ltd", package: "full", build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-01", created_at: "2026-10-01T09:00:00Z",
  });
  await insert(DB, "client_sites", { client_id: "c3", slug: "no-lead-ab12", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z" });
  const site = { client_id: "c3", place_id: null, host: null };
  const client = { id: "c3", name: "No Lead Ltd", package: "full" };
  await startTodos(DB, site, goodForm(), client, SUBMITTED);
  await startTodos(DB, site, goodForm(), client, SUBMITTED);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'build:c3:domain:buy'")).n, 1);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'build:c3:gbp'")).n, 1);
  assert.ok(await todo(DB, "build:c3:gphotos"));
});

test("once the clock has started, a D1 error making the site row or the todos still answers 200 and fires once", async () => {
  const DB = await seed();
  // D1 fails on the site row's insert and on the domain plan's write (both after the clock UPDATE)
  const failing = new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql) => {
          if (/INSERT INTO client_sites|json_patch/.test(sql)) throw new Error("D1_ERROR: network connection lost");
          return target.prepare(sql);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { fire, calls } = fakeFire();
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(String(msg));
  let out;
  try {
    out = await submitOnboarding(failing, {}, TOKEN, goodForm(), SUBMITTED, { fire });
  } finally {
    console.error = original;
  }
  assert.equal(out.status, 200);
  assert.equal(out.due_live_at, "2026-10-31T22:30:00Z");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1, 3), ["build", "build: client c1"]);
  const row = await one(DB, "SELECT status, submitted_at FROM onboarding WHERE client_id = 'c1'");
  assert.deepEqual({ ...row }, { status: "building", submitted_at: "2026-10-24T22:30:00Z" });
  assert.equal((await todo(DB, "build:new:c1")).status, "done");
  assert.ok(errors.some((e) => e.includes("Send for client c1: making the site row failed")), errors.join("\n"));
  assert.ok(errors.some((e) => e.includes("Send for client c1: filing the domain and Google todos failed")), errors.join("\n"));
  // a second press is still 409 and never fires again
  assert.equal((await submitOnboarding(DB, {}, TOKEN, goodForm(), SUBMITTED, { fire })).status, 409);
  assert.equal(calls.length, 1);
});

// care:nik_google_email is shared with stage 11's Care settings: whichever page saves it calls saveGbpEmail, so the
// setup:gbp-email todo closes wherever Nik fills it in.
test("saveGbpEmail: saves the address lower case and closes setup:gbp-email; a bad one saves nothing; empty clears it", async () => {
  const DB = fakeD1();
  await addTodo(DB, { kind: "setup", dedupe: "setup:gbp-email", title: "Add the Google account clients invite as Manager", link: "/#/setup" });
  assert.deepEqual(await saveGbpEmail(DB, "nik@gmail"), { error: GBP_EMAIL_BAD });
  assert.equal(GBP_EMAIL_BAD, "That doesn't look like an email address.");
  assert.deepEqual(await saveGbpEmail(DB, "nik@gmail.com\nBcc: x@y.com"), { error: GBP_EMAIL_BAD });
  assert.deepEqual(await saveGbpEmail(DB, 42), { error: GBP_EMAIL_BAD });
  assert.equal(await getSetting(DB, "care:nik_google_email"), null);
  assert.equal((await todo(DB, "setup:gbp-email")).status, "open");

  assert.deepEqual(await saveGbpEmail(DB, "  Nik.Aetos@Gmail.com "), { ok: true, email: "nik.aetos@gmail.com" });
  assert.equal(await getSetting(DB, "care:nik_google_email"), "nik.aetos@gmail.com");
  assert.equal((await todo(DB, "setup:gbp-email")).status, "done");

  assert.deepEqual(await saveGbpEmail(DB, ""), { ok: true, email: "" });
  assert.equal(await getSetting(DB, "care:nik_google_email"), null);
});
