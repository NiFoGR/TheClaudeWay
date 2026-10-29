// Control Room API for client sites (stage 10, 09-build.md section 13, Task 24): the Sites list, a site's detail,
// Approve and put live, Ask Claude for changes, Build again, Take offline / Put back online, the per-site switches,
// the domain (address, step ticks, nameservers, review link, Google profile ticks), the domain-step emails, Check now
// and Setup's test client. Every route is behind the login (middleware).
// Run: node --test control-room/tests/sites-api.test.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequest as middleware } from "../functions/_middleware.js";
import { onRequestGet as listRoute } from "../functions/api/sites.js";
import { onRequestGet as detailRoute } from "../functions/api/sites/[client_id].js";
import { onRequestPost as approveRoute } from "../functions/api/sites/[client_id]/approve.js";
import { onRequestPost as changesRoute } from "../functions/api/sites/[client_id]/changes.js";
import { onRequestPost as checkRoute } from "../functions/api/sites/[client_id]/check.js";
import { onRequestPost as domainRoute } from "../functions/api/sites/[client_id]/domain.js";
import { onRequestPost as featureRoute } from "../functions/api/sites/[client_id]/feature.js";
import { onRequestPost as rebuildRoute } from "../functions/api/sites/[client_id]/rebuild.js";
import {
  onRequestGet as emailPreviewRoute, onRequestPost as sendEmailRoute,
} from "../functions/api/sites/[client_id]/send-domain-email.js";
import { onRequestPost as statusRoute } from "../functions/api/sites/[client_id]/status.js";
import { onRequestDelete as deleteTestRoute, onRequestPost as createTestRoute } from "../functions/api/sites/test-client.js";
import { cnameEmail } from "../functions/_lib/sites/copy.js";
import { ensureSite } from "../functions/_lib/sites/db.js";
import { addTodo } from "../functions/_lib/todo.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-28T10:00:00Z"); // Wed 28 Oct, 10:00 UK
const T0 = "2026-10-20T09:00:00Z";
const CONTENT = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const FIRE_FAILED = "Claude couldn't be reached: the build Routine's link or token on Setup is wrong. Fix it on Setup, then press Build again.";
const BASE = "https://goldbarwebsites.pages.dev";
const TOO_LONG_SAVE = "That link is too long to print as a QR code. Use the short link from their Google Business Profile (Get more reviews), e.g. https://g.page/r/...";

const FORM = {
  business: {
    name: "Smith Roofing", phone: "01793 123456", email: "info@smithroofing.co.uk", address: "12 High St, Swindon",
    show_address: "no", legal_line: "Mark Smith trading as Smith Roofing", leads_email: "leads@smithroofing.co.uk",
  },
  services: [{ name: "Roof repairs", on: true, own: false }],
  areas: ["Swindon", "Wroughton"],
  domain: { has: "yes", name: "smithroofing.co.uk", registrar: "123-reg", can_login: "no", email_on_it: "yes", choices: ["", "", ""] },
  gbp: { has: "yes", invite_sent: true },
  review_link: "",
};

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const count = async (DB, table, where = "1", ...args) =>
  (await one(DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args)).n;
const site = (DB, id = "c1") => one(DB, "SELECT * FROM client_sites WHERE client_id = ?", id);
const todo = (DB, dedupe) => one(DB, "SELECT * FROM todos WHERE dedupe = ? OR dedupe LIKE ? || '@%' ORDER BY created_at DESC LIMIT 1", dedupe, dedupe);

/** A client with an onboarding row (form sent unless `submitted` is null) and a client_sites row. */
async function addClient(DB, id, name, { pkg = "full", site: s = {}, onboarding = {}, placeId = `p-${id}` } = {}) {
  await insert(DB, "clients", {
    id, name, place_id: placeId, package: pkg, build_fee_pence: 195000, monthly_pence: 24900, free_days: 60,
    paid_on: "2026-10-20", created_at: T0,
  });
  await insert(DB, "onboarding", {
    client_id: id, token: `${id}-`.padEnd(32, "t"), status: "review", form: JSON.stringify(FORM),
    submitted_at: "2026-10-24T22:30:00Z", due_live_at: "2026-10-31T22:30:00Z", created_at: T0, ...onboarding,
  });
  await ensureSite(DB, id, { name, place_id: placeId }, new Date(T0));
  const cols = Object.keys(s);
  if (cols.length) {
    await DB.prepare(`UPDATE client_sites SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE client_id = ?`)
      .bind(...Object.values(s), id)
      .run();
  }
}

async function setup({ site: s = {}, onboarding = {}, pkg = "full" } = {}) {
  const DB = fakeD1();
  await addClient(DB, "c1", "Smith Roofing", {
    pkg, onboarding,
    site: { status: "review", content: JSON.stringify(CONTENT), content_at: "2026-10-26T09:00:00Z", ...s },
  });
  await insert(DB, "research", {
    place_id: "p-c1", status: "done", owner: JSON.stringify({ first: "Mark", full: "Mark Smith", confident: true }),
  });
  await insert(DB, "client_links", { client_id: "c1", stripe_customer: "cus_1", email: "mark@smithroofing.co.uk" });
  await insert(DB, "settings", { key: "sites:pages_host", value: "goldbarwebsites.pages.dev" });
  return DB;
}

function fakeFire(result = { ok: true, status: 200 }) {
  const calls = [];
  return { calls, fire: async (...args) => (calls.push(args), result) };
}

const post = (path, body) => new Request(`${BASE}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
});
const ctx = (DB, request, extra = {}) => ({ request, env: { DB }, params: { client_id: "c1" }, now: NOW, ...extra });

// ---------------------------------------------------------------- the list

test("list: sorted by due date, labels from section 3, countdowns, hosts and enquiries in 30 days", async () => {
  const DB = fakeD1();
  await addClient(DB, "c1", "Smith Roofing", { site: { status: "review", content: "{}" } });
  await addClient(DB, "c2", "Jones Plumbing", { onboarding: { due_live_at: "2026-10-29T23:00:00Z" } });
  await addClient(DB, "c3", "Able Locks", {
    onboarding: { due_live_at: "2026-10-27T09:00:00Z", status: "live", live_at: "2026-10-26T09:00:00Z" },
    site: { status: "live", host: "www.ablelocks.co.uk", content: "{}", approved_at: "2026-10-25T09:00:00Z", live_at: "2026-10-26T09:00:00Z" },
  });
  await addClient(DB, "c4", "Best Removals", {
    onboarding: { due_live_at: "2026-11-02T09:00:00Z" }, site: { status: "live", host: "www.bestremovals.co.uk", content: "{}" },
  });
  await addClient(DB, "c5", "Crisp Electrics", { onboarding: { due_live_at: "2026-11-03T09:00:00Z" }, site: { status: "off", content: "{}" } });
  await addClient(DB, "c6", "Dale Heating", {
    onboarding: { due_live_at: "2026-11-04T09:00:00Z" }, site: { status: "draft", content: "{}", change_notes: "Bigger phone" },
  });
  await addClient(DB, "c7", "Early Mechanics", { onboarding: { status: "sent", submitted_at: null, due_live_at: null } });
  for (const [id, at] of [["a", "2026-10-27T09:00:00Z"], ["b", "2026-10-01T09:00:00Z"], ["c", "2026-09-01T09:00:00Z"]]) {
    await insert(DB, "site_leads", { id, client_id: "c3", source: "form", message: "Hi", created_at: at, updated_at: at });
  }

  const res = await listRoute({ request: new Request(`${BASE}/api/sites`), env: { DB }, now: NOW });
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  assert.deepEqual(list.map((r) => r.client_id), ["c3", "c2", "c1", "c4", "c5", "c6", "c7"]);
  const by = Object.fromEntries(list.map((r) => [r.client_id, r]));
  assert.equal(by.c1.status_label, "Ready to approve");
  assert.equal(by.c2.status_label, "Waiting for Claude");
  assert.equal(by.c3.status_label, "Live");
  assert.equal(by.c4.status_label, "Approved: waiting for the domain");
  assert.equal(by.c5.status_label, "Offline");
  assert.equal(by.c6.status_label, "Claude is making your changes");
  assert.equal(by.c1.name, "Smith Roofing");
  assert.deepEqual(by.c1.countdown, { label: "Due live Sat 31 Oct · 3 days left", level: "grey" });
  assert.deepEqual(by.c2.countdown, { label: "Due live Thu 29 Oct · 1 day left", level: "red" });
  assert.deepEqual(by.c3.countdown, { label: "Live Mon 26 Oct · on time", level: "green" });
  assert.equal(by.c7.countdown.level, "grey");
  assert.equal(by.c3.host, "www.ablelocks.co.uk");
  assert.equal(by.c3.live, true);
  assert.equal(by.c4.live, false);
  assert.equal(by.c1.host, null);
  assert.equal(by.c3.enquiries_30d, 2);
  assert.equal(by.c1.enquiries_30d, 0);
  for (const row of list) {
    for (const key of ["client_id", "name", "status_label", "countdown", "host", "live", "enquiries_30d"]) assert.ok(key in row, key);
  }
});

// ---------------------------------------------------------------- the detail

test("detail: label, countdown, pages with words, domain steps, chat, leads, files, form and the review kit", async () => {
  const DB = await setup();
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-28", messages: 7, fallbacks: 2, ai_errors: 0 });
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-10-03", messages: 5, fallbacks: 1, ai_errors: 0 });
  await insert(DB, "chat_usage", { client_id: "c1", day: "2026-09-30", messages: 100, fallbacks: 0, ai_errors: 0 });
  for (let i = 0; i < 22; i++) {
    const at = new Date(NOW.getTime() - (i + 1) * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await insert(DB, "site_leads", {
      id: `l${i}`, client_id: "c1", source: i % 2 ? "chat" : "form", name: i === 0 ? "<img src=x>" : `Visitor ${i}`,
      message: "x".repeat(300), created_at: at, updated_at: at,
    });
  }
  await DB.prepare("UPDATE client_sites SET domain = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ mode: "cname", domain: "smithroofing.co.uk", registrar: "123-reg", steps: { pages_cname: "2026-10-25T09:00:00Z" } }))
    .run();

  const res = await detailRoute(ctx(DB, new Request(`${BASE}/api/sites/c1`)));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.client_id, "c1");
  assert.equal(d.name, "Smith Roofing");
  assert.equal(d.status, "review");
  assert.equal(d.label, "Ready to approve");
  assert.deepEqual(d.countdown, { label: "Due live Sat 31 Oct · 3 days left", level: "grey" });
  assert.deepEqual(d.pages.map((p) => p.path), CONTENT.pages.map((p) => p.path));
  assert.ok(d.pages.every((p) => typeof p.title === "string" && Number.isInteger(p.words) && p.words > 0));
  assert.deepEqual(d.steps.map((s) => s.id), ["pages_cname", "cname_email"]);
  assert.equal(d.steps[0].done_at, "2026-10-25T09:00:00Z");
  assert.equal(d.steps[1].done_at, null);
  assert.equal(d.steps[0].auto, false);
  assert.match(d.steps[0].title, /www\.smithroofing\.co\.uk/);
  assert.equal(d.chat.on, false);
  assert.equal(typeof d.chat.reason, "string");
  assert.equal(d.chat.today, 7);
  assert.equal(d.chat.month, 12);
  assert.equal(d.chat.fallbacks_today, 2);
  assert.equal(d.leads.length, 20);
  assert.equal(d.leads[0].name, "<img src=x>"); // escaped by the page, not here
  assert.ok(d.leads.every((l) => l.message.length <= 120));
  assert.deepEqual(d.files, []);
  assert.equal(d.form.business.name, "Smith Roofing");
  assert.equal(d.review.url, "https://search.google.com/local/writereview?placeid=p-c1");
  assert.match(d.review.qr_svg, /^<svg/);
  assert.match(d.review.messages.sms, /Thanks, Mark$/);
  assert.equal(d.last_errors, null);
});

test("detail: an unknown client is a 404", async () => {
  const DB = await setup();
  const res = await detailRoute(ctx(DB, new Request(`${BASE}/api/sites/nope`), { params: { client_id: "nope" } }));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "No client with that id.");
});

test("detail: a review link too long for a QR code still shows the Site page (no QR)", async () => {
  const DB = await setup();
  const long = `https://g.page/r/${"a".repeat(2400)}/review`;
  await DB.prepare("UPDATE onboarding SET form = ? WHERE client_id = 'c1'").bind(JSON.stringify({ ...FORM, review_link: long })).run();
  const res = await detailRoute(ctx(DB, new Request(`${BASE}/api/sites/c1`)));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.review.url, long);
  assert.equal(d.review.qr_svg, "");
});

// ---------------------------------------------------------------- approve

test("approve: a site in review goes live, approved_at is stamped and the approve todo closes", async () => {
  const DB = await setup();
  await addTodo(DB, { kind: "build", dedupe: "build:c1:approve", title: "Approve Smith Roofing's site", client_id: "c1" });
  const res = await approveRoute(ctx(DB, post("/api/sites/c1/approve")));
  assert.equal(res.status, 200);
  const row = await site(DB);
  assert.equal(row.status, "live");
  assert.equal(row.approved_at, "2026-10-28T10:00:00Z");
  assert.equal((await todo(DB, "build:c1:approve")).status, "done");
  // the review link is stored for the live site (Google's write-a-review link for the place)
  assert.equal(row.review_url, "https://search.google.com/local/writereview?placeid=p-c1");
});

test("approve: on a draft site it's a 409 and nothing changes", async () => {
  const DB = await setup({ site: { status: "draft" } });
  const res = await approveRoute(ctx(DB, post("/api/sites/c1/approve")));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Approve only works when the site is ready to approve.");
  assert.equal((await site(DB)).status, "draft");
});

// ---------------------------------------------------------------- changes

test("changes: on a review site → draft, notes saved, the Routine fired with changes: client c1, onboarding building", async () => {
  const DB = await setup();
  await addTodo(DB, { kind: "build", dedupe: "build:c1:approve", title: "Approve Smith Roofing's site", client_id: "c1" });
  const { fire, calls } = fakeFire();
  const res = await changesRoute(ctx(DB, post("/api/sites/c1/changes", { notes: "Make the phone number bigger" }), { fire }));
  assert.equal(res.status, 200);
  const row = await site(DB);
  assert.equal(row.status, "draft");
  assert.equal(row.change_notes, "Make the phone number bigger");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "build");
  assert.equal(calls[0][2], "changes: client c1");
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "building");
  // no longer ready to approve: the Approve todo closes (Claude's next post files it again)
  assert.equal((await todo(DB, "build:c1:approve")).status, "done");
  const label = (await (await detailRoute(ctx(DB, new Request(`${BASE}/api/sites/c1`)))).json()).label;
  assert.equal(label, "Claude is making your changes");
});

test("changes: on an approved site still waiting for its domain, onboarding stays at review", async () => {
  const DB = await setup({ site: { status: "live", approved_at: "2026-10-26T09:00:00Z" } });
  const { fire, calls } = fakeFire();
  const res = await changesRoute(ctx(DB, post("/api/sites/c1/changes", { notes: "New photo on the home page" }), { fire }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal((await site(DB)).status, "live");
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "review");
});

test("changes: on a live site the site and onboarding stay live and the Routine is fired", async () => {
  const DB = await setup({
    site: { status: "live", host: "www.smithroofing.co.uk", live_at: "2026-10-27T09:00:00Z", approved_at: "2026-10-26T09:00:00Z" },
    onboarding: { status: "live", live_at: "2026-10-27T09:00:00Z" },
  });
  const { fire, calls } = fakeFire();
  const res = await changesRoute(ctx(DB, post("/api/sites/c1/changes", { notes: "Make the phone number bigger" }), { fire }));
  assert.equal(res.status, 200);
  const row = await site(DB);
  assert.equal(row.status, "live");
  assert.equal(row.change_notes, "Make the phone number bigger");
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "live");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "changes: client c1");
});

test("changes: empty notes are a 400 and nothing is fired", async () => {
  const DB = await setup();
  const { fire, calls } = fakeFire();
  for (const notes of ["", "   ", undefined]) {
    const res = await changesRoute(ctx(DB, post("/api/sites/c1/changes", { notes }), { fire }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Tell Claude what to change.");
  }
  assert.equal(calls.length, 0);
  assert.equal((await site(DB)).status, "review");
});

test("changes: a failing fire is a 502 and a review site stays ready to approve", async () => {
  const DB = await setup();
  const { fire } = fakeFire({ ok: false, status: null, error: "The Build Routine isn't connected" });
  const res = await changesRoute(ctx(DB, post("/api/sites/c1/changes", { notes: "Bigger phone" }), { fire }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /^Claude couldn't be reached: the build Routine's link or token on Setup is wrong\./);
  assert.equal((await site(DB)).status, "review");
  assert.equal((await site(DB)).change_notes, null); // nothing reached Claude: the notes aren't left behind
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "review");
});

// ---------------------------------------------------------------- build again

test("rebuild: a failing fire is a 502 with the plain-English fix", async () => {
  const DB = await setup({ site: { status: "draft", content: null, content_at: null }, onboarding: { status: "submitted" } });
  const { fire, calls } = fakeFire({ ok: false, status: null, error: "The Build Routine isn't connected" });
  const res = await rebuildRoute(ctx(DB, post("/api/sites/c1/rebuild"), { fire }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, FIRE_FAILED);
  assert.equal(calls[0][2], "build: client c1");
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "submitted");
});

test("rebuild: an accepted fire → onboarding building, the stuck todo closes", async () => {
  const DB = await setup({ site: { status: "draft", content: null, content_at: null }, onboarding: { status: "submitted" } });
  await addTodo(DB, { kind: "build", dedupe: "build:c1:stuck", title: "Claude hasn't built Smith Roofing's site yet", client_id: "c1" });
  const { fire, calls } = fakeFire();
  const res = await rebuildRoute(ctx(DB, post("/api/sites/c1/rebuild"), { fire }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => [c[1], c[2]]), [["build", "build: client c1"]]);
  assert.equal((await one(DB, "SELECT status FROM onboarding WHERE client_id = 'c1'")).status, "building");
  assert.equal((await todo(DB, "build:c1:stuck")).status, "done");
});

test("rebuild: before the form is sent it's a 409 and nothing is fired", async () => {
  const DB = await setup({ site: { status: "draft", content: null }, onboarding: { status: "sent", submitted_at: null, due_live_at: null } });
  const { fire, calls } = fakeFire();
  const res = await rebuildRoute(ctx(DB, post("/api/sites/c1/rebuild"), { fire }));
  assert.equal(res.status, 409);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- offline / online, switches

test("status: take offline, then put back online returns it to where it was", async () => {
  const DB = await setup({ site: { status: "live", approved_at: "2026-10-26T09:00:00Z" } });
  let res = await statusRoute(ctx(DB, post("/api/sites/c1/status", { status: "off" })));
  assert.equal(res.status, 200);
  assert.equal((await site(DB)).status, "off");
  res = await statusRoute(ctx(DB, post("/api/sites/c1/status", { status: "on" })));
  assert.equal(res.status, 200);
  assert.equal((await site(DB)).status, "live");
  // not approved yet → back to review
  await DB.prepare("UPDATE client_sites SET status = 'off', approved_at = NULL WHERE client_id = 'c1'").run();
  await statusRoute(ctx(DB, post("/api/sites/c1/status", { status: "on" })));
  assert.equal((await site(DB)).status, "review");
  // on when it isn't offline → 409; junk → 400
  res = await statusRoute(ctx(DB, post("/api/sites/c1/status", { status: "on" })));
  assert.equal(res.status, 409);
  res = await statusRoute(ctx(DB, post("/api/sites/c1/status", { status: "maybe" })));
  assert.equal(res.status, 400);
});

test("feature: switches the chatbot off and on for one site", async () => {
  const DB = await setup();
  let res = await featureRoute(ctx(DB, post("/api/sites/c1/feature", { feature: "chatbot", on: false })));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse((await site(DB)).features), { chatbot: false });
  res = await featureRoute(ctx(DB, post("/api/sites/c1/feature", { feature: "chatbot", on: true })));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse((await site(DB)).features), {});
  res = await featureRoute(ctx(DB, post("/api/sites/c1/feature", { feature: "prices", on: true })));
  assert.equal(res.status, 400);
  res = await featureRoute(ctx(DB, post("/api/sites/c1/feature", { feature: "chatbot", on: "yes" })));
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- domain

test("domain: the address is stored as www.<domain>; a host another client uses is a 409", async () => {
  const DB = await setup();
  let res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { host: "smithroofing.co.uk" })));
  assert.equal(res.status, 200);
  assert.equal((await site(DB)).host, "www.smithroofing.co.uk");
  assert.equal(JSON.parse((await site(DB)).domain).domain, "smithroofing.co.uk");

  await addClient(DB, "c2", "Jones Plumbing");
  res = await domainRoute(ctx(DB, post("/api/sites/c2/domain", { host: "https://www.SmithRoofing.co.uk/" }), { params: { client_id: "c2" } }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "www.smithroofing.co.uk is already used by Smith Roofing's site.");
  assert.equal((await site(DB, "c2")).host, null);

  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { host: "not a domain" })));
  assert.equal(res.status, 400);
});

test("domain: a review link that isn't Google's is a 400; a Google one is stored", async () => {
  const DB = await setup();
  let res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { review_url: "https://evil.com" })));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "That isn't a Google review link.");
  assert.equal((await site(DB)).review_url, null);
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { review_url: "https://g.page/r/abc/review" })));
  assert.equal(res.status, 200);
  assert.equal((await site(DB)).review_url, "https://g.page/r/abc/review");
});

test("domain: a review link too long for the QR card is a 400 and isn't stored", async () => {
  const DB = await setup();
  const res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { review_url: `https://g.page/r/${"a".repeat(2400)}/review` })));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, TOO_LONG_SAVE);
  assert.equal((await site(DB)).review_url, null);
});

// A long Google Maps link encodes (QR version 22-ish, no throw) but is past the printed card's 105 units, so it would
// be saved, shown with a QR, and then the card would refuse it. One limit: the save, the Site page and the card agree.
const MAPS_768 = `https://www.google.com/maps/place/Smith+Roofing/@51.5,-1.7,17z/data=${"x".repeat(768 - 68)}`;
test("domain: a 768-character Google Maps link (too big for the printed card) is a 400; a stored one shows no QR or card", async () => {
  assert.equal(MAPS_768.length, 768);
  const DB = await setup({ site: { status: "live", host: "www.smithroofing.co.uk", live_at: "2026-10-27T09:00:00Z" } });
  const res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { review_url: MAPS_768 })));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, TOO_LONG_SAVE);
  assert.equal((await site(DB)).review_url, null);

  // one stored before this check existed: the Site page shows the link, no QR and no card button
  await DB.prepare("UPDATE client_sites SET review_url = ? WHERE client_id = 'c1'").bind(MAPS_768).run();
  const d = await (await detailRoute(ctx(DB, new Request(`${BASE}/api/sites/c1`)))).json();
  assert.equal(d.review.url, MAPS_768);
  assert.equal(d.review.qr_svg, "");
  assert.equal(d.review.card_url, null);
  // a short link on the same live site: QR and card
  await DB.prepare("UPDATE client_sites SET review_url = ? WHERE client_id = 'c1'").bind("https://g.page/r/abc/review").run();
  const ok = await (await detailRoute(ctx(DB, new Request(`${BASE}/api/sites/c1`)))).json();
  assert.match(ok.review.qr_svg, /^<svg/);
  assert.equal(ok.review.card_url, "https://www.smithroofing.co.uk/s/review-card");
});

test("domain: ticking a step closes its todo; unticking files it again; auto steps can't be ticked", async () => {
  const DB = await setup();
  await DB.prepare("UPDATE client_sites SET domain = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ mode: "nameservers", domain: "smithroofing.co.uk", email_on_it: "yes" }))
    .run();
  await addTodo(DB, { kind: "build", dedupe: "build:c1:domain:zone", title: "Add smithroofing.co.uk to Cloudflare", client_id: "c1" });
  let res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { step: "zone", done: true })));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse((await site(DB)).domain).steps.zone, "2026-10-28T10:00:00Z");
  assert.equal((await todo(DB, "build:c1:domain:zone")).status, "done");
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { step: "zone", done: false })));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse((await site(DB)).domain).steps?.zone, undefined);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = 'build:c1:domain:zone'")).status, "open");
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { step: "ns_wait", done: true })));
  assert.equal(res.status, 400);
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { step: "buy", done: true })));
  assert.equal(res.status, 400);
});

test("domain: nameservers must be Cloudflare's two; saving them ticks the zone step", async () => {
  const DB = await setup();
  await DB.prepare("UPDATE client_sites SET domain = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ mode: "nameservers", domain: "smithroofing.co.uk" }))
    .run();
  let res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { nameservers: ["ns1.123-reg.co.uk", "ns2.123-reg.co.uk"] })));
  assert.equal(res.status, 400);
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { nameservers: ["Ada.ns.cloudflare.com "] })));
  assert.equal(res.status, 400);
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { nameservers: ["Ada.ns.cloudflare.com", "bob.ns.cloudflare.com."] })));
  assert.equal(res.status, 200);
  const domain = JSON.parse((await site(DB)).domain);
  assert.deepEqual(domain.nameservers, ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
  assert.equal(domain.steps.zone, "2026-10-28T10:00:00Z");
});

test("domain: Invite accepted waits for the site to be live; Profile created closes the gbp todo", async () => {
  const DB = await setup();
  await addTodo(DB, { kind: "build", dedupe: "build:c1:gbp", title: "Accept Smith Roofing's Google Business Profile invite", client_id: "c1" });
  let res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { gbp: "invite_accepted" })));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Tick this once the site is live: the day you tick it starts the 90 days.");
  assert.equal((await todo(DB, "build:c1:gbp")).status, "open");
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { gbp: "profile_created" })));
  assert.equal(res.status, 200);
  assert.equal((await todo(DB, "build:c1:gbp")).status, "done");

  await DB.prepare("UPDATE client_sites SET status = 'live', live_at = '2026-10-27T09:00:00Z' WHERE client_id = 'c1'").run();
  res = await domainRoute(ctx(DB, post("/api/sites/c1/domain", { gbp: "invite_accepted" })));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse((await site(DB)).domain).gbp.invite_accepted, "2026-10-28T10:00:00Z");
});

// ---------------------------------------------------------------- domain emails

test("send-domain-email (cname) with no mailbox at all → a setup todo with the email as its draft, no welcome todo", async () => {
  const DB = await setup();
  await DB.prepare("UPDATE client_sites SET domain = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ mode: "cname", domain: "smithroofing.co.uk", registrar: "123-reg" }))
    .run();
  const res = await sendEmailRoute(ctx(DB, post("/api/sites/c1/send-domain-email", { kind: "cname" })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.queued, null);
  const t = await todo(DB, "setup:client-mail:c1:domain-cname");
  assert.ok(t, "the setup todo exists");
  assert.equal(t.kind, "setup");
  assert.equal(t.title, "Send Smith Roofing this email yourself (no mailbox yet)");
  assert.equal(t.link, "/#/site/c1");
  const email = cnameEmail({ first: "Mark", domain: "smithroofing.co.uk", registrar: "123-reg", pagesHost: "goldbarwebsites.pages.dev", nik: "Nik" });
  assert.equal(t.draft, email.body);
  assert.match(t.detail, /^To: mark@smithroofing\.co\.uk\nSubject: One quick job for your new website\n\n/);
  assert.equal(await todo(DB, "setup:welcome:c1"), null);
  assert.equal(await count(DB, "messages"), 0);
  assert.equal(JSON.parse((await site(DB)).domain).steps?.cname_email, undefined);
});

test("send-domain-email: with a mailbox the email is queued (Nik's edits kept) and the step is ticked", async () => {
  const DB = await setup();
  await insert(DB, "mailboxes", {
    id: "mb-sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-01-01",
    status: "active", created_at: T0,
  });
  await DB.prepare("UPDATE client_sites SET domain = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ mode: "nameservers", domain: "smithroofing.co.uk", registrar: "123-reg", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] }))
    .run();
  await addTodo(DB, { kind: "build", dedupe: "build:c1:domain:ns_email", title: "Send Smith Roofing the nameserver steps", client_id: "c1" });
  // filed while there was no mailbox: done once the email has really been queued
  await addTodo(DB, { kind: "setup", dedupe: "setup:client-mail:c1:domain-nameservers", title: "Send Smith Roofing this email yourself (no mailbox yet)", client_id: "c1" });

  const preview = await emailPreviewRoute(ctx(DB, new Request(`${BASE}/api/sites/c1/send-domain-email?kind=nameservers`)));
  assert.equal(preview.status, 200);
  const p = await preview.json();
  assert.equal(p.to, "mark@smithroofing.co.uk");
  assert.equal(p.subject, "One quick job for your new website");
  assert.match(p.body, /^Hi Mark,\n\n/);
  assert.match(p.body, /ada\.ns\.cloudflare\.com\nbob\.ns\.cloudflare\.com/);

  const res = await sendEmailRoute(ctx(DB, post("/api/sites/c1/send-domain-email", {
    kind: "nameservers", subject: "One quick job\r\nBcc: x@evil.com", body: `${p.body}\n\nPS: call me any time.`,
  })));
  assert.equal(res.status, 200);
  const msg = await one(DB, "SELECT * FROM messages");
  assert.equal(msg.kind, "system");
  assert.equal(msg.client_id, "c1");
  assert.equal(msg.to_addr, "mark@smithroofing.co.uk");
  assert.equal(msg.subject, "One quick job Bcc: x@evil.com");
  assert.match(msg.body, /PS: call me any time\.$/);
  assert.equal(JSON.parse((await site(DB)).domain).steps.ns_email, "2026-10-28T10:00:00Z");
  assert.equal((await todo(DB, "build:c1:domain:ns_email")).status, "done");
  assert.equal((await todo(DB, "setup:client-mail:c1:domain-nameservers")).status, "done");
});

test("send-domain-email: without Cloudflare's nameservers it's a 400 in plain English", async () => {
  const DB = await setup();
  await DB.prepare("UPDATE client_sites SET domain = ? WHERE client_id = 'c1'")
    .bind(JSON.stringify({ mode: "nameservers", domain: "smithroofing.co.uk" }))
    .run();
  const res = await sendEmailRoute(ctx(DB, post("/api/sites/c1/send-domain-email", { kind: "nameservers" })));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "The nameserver email needs Cloudflare's two nameservers: paste them on the Site page first.");
});

// ---------------------------------------------------------------- check now

test("check: runs the DNS check now and answers its plain-English detail", async () => {
  const DB = await setup({ site: { host: "www.smithroofing.co.uk" } });
  const fetchImpl = async (url) => {
    const type = new URL(url).searchParams.get("type");
    const Answer = type === "CNAME" ? [{ type: 5, data: "goldbarwebsites.pages.dev." }] : [];
    return new Response(JSON.stringify({ Status: 0, Answer }), { headers: { "content-type": "application/dns-json" } });
  };
  const res = await checkRoute(ctx(DB, post("/api/sites/c1/check"), { fetchImpl }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.detail, "www.smithroofing.co.uk points at us ✓");
  assert.equal(JSON.parse((await site(DB)).host_check).ok, true);

  const none = await checkRoute(ctx(DB, post("/api/sites/x/check"), { fetchImpl, params: { client_id: "x" } }));
  assert.equal(none.status, 404);
});

// ---------------------------------------------------------------- test client

test("test client: POST creates the client, onboarding and an is_test site on site-test.aetoswebsites.com; DELETE removes it all", async () => {
  const DB = fakeD1();
  await addClient(DB, "c1", "Smith Roofing"); // a real client stays untouched
  const res = await createTestRoute({ request: post("/api/sites/test-client"), env: { DB }, now: NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  const id = body.client_id;
  assert.ok(id);
  const client = await one(DB, "SELECT * FROM clients WHERE id = ?", id);
  assert.equal(client.notes, "TEST");
  assert.equal(client.monthly_pence, 0);
  assert.equal(client.package, "full");
  const ob = await one(DB, "SELECT * FROM onboarding WHERE client_id = ?", id);
  assert.equal(ob.status, "sent");
  assert.match(ob.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(body.onboard_url, `${BASE}/onboard/${ob.token}`);
  const s = await site(DB, id);
  assert.equal(s.is_test, 1);
  assert.equal(s.host, "site-test.aetoswebsites.com");

  // a second one is refused while the first exists
  const again = await createTestRoute({ request: post("/api/sites/test-client"), env: { DB }, now: NOW });
  assert.equal(again.status, 409);

  // what the test client collects on its way
  await insert(DB, "site_leads", { id: "sl1", client_id: id, source: "chat", message: "Hi", created_at: T0, updated_at: T0 });
  await insert(DB, "site_files", {
    id: "f".repeat(32), client_id: id, kind: "photo", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), size: 3, width: 1, height: 1, created_at: T0,
  });
  await insert(DB, "chat_usage", { client_id: id, day: "2026-10-28", messages: 3 });
  await addTodo(DB, { kind: "build", dedupe: `build:${id}:approve`, title: "Approve the test site", client_id: id });
  await addTodo(DB, { kind: "setup", dedupe: `setup:client-mail:${id}:go-live`, title: "Send the test client this email yourself" });

  const del = await deleteTestRoute({ request: new Request(`${BASE}/api/sites/test-client`, { method: "DELETE" }), env: { DB }, now: NOW });
  assert.equal(del.status, 200);
  for (const table of ["onboarding", "client_sites", "site_leads", "site_files", "chat_usage"]) {
    assert.equal(await count(DB, table, "client_id = ?", id), 0, table);
  }
  assert.equal(await count(DB, "clients", "id = ?", id), 0);
  assert.equal(await count(DB, "todos", "client_id = ? OR dedupe LIKE ?", id, `%${id}%`), 0);
  // the real client is still there
  assert.equal(await count(DB, "clients", "id = 'c1'"), 1);
  assert.equal(await count(DB, "client_sites", "client_id = 'c1'"), 1);
  // deleting again is fine
  const again2 = await deleteTestRoute({ request: new Request(`${BASE}/api/sites/test-client`, { method: "DELETE" }), env: { DB }, now: NOW });
  assert.equal(again2.status, 404);
});

test("test client: DELETE also removes a test client left without a site, and never a real client noted TEST", async () => {
  const DB = fakeD1();
  await addClient(DB, "c1", "Smith Roofing");
  await DB.prepare("UPDATE clients SET notes = 'TEST' WHERE id = 'c1'").run(); // a real client Nik happened to note TEST
  await insert(DB, "clients", { id: "cl_test_abcdef123456", name: "Aetos Test Site", package: "full", build_fee_pence: 0, monthly_pence: 0, free_days: 0, paid_on: "2026-10-28", notes: "TEST", created_at: T0 });
  await insert(DB, "onboarding", { client_id: "cl_test_abcdef123456", token: "t".repeat(32), status: "sent", created_at: T0 });
  const del = await deleteTestRoute({ request: new Request(`${BASE}/api/sites/test-client`, { method: "DELETE" }), env: { DB }, now: NOW });
  assert.equal(del.status, 200);
  assert.deepEqual((await del.json()).deleted, ["cl_test_abcdef123456"]);
  assert.equal(await count(DB, "clients", "id = 'cl_test_abcdef123456'"), 0);
  assert.equal(await count(DB, "onboarding", "client_id = 'cl_test_abcdef123456'"), 0);
  assert.equal(await count(DB, "clients", "id = 'c1'"), 1);
  assert.equal(await count(DB, "client_sites", "client_id = 'c1'"), 1);
  assert.equal(await count(DB, "onboarding", "client_id = 'c1'"), 1);
});

// ---------------------------------------------------------------- login

const PASSWORD = "test-password-123";
const COOKIE = `cr_session=${createHmac("sha256", PASSWORD).update("goldbar-control-room-session").digest("hex")}`;
const ROUTES = [
  ["GET", "/api/sites"], ["GET", "/api/sites/c1"], ["POST", "/api/sites/c1/approve"], ["POST", "/api/sites/c1/changes"],
  ["POST", "/api/sites/c1/rebuild"], ["POST", "/api/sites/c1/status"], ["POST", "/api/sites/c1/feature"],
  ["POST", "/api/sites/c1/domain"], ["GET", "/api/sites/c1/send-domain-email?kind=cname"],
  ["POST", "/api/sites/c1/send-domain-email"], ["POST", "/api/sites/c1/check"], ["POST", "/api/sites/test-client"],
  ["DELETE", "/api/sites/test-client"],
];

test("every sites route is 401 without the login cookie, on every host", async () => {
  for (const host of ["goldbarwebsites.pages.dev", "control.aetoswebsites.com"]) {
    for (const [method, path] of ROUTES) {
      let ran = 0;
      const request = new Request(`https://${host}${path}`, { method, body: method === "POST" ? "{}" : undefined });
      const res = await middleware({ request, env: { CONTROL_ROOM_PASSWORD: PASSWORD, DB: fakeD1() }, next: async () => { ran++; return new Response("ran"); } });
      assert.equal(res.status, 401, `${method} ${host}${path}`);
      assert.deepEqual(await res.json(), { error: "Not logged in" });
      assert.equal(ran, 0);
    }
  }
  let ran = 0;
  const ok = await middleware({
    request: new Request(`${BASE}/api/sites`, { headers: { cookie: COOKIE } }),
    env: { CONTROL_ROOM_PASSWORD: PASSWORD, DB: fakeD1() },
    next: async () => { ran++; return new Response("ran"); },
  });
  assert.equal(ok.status, 200);
  assert.equal(ran, 1);
});
